//! Reviewed transfer of a round cursor and validated evidence between body instances.
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use lattice_domain::{
    AuditActor, AuditRecord, BodyId, ContinuationContext, InspectionEvidence, Mission, MissionId,
    MissionStatus, ObservationReference, SkillCommand,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{ApplicationError, CreateMissionRequest, LatticeService, Observation, RoundStep};

/// An immutable review snapshot plus its mutable approval/receipt outcome.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HandoffProposal {
    /// Stable review identity.
    pub id: String,
    /// Digest binding the frozen source, target, cursor, evidence and deadlines.
    pub digest: String,
    /// Original inspection objective.
    pub round_id: String,
    /// Body whose old execution authorization is withdrawn.
    pub source_body_id: BodyId,
    /// Only body permitted to continue this snapshot.
    pub target_body_id: BodyId,
    /// Snapshot time.
    pub created_at: DateTime<Utc>,
    /// Approval deadline.
    pub expires_at: DateTime<Utc>,
    /// Original signed command expiry plus clock-skew allowance.
    pub not_before_at: DateTime<Utc>,
    /// pending, approved or invalidated.
    pub status: String,
    /// Finished steps, retained only for context; never reexecuted by this transfer.
    pub completed_steps: Vec<RoundStep>,
    /// Current unfinished step followed by the original approved suffix.
    pub remaining_steps: Vec<RoundStep>,
    /// Identifiers of retained validated observations.
    pub retained_observation_ids: Vec<String>,
    /// Context delivered inside every signed continuation command.
    pub context: ContinuationContext,
    /// Held original mission.
    pub source_mission_id: MissionId,
    /// New execution attempt, populated exactly once on approval.
    pub resumed_mission_id: Option<MissionId>,
    /// Approval timestamp.
    pub approved_at: Option<DateTime<Utc>>,
    /// First matching body acknowledgement of evidence delivery.
    pub context_acknowledged_at: Option<DateTime<Utc>>,
}
impl HandoffProposal {
    fn computed_digest(&self) -> Result<String, ApplicationError> {
        let snapshot = (
            &self.id,
            &self.round_id,
            &self.source_body_id,
            &self.target_body_id,
            self.created_at,
            self.expires_at,
            self.not_before_at,
            &self.completed_steps,
            &self.remaining_steps,
            &self.retained_observation_ids,
            &self.context,
            &self.source_mission_id,
        );
        Ok(format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&snapshot).map_err(|_| ApplicationError::Infrastructure)?
            )
        ))
    }
}

/// Transaction-scoped handoff history and persistent body authorization fences.
#[async_trait]
pub trait HandoffRepository: Send + Sync {
    /// Saves the frozen review and mutable outcome.
    async fn save_handoff(&self, proposal: HandoffProposal) -> Result<(), ApplicationError>;
    /// Loads one review.
    async fn get_handoff(&self, id: &str) -> Result<Option<HandoffProposal>, ApplicationError>;
    /// Lists review history.
    async fn list_handoffs(&self) -> Result<Vec<HandoffProposal>, ApplicationError>;
    /// Monotonically extends a body fence; an older proposal cannot shorten it.
    async fn fence_body(&self, body: &BodyId, until: DateTime<Utc>)
    -> Result<(), ApplicationError>;
    /// Returns the latest fence deadline, including an elapsed one.
    async fn body_fence(&self, body: &BodyId) -> Result<Option<DateTime<Utc>>, ApplicationError>;
}

impl LatticeService {
    /// Lists immutable handoff reviews and evidence acknowledgement outcomes.
    pub async fn list_handoffs(&self) -> Result<Vec<HandoffProposal>, ApplicationError> {
        let mut rows = self.handoff_store()?.list_handoffs().await?;
        rows.sort_by_key(|h| std::cmp::Reverse(h.created_at));
        Ok(rows)
    }

