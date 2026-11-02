//! Bounded semantic routing across explicitly staged, capable body instances.
//!
//! This is deterministic graph planning, not a geometric collision planner. The
//! application must derive candidate readiness, availability and map placement
//! from authoritative current state and revalidate them before approval.
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, VecDeque};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{BodyId, Capability, DomainError};

const MAX_PLACES: usize = 16;
const MAX_SEGMENTS: usize = 32;
const MAX_BODIES: usize = 4;
const MAX_LEGS: usize = 12;
const MAX_EXPANSIONS: usize = 16_384;

/// Position in the semantic map's common frame, in metres.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoutePose {
    /// Map-frame horizontal coordinate.
    pub x: f64,
    /// Map-frame horizontal coordinate.
    pub y: f64,
    /// Map-frame elevation; distinct floors must not collapse into one place.
    pub z: f64,
}
impl RoutePose {
    /// Rejects non-finite or unbounded map coordinates.
    pub fn validate(&self) -> Result<(), DomainError> {
        if [self.x, self.y, self.z]
            .iter()
            .any(|v| !v.is_finite() || v.abs() > 10_000.0)
        {
            return Err(invalid(
                "route coordinates must be finite and within 10000 metres",
            ));
        }
        Ok(())
    }
    /// Straight-line spatial distance, not an estimated navigation trajectory.
    pub fn distance_to(&self, other: &Self) -> f64 {
        (self.x - other.x)
            .hypot(self.y - other.y)
            .hypot(self.z - other.z)
    }
}

/// A named, bounded arrival region and optional body transfer point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticPlace {
    /// Stable path-safe place identity.
    pub id: String,
    /// Operator-facing name.
    pub label: String,
    /// Centre of the arrival region in the map frame.
    pub pose: RoutePose,
    /// Maximum spatial distance for placement and arrival checks.
    pub arrival_radius_m: f64,
    /// Whether mission ownership may change at this place.
    pub transfer_allowed: bool,
}

/// One directed, explicitly permitted semantic traversal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteSegment {
    /// Stable identity of the reviewed segment.
    pub id: String,
    /// Starting place ID.
    pub from: String,
    /// Destination place ID.
    pub to: String,
    /// Every listed capability is required; this is not an any-of condition.
    pub required_capabilities: BTreeSet<Capability>,
    /// Segment speed ceiling, additionally subject to adapter-local limits.
    pub max_speed_mps: f32,
    /// False removes this segment from executable planning.
    pub enabled: bool,
}

/// Operator-maintained semantic graph, frozen by revision and content digest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticMap {
    /// Stable map identity.
    pub id: String,
    /// Explicit positive map revision.
    pub revision: u64,
    /// Common coordinate frame used by both map and localized body state.
    pub frame_id: String,
    /// At most sixteen unique places.
    pub places: Vec<SemanticPlace>,
    /// At most thirty-two unique directed segments.
    pub segments: Vec<RouteSegment>,
}
impl SemanticMap {
    /// Finds one named place without treating an unknown name as a coordinate.
    pub fn place(&self, id: &str) -> Option<&SemanticPlace> {
        self.places.iter().find(|place| place.id == id)
    }
    /// Finds one reviewed segment.
    pub fn segment(&self, id: &str) -> Option<&RouteSegment> {
        self.segments.iter().find(|segment| segment.id == id)
    }
    /// Validates graph bounds, unique IDs, finite geometry and typed requirements.
    pub fn validate(&self) -> Result<(), DomainError> {
        validate_id(&self.id)?;
        validate_id(&self.frame_id)?;
        if self.revision == 0
            || !(1..=MAX_PLACES).contains(&self.places.len())
            || self.segments.len() > MAX_SEGMENTS
        {
            return Err(invalid(
                "map requires a positive revision, 1..16 places and at most 32 segments",
            ));
        }
        let mut places = BTreeSet::new();
        for place in &self.places {
            validate_id(&place.id)?;
            if !places.insert(&place.id) {
                return Err(invalid("duplicate semantic place"));
            }
            if !(1..=100).contains(&place.label.len())
                || place.label.chars().any(char::is_control)
                || place.label.trim().is_empty()
            {
                return Err(invalid(
                    "place label must contain 1..100 printable characters",
                ));
            }
            place.pose.validate()?;
            if !place.arrival_radius_m.is_finite()
                || !(0.05..=2.0).contains(&place.arrival_radius_m)
            {
                return Err(invalid(
                    "place arrival radius must be within 0.05..2 metres",
                ));
            }
        }
        let mut segments = BTreeSet::new();
        for segment in &self.segments {
            validate_id(&segment.id)?;
            if !segments.insert(&segment.id) {
                return Err(invalid("duplicate semantic segment"));
            }
            let from = self
                .place(&segment.from)
                .ok_or_else(|| invalid("unknown segment source"))?;
            let to = self
                .place(&segment.to)
                .ok_or_else(|| invalid("unknown segment destination"))?;
            if segment.from == segment.to || from.pose.distance_to(&to.pose) < 0.001 {
                return Err(invalid(
                    "segment endpoints must be distinct by at least one millimetre",
                ));
            }
            if !segment
                .required_capabilities
                .contains(&Capability::Navigate)
                || segment.required_capabilities.iter().any(|capability| {
                    !matches!(
                        capability,
                        Capability::Navigate | Capability::Stairs | Capability::RoughTerrain
                    )
                })
                || !segment.max_speed_mps.is_finite()
                || !(0.05..=1.0).contains(&segment.max_speed_mps)
            {
                return Err(invalid(
                    "segment requires navigate, optional stairs/rough_terrain, and a speed within 0.05..1 metre per second",
                ));
            }
        }
        Ok(())
    }
    /// Hashes all validated map content, independent of input collection order.
    pub fn digest(&self) -> Result<String, DomainError> {
        self.validate()?;
        let mut canonical = self.clone();
        canonical.places.sort_by(|a, b| a.id.cmp(&b.id));
        canonical.segments.sort_by(|a, b| a.id.cmp(&b.id));
        let bytes =
            serde_json::to_vec(&canonical).map_err(|_| invalid("map serialization failed"))?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
}

/// Current candidate facts supplied by the trusted application, not model output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteCandidate {
    /// Authenticated body identity.
    pub body_id: BodyId,
    /// Verified current placement; None is excluded rather than guessed.
    pub place_id: Option<String>,
    /// Explicit capabilities available through its adapter.
    pub capabilities: BTreeSet<Capability>,
    /// Fresh, sufficiently charged, localized and locally ready.
    pub ready: bool,
    /// Not busy, fenced or reserved by another mission.
    pub available: bool,
}

