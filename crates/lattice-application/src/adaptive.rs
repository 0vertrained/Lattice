//! Durable route observations and explicitly reviewed remaining-work replanning.
use crate::{
    ApplicationError, InspectionRound, LatticeService, RoundStep, RouteObjectiveRequest,
    RoutePlanProposal,
};
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use lattice_domain::{
    AuditActor, AuditRecord, BodyId, BodyPose, BodyStatus, CommandId, Mission, MissionId,
    MissionStatus, RouteTraversal, SkillCommand,
    navigation::{
        RouteFailureCode, RoutePlan, RoutePlanningFailure, RouteRequest,
        plan_route_with_blocked_segments,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc};

/// A durable route condition; clearing requires a new explicit observation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteConditionStatus {
    /// The segment is excluded from planning and execution.
    Blocked,
    /// An operator has explicitly cleared the reported exclusion.
    Clear,
}

/// Body-attested bounded laser evidence, not an independent object classifier.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteConditionEvidence {
    /// Currently laser_scan only.
    pub sensor: String,
    /// Evidence has been transformed into the semantic map frame.
    pub frame_id: String,
    /// Nearest measured corridor return, in metres.
    pub distance_m: f64,
    /// Number of supporting finite laser returns.
    pub blocked_samples: u32,
    /// Hash of the raw scan retained by the local body recorder.
    pub scan_sha256: String,
    /// Body pose when the scan was observed.
    pub observer_pose: BodyPose,
}

/// A bounded, idempotent report. The transport supplies the authenticated actor.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteConditionInput {
    /// Caller-generated event identity, scoped by persisted actor binding.
    pub event_id: String,
    /// Reviewed static semantic map digest.
    pub map_digest: String,
    /// Named segment in that map.
    pub segment_id: String,
    /// Requested status.
    pub status: RouteConditionStatus,
    /// Human-readable bounded explanation.
    pub reason: String,
    /// Actual sensor time, or operator report time for manual observations.
    pub observed_at: DateTime<Utc>,
    /// Active body command; absent for operator reports.
    #[serde(default)]
    pub command_id: Option<CommandId>,
    /// Sensor evidence; absent for operator reports.
    #[serde(default)]
    pub evidence: Option<RouteConditionEvidence>,
    /// Required compare-and-clear revision for operators; body block reports omit it.
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

/// Append-only observation with server-assigned revision and provenance.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RouteConditionObservation {
    /// Immutable record identity.
    pub id: String,
    /// Global monotonic observation revision.
    pub revision: u64,
    /// Exact submitted event fields.
    #[serde(flatten)]
    pub input: RouteConditionInput,
    /// Server receipt time.
    pub received_at: DateTime<Utc>,
    /// Authenticated reporter.
    pub actor: AuditActor,
    /// Body identity for sensor reports; absent for operator reports.
    pub body_id: Option<BodyId>,
}

/// Current exclusions plus retained observations; reading never changes state.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RouteConditionSnapshot {
    /// Configured map identity.
    pub map_id: String,
    /// Static map digest, unchanged by observations.
    pub map_digest: String,
    /// Latest durable observation revision.
    pub revision: u64,
    /// Newest first, including explicit clear records.
    pub conditions: Vec<RouteConditionObservation>,
    /// Current excluded segments in stable order.
    pub blocked_segment_ids: Vec<String>,
}

/// Additional frozen context for new route reviews; legacy reviews omit it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AdaptiveRouteContext {
    /// Observation revision reviewed with this plan.
    pub conditions_revision: u64,
    /// Exact excluded segments used by the planner.
    pub blocked_segment_ids: Vec<String>,
    /// Completed prefix preceding this plan's remaining route legs.
    pub step_offset: usize,
    /// Previous immutable route review, when replacing a remaining suffix.
    pub parent_plan_id: Option<String>,
}