    /// Holds the source and freezes a continuation review without dispatching its target.
    pub async fn propose_handoff(
        &self,
        round_id: &str,
        target_body_id: BodyId,
        actor: AuditActor,
    ) -> Result<HandoffProposal, ApplicationError> {
        let _reservation = self.approval_lock.lock().await;
        let mut round = self
            .round_store()?
            .get(round_id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "round" })?;
        if !matches!(round.status.as_str(), "active" | "recovery_required") {
            return Err(conflict("only an active or held round can be handed off"));
        }
        let source_mission_id = round
            .current_mission_id
            .clone()
            .ok_or_else(|| conflict("round has no current mission"))?;
        let mut source = self
            .missions
            .get(&source_mission_id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "mission" })?;
        if !matches!(
            source.status,
            MissionStatus::Assigned | MissionStatus::Running | MissionStatus::RecoveryRequired
        ) {
            return Err(conflict("current round mission is not transferable"));
        }
        let source_body_id = source
            .assigned_body_id
            .clone()
            .ok_or_else(|| conflict("round has no source body"))?;
        if source_body_id == target_body_id {
            return Err(conflict(
                "handoff requires a different body; use recovery to continue on the same rover",
            ));
        }
        self.validate_route_transfer(&round, &target_body_id)
            .await?;
        for step in self.handoff_target_steps(&round, &target_body_id).await? {
            if !self.body_available(&target_body_id, &step.command).await? {
                return Err(conflict(
                    "target body must be fresh, capable of every remaining step, unfenced and idle",
                ));
            }
        }
        let now = self.clock.now();
        let not_before_at = if source.active_command_id.is_some() {
            source
                .command_expires_at
                .unwrap_or(now + Duration::seconds(300))
                + Duration::seconds(2)
        } else {
            now + Duration::seconds(2)
        }
        .max(now);
        let expires_at = not_before_at + Duration::minutes(5);
        let id = format!("handoff-{}", uuid::Uuid::new_v4().simple());
        let observations = self
            .observations
            .as_ref()
            .ok_or_else(|| conflict("handoff requires durable observation memory"))?;
        let mut refs = Vec::new();
        for mission_id in &round.mission_ids {
            if let Some(mission) = self.missions.get(mission_id).await?
                && let Some(command_id) = mission.active_command_id
                && let Some(observation) = observations
                    .get_observation(&format!("observation-{command_id}"))
                    .await?
            {
                if observation.mission_id != *mission_id {
                    return Err(ApplicationError::Security);
                }
                refs.push(ObservationReference {
                    observation_id: observation.id,
                    image_sha256: observation.image_sha256,
                });
            }
        }
        if refs.len() > 6 {
            return Err(conflict("round observation context exceeded its bound"));
        }
        let mut context = ContinuationContext {
            handoff_id: id.clone(),
            round_id: round.id.clone(),
            source_body_id: source_body_id.clone(),
            target_body_id: target_body_id.clone(),
            completed_steps: round.current_step,
            observations: refs,
            digest: String::new(),
        };
        context.digest = context
            .compute_digest()
            .map_err(|_| ApplicationError::Infrastructure)?;
        context.validate()?;
        let mut proposal = HandoffProposal {
            id,
            digest: String::new(),
            round_id: round.id.clone(),
            source_body_id: source_body_id.clone(),
            target_body_id,
            created_at: now,
            expires_at,
            not_before_at,
            status: "pending".into(),
            completed_steps: round.steps[..round.current_step].to_vec(),
            remaining_steps: round.steps[round.current_step..].to_vec(),
            retained_observation_ids: context
                .observations
                .iter()
                .map(|r| r.observation_id.clone())
                .collect(),
            context,
            source_mission_id,
            resumed_mission_id: None,
            approved_at: None,
            context_acknowledged_at: None,
        };
        proposal.digest = proposal.computed_digest()?;
        // The withdrawal, held cursor, fence, review and audit commit together.
        source.require_recovery(now);
        source.status_detail = Some(format!(
            "Held for reviewed handoff {}. Source authorization is fenced through {}.",
            proposal.id,
            not_before_at.to_rfc3339()
        ));
        self.missions.save(source).await?;
        round.status = "recovery_required".into();
        round.assigned_body_id = Some(source_body_id.clone());
        self.round_store()?.save(round).await?;
        self.handoff_store()?
            .fence_body(&source_body_id, not_before_at)
            .await?;
        if let Some(mut body) = self.bodies.get(&source_body_id).await? {
            body.status = lattice_domain::BodyStatus::Offline;
            self.bodies.save(body).await?;
        }
        for mut other in self.handoff_store()?.list_handoffs().await? {
            if other.round_id == proposal.round_id && other.status == "pending" {
                other.status = "invalidated".into();
                self.handoff_store()?.save_handoff(other).await?;
            }
        }
        self.handoff_store()?.save_handoff(proposal.clone()).await?;
        self.handoff_audit(&proposal, "handoff.proposed", actor)
            .await?;
        Ok(proposal)
    }

    /// Approves exactly one frozen target and suffix after the old command can no longer run.
    pub async fn approve_handoff(
        &self,
        id: &str,
        digest: &str,
        actor: AuditActor,
    ) -> Result<HandoffProposal, ApplicationError> {
        let _reservation = self.approval_lock.lock().await;
        let mut proposal = self
            .handoff_store()?
            .get_handoff(id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "handoff" })?;
        if proposal.digest != digest || proposal.computed_digest()? != digest {
            return Err(conflict("handoff digest mismatch"));
        }
        if proposal.status == "approved" {
            return Ok(proposal);
        }
        let now = self.clock.now();
        if proposal.status != "pending" || now >= proposal.expires_at {
            return Err(conflict("handoff review is no longer pending and current"));
        }
        if now < proposal.not_before_at {
            return Err(conflict(
                "source command has not reached its safe expiry; wait until not_before_at",
            ));
        }
        proposal.context.validate()?;
        let mut round = self
            .round_store()?
            .get(&proposal.round_id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "round" })?;
        if round.status != "recovery_required"
            || round.current_mission_id.as_ref() != Some(&proposal.source_mission_id)
            || round.current_step != proposal.completed_steps.len()
            || round.assigned_body_id.as_ref() != Some(&proposal.source_body_id)
        {
            return Err(conflict("round changed after this handoff review"));
        }
        let mut source = self
            .missions
            .get(&proposal.source_mission_id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "mission" })?;
        if source.status != MissionStatus::RecoveryRequired
            || source.assigned_body_id.as_ref() != Some(&proposal.source_body_id)
        {
            return Err(conflict(
                "source mission is no longer held for this transfer",
            ));
        }
        self.validate_route_transfer(&round, &proposal.target_body_id)
            .await?;
        for step in self
            .handoff_target_steps(&round, &proposal.target_body_id)
            .await?
        {
            if !self
                .body_available(&proposal.target_body_id, &step.command)
                .await?
            {
                return Err(conflict(
                    "target body must be fresh, capable of every remaining step, unfenced and idle",
                ));
            }
        }
        let step = proposal
            .remaining_steps
            .first()
            .ok_or(ApplicationError::Infrastructure)?;
        let mission = self
            .create_mission_for_body(
                CreateMissionRequest {
                    title: step.title.clone(),
                    command: step.command.clone(),
                },
                proposal.target_body_id.clone(),
                Some(proposal.context.clone()),
                actor.clone(),
            )
            .await?;
        source.status = MissionStatus::Cancelled;
        source.updated_at = now;
        source.status_detail = Some(format!(
            "Transferred after review as {} on {}",
            mission.id, proposal.target_body_id
        ));
        self.missions.save(source).await?;
        round.status = "active".into();
        round.assigned_body_id = Some(proposal.target_body_id.clone());
        round.continuation = Some(proposal.context.clone());
        round.current_mission_id = Some(mission.id.clone());
        round.mission_ids.push(mission.id.clone());
        self.round_store()?.save(round).await?;
        proposal.status = "approved".into();
        proposal.approved_at = Some(now);
        proposal.resumed_mission_id = Some(mission.id);
        self.handoff_store()?.save_handoff(proposal.clone()).await?;
        for mut other in self.handoff_store()?.list_handoffs().await? {
            if other.round_id == proposal.round_id
                && other.id != proposal.id
                && other.status == "pending"
            {
                other.status = "invalidated".into();
                self.handoff_store()?.save_handoff(other).await?;
            }
        }
        self.handoff_audit(&proposal, "handoff.approved", actor)
            .await?;
        Ok(proposal)
    }

    /// Returns only source evidence explicitly named in this body's active signed context.
    pub async fn handoff_evidence(
        &self,
        body_id: &BodyId,
        mission_id: &MissionId,
        observation_id: &str,
    ) -> Result<(Observation, InspectionEvidence), ApplicationError> {
        let mission = self
            .missions
            .get(mission_id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "mission" })?;
        if mission.assigned_body_id.as_ref() != Some(body_id)
            || !matches!(
                mission.status,
                MissionStatus::Assigned | MissionStatus::Running
            )
            || mission
                .command_expires_at
                .is_none_or(|deadline| self.clock.now() >= deadline)
        {
            return Err(ApplicationError::Security);
        }
        let context = mission
            .continuation
            .as_ref()
            .ok_or(ApplicationError::Security)?;
        context.validate()?;
        if context.target_body_id != *body_id {
            return Err(ApplicationError::Security);
        }
        let reference = context
            .observations
            .iter()
            .find(|r| r.observation_id == observation_id)
            .ok_or(ApplicationError::Security)?;
        let observation = self.observation(observation_id).await?;
        if observation.image_sha256 != reference.image_sha256 {
            return Err(ApplicationError::Security);
        }
        let evidence = self.source_evidence(&observation).await?;
        if evidence.image_sha256 != reference.image_sha256 {
            return Err(ApplicationError::Security);
        }
        Ok((observation, evidence))
    }

    pub(crate) async fn acknowledge_handoff(
        &self,
        mission: &Mission,
    ) -> Result<(), ApplicationError> {
        let Some(context) = &mission.continuation else {
            return Ok(());
        };
        let mut proposal = self
            .handoff_store()?
            .get_handoff(&context.handoff_id)
            .await?
            .ok_or(ApplicationError::Security)?;
        if proposal.status != "approved"
            || proposal.context.digest != context.digest
            || mission.assigned_body_id.as_ref() != Some(&proposal.target_body_id)
        {
            return Err(ApplicationError::Security);
        }
        if proposal.context_acknowledged_at.is_none() {
            proposal.context_acknowledged_at = Some(self.clock.now());
            self.handoff_store()?.save_handoff(proposal.clone()).await?;
            self.handoff_audit(
                &proposal,
                "handoff.context_acknowledged",
                AuditActor::Body(proposal.target_body_id.to_string()),
            )
            .await?;
        }
        Ok(())
    }

    pub(crate) async fn ensure_not_fenced(&self, body_id: &BodyId) -> Result<(), ApplicationError> {
        if let Some(store) = &self.handoffs
            && store
                .body_fence(body_id)
                .await?
                .is_some_and(|until| self.clock.now() < until)
        {
            return Err(conflict(
                "body execution is fenced while a reviewed handoff withdraws its previous authorization",
            ));
        }
        Ok(())
    }

    pub(crate) async fn body_available(
        &self,
        body_id: &BodyId,
        command: &SkillCommand,
    ) -> Result<bool, ApplicationError> {
        if let Some(store) = &self.handoffs
            && store
                .body_fence(body_id)
                .await?
                .is_some_and(|until| self.clock.now() < until)
        {
            return Ok(false);
        }
        let Some(body) = self.bodies.get(body_id).await? else {
            return Ok(false);
        };
        if command.required_capabilities().iter().any(|capability| {
            !body.is_eligible(*capability, self.clock.now(), self.config.heartbeat_timeout)
        }) {
            return Ok(false);
        }
        Ok(!self.missions.list().await?.iter().any(|m| {
            m.assigned_body_id.as_ref() == Some(body_id)
                && matches!(m.status, MissionStatus::Assigned | MissionStatus::Running)
        }))
    }

    pub(crate) async fn create_mission_for_body(
        &self,
        request: CreateMissionRequest,
        body_id: BodyId,
        context: Option<ContinuationContext>,
        actor: AuditActor,
    ) -> Result<Mission, ApplicationError> {
        if !self.body_available(&body_id, &request.command).await? {
            return Err(conflict(
                "target body must be fresh, capable, unfenced and idle",
            ));
        }
        let mut mission = Mission::new(
            MissionId::new(format!("mission-{}", uuid::Uuid::new_v4().simple()))?,
            request.title,
            request.command,
            self.clock.now(),
        )?;
        mission.continuation = context;
        self.assign_and_enqueue(&mut mission, body_id, actor)
            .await?;
        Ok(mission)
    }

    fn handoff_store(&self) -> Result<&dyn HandoffRepository, ApplicationError> {
        self.handoffs
            .as_deref()
            .ok_or_else(|| conflict("reviewed handoff requires durable storage"))
    }

    async fn handoff_audit(
        &self,
        proposal: &HandoffProposal,
        event: &str,
        actor: AuditActor,
    ) -> Result<(), ApplicationError> {
        self.audit.append(AuditRecord { occurred_at: self.clock.now(), actor, event_type: event.into(), object_id: proposal.id.clone(),
            metadata: json!({"digest":proposal.digest,"round_id":proposal.round_id,"source_body_id":proposal.source_body_id,"target_body_id":proposal.target_body_id,"not_before_at":proposal.not_before_at,"context_digest":proposal.context.digest,"retained_observation_ids":proposal.retained_observation_ids,"resumed_mission_id":proposal.resumed_mission_id}) }).await
    }
}
fn conflict(message: &str) -> ApplicationError {
    ApplicationError::Conflict(message.into())
}