/// Bounded goal for the semantic planner.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteRequest {
    /// Body that must begin the reviewed objective.
    pub source_body_id: BodyId,
    /// Its verified starting place.
    pub source_place_id: String,
    /// Requested destination place.
    pub destination_place_id: String,
    /// Optional capability required for the task after arrival, e.g. inspection.
    #[serde(default)]
    pub destination_capability: Option<Capability>,
}

/// Exact traversal assigned to one body in the proposed plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlannedLeg {
    /// Reviewed semantic segment identity.
    pub segment_id: String,
    /// Body permitted to execute this segment.
    pub body_id: BodyId,
    /// Source place ID.
    pub from: String,
    /// Destination place ID.
    pub to: String,
    /// Frozen source geometry.
    pub from_pose: RoutePose,
    /// Frozen destination geometry.
    pub to_pose: RoutePose,
    /// Destination arrival tolerance.
    pub arrival_radius_m: f64,
    /// Every required mobility capability.
    pub required_capabilities: BTreeSet<Capability>,
    /// Frozen segment speed ceiling.
    pub max_speed_mps: f32,
    /// Straight-line graph-edge length used by this baseline's cost function.
    pub distance_m: f64,
}

/// A proposed change of body at an explicitly permitted transfer point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlannedTransfer {
    /// Shared place at which both bodies must be staged before continuation.
    pub place_id: String,
    /// Body that must stop and relinquish the mission.
    pub source_body_id: BodyId,
    /// Eligible body already staged at this point in the planning snapshot.
    pub target_body_id: BodyId,
    /// Number of route legs completed before the transfer.
    pub before_leg_index: usize,
    /// Explanation grounded in capability requirements and placement.
    pub reason: String,
}

/// Specific traversal requirements a candidate cannot fulfil.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SegmentCapabilityGap {
    /// Relevant semantic segment, or `destination_task` for the final capability.
    pub segment_id: String,
    /// Required capabilities absent from the body.
    pub missing_capabilities: BTreeSet<Capability>,
}

/// Reviewable eligibility and capability limitations for one fleet candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateAssessment {
    /// Body whose snapshot was assessed.
    pub body_id: BodyId,
    /// Supplied verified place, retained even when it is unusable in this map.
    pub place_id: Option<String>,
    /// Ready, available and located at a known map place; individual legs still need capabilities.
    pub eligible: bool,
    /// Explicit reasons why the candidate is excluded before graph search.
    pub reasons: Vec<String>,
    /// Per-segment and optional destination-task capability gaps.
    pub capability_gaps: Vec<SegmentCapabilityGap>,
}

/// Deterministic, reviewable route proposal; it grants no execution authority.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoutePlan {
    /// Versioned deterministic baseline.
    pub planner_id: String,
    /// Frozen map identity.
    pub map_id: String,
    /// Frozen map revision.
    pub map_revision: u64,
    /// Digest of the full map, including disabled segments and transfer permissions.
    pub map_digest: String,
    /// Requested starting body.
    pub source_body_id: BodyId,
    /// Verified initial place.
    pub source_place_id: String,
    /// Requested final place.
    pub destination_place_id: String,
    /// Body assigned to the destination task after all proposed transfers.
    pub destination_body_id: BodyId,
    /// Required task capability after arrival, if any.
    pub destination_capability: Option<Capability>,
    /// Ordered, bounded route segments and their body assignments.
    pub legs: Vec<PlannedLeg>,
    /// Proposed transfers, each requiring explicit execution-layer review.
    pub transfers: Vec<PlannedTransfer>,
    /// Sum of graph-edge distances; not measured travel or trajectory length.
    pub distance_m: f64,
    /// Grounded explanation of the selected plan and its limits.
    pub explanation: Vec<String>,
    /// Eligibility and capability gaps for all supplied candidates.
    pub assessments: Vec<CandidateAssessment>,
}

/// Reasons why the bounded planner declined to produce a route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteFailureCode {
    /// Malformed or oversized graph, request or fleet snapshot.
    InvalidInput,
    /// The requested source is missing, unready, busy or not at its claimed start.
    SourceUnavailable,
    /// No semantic path exists, including disabled segments.
    Unreachable,
    /// A semantic path exists only through disabled or currently blocked segments.
    BlockedRoute,
    /// No ready, available body combination can fulfil a required capability.
    NoCapableBody,
    /// Required bodies are not staged at allowed transfer points.
    TransferUnavailable,
    /// A route exceeded the bounded search/leg budget; no partial plan is returned.
    SearchLimit,
}

