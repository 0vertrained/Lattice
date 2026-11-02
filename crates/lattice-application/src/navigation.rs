//! Frozen deterministic route plans, grounded in the configured map and current bodies.
use crate::{ApplicationError, InspectionRound, LatticeService, RoundStep};
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use lattice_domain::{
    AuditActor, AuditRecord, BodyId, BodyKind, BodySnapshot, BodyStatus, Capability, Mission,
    MissionId, MissionStatus, RouteTraversal, SkillCommand,
    navigation::{
        RouteCandidate, RouteFailureCode, RoutePlan, RoutePlanningFailure, RouteRequest,
        SemanticMap, SemanticPlace, plan_route_with_blocked_segments,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// A bounded route objective; the caller never supplies the map or executable legs.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteObjectiveRequest {
    /// Starting body and named endpoints in the configured semantic map.
    pub route: RouteRequest,
    /// Preserve a source observation before departure.
    pub inspect_source: bool,
    /// Capture a new observation at the destination.
    pub inspect_destination: bool,
}

/// Immutable planner output and executable suffix, with a separate approval outcome.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RoutePlanProposal {
    /// Stable review identity.
    pub id: String,
    /// Digest of the complete frozen snapshot.
    pub digest: String,
    /// Original bounded objective.
    pub request: RouteObjectiveRequest,
    /// Grounded deterministic plan, absent when planning refused the request.
    pub plan: Option<RoutePlan>,
    /// Structured reason for refusal; blocked plans cannot be approved.
    pub failure: Option<RoutePlanningFailure>,
    /// Exact commands frozen for operator review.
    pub steps: Vec<RoundStep>,
    /// Planned body for every step, including inspection steps.
    pub step_body_ids: Vec<BodyId>,
    /// Proposal timestamp.
    pub created_at: DateTime<Utc>,
    /// Approval deadline.
    pub expires_at: DateTime<Utc>,
    /// pending, blocked, approved, invalidated.
    pub status: String,
    /// Approved execution round, created once.
    pub round_id: Option<String>,
    /// Frozen live-condition context; absent on pre-adaptive reviews.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive: Option<crate::AdaptiveRouteContext>,
}
impl RoutePlanProposal {
    pub(crate) fn computed_digest(&self) -> Result<String, ApplicationError> {
        let legacy = serde_json::to_vec(&(
            &self.id,
            &self.request,
            &self.plan,
            &self.failure,
            &self.steps,
            &self.step_body_ids,
            self.created_at,
            self.expires_at,
        ))
        .map_err(|_| ApplicationError::Infrastructure)?;
        // Preserve existing persisted review digests byte-for-byte.
        let bytes = match &self.adaptive {
            Some(context) => serde_json::to_vec(&(legacy, context)),
            None => Ok(legacy),
        }
        .map_err(|_| ApplicationError::Infrastructure)?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
}

/// A read-only recommendation. Creating and approving the handoff remain explicit actions.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RouteTransferOptions {
    /// Current round identity.
    pub round_id: String,
    /// Governing frozen route proposal, absent on legacy rounds.
    pub route_plan_id: Option<String>,
    /// Current step cursor.
    pub current_step: usize,
    /// Whether this step requires the approved body transition.
    pub required: bool,
    /// Body that completed the preceding work.
    pub source_body_id: Option<BodyId>,
    /// Only replacement allowed by this route review.
    pub recommended_target_body_id: Option<BodyId>,
    /// Reviewed, map-defined transfer location.
    pub transfer_place_id: Option<String>,
    /// Explanation of why another body is needed.
    pub reason: String,
    /// Current readiness of this recommendation; approval rechecks it.
    pub ready: bool,
    /// Reasons the recommendation cannot be prepared right now.
    pub blocking_reasons: Vec<String>,
    /// Immutable trusted-map digest.
    pub map_digest: Option<String>,
}

/// Transaction-scoped persistence for deterministic route reviews.
#[async_trait]
pub trait RoutePlanRepository: Send + Sync {
    /// Stores a frozen snapshot and mutable approval outcome.
    async fn save_route_plan(&self, proposal: RoutePlanProposal) -> Result<(), ApplicationError>;
    /// Finds a route review.
    async fn get_route_plan(&self, id: &str)
    -> Result<Option<RoutePlanProposal>, ApplicationError>;
    /// Lists route review history.
    async fn list_route_plans(&self) -> Result<Vec<RoutePlanProposal>, ApplicationError>;
}

