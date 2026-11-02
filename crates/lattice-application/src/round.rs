//! Immutable operator-reviewed inspection rounds, advanced only by committed body results.
use crate::{ApplicationError, CreateMissionRequest, LatticeService, validate_warehouse_command};
use chrono::{DateTime, Duration, Utc};
use lattice_domain::{
    AuditActor, AuditRecord, BodyId, ContinuationContext, Mission, MissionId, MissionStatus,
    SkillCommand,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

/// One bounded step; continuing after failure is an explicit part of the review.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoundStep {
    /// Operator-facing task.
    pub title: String,
    /// Typed warehouse command.
    pub command: SkillCommand,
    /// Whether a failed inspection with a validated no-marker image may proceed.
    pub continue_on_missing_marker: bool,
}
/// A frozen multi-step objective and its durable execution cursor.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InspectionRound {
    /// Stable identity.
    pub id: String,
    /// Frozen plan digest.
    pub digest: String,
    /// Reviewed steps; a replan preserves the completed prefix and versions the remaining suffix.
    pub steps: Vec<RoundStep>,
    /// Proposal timestamp.
    pub created_at: DateTime<Utc>,
    /// Approval deadline.
    pub expires_at: DateTime<Utc>,
    /// pending, active, recovery_required, completed, failed, cancelled, invalidated.
    pub status: String,
    /// Approval identity and time.
    pub approved_by: Option<AuditActor>,
    /// Approval timestamp.
    pub approved_at: Option<DateTime<Utc>>,
    /// Zero-based current step.
    pub current_step: usize,
    /// Current mission, including a replacement created during recovery.
    pub current_mission_id: Option<MissionId>,
    /// All missions, retaining interrupted attempts.
    pub mission_ids: Vec<MissionId>,
    /// Failed steps explicitly permitted to continue.
    pub anomaly_count: usize,
    /// Body instance pinned for the remaining approved steps.
    #[serde(default)]
    pub assigned_body_id: Option<BodyId>,
    /// Reviewed evidence context retained after a body transfer.
    #[serde(default)]
    pub continuation: Option<ContinuationContext>,
    /// Optional frozen capability-route plan governing step assignments and transfers.
    #[serde(default)]
    pub route_plan_id: Option<String>,
}
impl LatticeService {
    /// Freezes an operator-authored round. No command is dispatched.
    pub async fn propose_round(
        &self,
        steps: Vec<RoundStep>,
    ) -> Result<InspectionRound, ApplicationError> {
        if !(2..=6).contains(&steps.len()) {
            return Err(conflict("round requires two to six steps"));
        }
        let now = self.clock.now();
        for step in &steps {
            validate_warehouse_command(&step.command)?;
            Mission::new(
                MissionId::new("validation-step")?,
                step.title.clone(),
                step.command.clone(),
                now,
            )?;
            // Movement failures always stop the round; only inspection anomalies may continue.
            if step.continue_on_missing_marker
                && !matches!(step.command, SkillCommand::Inspect { .. })
            {
                return Err(conflict("only inspection failure may continue"));
            }
        }
        let id = format!("round-{}", uuid::Uuid::new_v4().simple());
        let expires_at = now + Duration::minutes(5);
        let bytes = serde_json::to_vec(&(&id, now, expires_at, &steps))
            .map_err(|_| ApplicationError::Infrastructure)?;
        let round = InspectionRound {
            id,
            digest: format!("{:x}", Sha256::digest(bytes)),
            steps,
            created_at: now,
            expires_at,
            status: "pending".into(),
            approved_by: None,
            approved_at: None,
            current_step: 0,
            current_mission_id: None,
            mission_ids: vec![],
            anomaly_count: 0,
            assigned_body_id: None,
            continuation: None,
            route_plan_id: None,
        };
        self.round_store()?.save(round.clone()).await?;
        self.round_audit(
            &round,
            "round.proposed",
            AuditActor::Service("round-api".into()),
        )
        .await?;
        Ok(round)
    }
    /// Lists retained plans and their execution cursors.
    pub async fn list_rounds(&self) -> Result<Vec<InspectionRound>, ApplicationError> {
        let mut rows = self.round_store()?.list().await?;
        rows.sort_by_key(|r| std::cmp::Reverse(r.created_at));
        Ok(rows)
    }
    /// Approves the exact full plan, including failure policies, once.
    pub async fn approve_round(
        &self,
        id: &str,
        digest: &str,
        actor: AuditActor,
    ) -> Result<InspectionRound, ApplicationError> {
        let mut round = self
            .round_store()?
            .get(id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "round" })?;
        if round.digest != digest {
            return Err(conflict("round digest mismatch"));
        }
        if round.approved_at.is_some() {
            return Ok(round);
        }
        if round.status != "pending" || self.clock.now() >= round.expires_at {
            return Err(conflict("round is not pending and current"));
        }
        if self
            .list_rounds()
            .await?
            .iter()
            .any(|r| matches!(r.status.as_str(), "active" | "recovery_required"))
        {
            return Err(conflict("finish or recover the active round first"));
        }
        round.status = "active".into();
        round.approved_at = Some(self.clock.now());
        round.approved_by = Some(actor.clone());
        self.dispatch_round_step(&mut round).await?;
        self.round_audit(&round, "round.approved", actor).await?;
        Ok(round)
    }

    /// Explicitly retires held work without deleting its evidence or releasing an old command early.
    pub async fn abandon_round(
        &self,
        id: &str,
        digest: &str,
        actor: AuditActor,
    ) -> Result<InspectionRound, ApplicationError> {
        let _reservation = self.approval_lock.lock().await;
        let mut round = self
            .round_store()?
            .get(id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "round" })?;
        if round.digest != digest {
            return Err(conflict("round abandonment digest mismatch"));
        }
        if round.status == "cancelled" {
            return Ok(round);
        }
        if round.status != "recovery_required" {
            return Err(conflict("only a held round can be abandoned"));
        }
        let mission_id = round
            .current_mission_id
            .as_ref()
            .ok_or_else(|| conflict("held round has no current mission"))?;
        let mut mission = self
            .missions
            .get(mission_id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "mission" })?;
        if mission.status != MissionStatus::RecoveryRequired {
            return Err(conflict("round mission is no longer held"));
        }
        let body_id = mission
            .assigned_body_id
            .clone()
            .ok_or_else(|| conflict("held round has no assigned body"))?;
        let handoffs = self
            .handoffs
            .as_ref()
            .ok_or_else(|| conflict("round abandonment requires durable body fences"))?;
        let now = self.clock.now();
        let fence_until = if mission.active_command_id.is_some() {
            mission
                .command_expires_at
                .unwrap_or(now + Duration::seconds(300))
        } else {
            now
        }
        .max(now)
            + Duration::seconds(2);
        handoffs.fence_body(&body_id, fence_until).await?;
        if let Some(mut body) = self.bodies.get(&body_id).await? {
            body.status = lattice_domain::BodyStatus::Offline;
            self.bodies.save(body).await?;
        }
        // Command delivery rejects cancelled missions; an already-delivered command
        // remains fenced until its signed authorization expires plus the stop margin.
        mission.status = MissionStatus::Cancelled;
        mission.updated_at = now;
        mission.status_detail = Some(format!(
            "Round explicitly abandoned; body authorization remains fenced through {}.",
            fence_until.to_rfc3339()
        ));
        self.missions.save(mission).await?;
        for mut proposal in handoffs.list_handoffs().await? {
            if proposal.round_id == round.id && proposal.status == "pending" {
                proposal.status = "invalidated".into();
                handoffs.save_handoff(proposal).await?;
            }
        }
        for mut proposal in self.proposals.list().await? {
            if proposal.recovery_of.as_ref() == Some(mission_id) && proposal.status == "pending" {
                proposal.status = "invalidated".into();
                self.proposals.save(proposal).await?;
            }
        }
        round.status = "cancelled".into();
        self.round_store()?.save(round.clone()).await?;
        self.invalidate_round_reviews(&round.id).await?;
        self.audit
            .append(AuditRecord {
                occurred_at: now,
                actor,
                event_type: "round.abandoned".into(),
                object_id: round.id.clone(),
                metadata: json!({
                    "digest": round.digest,
                    "mission_id": round.current_mission_id,
                    "body_id": body_id,
                    "fence_until": fence_until,
                    "route_plan_id": round.route_plan_id,
                }),
            })
            .await?;
        Ok(round)
    }

    pub(crate) async fn dispatch_round_step(
        &self,
        round: &mut InspectionRound,
    ) -> Result<(), ApplicationError> {
        let step = round
            .steps
            .get(round.current_step)
            .ok_or(ApplicationError::Infrastructure)?;
        let request = CreateMissionRequest {
            title: step.title.clone(),
            command: step.command.clone(),
        };
        let actor = round
            .approved_by
            .clone()
            .ok_or(ApplicationError::Security)?;
        // A route review binds each step to a body. Reaching a transfer never
        // dispatches the next body automatically, even when the source has that skill.
        let route_policy = self.planned_route_body(round).await;
        let hold_reason = match route_policy {
            Ok(Some(ref planned)) if round.assigned_body_id.as_ref() != Some(planned) => {
                Some(format!(
                    "Route requires a reviewed transfer to {planned} before step {}. Open transfer recommendations.",
                    round.current_step + 1
                ))
            }
            Err(crate::ApplicationError::Conflict(reason)) => Some(format!(
                "Route step held: {reason}. Review the route and current body position."
            )),
            Err(_) => Some(
                "Route map or approved assignment changed. Work remains held for a fresh review."
                    .into(),
            ),
            _ => None,
        };
        if let Some(reason) = hold_reason {
            let mut mission = Mission::new(
                MissionId::new(format!("mission-{}", uuid::Uuid::new_v4().simple()))?,
                request.title,
                request.command,
                self.clock.now(),
            )?;
            mission.assigned_body_id = round.assigned_body_id.clone();
            mission.continuation = round.continuation.clone();
            mission.require_recovery(self.clock.now());
            mission.status_detail = Some(reason);
            self.missions.save(mission.clone()).await?;
            round.status = "recovery_required".into();
            round.current_mission_id = Some(mission.id.clone());
            round.mission_ids.push(mission.id);
            self.round_store()?.save(round.clone()).await?;
            return Ok(());
        }
        let mission = match &round.assigned_body_id {
            Some(body_id) if self.body_available(body_id, &request.command).await? => {
                self.create_mission_for_body(
                    request,
                    body_id.clone(),
                    round.continuation.clone(),
                    actor,
                )
                .await?
            }
            Some(body_id) => {
                // Commit the previous step and its evidence even when its pinned body goes away.
                // No substitute is dispatched until a new operator review.
                let mut mission = Mission::new(
                    MissionId::new(format!("mission-{}", uuid::Uuid::new_v4().simple()))?,
                    request.title,
                    request.command,
                    self.clock.now(),
                )?;
                mission.assigned_body_id = Some(body_id.clone());
                mission.continuation = round.continuation.clone();
                mission.require_recovery(self.clock.now());
                mission.status_detail = Some(
                    "Pinned round body is unavailable. Review recovery or a body handoff.".into(),
                );
                round.status = "recovery_required".into();
                self.missions.save(mission.clone()).await?;
                mission
            }
            None => {
                let mission = self.create_mission(request, actor).await?;
                round.assigned_body_id = mission.assigned_body_id.clone();
                mission
            }
        };
        round.current_mission_id = Some(mission.id.clone());
        round.mission_ids.push(mission.id);
        self.round_store()?.save(round.clone()).await
    }
    pub(crate) async fn advance_round(&self, mission: &Mission) -> Result<(), ApplicationError> {
        let Some(store) = &self.rounds else {
            return Ok(());
        };
        if !matches!(
            mission.status,
            MissionStatus::Succeeded | MissionStatus::Failed
        ) {
            return Ok(());
        }
        for mut round in store.list().await? {
            if round.status != "active" || round.current_mission_id.as_ref() != Some(&mission.id) {
                continue;
            }
            if mission.status == MissionStatus::Failed {
                round.anomaly_count += 1;
                if round.route_plan_id.is_some()
                    && self.adaptive_routes.is_some()
                    && matches!(mission.command, SkillCommand::TraverseRoute { .. })
                {
                    self.hold_failed_route_round(&mut round, mission).await?;
                    continue;
                }
                if !round.steps[round.current_step].continue_on_missing_marker
                    || mission
                        .evidence
                        .as_ref()
                        .is_none_or(|e| !e.detections.is_empty())
                {
                    round.status = "failed".into();
                    store.save(round.clone()).await?;
                    self.round_audit(
                        &round,
                        "round.stopped",
                        AuditActor::Service("round-coordinator".into()),
                    )
                    .await?;
                    continue;
                }
            }
            if round.current_step + 1 == round.steps.len() {
                round.status = "completed".into();
                store.save(round.clone()).await?;
            } else {
                round.current_step += 1;
                self.dispatch_round_step(&mut round).await?;
            }
            self.round_audit(
                &round,
                "round.advanced",
                AuditActor::Service("round-coordinator".into()),
            )
            .await?;
        }
        Ok(())
    }
    pub(crate) async fn hold_round(&self, mission: &Mission) -> Result<(), ApplicationError> {
        if let Some(store) = &self.rounds {
            for mut round in store.list().await? {
                if round.status == "active"
                    && round.current_mission_id.as_ref() == Some(&mission.id)
                {
                    round.status = "recovery_required".into();
                    store.save(round).await?;
                }
            }
        }
        Ok(())
    }

    pub(crate) async fn recover_round_mission(
        &self,
        old: &MissionId,
        new: &MissionId,
    ) -> Result<(), ApplicationError> {
        let Some(store) = &self.rounds else {
            return Ok(());
        };
        for mut round in store.list().await? {
            if round.status == "recovery_required" && round.current_mission_id.as_ref() == Some(old)
            {
                let mission = self
                    .missions
                    .get(new)
                    .await?
                    .ok_or(ApplicationError::Infrastructure)?;
                round.assigned_body_id = mission.assigned_body_id.clone();
                round.continuation = mission.continuation.clone();
                round.current_mission_id = Some(new.clone());
                round.mission_ids.push(new.clone());
                round.status = "active".into();
                store.save(round.clone()).await?;
                if let Some(handoffs) = &self.handoffs {
                    for mut proposal in handoffs.list_handoffs().await? {
                        if proposal.round_id == round.id && proposal.status == "pending" {
                            proposal.status = "invalidated".into();
                            handoffs.save_handoff(proposal).await?;
                        }
                    }
                }
                self.round_audit(
                    &round,
                    "round.recovered",
                    AuditActor::Service("round-coordinator".into()),
                )
                .await?;
            }
        }
        Ok(())
    }
    pub(crate) fn round_store(
        &self,
    ) -> Result<&std::sync::Arc<dyn crate::RoundRepository>, ApplicationError> {
        self.rounds
            .as_ref()
            .ok_or_else(|| conflict("inspection rounds require durable storage"))
    }
    async fn round_audit(
        &self,
        round: &InspectionRound,
        event: &str,
        actor: AuditActor,
    ) -> Result<(), ApplicationError> {
        self.audit.append(AuditRecord{occurred_at:self.clock.now(),actor,event_type:event.into(),object_id:round.id.clone(),metadata:json!({"digest":round.digest,"step":round.current_step,"mission_id":round.current_mission_id,"status":round.status,"anomalies":round.anomaly_count})}).await
    }
}
fn conflict(s: &str) -> ApplicationError {
    ApplicationError::Conflict(s.into())
}