/// Structured planning failure with no executable fallback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
#[serde(deny_unknown_fields)]
pub struct RoutePlanningFailure {
    /// Machine-readable refusal category.
    pub code: RouteFailureCode,
    /// Operator-safe explanation.
    pub message: String,
    /// Candidate limitations when input validation permitted assessment.
    pub assessments: Vec<CandidateAssessment>,
}

/// Computes a route with fewest transfers, then shortest graph distance, then
/// stable lexical tie-breaking. A replacement must already be staged at an
/// allowed transfer point and cannot be selected twice in one plan.
pub fn plan_route(
    map: &SemanticMap,
    request: &RouteRequest,
    candidates: &[RouteCandidate],
) -> Result<RoutePlan, RoutePlanningFailure> {
    plan_route_with_blocked_segments(map, request, candidates, &BTreeSet::new())
}

/// Plans around current route closures without changing trusted map geometry.
/// The application must freeze the supplied closure set and its revision in the
/// review and recheck it before approval and dispatch. An empty set cannot open
/// a statically disabled segment; unknown segment identities fail closed.
pub fn plan_route_with_blocked_segments(
    map: &SemanticMap,
    request: &RouteRequest,
    candidates: &[RouteCandidate],
    blocked_segments: &BTreeSet<String>,
) -> Result<RoutePlan, RoutePlanningFailure> {
    map.validate().map_err(invalid_failure)?;
    if blocked_segments.len() > MAX_SEGMENTS
        || blocked_segments.iter().any(|id| map.segment(id).is_none())
    {
        return Err(failure(
            RouteFailureCode::InvalidInput,
            "current closures must identify at most 32 segments in the trusted map",
            vec![],
        ));
    }
    let traversable =
        |segment: &RouteSegment| segment.enabled && !blocked_segments.contains(&segment.id);
    validate_id(&request.source_place_id).map_err(invalid_failure)?;
    validate_id(&request.destination_place_id).map_err(invalid_failure)?;
    BodyId::new(request.source_body_id.as_str()).map_err(invalid_failure)?;
    if !(1..=MAX_BODIES).contains(&candidates.len()) {
        return Err(failure(
            RouteFailureCode::InvalidInput,
            "planner requires one to four candidate bodies",
            vec![],
        ));
    }
    let mut bodies: Vec<_> = candidates.iter().collect();
    bodies.sort_by(|a, b| a.body_id.cmp(&b.body_id));
    let mut ids = BTreeSet::new();
    for body in &bodies {
        BodyId::new(body.body_id.as_str()).map_err(invalid_failure)?;
        if !ids.insert(&body.body_id) {
            return Err(failure(
                RouteFailureCode::InvalidInput,
                "duplicate candidate body",
                vec![],
            ));
        }
        if let Some(place) = &body.place_id {
            validate_id(place).map_err(invalid_failure)?;
        }
    }
    let mut places: Vec<_> = map.places.iter().collect();
    places.sort_by(|a, b| a.id.cmp(&b.id));
    let mut segments: Vec<_> = map.segments.iter().collect();
    segments.sort_by(|a, b| a.id.cmp(&b.id));
    let assessments: Vec<_> = bodies
        .iter()
        .map(|body| assess(map, request, body, &segments, blocked_segments))
        .collect();
    let source_place = places
        .iter()
        .position(|p| p.id == request.source_place_id)
        .ok_or_else(|| {
            failure(
                RouteFailureCode::InvalidInput,
                "unknown source place",
                assessments.clone(),
            )
        })?;
    let destination = places
        .iter()
        .position(|p| p.id == request.destination_place_id)
        .ok_or_else(|| {
            failure(
                RouteFailureCode::InvalidInput,
                "unknown destination place",
                assessments.clone(),
            )
        })?;
    let source_body = bodies
        .iter()
        .position(|body| body.body_id == request.source_body_id)
        .ok_or_else(|| {
            failure(
                RouteFailureCode::SourceUnavailable,
                "requested source body is not in the current fleet snapshot",
                assessments.clone(),
            )
        })?;
    if !assessments[source_body].eligible
        || bodies[source_body].place_id.as_deref() != Some(&request.source_place_id)
    {
        return Err(failure(
            RouteFailureCode::SourceUnavailable,
            "source body must be ready, available and verified at the requested starting place",
            assessments,
        ));
    }
    if shortest_hops(map, request, |_| true).is_none() {
        return Err(failure(
            RouteFailureCode::Unreachable,
            "no semantic path connects the source and destination",
            assessments,
        ));
    }
    if shortest_hops(map, request, traversable).is_none() {
        return Err(failure(
            RouteFailureCode::BlockedRoute,
            "the route is blocked by disabled semantic segments or current route conditions",
            assessments,
        ));
    }
    let compatible_hops = shortest_hops(map, request, |segment| {
        traversable(segment)
            && bodies.iter().enumerate().any(|(index, body)| {
                assessments[index].eligible
                    && segment.required_capabilities.is_subset(&body.capabilities)
            })
    });
    if compatible_hops.is_none()
        || request.destination_capability.is_some_and(|capability| {
            !bodies.iter().enumerate().any(|(index, body)| {
                assessments[index].eligible && body.capabilities.contains(&capability)
            })
        })
    {
        return Err(failure(
            RouteFailureCode::NoCapableBody,
            "no eligible body combination provides all required route and destination capabilities",
            assessments,
        ));
    }
    if compatible_hops.is_some_and(|hops| hops > MAX_LEGS) {
        return Err(failure(
            RouteFailureCode::SearchLimit,
            "the route exceeds the twelve-leg planning limit",
            assessments,
        ));
    }
    let initial = SearchEntry {
        key: SearchKey {
            place: source_place,
            body: source_body,
            used: 1 << source_body,
            legs: 0,
        },
        cost: Cost {
            transfers: 0,
            distance: 0.0,
            tie_break: vec![],
        },
        legs: vec![],
        transfers: vec![],
    };
    let mut best = BTreeMap::from([(initial.key, initial.cost.clone())]);
    let mut frontier = BinaryHeap::from([initial]);
    let mut expansions = 0;
    while let Some(current) = frontier.pop() {
        if best.get(&current.key) != Some(&current.cost) {
            continue;
        }
        expansions += 1;
        if expansions > MAX_EXPANSIONS {
            return Err(failure(
                RouteFailureCode::SearchLimit,
                "bounded route search exhausted; no partial plan is authorized",
                assessments,
            ));
        }
        let body = bodies[current.key.body];
        let place = places[current.key.place];
        if current.key.place == destination
            && request
                .destination_capability
                .is_none_or(|capability| body.capabilities.contains(&capability))
        {
            let mut plan = finish_plan(map, request, &bodies, current, assessments)?;
            if !blocked_segments.is_empty() {
                plan.explanation.insert(1, format!(
                    "Excluded segments [{}] from the current condition snapshot; trusted map geometry and digest are unchanged. Approval must recheck the condition revision.",
                    blocked_segments.iter().cloned().collect::<Vec<_>>().join(", ")
                ));
            }
            return Ok(plan);
        }
        if current.key.legs < MAX_LEGS {
            for segment in &segments {
                if !traversable(segment)
                    || segment.from != place.id
                    || !segment.required_capabilities.is_subset(&body.capabilities)
                {
                    continue;
                }
                let next_place =
                    places
                        .iter()
                        .position(|p| p.id == segment.to)
                        .ok_or_else(|| {
                            failure(
                                RouteFailureCode::InvalidInput,
                                "segment endpoint disappeared",
                                assessments.clone(),
                            )
                        })?;
                let target = places[next_place];
                let distance = place.pose.distance_to(&target.pose);
                let mut next = current.clone();
                next.key.place = next_place;
                next.key.legs += 1;
                next.cost.distance += distance;
                next.cost
                    .tie_break
                    .push(format!("leg:{}:{}", segment.id, body.body_id));
                next.legs.push(PlannedLeg {
                    segment_id: segment.id.clone(),
                    body_id: body.body_id.clone(),
                    from: place.id.clone(),
                    to: target.id.clone(),
                    from_pose: place.pose,
                    to_pose: target.pose,
                    arrival_radius_m: target.arrival_radius_m,
                    required_capabilities: segment.required_capabilities.clone(),
                    max_speed_mps: segment.max_speed_mps,
                    distance_m: distance,
                });
                enqueue(next, &mut best, &mut frontier);
            }
        }
        if place.transfer_allowed {
            for (index, replacement) in bodies.iter().enumerate() {
                if !assessments[index].eligible
                    || current.key.used & (1 << index) != 0
                    || replacement.place_id.as_deref() != Some(&place.id)
                {
                    continue;
                }
                let mut next = current.clone();
                next.key.body = index;
                next.key.used |= 1 << index;
                next.cost.transfers += 1;
                next.cost
                    .tie_break
                    .push(format!("transfer:{}:{}", place.id, replacement.body_id));
                next.transfers.push(PlannedTransfer {
                    place_id: place.id.clone(),
                    source_body_id: body.body_id.clone(),
                    target_body_id: replacement.body_id.clone(),
                    before_leg_index: current.legs.len(),
                    reason: String::new(),
                });
                enqueue(next, &mut best, &mut frontier);
            }
        }
    }
    Err(failure(
        RouteFailureCode::TransferUnavailable,
        "capabilities exist, but no route within twelve legs can use them through allowed transfer points with replacements already staged; unknown positions and repeated-body transfers are not assumed",
        assessments,
    ))
}