impl LatticeService {
    /// Returns the trusted server-configured map; no browser-write endpoint exists.
    pub fn navigation_map(&self) -> Result<SemanticMap, ApplicationError> {
        let map = self
            .navigation_map
            .as_ref()
            .ok_or_else(|| conflict("capability routes require a configured semantic map"))?;
        map.validate()?;
        Ok((**map).clone())
    }

    /// Lists retained ready and blocked route proposals.
    pub async fn list_route_plans(&self) -> Result<Vec<RoutePlanProposal>, ApplicationError> {
        let mut plans = self.route_store()?.list_route_plans().await?;
        plans.sort_by_key(|plan| std::cmp::Reverse(plan.created_at));
        Ok(plans)
    }

    /// Produces an explainable frozen route proposal without dispatching a command.
    pub async fn propose_route_plan(
        &self,
        mut request: RouteObjectiveRequest,
    ) -> Result<RoutePlanProposal, ApplicationError> {
        if request
            .route
            .destination_capability
            .is_some_and(|capability| {
                !request.inspect_destination || capability != Capability::Inspect
            })
        {
            return Err(conflict(
                "destination capability must match the requested destination inspection",
            ));
        }
        let map = self.navigation_map()?;
        if request.inspect_destination {
            request.route.destination_capability = Some(Capability::Inspect);
        }
        let candidates = self
            .route_candidates(&map, &request.route.source_body_id)
            .await?;
        let conditions = self.route_conditions().await?;
        let result = plan_route_with_blocked_segments(
            &map,
            &request.route,
            &candidates,
            &conditions.blocked_segment_ids.iter().cloned().collect(),
        );
        let (mut plan, mut failure) = match result {
            Ok(plan) => (Some(plan), None),
            Err(error) => (None, Some(error)),
        };
        if plan.is_some()
            && request.inspect_source
            && !candidates.iter().any(|candidate| {
                candidate.body_id == request.route.source_body_id
                    && candidate.capabilities.contains(&Capability::Inspect)
            })
        {
            failure = Some(RoutePlanningFailure {
                code: RouteFailureCode::NoCapableBody,
                message: "Starting body cannot inspect the source station.".into(),
                assessments: plan
                    .as_ref()
                    .map(|p| p.assessments.clone())
                    .unwrap_or_default(),
            });
            plan = None;
        }
        let mut steps = Vec::new();
        let mut bodies = Vec::new();
        if let Some(plan) = &plan {
            if request.inspect_source {
                steps.push(inspection_step(&map, &request.route.source_place_id)?);
                bodies.push(request.route.source_body_id.clone());
            }
            for leg in &plan.legs {
                let segment = map
                    .segment(&leg.segment_id)
                    .ok_or(ApplicationError::Infrastructure)?;
                let traversal = RouteTraversal::from_segment(&map, segment)?;
                steps.push(RoundStep {
                    title: format!("Traverse {} to {}", segment.from, segment.to),
                    command: SkillCommand::TraverseRoute { traversal },
                    continue_on_missing_marker: false,
                });
                bodies.push(leg.body_id.clone());
            }
            if request.inspect_destination {
                steps.push(inspection_step(&map, &request.route.destination_place_id)?);
                bodies.push(plan.destination_body_id.clone());
            }
            if !(2..=6).contains(&steps.len()) {
                return Err(conflict(
                    "route objective must produce two to six bounded steps",
                ));
            }
            for step in &steps {
                Mission::new(
                    MissionId::new("route-validation")?,
                    &step.title,
                    step.command.clone(),
                    self.clock.now(),
                )?;
            }
        }
        let now = self.clock.now();
        let mut proposal = RoutePlanProposal {
            id: format!("route-plan-{}", uuid::Uuid::new_v4().simple()),
            digest: String::new(),
            request,
            plan,
            failure,
            steps,
            step_body_ids: bodies,
            created_at: now,
            expires_at: now + Duration::minutes(5),
            status: "pending".into(),
            round_id: None,
            adaptive: Some(crate::AdaptiveRouteContext {
                conditions_revision: conditions.revision,
                blocked_segment_ids: conditions.blocked_segment_ids,
                step_offset: 0,
                parent_plan_id: None,
            }),
        };
        if proposal.failure.is_some() {
            proposal.status = "blocked".into();
        }
        proposal.digest = proposal.computed_digest()?;
        self.route_store()?
            .save_route_plan(proposal.clone())
            .await?;
        self.route_audit(
            &proposal,
            "route_plan.proposed",
            AuditActor::Service("route-planner".into()),
        )
        .await?;
        Ok(proposal)
    }