/// Immutable review of a held objective's remaining work.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RouteReplanProposal {
    /// Review identity.
    pub id: String,
    /// Digest of the frozen review.
    pub digest: String,
    /// Same durable round that will continue.
    pub round_id: String,
    /// Exact prior round revision.
    pub round_digest: String,
    /// Prior immutable route review.
    pub original_route_plan_id: String,
    /// Original objective, retained across every replan.
    pub original_objective: RouteObjectiveRequest,
    /// Current source body, never silently replaced at approval.
    pub source_body_id: BodyId,
    /// Unique known current place; absent when localization cannot ground a plan.
    pub source_place_id: Option<String>,
    /// Completed prefix retained unchanged.
    pub completed_steps: Vec<RoundStep>,
    /// Exact newly planned suffix.
    pub remaining_steps: Vec<RoundStep>,
    /// Body assignment for each suffix step.
    pub step_body_ids: Vec<BodyId>,
    /// Historical missions, including held attempts.
    pub retained_mission_ids: Vec<MissionId>,
    /// Immutable observation IDs still belonging to the objective.
    pub retained_observation_ids: Vec<String>,
    /// Resulting route, absent on a blocked review.
    pub plan: Option<RoutePlan>,
    /// Typed reason the remaining objective cannot currently be planned.
    pub failure: Option<RoutePlanningFailure>,
    /// Frozen observation revision.
    pub conditions_revision: u64,
    /// Frozen current exclusions.
    pub blocked_segment_ids: Vec<String>,
    /// Review creation time.
    pub created_at: DateTime<Utc>,
    /// Review expiry.
    pub expires_at: DateTime<Utc>,
    /// Full prior command expiry and stop margin.
    pub not_before_at: DateTime<Utc>,
    /// pending, blocked, approved, invalidated.
    pub status: String,
    /// Explicit approval time.
    pub approved_at: Option<DateTime<Utc>>,
}
impl RouteReplanProposal {
    fn computed_digest(&self) -> Result<String, ApplicationError> {
        let mut value = serde_json::to_value(self).map_err(|_| ApplicationError::Infrastructure)?;
        let object = value
            .as_object_mut()
            .ok_or(ApplicationError::Infrastructure)?;
        for field in ["digest", "status", "approved_at"] {
            object.remove(field);
        }
        Ok(format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&value).map_err(|_| ApplicationError::Infrastructure)?
            )
        ))
    }
}

/// Ports bound to the same database transaction as missions, commands and audit.
#[async_trait]
pub trait AdaptiveRouteRepository: Send + Sync {
    /// Append once; event identity must not overwrite another observation.
    async fn append_route_condition(
        &self,
        observation: RouteConditionObservation,
    ) -> Result<(), ApplicationError>;
    /// Find an event before revalidating a possibly retried report.
    async fn route_condition_event(
        &self,
        event_id: &str,
    ) -> Result<Option<RouteConditionObservation>, ApplicationError>;
    /// Read retained observation history.
    async fn list_route_condition_observations(
        &self,
    ) -> Result<Vec<RouteConditionObservation>, ApplicationError>;
    /// Store an immutable review and its separate approval status.
    async fn save_route_replan(
        &self,
        proposal: RouteReplanProposal,
    ) -> Result<(), ApplicationError>;
    /// Find one review.
    async fn get_route_replan(
        &self,
        id: &str,
    ) -> Result<Option<RouteReplanProposal>, ApplicationError>;
    /// List retained replan reviews.
    async fn list_route_replans(&self) -> Result<Vec<RouteReplanProposal>, ApplicationError>;
}

impl LatticeService {
    /// Returns current route conditions without holding, clearing or approving work.
    pub async fn route_conditions(&self) -> Result<RouteConditionSnapshot, ApplicationError> {
        let map = self.navigation_map()?;
        let digest = map.digest()?;
        let mut history = match &self.adaptive_routes {
            Some(store) => store.list_route_condition_observations().await?,
            None => Vec::new(),
        };
        history.sort_by_key(|row| std::cmp::Reverse(row.revision));
        let revision = history.first().map_or(0, |row| row.revision);
        history.retain(|row| row.input.map_digest == digest);
        let mut latest = BTreeMap::new();
        for row in &history {
            latest
                .entry(row.input.segment_id.clone())
                .or_insert(row.input.status);
        }
        Ok(RouteConditionSnapshot {
            map_id: map.id,
            map_digest: digest,
            revision,
            blocked_segment_ids: latest
                .into_iter()
                .filter_map(|(id, status)| (status == RouteConditionStatus::Blocked).then_some(id))
                .collect(),
            conditions: history,
        })
    }

    /// Records an explicit operator observation; it cannot impersonate sensor evidence.
    pub async fn report_route_condition(
        &self,
        input: RouteConditionInput,
        actor: AuditActor,
    ) -> Result<RouteConditionObservation, ApplicationError> {
        if !matches!(actor, AuditActor::Operator(_))
            || input.command_id.is_some()
            || input.evidence.is_some()
        {
            return Err(conflict(
                "operator condition reports cannot supply body command or sensor evidence",
            ));
        }
        self.record_route_condition(input, actor, None).await
    }

    /// Accepts evidence only for this body's active, matching signed route command.
    pub async fn report_body_route_condition(
        &self,
        body: &BodyId,
        input: RouteConditionInput,
    ) -> Result<RouteConditionObservation, ApplicationError> {
        self.record_route_condition(
            input,
            AuditActor::Body(body.to_string()),
            Some(body.clone()),
        )
        .await
    }