fn finish_plan(
    map: &SemanticMap,
    request: &RouteRequest,
    bodies: &[&RouteCandidate],
    mut found: SearchEntry,
    assessments: Vec<CandidateAssessment>,
) -> Result<RoutePlan, RoutePlanningFailure> {
    let destination_body_id = bodies[found.key.body].body_id.clone();
    let mut explanation = vec![format!(
        "Selected {} route legs with {} body transfers; minimise transfers before summed straight-line graph distance.",
        found.legs.len(),
        found.transfers.len()
    )];
    for transfer in &mut found.transfers {
        let source = bodies
            .iter()
            .find(|body| body.body_id == transfer.source_body_id)
            .ok_or_else(|| {
                failure(
                    RouteFailureCode::InvalidInput,
                    "transfer source missing",
                    assessments.clone(),
                )
            })?;
        let mut missing = BTreeSet::new();
        for leg in found
            .legs
            .iter()
            .skip(transfer.before_leg_index)
            .take_while(|leg| leg.body_id == transfer.target_body_id)
        {
            missing.extend(
                leg.required_capabilities
                    .difference(&source.capabilities)
                    .copied(),
            );
        }
        if destination_body_id == transfer.target_body_id
            && let Some(capability) = request.destination_capability
            && !source.capabilities.contains(&capability)
        {
            missing.insert(capability);
        }
        let names = capability_names(&missing);
        transfer.reason = if missing.is_empty() {
            format!(
                "{} is ready and staged at allowed transfer point {} for the remaining route or destination task.",
                transfer.target_body_id, transfer.place_id
            )
        } else {
            format!(
                "{} lacks [{}] needed after {}; {} provides them and is ready and staged at that allowed transfer point.",
                transfer.source_body_id, names, transfer.place_id, transfer.target_body_id
            )
        };
        explanation.push(transfer.reason.clone());
    }
    explanation.push("This proposal grants no motion authority. Approval must recheck the map, body readiness, placement and source-stop boundary; adapters remain responsible for local path and motion safety.".into());
    Ok(RoutePlan {
        planner_id: "semantic-capability-dijkstra-v1".into(),
        map_id: map.id.clone(),
        map_revision: map.revision,
        map_digest: map.digest().map_err(invalid_failure)?,
        source_body_id: request.source_body_id.clone(),
        source_place_id: request.source_place_id.clone(),
        destination_place_id: request.destination_place_id.clone(),
        destination_body_id,
        destination_capability: request.destination_capability,
        legs: found.legs,
        transfers: found.transfers,
        distance_m: found.cost.distance,
        explanation,
        assessments,
    })
}