    /// Approves one immutable map/route/body assignment snapshot and creates its round once.
    pub async fn approve_route_plan(
        &self,
        id: &str,
        digest: &str,
        actor: AuditActor,
    ) -> Result<InspectionRound, ApplicationError> {
        let _reservation = self.approval_lock.lock().await;
        let mut proposal =
            self.route_store()?
                .get_route_plan(id)
                .await?
                .ok_or(ApplicationError::NotFound {
                    entity: "route plan",
                })?;
        if proposal.digest != digest || proposal.computed_digest()? != digest {
            return Err(conflict("route plan digest mismatch"));
        }
        if let Some(round_id) = &proposal.round_id {
            return self
                .round_store()?
                .get(round_id)
                .await?
                .ok_or(ApplicationError::NotFound { entity: "round" });
        }
        if proposal.status != "pending"
            || self.clock.now() >= proposal.expires_at
            || proposal.failure.is_some()
        {
            return Err(conflict(
                "route plan is not pending, executable and current",
            ));
        }
        let map = self.validate_route_snapshot(&proposal)?;
        self.validate_route_conditions_review(&proposal).await?;
        let plan = proposal.plan.as_ref().ok_or(ApplicationError::Security)?;
        let candidates = self.route_candidates(&map, &plan.source_body_id).await?;
        for (index, body_id) in proposal.step_body_ids.iter().enumerate() {
            if !self
                .body_available(body_id, &proposal.steps[index].command)
                .await?
            {
                return Err(conflict(
                    "a planned body is no longer fresh, capable, unfenced and idle",
                ));
            }
        }
        let source = candidates
            .iter()
            .find(|body| body.body_id == plan.source_body_id)
            .ok_or_else(|| conflict("planned source is unavailable"))?;
        if !source.ready
            || !source.available
            || source.place_id.as_deref() != Some(plan.source_place_id.as_str())
        {
            return Err(conflict(
                "source must remain fresh, ready, unfenced and idle at the reviewed starting place",
            ));
        }
        for transfer in &plan.transfers {
            let target = candidates
                .iter()
                .find(|body| body.body_id == transfer.target_body_id)
                .ok_or_else(|| conflict("planned transfer target is unavailable"))?;
            if !target.ready
                || !target.available
                || target.place_id.as_deref() != Some(transfer.place_id.as_str())
            {
                return Err(conflict(
                    "planned target is not staged and ready at its transfer place",
                ));
            }
        }
        if self
            .list_rounds()
            .await?
            .iter()
            .any(|round| matches!(round.status.as_str(), "active" | "recovery_required"))
        {
            return Err(conflict("finish or recover the active round first"));
        }
        let now = self.clock.now();
        let round_id = format!("round-{}", uuid::Uuid::new_v4().simple());
        let round_digest = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    &round_id,
                    &proposal.id,
                    &proposal.digest,
                    &proposal.steps,
                    &proposal.step_body_ids
                ))
                .map_err(|_| ApplicationError::Infrastructure)?
            )
        );
        let mut round = InspectionRound {
            id: round_id.clone(),
            digest: round_digest,
            steps: proposal.steps.clone(),
            created_at: now,
            expires_at: proposal.expires_at,
            status: "active".into(),
            approved_by: Some(actor.clone()),
            approved_at: Some(now),
            current_step: 0,
            current_mission_id: None,
            mission_ids: vec![],
            anomaly_count: 0,
            assigned_body_id: Some(plan.source_body_id.clone()),
            continuation: None,
            route_plan_id: Some(proposal.id.clone()),
        };
        proposal.status = "approved".into();
        proposal.round_id = Some(round_id);
        self.route_store()?
            .save_route_plan(proposal.clone())
            .await?;
        self.dispatch_round_step(&mut round).await?;
        self.route_audit(&proposal, "route_plan.approved", actor)
            .await?;
        Ok(round)
    }

    /// Explains the next required body transition without pausing or approving anything.
    pub async fn route_transfer_options(
        &self,
        round_id: &str,
    ) -> Result<RouteTransferOptions, ApplicationError> {
        let round = self
            .round_store()?
            .get(round_id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "round" })?;
        let mut options = RouteTransferOptions {
            round_id: round.id.clone(),
            route_plan_id: round.route_plan_id.clone(),
            current_step: round.current_step,
            required: false,
            source_body_id: round.assigned_body_id.clone(),
            recommended_target_body_id: None,
            transfer_place_id: None,
            reason: "This round has no required capability transfer at its current step.".into(),
            ready: false,
            blocking_reasons: vec![],
            map_digest: None,
        };
        let Some(plan_id) = &round.route_plan_id else {
            return Ok(options);
        };
        let proposal = self
            .route_store()?
            .get_route_plan(plan_id)
            .await?
            .ok_or(ApplicationError::Security)?;
        let plan = proposal.plan.as_ref().ok_or(ApplicationError::Security)?;
        options.map_digest = Some(plan.map_digest.clone());
        let Some(target) = proposal.step_body_ids.get(round.current_step) else {
            return Ok(options);
        };
        if round.assigned_body_id.as_ref() == Some(target) {
            return Ok(options);
        }
        options.required = true;
        options.recommended_target_body_id = Some(target.clone());
        let leg_index = round
            .current_step
            .checked_sub(proposal.adaptive.as_ref().map_or(0, |c| c.step_offset))
            .ok_or(ApplicationError::Security)?
            .checked_sub(usize::from(proposal.request.inspect_source))
            .ok_or(ApplicationError::Security)?;
        let transfer = plan
            .transfers
            .iter()
            .find(|transfer| {
                transfer.before_leg_index == leg_index && &transfer.target_body_id == target
            })
            .ok_or(ApplicationError::Security)?;
        options.transfer_place_id = Some(transfer.place_id.clone());
        options.reason = transfer.reason.clone();
        if let Err(error) = self.validate_route_transfer(&round, target).await {
            options.blocking_reasons.push(safe_reason(error));
        }
        options.ready = options.blocking_reasons.is_empty() && round.status == "recovery_required";
        if round.status != "recovery_required" {
            options
                .blocking_reasons
                .push("Round must be held at the transfer step before review.".into());
        }
        Ok(options)
    }

    pub(crate) async fn planned_route_body(
        &self,
        round: &InspectionRound,
    ) -> Result<Option<BodyId>, ApplicationError> {
        let Some(id) = &round.route_plan_id else {
            return Ok(None);
        };
        let proposal = self
            .route_store()?
            .get_route_plan(id)
            .await?
            .ok_or(ApplicationError::Security)?;
        self.validate_route_snapshot(&proposal)?;
        if proposal.status != "approved"
            || proposal.round_id.as_ref() != Some(&round.id)
            || proposal.steps != round.steps
        {
            return Err(ApplicationError::Security);
        }
        let body_id = proposal
            .step_body_ids
            .get(round.current_step)
            .cloned()
            .ok_or(ApplicationError::Security)?;
        self.validate_live_route_command(&round.steps[round.current_step].command)
            .await?;
        if round.assigned_body_id.as_ref() == Some(&body_id) {
            let body = self
                .bodies
                .get(&body_id)
                .await?
                .ok_or_else(|| conflict("planned body is unavailable"))?;
            let command = &round.steps[round.current_step].command;
            let place_id = match command {
                SkillCommand::TraverseRoute { traversal } => &traversal.from.id,
                SkillCommand::Inspect { location } => location,
                _ => return Err(ApplicationError::Security),
            };
            let map = self.navigation_map()?;
            let place = map.place(place_id).ok_or(ApplicationError::Security)?;
            if !self.body_pose_is_fresh(&body) || !at_place(&body, place) {
                return Err(conflict(
                    "planned body must be localized at the reviewed step's starting place",
                ));
            }
        }
        Ok(Some(body_id))
    }

    pub(crate) async fn handoff_target_steps(
        &self,
        round: &InspectionRound,
        target: &BodyId,
    ) -> Result<Vec<RoundStep>, ApplicationError> {
        let Some(id) = &round.route_plan_id else {
            return Ok(round.steps[round.current_step..].to_vec());
        };
        let proposal = self
            .route_store()?
            .get_route_plan(id)
            .await?
            .ok_or(ApplicationError::Security)?;
        self.validate_route_snapshot(&proposal)?;
        Ok(proposal
            .steps
            .into_iter()
            .zip(proposal.step_body_ids)
            .skip(round.current_step)
            .take_while(|(_, body)| body == target)
            .map(|(step, _)| step)
            .collect())
    }

    pub(crate) async fn validate_route_transfer(
        &self,
        round: &InspectionRound,
        target: &BodyId,
    ) -> Result<(), ApplicationError> {
        let Some(id) = &round.route_plan_id else {
            return Ok(());
        };
        let proposal = self
            .route_store()?
            .get_route_plan(id)
            .await?
            .ok_or(ApplicationError::Security)?;
        let map = self.validate_route_snapshot(&proposal)?;
        for step in &round.steps[round.current_step..] {
            self.validate_live_route_command(&step.command).await?;
        }
        if proposal.round_id.as_ref() != Some(&round.id)
            || proposal.status != "approved"
            || proposal.steps != round.steps
        {
            return Err(ApplicationError::Security);
        }
        if proposal.step_body_ids.get(round.current_step) != Some(target)
            || round.assigned_body_id.as_ref() == Some(target)
        {
            return Err(conflict(
                "handoff target does not match the reviewed route transition",
            ));
        }
        let plan = proposal.plan.as_ref().ok_or(ApplicationError::Security)?;
        let index = round
            .current_step
            .checked_sub(proposal.adaptive.as_ref().map_or(0, |c| c.step_offset))
            .ok_or(ApplicationError::Security)?
            .checked_sub(usize::from(proposal.request.inspect_source))
            .ok_or(ApplicationError::Security)?;
        let transfer = plan
            .transfers
            .iter()
            .find(|transfer| {
                transfer.before_leg_index == index
                    && &transfer.target_body_id == target
                    && round.assigned_body_id.as_ref() == Some(&transfer.source_body_id)
            })
            .ok_or_else(|| {
                conflict("route handoff is allowed only at its reviewed transfer step")
            })?;
        let place = map
            .place(&transfer.place_id)
            .ok_or(ApplicationError::Security)?;
        if !place.transfer_allowed {
            return Err(conflict("this place no longer permits transfer"));
        }
        for body_id in [&transfer.source_body_id, target] {
            let body = self
                .bodies
                .get(body_id)
                .await?
                .ok_or_else(|| conflict("transfer body is unavailable"))?;
            if !self.body_pose_is_fresh(&body) || !at_place(&body, place) {
                return Err(conflict(
                    "both bodies must have fresh poses at the reviewed transfer place",
                ));
            }
            if self.missions.list().await?.iter().any(|mission| {
                mission.assigned_body_id.as_ref() == Some(body_id)
                    && matches!(
                        mission.status,
                        MissionStatus::Assigned | MissionStatus::Running
                    )
            }) {
                return Err(conflict("a transfer body is executing another command"));
            }
        }
        for (step, planned) in proposal
            .steps
            .iter()
            .zip(&proposal.step_body_ids)
            .skip(round.current_step)
        {
            if planned != target {
                break;
            }
            if !self.body_available(target, &step.command).await? {
                return Err(conflict(
                    "planned target is no longer ready for its reviewed route steps",
                ));
            }
        }
        Ok(())
    }

    pub(crate) async fn validate_route_recovery(
        &self,
        original: &Mission,
        command: &SkillCommand,
    ) -> Result<bool, ApplicationError> {
        let Some(rounds) = &self.rounds else {
            return Ok(false);
        };
        let Some(round) = rounds.list().await?.into_iter().find(|round| {
            round.current_mission_id.as_ref() == Some(&original.id) && round.route_plan_id.is_some()
        }) else {
            return Ok(false);
        };
        let proposal = self
            .route_store()?
            .get_route_plan(
                round
                    .route_plan_id
                    .as_ref()
                    .ok_or(ApplicationError::Security)?,
            )
            .await?
            .ok_or(ApplicationError::Security)?;
        if self
            .validate_route_conditions_review(&proposal)
            .await
            .is_err()
        {
            return Err(conflict(
                "route conditions changed; prepare a remaining-work replan instead of generic recovery",
            ));
        }
        let planned = self
            .planned_route_body(&round)
            .await?
            .ok_or(ApplicationError::Security)?;
        if original.assigned_body_id.as_ref() != Some(&planned) {
            return Err(conflict(
                "this step requires the reviewed body transfer, not same-body recovery",
            ));
        }
        if &round.steps[round.current_step].command != command || &original.command != command {
            return Err(ApplicationError::Security);
        }
        self.validate_route_command(command)?;
        Ok(true)
    }

    pub(crate) fn validate_route_command(
        &self,
        command: &SkillCommand,
    ) -> Result<(), ApplicationError> {
        let map = self.navigation_map()?;
        match command {
            SkillCommand::TraverseRoute { traversal } => {
                let segment = map
                    .segment(&traversal.segment_id)
                    .ok_or_else(|| conflict("route segment is no longer configured"))?;
                if !segment.enabled || RouteTraversal::from_segment(&map, segment)? != *traversal {
                    return Err(conflict("route segment or map changed after review"));
                }
            }
            SkillCommand::Inspect { location } if map.place(location).is_some() => {}
            _ => {
                return Err(conflict(
                    "command is not part of the configured route policy",
                ));
            }
        }
        command.validate()?;
        Ok(())
    }

    pub(crate) fn validate_route_snapshot(
        &self,
        proposal: &RoutePlanProposal,
    ) -> Result<SemanticMap, ApplicationError> {
        if proposal.computed_digest()? != proposal.digest
            || proposal.steps.len() != proposal.step_body_ids.len()
        {
            return Err(ApplicationError::Security);
        }
        let map = self.navigation_map()?;
        let plan = proposal.plan.as_ref().ok_or(ApplicationError::Security)?;
        if plan.map_id != map.id
            || plan.map_revision != map.revision
            || plan.map_digest != map.digest()?
        {
            return Err(conflict("semantic map changed; review a new route plan"));
        }
        for step in &proposal.steps {
            self.validate_route_command(&step.command)?;
        }
        Ok(map)
    }

    pub(crate) async fn route_candidates(
        &self,
        map: &SemanticMap,
        source: &BodyId,
    ) -> Result<Vec<RouteCandidate>, ApplicationError> {
        let missions = self.missions.list().await?;
        let mut rows = self.bodies.list().await?;
        rows.sort_by_key(|body| {
            (
                body.id != *source,
                std::cmp::Reverse(body.last_seen),
                body.id.clone(),
            )
        });
        let mut candidates = Vec::new();
        for body in rows {
            let place_id = if self.body_pose_is_fresh(&body) {
                let mut matches = map.places.iter().filter(|place| at_place(&body, place));
                let first = matches.next();
                if matches.next().is_none() {
                    first.map(|place| place.id.clone())
                } else {
                    None
                }
            } else {
                None
            };
            let ready = body.status == BodyStatus::Online
                && body.battery.value() >= 15
                && self.body_pose_is_fresh(&body);
            if body.id != *source && !ready && place_id.is_none() {
                continue;
            }
            let mut available = !missions.iter().any(|mission| {
                mission.assigned_body_id.as_ref() == Some(&body.id)
                    && matches!(
                        mission.status,
                        MissionStatus::Assigned | MissionStatus::Running
                    )
            });
            if let Some(handoffs) = &self.handoffs {
                available &= !handoffs
                    .body_fence(&body.id)
                    .await?
                    .is_some_and(|until| self.clock.now() < until);
            }
            candidates.push(RouteCandidate {
                body_id: body.id,
                place_id,
                capabilities: body.capabilities,
                ready,
                available,
            });
        }
        Ok(candidates)
    }

    pub(crate) fn body_pose_is_fresh(&self, body: &BodySnapshot) -> bool {
        let now = self.clock.now();
        body.pose.is_some()
            && body.last_seen <= now
            && now
                .signed_duration_since(body.last_seen)
                .to_std()
                .is_ok_and(|age| age <= self.config.heartbeat_timeout)
    }
    pub(crate) fn route_store(&self) -> Result<&Arc<dyn RoutePlanRepository>, ApplicationError> {
        self.route_plans
            .as_ref()
            .ok_or_else(|| conflict("capability route plans require durable storage"))
    }
    async fn route_audit(
        &self,
        proposal: &RoutePlanProposal,
        event: &str,
        actor: AuditActor,
    ) -> Result<(), ApplicationError> {
        self.audit
            .append(AuditRecord {
                occurred_at: self.clock.now(),
                actor,
                event_type: event.into(),
                object_id: proposal.id.clone(),
                metadata: json!({
                    "digest": proposal.digest,
                    "status": proposal.status,
                    "map_digest": proposal.plan.as_ref().map(|plan| &plan.map_digest),
                    "round_id": proposal.round_id,
                    "failure": proposal.failure,
                }),
            })
            .await
    }
}
fn at_place(body: &BodySnapshot, place: &SemanticPlace) -> bool {
    let Some(pose) = body.pose else {
        return false;
    };
    let z = match (pose.z, body.kind) {
        (Some(z), _) => z,
        (None, BodyKind::Rover) => 0.0,
        _ => return false,
    };
    ((pose.x - place.pose.x).powi(2) + (pose.y - place.pose.y).powi(2) + (z - place.pose.z).powi(2))
        .sqrt()
        <= place.arrival_radius_m
}
pub(crate) fn inspection_step(map: &SemanticMap, id: &str) -> Result<RoundStep, ApplicationError> {
    let place = map
        .place(id)
        .ok_or_else(|| conflict("unknown inspection place"))?;
    Ok(RoundStep {
        title: format!("Inspect {}", place.label),
        command: SkillCommand::Inspect {
            location: id.into(),
        },
        continue_on_missing_marker: false,
    })
}
fn conflict(message: &str) -> ApplicationError {
    ApplicationError::Conflict(message.into())
}
fn safe_reason(error: ApplicationError) -> String {
    match error {
        ApplicationError::Conflict(message) => message,
        _ => "Route snapshot or required state is unavailable; request a fresh review.".into(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn legacy_route_review_digest_stays_valid_without_adaptive_context() {
        let now = DateTime::from_timestamp(1_800_000_000, 0).unwrap();
        let mut review = RoutePlanProposal {
            id: "legacy-route".into(),
            digest: String::new(),
            request: RouteObjectiveRequest {
                route: RouteRequest {
                    source_body_id: BodyId::new("rover").unwrap(),
                    source_place_id: "bay".into(),
                    destination_place_id: "upper".into(),
                    destination_capability: Some(Capability::Inspect),
                },
                inspect_source: true,
                inspect_destination: true,
            },
            plan: None,
            failure: None,
            steps: vec![],
            step_body_ids: vec![],
            created_at: now,
            expires_at: now + Duration::minutes(5),
            status: "pending".into(),
            round_id: None,
            adaptive: None,
        };
        let original_bytes = serde_json::to_vec(&(
            &review.id,
            &review.request,
            &review.plan,
            &review.failure,
            &review.steps,
            &review.step_body_ids,
            review.created_at,
            review.expires_at,
        ))
        .unwrap();
        let original_digest = format!("{:x}", Sha256::digest(original_bytes));
        assert_eq!(review.computed_digest().unwrap(), original_digest);
        assert!(!serde_json::to_string(&review).unwrap().contains("adaptive"));
        review.adaptive = Some(crate::AdaptiveRouteContext {
            conditions_revision: 1,
            blocked_segment_ids: vec!["closed-aisle".into()],
            step_offset: 0,
            parent_plan_id: None,
        });
        assert_ne!(review.computed_digest().unwrap(), original_digest);
    }
}