    async fn record_route_condition(
        &self,
        input: RouteConditionInput,
        actor: AuditActor,
        body: Option<BodyId>,
    ) -> Result<RouteConditionObservation, ApplicationError> {
        let _reservation = self.approval_lock.lock().await;
        let store = self.adaptive_store()?;
        if let Some(prior) = store.route_condition_event(&input.event_id).await? {
            return if prior.input == input && prior.actor == actor && prior.body_id == body {
                Ok(prior)
            } else {
                Err(conflict(
                    "condition event identity was already used for different evidence or reporter",
                ))
            };
        }
        let map = self.navigation_map()?;
        let now = self.clock.now();
        if !safe_id(&input.event_id)
            || input.reason.trim().len() < 5
            || input.reason.len() > 240
            || input.reason.chars().any(char::is_control)
            || input.map_digest != map.digest()?
            || map.segment(&input.segment_id).is_none()
            || input.observed_at < now - Duration::seconds(5)
            || input.observed_at > now + Duration::seconds(1)
        {
            return Err(conflict(
                "condition report requires a current map segment, fresh time and bounded identity/reason",
            ));
        }
        let current_revision = self.route_conditions().await?.revision;
        if input.status == RouteConditionStatus::Clear
            && input.expected_revision != Some(current_revision)
        {
            return Err(conflict(
                "route conditions changed since the clear review; refresh before explicitly clearing",
            ));
        }
        if let Some(body_id) = &body {
            let evidence = input
                .evidence
                .as_ref()
                .ok_or_else(|| conflict("body blockage requires laser evidence"))?;
            let command_id = input
                .command_id
                .as_ref()
                .ok_or_else(|| conflict("body blockage requires its active command"))?;
            if input.status != RouteConditionStatus::Blocked
                || evidence.sensor != "laser_scan"
                || evidence.frame_id != map.frame_id
                || !evidence.distance_m.is_finite()
                || !(0.01..=3.0).contains(&evidence.distance_m)
                || !(3..=10_000).contains(&evidence.blocked_samples)
                || !hex_digest(&evidence.scan_sha256)
            {
                return Err(conflict("invalid bounded body blockage evidence"));
            }
            evidence.observer_pose.validate()?;
            let snapshot = self
                .bodies
                .get(body_id)
                .await?
                .ok_or(ApplicationError::NotFound { entity: "body" })?;
            let pose = snapshot
                .pose
                .ok_or_else(|| conflict("body evidence requires current localization"))?;
            if !self.body_pose_is_fresh(&snapshot)
                || (pose.x - evidence.observer_pose.x).hypot(pose.y - evidence.observer_pose.y)
                    > 0.5
                || (pose.z.unwrap_or(0.0) - evidence.observer_pose.z.unwrap_or(0.0)).abs() > 0.5
            {
                return Err(conflict(
                    "body evidence pose differs from fresh authenticated localization",
                ));
            }
            let valid_command = self.missions.list().await?.iter().any(|mission| {
                mission.assigned_body_id.as_ref() == Some(body_id) && mission.active_command_id.as_ref() == Some(command_id)
                    && matches!(mission.status, MissionStatus::Assigned | MissionStatus::Running)
                    && mission.command_expires_at.is_some_and(|expiry| now < expiry)
                    && matches!(&mission.command, SkillCommand::TraverseRoute { traversal }
                        if traversal.segment_id == input.segment_id && traversal.map_digest == input.map_digest)
            });
            if !valid_command {
                return Err(conflict(
                    "body evidence does not belong to an active matching route command",
                ));
            }
        }
        let revision = current_revision
            .checked_add(1)
            .ok_or(ApplicationError::Infrastructure)?;
        let row = RouteConditionObservation {
            id: format!("route-condition-{}", uuid::Uuid::new_v4().simple()),
            revision,
            input,
            received_at: now,
            actor: actor.clone(),
            body_id: body,
        };
        store.append_route_condition(row.clone()).await?;
        if row.input.status == RouteConditionStatus::Blocked {
            self.hold_routes_using_segment(&row.input.segment_id)
                .await?;
        }
        self.adaptive_audit("route_condition.recorded", &row.id, actor,
            json!({"revision":row.revision,"map_digest":row.input.map_digest,"segment_id":row.input.segment_id,
                "status":row.input.status,"body_id":row.body_id,"command_id":row.input.command_id,
                "scan_sha256":row.input.evidence.as_ref().map(|e| &e.scan_sha256)})).await?;
        Ok(row)
    }