fn assess(
    map: &SemanticMap,
    request: &RouteRequest,
    body: &RouteCandidate,
    segments: &[&RouteSegment],
    blocked_segments: &BTreeSet<String>,
) -> CandidateAssessment {
    let mut reasons = Vec::new();
    if !body.ready {
        reasons.push("body is not currently ready and fresh".into());
    }
    if !body.available {
        reasons.push("body is busy, fenced or otherwise unavailable".into());
    }
    match &body.place_id {
        None => reasons.push("body has no verified semantic placement".into()),
        Some(id) if map.place(id).is_none() => {
            reasons.push("body placement is outside the reviewed semantic map".into())
        }
        Some(_) => {}
    }
    let mut capability_gaps: Vec<_> = segments
        .iter()
        .filter(|segment| segment.enabled && !blocked_segments.contains(&segment.id))
        .filter_map(|segment| {
            let missing_capabilities: BTreeSet<_> = segment
                .required_capabilities
                .difference(&body.capabilities)
                .copied()
                .collect();
            (!missing_capabilities.is_empty()).then(|| SegmentCapabilityGap {
                segment_id: segment.id.clone(),
                missing_capabilities,
            })
        })
        .collect();
    if let Some(capability) = request.destination_capability
        && !body.capabilities.contains(&capability)
    {
        capability_gaps.push(SegmentCapabilityGap {
            segment_id: "destination_task".into(),
            missing_capabilities: BTreeSet::from([capability]),
        });
    }
    CandidateAssessment {
        body_id: body.body_id.clone(),
        place_id: body.place_id.clone(),
        eligible: reasons.is_empty(),
        reasons,
        capability_gaps,
    }
}

fn shortest_hops(
    map: &SemanticMap,
    request: &RouteRequest,
    permits: impl Fn(&RouteSegment) -> bool,
) -> Option<usize> {
    let mut frontier = VecDeque::from([(request.source_place_id.as_str(), 0)]);
    let mut visited = BTreeSet::from([request.source_place_id.as_str()]);
    while let Some((place, hops)) = frontier.pop_front() {
        if place == request.destination_place_id {
            return Some(hops);
        }
        for segment in &map.segments {
            if segment.from == place && permits(segment) && visited.insert(&segment.to) {
                frontier.push_back((&segment.to, hops + 1));
            }
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct SearchKey {
    place: usize,
    body: usize,
    used: u8,
    legs: usize,
}
#[derive(Debug, Clone)]
struct Cost {
    transfers: usize,
    distance: f64,
    tie_break: Vec<String>,
}
impl PartialEq for Cost {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Cost {}
impl PartialOrd for Cost {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Cost {
    fn cmp(&self, other: &Self) -> Ordering {
        self.transfers
            .cmp(&other.transfers)
            .then_with(|| self.distance.total_cmp(&other.distance))
            .then_with(|| self.tie_break.cmp(&other.tie_break))
    }
}
#[derive(Debug, Clone)]
struct SearchEntry {
    key: SearchKey,
    cost: Cost,
    legs: Vec<PlannedLeg>,
    transfers: Vec<PlannedTransfer>,
}
impl PartialEq for SearchEntry {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key && self.cost == other.cost
    }
}
impl Eq for SearchEntry {}
impl PartialOrd for SearchEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for SearchEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .cost
            .cmp(&self.cost)
            .then_with(|| other.key.cmp(&self.key))
    }
}
fn enqueue(
    entry: SearchEntry,
    best: &mut BTreeMap<SearchKey, Cost>,
    frontier: &mut BinaryHeap<SearchEntry>,
) {
    if best.get(&entry.key).is_none_or(|cost| entry.cost < *cost) {
        best.insert(entry.key, entry.cost.clone());
        frontier.push(entry);
    }
}
fn capability_names(capabilities: &BTreeSet<Capability>) -> String {
    capabilities
        .iter()
        .map(|capability| match capability {
            Capability::Navigate => "navigate",
            Capability::Inspect => "inspect",
            Capability::Follow => "follow",
            Capability::Carry => "carry",
            Capability::Stairs => "stairs",
            Capability::Aerial => "aerial",
            Capability::RoughTerrain => "rough_terrain",
        })
        .collect::<Vec<_>>()
        .join(", ")
}
fn validate_id(id: &str) -> Result<(), DomainError> {
    if !(1..=64).contains(&id.len())
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(invalid(
            "semantic identifiers require 1..64 ASCII letters, digits, hyphens or underscores",
        ));
    }
    Ok(())
}
fn invalid(message: &str) -> DomainError {
    DomainError::InvalidCommand(message.into())
}
fn failure(
    code: RouteFailureCode,
    message: &str,
    assessments: Vec<CandidateAssessment>,
) -> RoutePlanningFailure {
    RoutePlanningFailure {
        code,
        message: message.into(),
        assessments,
    }
}
fn invalid_failure(error: DomainError) -> RoutePlanningFailure {
    failure(RouteFailureCode::InvalidInput, &error.to_string(), vec![])
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    fn body(id: &str, place: Option<&str>, capabilities: &[Capability]) -> RouteCandidate {
        RouteCandidate {
            body_id: BodyId::new(id).unwrap(),
            place_id: place.map(str::to_owned),
            capabilities: capabilities.iter().copied().collect(),
            ready: true,
            available: true,
        }
    }
    fn place(id: &str, x: f64, z: f64, transfer_allowed: bool) -> SemanticPlace {
        SemanticPlace {
            id: id.into(),
            label: id.into(),
            pose: RoutePose { x, y: 0.0, z },
            arrival_radius_m: 0.25,
            transfer_allowed,
        }
    }
    fn segment(id: &str, from: &str, to: &str, capabilities: &[Capability]) -> RouteSegment {
        RouteSegment {
            id: id.into(),
            from: from.into(),
            to: to.into(),
            required_capabilities: capabilities.iter().copied().collect(),
            max_speed_mps: 0.2,
            enabled: true,
        }
    }
    fn fixture() -> (SemanticMap, RouteRequest, Vec<RouteCandidate>) {
        let map = SemanticMap {
            id: "stair_lab".into(),
            revision: 1,
            frame_id: "map".into(),
            places: vec![
                place("bay", 0.0, 0.0, false),
                place("stair_foot", 2.0, 0.0, true),
                place("landing", 3.0, 0.4, false),
            ],
            segments: vec![
                segment("approach", "bay", "stair_foot", &[Capability::Navigate]),
                segment(
                    "stairs",
                    "stair_foot",
                    "landing",
                    &[Capability::Navigate, Capability::Stairs],
                ),
            ],
        };
        let request = RouteRequest {
            source_body_id: BodyId::new("rover-a").unwrap(),
            source_place_id: "bay".into(),
            destination_place_id: "landing".into(),
            destination_capability: Some(Capability::Inspect),
        };
        let bodies = vec![
            body(
                "rover-a",
                Some("bay"),
                &[Capability::Navigate, Capability::Inspect],
            ),
            body(
                "quad-b",
                Some("stair_foot"),
                &[
                    Capability::Navigate,
                    Capability::Stairs,
                    Capability::Inspect,
                ],
            ),
        ];
        (map, request, bodies)
    }
    #[test]
    fn rover_cannot_traverse_stairs_and_replacement_must_be_staged() {
        let (map, request, bodies) = fixture();
        let plan = plan_route(&map, &request, &bodies).unwrap();
        assert_eq!(plan.legs.len(), 2);
        assert_eq!(plan.legs[0].body_id.as_str(), "rover-a");
        assert_eq!(plan.legs[1].body_id.as_str(), "quad-b");
        assert_eq!(plan.transfers.len(), 1);
        assert_eq!(plan.transfers[0].before_leg_index, 1);
        assert!(plan.transfers[0].reason.contains("lacks [stairs]"));
        assert_eq!(plan.legs[1].to_pose.z, 0.4);
        assert_eq!(plan.map_digest, map.digest().unwrap());
    }
    #[test]
    fn unknown_wrong_or_unavailable_replacement_never_teleports() {
        let (map, request, mut bodies) = fixture();
        for placement in [None, Some("bay"), Some("not_in_map")] {
            bodies[1].place_id = placement.map(str::to_owned);
            assert!(plan_route(&map, &request, &bodies).is_err());
        }
        bodies[1].place_id = Some("stair_foot".into());
        bodies[1].available = false;
        assert_eq!(
            plan_route(&map, &request, &bodies).unwrap_err().code,
            RouteFailureCode::NoCapableBody
        );
        bodies[1].available = true;
        bodies[1].ready = false;
        assert_eq!(
            plan_route(&map, &request, &bodies).unwrap_err().code,
            RouteFailureCode::NoCapableBody
        );
    }
    #[test]
    fn transfer_permission_and_disabled_routes_are_authoritative() {
        let (mut map, request, bodies) = fixture();
        map.places[1].transfer_allowed = false;
        assert_eq!(
            plan_route(&map, &request, &bodies).unwrap_err().code,
            RouteFailureCode::TransferUnavailable
        );
        map.places[1].transfer_allowed = true;
        map.segments[1].enabled = false;
        assert_eq!(
            plan_route(&map, &request, &bodies).unwrap_err().code,
            RouteFailureCode::BlockedRoute
        );
        map.segments.pop();
        assert_eq!(
            plan_route(&map, &request, &bodies).unwrap_err().code,
            RouteFailureCode::Unreachable
        );
    }
    #[test]
    fn live_closure_selects_a_real_detour_without_changing_signed_map_geometry() {
        let (mut map, request, bodies) = fixture();
        map.places.push(place("detour", -1.0, 0.0, false));
        map.segments.extend([
            segment("detour_out", "bay", "detour", &[Capability::Navigate]),
            segment(
                "detour_back",
                "detour",
                "stair_foot",
                &[Capability::Navigate],
            ),
        ]);
        let original_map = map.clone();
        let baseline = plan_route(&map, &request, &bodies).unwrap();
        assert_eq!(baseline.legs[0].segment_id, "approach");
        let blocked = BTreeSet::from(["approach".into()]);
        let plan = plan_route_with_blocked_segments(&map, &request, &bodies, &blocked).unwrap();
        assert_eq!(
            plan.legs
                .iter()
                .map(|leg| leg.segment_id.as_str())
                .collect::<Vec<_>>(),
            ["detour_out", "detour_back", "stairs"]
        );
        assert_eq!(plan.transfers[0].before_leg_index, 2);
        assert_eq!(plan.map_digest, baseline.map_digest);
        assert_eq!(map, original_map);
        for leg in &plan.legs {
            let traversal =
                crate::RouteTraversal::from_segment(&map, map.segment(&leg.segment_id).unwrap())
                    .unwrap();
            traversal.validate_against(&original_map).unwrap();
        }
        assert!(
            plan.explanation
                .iter()
                .any(|line| line.contains("Excluded segments [approach]"))
        );
        let mut reordered = map.clone();
        reordered.segments.reverse();
        let mut reordered_bodies = bodies.clone();
        reordered_bodies.reverse();
        assert_eq!(
            plan_route_with_blocked_segments(&reordered, &request, &reordered_bodies, &blocked)
                .unwrap(),
            plan
        );
    }
    #[test]
    fn closures_never_reopen_static_edges_or_guess_unknown_conditions() {
        let (mut map, request, bodies) = fixture();
        let blocked = BTreeSet::from(["approach".into()]);
        assert_eq!(
            plan_route_with_blocked_segments(&map, &request, &bodies, &blocked)
                .unwrap_err()
                .code,
            RouteFailureCode::BlockedRoute
        );
        map.segments[1].enabled = false;
        assert_eq!(
            plan_route_with_blocked_segments(&map, &request, &bodies, &BTreeSet::new())
                .unwrap_err()
                .code,
            RouteFailureCode::BlockedRoute
        );
        for invalid in [
            BTreeSet::from(["unknown".into()]),
            (0..33).map(|i| format!("segment_{i}")).collect(),
        ] {
            assert_eq!(
                plan_route_with_blocked_segments(&map, &request, &bodies, &invalid)
                    .unwrap_err()
                    .code,
                RouteFailureCode::InvalidInput
            );
        }
    }
    #[test]
    fn a_live_detour_still_requires_localized_capable_staged_bodies() {
        let (mut map, mut request, mut bodies) = fixture();
        // The remaining objective begins at a verified transfer place; completed
        // approach work is absent from the returned suffix, never replayed.
        request.source_place_id = "stair_foot".into();
        bodies[0].place_id = Some("stair_foot".into());
        let blocked = BTreeSet::from(["approach".into()]);
        let plan = plan_route_with_blocked_segments(&map, &request, &bodies, &blocked).unwrap();
        assert_eq!(plan.legs.len(), 1);
        assert_eq!(plan.legs[0].segment_id, "stairs");
        assert_eq!(plan.transfers[0].before_leg_index, 0);
        bodies[1].place_id = Some("bay".into());
        assert_eq!(
            plan_route_with_blocked_segments(&map, &request, &bodies, &blocked)
                .unwrap_err()
                .code,
            RouteFailureCode::TransferUnavailable
        );
        bodies[0].place_id = None;
        assert_eq!(
            plan_route_with_blocked_segments(&map, &request, &bodies, &blocked)
                .unwrap_err()
                .code,
            RouteFailureCode::SourceUnavailable
        );
        bodies[0].place_id = Some("stair_foot".into());
        bodies[1].place_id = Some("stair_foot".into());
        map.segments[1]
            .required_capabilities
            .insert(Capability::RoughTerrain);
        assert_eq!(
            plan_route_with_blocked_segments(&map, &request, &bodies, &blocked)
                .unwrap_err()
                .code,
            RouteFailureCode::NoCapableBody
        );
    }
    #[test]
    fn missing_source_or_wrong_source_placement_is_not_assumed() {
        let (map, request, mut bodies) = fixture();
        bodies[0].place_id = Some("stair_foot".into());
        assert_eq!(
            plan_route(&map, &request, &bodies).unwrap_err().code,
            RouteFailureCode::SourceUnavailable
        );
        bodies.remove(0);
        assert_eq!(
            plan_route(&map, &request, &bodies).unwrap_err().code,
            RouteFailureCode::SourceUnavailable
        );
    }
    #[test]
    fn destination_task_capability_is_required_in_addition_to_mobility() {
        let (map, request, mut bodies) = fixture();
        bodies[1].capabilities.remove(&Capability::Inspect);
        assert_eq!(
            plan_route(&map, &request, &bodies).unwrap_err().code,
            RouteFailureCode::TransferUnavailable
        );
        let mut route_only = request;
        route_only.destination_capability = None;
        assert!(plan_route(&map, &route_only, &bodies).is_ok());
    }
    #[test]
    fn a_destination_transfer_keeps_the_final_task_owner_explicit() {
        let (mut map, request, mut bodies) = fixture();
        map.places[2].transfer_allowed = true;
        bodies[1].capabilities.remove(&Capability::Inspect);
        bodies.push(body("camera-c", Some("landing"), &[Capability::Inspect]));
        let plan = plan_route(&map, &request, &bodies).unwrap();
        assert_eq!(plan.legs.last().unwrap().body_id.as_str(), "quad-b");
        assert_eq!(plan.destination_body_id.as_str(), "camera-c");
        assert_eq!(plan.transfers.last().unwrap().before_leg_index, 2);
        assert!(
            plan.transfers
                .last()
                .unwrap()
                .reason
                .contains("lacks [inspect]")
        );
    }
    #[test]
    fn canonical_map_and_plan_ignore_collection_order() {
        let (mut map, request, mut bodies) = fixture();
        bodies.push(body(
            "quad-c",
            Some("stair_foot"),
            &[
                Capability::Navigate,
                Capability::Stairs,
                Capability::Inspect,
            ],
        ));
        let original = plan_route(&map, &request, &bodies).unwrap();
        let digest = map.digest().unwrap();
        map.places.reverse();
        map.segments.reverse();
        bodies.reverse();
        assert_eq!(map.digest().unwrap(), digest);
        assert_eq!(plan_route(&map, &request, &bodies).unwrap(), original);
        assert_eq!(original.legs[1].body_id.as_str(), "quad-b");
        map.segments[0].max_speed_mps = 0.1;
        assert_ne!(map.digest().unwrap(), digest);
    }
    #[test]
    fn fewer_transfers_precede_distance_and_distance_breaks_equal_transfer_cost() {
        let (mut map, request, bodies) = fixture();
        map.places.push(place("ramp_detour", 8.0, 0.2, false));
        map.segments.push(segment(
            "ramp_out",
            "bay",
            "ramp_detour",
            &[Capability::Navigate],
        ));
        map.segments.push(segment(
            "ramp_back",
            "ramp_detour",
            "landing",
            &[Capability::Navigate],
        ));
        let plan = plan_route(&map, &request, &bodies).unwrap();
        assert!(plan.transfers.is_empty());
        assert_eq!(plan.legs[0].segment_id, "ramp_out");
        map.segments.push(segment(
            "direct_flat",
            "bay",
            "landing",
            &[Capability::Navigate],
        ));
        let plan = plan_route(&map, &request, &bodies).unwrap();
        assert_eq!(plan.legs.len(), 1);
        assert_eq!(plan.legs[0].segment_id, "direct_flat");
    }
    #[test]
    fn every_valid_segment_can_be_frozen_as_an_executable_mobility_command() {
        let (mut map, request, bodies) = fixture();
        for capabilities in [
            vec![],
            vec![Capability::Stairs],
            vec![Capability::Navigate, Capability::Inspect],
            vec![Capability::Navigate, Capability::Aerial],
        ] {
            map.segments[0].required_capabilities = capabilities.into_iter().collect();
            assert_eq!(
                plan_route(&map, &request, &bodies).unwrap_err().code,
                RouteFailureCode::InvalidInput
            );
        }
        for capabilities in [
            vec![Capability::Navigate],
            vec![Capability::Navigate, Capability::Stairs],
            vec![Capability::Navigate, Capability::RoughTerrain],
            vec![
                Capability::Navigate,
                Capability::Stairs,
                Capability::RoughTerrain,
            ],
        ] {
            map.segments[0].required_capabilities = capabilities.into_iter().collect();
            map.validate().unwrap();
            for segment in &map.segments {
                crate::RouteTraversal::from_segment(&map, segment).unwrap();
            }
        }
    }
    #[test]
    fn rejects_malformed_geometry_graph_ids_and_fleet_bounds() {
        let (mut map, request, mut bodies) = fixture();
        map.places[0].pose.z = f64::NAN;
        assert_eq!(
            plan_route(&map, &request, &bodies).unwrap_err().code,
            RouteFailureCode::InvalidInput
        );
        map.places[0].pose.z = 0.0;
        map.segments[0].from = "missing".into();
        assert!(map.validate().is_err());
        map.segments[0].from = "bay".into();
        map.id = "../escape".into();
        assert!(map.validate().is_err());
        map.id = "stair_lab".into();
        bodies.push(bodies[0].clone());
        assert_eq!(
            plan_route(&map, &request, &bodies).unwrap_err().code,
            RouteFailureCode::InvalidInput
        );
    }
    #[test]
    fn cycles_do_not_duplicate_finished_legs_and_leg_limit_refuses_partial_plan() {
        let (mut map, request, bodies) = fixture();
        map.segments.push(segment(
            "return_loop",
            "stair_foot",
            "bay",
            &[Capability::Navigate],
        ));
        let plan = plan_route(&map, &request, &bodies).unwrap();
        assert_eq!(plan.legs.len(), 2);
        assert_eq!(plan.transfers.len(), 1);
        let places = (0..14)
            .map(|i| place(&format!("place_{i}"), f64::from(i), 0.0, false))
            .collect();
        let segments = (0..13)
            .map(|i| {
                segment(
                    &format!("segment_{i}"),
                    &format!("place_{i}"),
                    &format!("place_{}", i + 1),
                    &[Capability::Navigate],
                )
            })
            .collect();
        let map = SemanticMap {
            id: "long_route".into(),
            revision: 1,
            frame_id: "map".into(),
            places,
            segments,
        };
        let mut request = request;
        request.source_place_id = "place_0".into();
        request.destination_place_id = "place_13".into();
        let mut rover = bodies[0].clone();
        rover.place_id = Some("place_0".into());
        assert_eq!(
            plan_route(&map, &request, &[rover]).unwrap_err().code,
            RouteFailureCode::SearchLimit
        );
    }
}