    async fn hold_routes_using_segment(&self, segment: &str) -> Result<(), ApplicationError> {
        for round in self.list_rounds().await? {
            if round.status != "active" || round.route_plan_id.is_none() {
                continue;
            }
            if round.steps[round.current_step..].iter().any(|step| {
                matches!(&step.command,
                SkillCommand::TraverseRoute { traversal } if traversal.segment_id == segment)
            }) {
                let id = round
                    .current_mission_id
                    .as_ref()
                    .ok_or(ApplicationError::Security)?;
                let mut mission = self
                    .missions
                    .get(id)
                    .await?
                    .ok_or(ApplicationError::Security)?;
                self.hold_adaptive_mission(&mut mission, &format!("Route segment {segment} was reported blocked; review the remaining objective.")).await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn hold_adaptive_mission(
        &self,
        mission: &mut Mission,
        reason: &str,
    ) -> Result<DateTime<Utc>, ApplicationError> {
        let now = self.clock.now();
        let body = mission
            .assigned_body_id
            .clone()
            .ok_or(ApplicationError::Security)?;
        let until = if mission.active_command_id.is_some() {
            mission
                .command_expires_at
                .unwrap_or(now + Duration::seconds(300))
                .max(now)
                + Duration::seconds(2)
        } else {
            now + Duration::seconds(2)
        };
        if let Some(store) = &self.handoffs {
            store.fence_body(&body, until).await?;
        } else {
            return Err(conflict("adaptive stopping requires durable body fences"));
        }
        mission.require_recovery(now);
        mission.status_detail = Some(reason.into());
        self.missions.save(mission.clone()).await?;
        self.hold_round(mission).await?;
        if let Some(mut snapshot) = self.bodies.get(&body).await? {
            snapshot.status = BodyStatus::Offline;
            self.bodies.save(snapshot).await?;
        }
        Ok(until)
    }

    pub(crate) async fn hold_failed_route_round(
        &self,
        round: &mut InspectionRound,
        failed: &Mission,
    ) -> Result<(), ApplicationError> {
        let now = self.clock.now();
        let body = failed
            .assigned_body_id
            .clone()
            .ok_or(ApplicationError::Security)?;
        let until = failed
            .command_expires_at
            .unwrap_or(now + Duration::seconds(300))
            .max(now)
            + Duration::seconds(2);
        self.handoffs
            .as_ref()
            .ok_or(ApplicationError::Security)?
            .fence_body(&body, until)
            .await?;
        if let Some(mut snapshot) = self.bodies.get(&body).await? {
            snapshot.status = BodyStatus::Offline;
            self.bodies.save(snapshot).await?;
        }
        // Keep the failed attempt and its reason immutable; hold a new unissued
        // placeholder at the same cursor for an explicitly reviewed replacement.
        let mut held = Mission::new(
            MissionId::new(format!("mission-{}", uuid::Uuid::new_v4().simple()))?,
            failed.title.clone(),
            failed.command.clone(),
            now,
        )?;
        held.assigned_body_id = Some(body);
        held.continuation = round.continuation.clone();
        held.require_recovery(now);
        held.status_detail = Some(format!(
            "Previous route attempt {} failed. Review remaining work from a known place; source fenced through {}.",
            failed.id,
            until.to_rfc3339()
        ));
        self.missions.save(held.clone()).await?;
        round.status = "recovery_required".into();
        round.current_mission_id = Some(held.id.clone());
        round.mission_ids.push(held.id);
        self.round_store()?.save(round.clone()).await?;
        self.adaptive_audit("route.local_failure_held", failed.id.as_str(), AuditActor::Service("route-coordinator".into()),
            json!({"round_id":round.id,"failed_mission_id":failed.id,"held_mission_id":round.current_mission_id,"not_before_at":until})).await
    }

    /// Periodic coordinator action: holds unavailable route bodies without assigning replacements.
    /// The caller supplies a fresh, epoch-checked transaction; GET requests never invoke this.
    pub async fn hold_unavailable_route_work(&self) -> Result<usize, ApplicationError> {
        let mut held = 0;
        if self.navigation_map.is_none() || self.adaptive_routes.is_none() {
            return Ok(0);
        }
        for round in self.list_rounds().await? {
            if round.status != "active" || round.route_plan_id.is_none() {
                continue;
            }
            let id = round
                .current_mission_id
                .as_ref()
                .ok_or(ApplicationError::Security)?;
            let mut mission = self
                .missions
                .get(id)
                .await?
                .ok_or(ApplicationError::Security)?;
            if !matches!(
                mission.status,
                MissionStatus::Assigned | MissionStatus::Running
            ) {
                continue;
            }
            let available = match &mission.assigned_body_id {
                Some(body) => self.bodies.get(body).await?.is_some_and(|snapshot| {
                    self.body_pose_is_fresh(&snapshot)
                        && mission
                            .command
                            .required_capabilities()
                            .iter()
                            .all(|capability| {
                                snapshot.is_eligible(
                                    *capability,
                                    self.clock.now(),
                                    self.config.heartbeat_timeout,
                                )
                            })
                }),
                None => false,
            };
            if !available {
                self.hold_adaptive_mission(&mut mission, "Assigned route body became unavailable; completed work is retained for reviewed replanning.").await?;
                self.adaptive_audit(
                    "route.body_unavailable",
                    mission.id.as_str(),
                    AuditActor::Service("route-coordinator".into()),
                    json!({"round_id":round.id,"body_id":mission.assigned_body_id}),
                )
                .await?;
                held += 1;
            }
        }
        Ok(held)
    }

    pub(crate) async fn validate_route_conditions_review(
        &self,
        proposal: &RoutePlanProposal,
    ) -> Result<(), ApplicationError> {
        let snapshot = self.route_conditions().await?;
        if proposal
            .adaptive
            .as_ref()
            .map_or(0, |c| c.conditions_revision)
            != snapshot.revision
            || proposal
                .adaptive
                .as_ref()
                .is_some_and(|c| c.blocked_segment_ids != snapshot.blocked_segment_ids)
        {
            return Err(conflict(
                "route conditions changed since review; prepare a fresh route plan",
            ));
        }
        let offset = proposal.adaptive.as_ref().map_or(0, |c| c.step_offset);
        let steps = proposal
            .steps
            .get(offset..)
            .ok_or(ApplicationError::Security)?;
        for step in steps {
            self.validate_live_route_command(&step.command).await?;
        }
        Ok(())
    }

    /// Lists retained reviews; it never prepares or approves a replacement.
    pub async fn list_route_replans(&self) -> Result<Vec<RouteReplanProposal>, ApplicationError> {
        self.adaptive_store()?.list_route_replans().await
    }

    /// Freezes a new suffix from a held body's unique known place, preserving its objective.
    pub async fn propose_route_replan(
        &self,
        round_id: &str,
        digest: &str,
        actor: AuditActor,
    ) -> Result<RouteReplanProposal, ApplicationError> {
        let _reservation = self.approval_lock.lock().await;
        let round = self
            .round_store()?
            .get(round_id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "round" })?;
        if round.digest != digest || round.status != "recovery_required" {
            return Err(conflict("replanning requires the exact held round review"));
        }
        let old_id = round
            .route_plan_id
            .clone()
            .ok_or_else(|| conflict("only capability-route rounds support replanning"))?;
        let old = self
            .route_store()?
            .get_route_plan(&old_id)
            .await?
            .ok_or(ApplicationError::Security)?;
        self.validate_route_snapshot(&old)?;
        let original_objective = self.original_route_objective(&old).await?;
        let source = round
            .assigned_body_id
            .clone()
            .ok_or(ApplicationError::Security)?;
        let map = self.navigation_map()?;
        let conditions = self.route_conditions().await?;
        let now = self.clock.now();
        let mut candidates = self.route_candidates(&map, &source).await?;
        let held = self
            .missions
            .get(
                round
                    .current_mission_id
                    .as_ref()
                    .ok_or(ApplicationError::Security)?,
            )
            .await?
            .ok_or(ApplicationError::Security)?;
        if held.status != MissionStatus::RecoveryRequired {
            return Err(conflict("current mission is not held"));
        }
        let not_before = self
            .handoffs
            .as_ref()
            .ok_or(ApplicationError::Security)?
            .body_fence(&source)
            .await?
            .unwrap_or(now)
            .max(if held.active_command_id.is_some() {
                held.command_expires_at
                    .unwrap_or(now + Duration::seconds(300))
                    + Duration::seconds(2)
            } else {
                now
            });
        // Preparation may occur while the known source's stop fence is running.
        // Approval below requires an online post-fence heartbeat and never grants this exemption.
        if let Some(candidate) = candidates.iter_mut().find(|c| c.body_id == source)
            && let Some(snapshot) = self.bodies.get(&source).await?
            && snapshot.status == BodyStatus::Offline
            && now < not_before
            && self.body_pose_is_fresh(&snapshot)
        {
            candidate.ready = snapshot.battery.value() >= 15;
            candidate.available = true;
        }
        let place = candidates
            .iter()
            .find(|c| c.body_id == source)
            .and_then(|c| c.place_id.clone());
        let request = RouteRequest {
            source_body_id: source.clone(),
            source_place_id: place.clone().unwrap_or_default(),
            destination_place_id: original_objective.route.destination_place_id.clone(),
            destination_capability: original_objective.route.destination_capability,
        };
        let inspect_source = original_objective.inspect_source && round.current_step == 0;
        let unfinished_source_changed = inspect_source
            && place.as_deref() != Some(original_objective.route.source_place_id.as_str());
        let source_lacks_inspection = inspect_source
            && !candidates.iter().any(|c| {
                c.body_id == source
                    && c.capabilities
                        .contains(&lattice_domain::Capability::Inspect)
            });
        let result = match &place {
            Some(_) if unfinished_source_changed || source_lacks_inspection => Err(RoutePlanningFailure {
                code: RouteFailureCode::SourceUnavailable,
                message: "The unfinished source inspection still requires its original station and an inspection-capable source; re-stage before review.".into(),
                assessments: vec![],
            }),
            Some(_) => plan_route_with_blocked_segments(&map, &request, &candidates, &conditions.blocked_segment_ids.iter().cloned().collect()),
            None => Err(RoutePlanningFailure { code: RouteFailureCode::SourceUnavailable,
                message: "Held body must have a fresh, unambiguous pose at a known semantic place; no route anchor is invented.".into(), assessments: vec![] }),
        };
        let (mut plan, mut failure) = match result {
            Ok(plan) => (Some(plan), None),
            Err(error) => (None, Some(error)),
        };
        let mut steps = Vec::new();
        let mut bodies = Vec::new();
        if let Some(route) = &plan {
            if inspect_source {
                steps.push(crate::navigation::inspection_step(
                    &map,
                    &route.source_place_id,
                )?);
                bodies.push(source.clone());
            }
            for leg in &route.legs {
                let segment = map
                    .segment(&leg.segment_id)
                    .ok_or(ApplicationError::Security)?;
                steps.push(RoundStep {
                    title: format!("Traverse {} to {}", segment.from, segment.to),
                    command: SkillCommand::TraverseRoute {
                        traversal: RouteTraversal::from_segment(&map, segment)?,
                    },
                    continue_on_missing_marker: false,
                });
                bodies.push(leg.body_id.clone());
            }
            if original_objective.inspect_destination {
                steps.push(crate::navigation::inspection_step(
                    &map,
                    &route.destination_place_id,
                )?);
                bodies.push(route.destination_body_id.clone());
            }
            if steps.is_empty() || round.current_step + steps.len() > 6 {
                failure = Some(RoutePlanningFailure { code: RouteFailureCode::InvalidInput,
                    message: "Remaining objective must fit the six-step bound without dropping completed work.".into(), assessments: vec![] });
                plan = None;
                steps.clear();
                bodies.clear();
            }
        }
        let mut proposal = RouteReplanProposal {
            id: format!("replan-{}", uuid::Uuid::new_v4().simple()),
            digest: String::new(),
            round_id: round.id.clone(),
            round_digest: round.digest.clone(),
            original_route_plan_id: old_id,
            original_objective,
            source_body_id: source,
            source_place_id: place,
            completed_steps: round.steps[..round.current_step].to_vec(),
            remaining_steps: steps,
            step_body_ids: bodies,
            retained_mission_ids: round.mission_ids.clone(),
            retained_observation_ids: self.round_observation_ids(&round).await?,
            plan,
            failure,
            conditions_revision: conditions.revision,
            blocked_segment_ids: conditions.blocked_segment_ids,
            created_at: now,
            expires_at: not_before.max(now) + Duration::minutes(5),
            not_before_at: not_before,
            status: "pending".into(),
            approved_at: None,
        };
        if proposal.failure.is_some() {
            proposal.status = "blocked".into();
        }
        proposal.digest = proposal.computed_digest()?;
        self.adaptive_store()?
            .save_route_replan(proposal.clone())
            .await?;
        self.adaptive_audit("route_replan.proposed", &proposal.id, actor,
            json!({"round_id":round.id,"round_digest":round.digest,"digest":proposal.digest,"conditions_revision":proposal.conditions_revision,"status":proposal.status})).await?;
        Ok(proposal)
    }

    /// Approves only the frozen suffix, leaving completed steps and evidence intact.
    pub async fn approve_route_replan(
        &self,
        id: &str,
        digest: &str,
        actor: AuditActor,
    ) -> Result<InspectionRound, ApplicationError> {
        let _reservation = self.approval_lock.lock().await;
        let mut proposal = self.adaptive_store()?.get_route_replan(id).await?.ok_or(
            ApplicationError::NotFound {
                entity: "route replan",
            },
        )?;
        if proposal.digest != digest || proposal.computed_digest()? != digest {
            return Err(conflict("replan digest mismatch"));
        }
        let mut round = self
            .round_store()?
            .get(&proposal.round_id)
            .await?
            .ok_or(ApplicationError::Security)?;
        if proposal.status == "approved" {
            return Ok(round);
        }
        let now = self.clock.now();
        if proposal.status != "pending"
            || proposal.failure.is_some()
            || now >= proposal.expires_at
            || now < proposal.not_before_at
        {
            return Err(conflict(
                "replan requires a current executable review after the complete source stop fence",
            ));
        }
        if round.status != "recovery_required"
            || round.digest != proposal.round_digest
            || round.route_plan_id.as_ref() != Some(&proposal.original_route_plan_id)
            || round.steps[..round.current_step] != proposal.completed_steps
            || round.mission_ids != proposal.retained_mission_ids
            || self.round_observation_ids(&round).await? != proposal.retained_observation_ids
        {
            return Err(conflict(
                "held objective changed; prepare a new replan review",
            ));
        }
        let conditions = self.route_conditions().await?;
        if conditions.revision != proposal.conditions_revision
            || conditions.blocked_segment_ids != proposal.blocked_segment_ids
        {
            return Err(conflict("route conditions changed; prepare a new review"));
        }
        let old = self
            .route_store()?
            .get_route_plan(&proposal.original_route_plan_id)
            .await?
            .ok_or(ApplicationError::Security)?;
        let map = self.validate_route_snapshot(&old)?;
        let plan = proposal.plan.as_ref().ok_or(ApplicationError::Security)?;
        let candidates = self
            .route_candidates(&map, &proposal.source_body_id)
            .await?;
        let source = candidates
            .iter()
            .find(|c| c.body_id == proposal.source_body_id)
            .ok_or(ApplicationError::Security)?;
        let snapshot = self
            .bodies
            .get(&source.body_id)
            .await?
            .ok_or(ApplicationError::Security)?;
        if !source.ready
            || !source.available
            || source.place_id != proposal.source_place_id
            || snapshot.last_seen < proposal.not_before_at
        {
            return Err(conflict(
                "replan source needs a fresh post-fence heartbeat at the reviewed starting place",
            ));
        }
        for (step, body) in proposal.remaining_steps.iter().zip(&proposal.step_body_ids) {
            if !self.body_available(body, &step.command).await? {
                return Err(conflict(
                    "a remaining-step body is no longer ready and capable",
                ));
            }
        }
        for transfer in &plan.transfers {
            if !candidates.iter().any(|c| {
                c.body_id == transfer.target_body_id
                    && c.ready
                    && c.available
                    && c.place_id.as_deref() == Some(&transfer.place_id)
            }) {
                return Err(conflict(
                    "replacement body left its reviewed transfer place",
                ));
            }
        }
        let mut mission = self
            .missions
            .get(
                round
                    .current_mission_id
                    .as_ref()
                    .ok_or(ApplicationError::Security)?,
            )
            .await?
            .ok_or(ApplicationError::Security)?;
        if mission.status != MissionStatus::RecoveryRequired {
            return Err(conflict("current mission is no longer held"));
        }
        mission.status = MissionStatus::Cancelled;
        mission.updated_at = now;
        mission.status_detail = Some(format!(
            "Superseded by reviewed replan {} without repeating completed work.",
            proposal.id
        ));
        self.missions.save(mission).await?;
        let mut steps = proposal.completed_steps.clone();
        steps.extend(proposal.remaining_steps.clone());
        let mut bodies = old.step_body_ids[..round.current_step].to_vec();
        bodies.extend(proposal.step_body_ids.clone());
        let route_id = format!("route-plan-{}", uuid::Uuid::new_v4().simple());
        let mut route = RoutePlanProposal {
            id: route_id.clone(),
            digest: String::new(),
            request: RouteObjectiveRequest {
                route: RouteRequest {
                    source_body_id: source.body_id.clone(),
                    source_place_id: plan.source_place_id.clone(),
                    destination_place_id: plan.destination_place_id.clone(),
                    destination_capability: proposal
                        .original_objective
                        .route
                        .destination_capability,
                },
                inspect_source: proposal.original_objective.inspect_source
                    && round.current_step == 0,
                inspect_destination: proposal.original_objective.inspect_destination,
            },
            plan: Some(plan.clone()),
            failure: None,
            steps: steps.clone(),
            step_body_ids: bodies,
            created_at: now,
            expires_at: proposal.expires_at,
            status: "approved".into(),
            round_id: Some(round.id.clone()),
            adaptive: Some(AdaptiveRouteContext {
                conditions_revision: proposal.conditions_revision,
                blocked_segment_ids: proposal.blocked_segment_ids.clone(),
                step_offset: round.current_step,
                parent_plan_id: Some(old.id.clone()),
            }),
        };
        route.digest = route.computed_digest()?;
        self.route_store()?.save_route_plan(route.clone()).await?;
        let prior_digest = round.digest.clone();
        round.digest = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(&round.id, &prior_digest, &proposal.digest, &route.digest))
                    .map_err(|_| ApplicationError::Infrastructure)?
            )
        );
        round.steps = steps;
        round.route_plan_id = Some(route_id);
        round.status = "active".into();
        round.approved_by = Some(actor.clone());
        round.approved_at = Some(now);
        self.invalidate_round_reviews(&round.id).await?;
        self.dispatch_round_step(&mut round).await?;
        proposal.status = "approved".into();
        proposal.approved_at = Some(now);
        self.adaptive_store()?
            .save_route_replan(proposal.clone())
            .await?;
        self.adaptive_audit("route_replan.approved", &proposal.id, actor,
            json!({"round_id":round.id,"prior_round_digest":prior_digest,"round_digest":round.digest,
                "digest":proposal.digest,"route_plan_id":round.route_plan_id,"retained_mission_ids":proposal.retained_mission_ids,
                "retained_observation_ids":proposal.retained_observation_ids,"completed_steps":round.current_step})).await?;
        Ok(round)
    }

    async fn original_route_objective(
        &self,
        current: &RoutePlanProposal,
    ) -> Result<RouteObjectiveRequest, ApplicationError> {
        let mut row = current.clone();
        for _ in 0..32 {
            let Some(parent) = row
                .adaptive
                .as_ref()
                .and_then(|c| c.parent_plan_id.as_ref())
            else {
                return Ok(row.request);
            };
            row = self
                .route_store()?
                .get_route_plan(parent)
                .await?
                .ok_or(ApplicationError::Security)?;
        }
        Err(conflict("objective exceeded the bounded replan history"))
    }

    async fn round_observation_ids(
        &self,
        round: &InspectionRound,
    ) -> Result<Vec<String>, ApplicationError> {
        let store = self
            .observations
            .as_ref()
            .ok_or(ApplicationError::Security)?;
        let mut ids = Vec::new();
        for id in &round.mission_ids {
            if let Some(mission) = self.missions.get(id).await?
                && let Some(command) = mission.active_command_id
                && let Some(observation) = store
                    .get_observation(&format!("observation-{command}"))
                    .await?
            {
                if observation.mission_id != *id {
                    return Err(ApplicationError::Security);
                }
                ids.push(observation.id);
            }
        }
        Ok(ids)
    }

    pub(crate) async fn invalidate_round_reviews(
        &self,
        round_id: &str,
    ) -> Result<(), ApplicationError> {
        if let Some(store) = &self.handoffs {
            for mut review in store.list_handoffs().await? {
                if review.round_id == round_id && review.status == "pending" {
                    review.status = "invalidated".into();
                    store.save_handoff(review).await?;
                }
            }
        }
        if let Some(store) = &self.adaptive_routes {
            for mut review in store.list_route_replans().await? {
                if review.round_id == round_id && review.status == "pending" {
                    review.status = "invalidated".into();
                    store.save_route_replan(review).await?;
                }
            }
        }
        let round = self
            .round_store()?
            .get(round_id)
            .await?
            .ok_or(ApplicationError::Security)?;
        for mut review in self.proposals.list().await? {
            if review.status == "pending"
                && review
                    .recovery_of
                    .as_ref()
                    .is_some_and(|id| round.mission_ids.contains(id))
            {
                review.status = "invalidated".into();
                self.proposals.save(review).await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn validate_live_route_command(
        &self,
        command: &SkillCommand,
    ) -> Result<(), ApplicationError> {
        if let SkillCommand::TraverseRoute { traversal } = command {
            self.validate_route_command(command)?;
            if self
                .route_conditions()
                .await?
                .blocked_segment_ids
                .contains(&traversal.segment_id)
            {
                return Err(conflict(
                    "route segment is currently blocked; review a replan",
                ));
            }
        }
        Ok(())
    }
    pub(crate) fn adaptive_store(
        &self,
    ) -> Result<&Arc<dyn AdaptiveRouteRepository>, ApplicationError> {
        self.adaptive_routes
            .as_ref()
            .ok_or_else(|| conflict("adaptive routes require durable storage"))
    }
    async fn adaptive_audit(
        &self,
        event: &str,
        id: &str,
        actor: AuditActor,
        metadata: serde_json::Value,
    ) -> Result<(), ApplicationError> {
        self.audit
            .append(AuditRecord {
                occurred_at: self.clock.now(),
                actor,
                event_type: event.into(),
                object_id: id.into(),
                metadata,
            })
            .await
    }
}
fn conflict(message: &str) -> ApplicationError {
    ApplicationError::Conflict(message.into())
}
fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
fn hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
