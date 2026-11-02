use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use chrono::Duration as ChronoDuration;
use lattice_domain::{
    AuditActor, AuditRecord, BatteryPercent, BodyId, BodyKind, BodySnapshot, BodyStatus,
    CommandEnvelope, CommandId, CommandResult, CommandResultStatus, Mission, MissionId,
    MissionStatus, SignedCommand, SkillCommand, VerificationKey,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{
    ApplicationError, AuditSink, BodyRepository, Clock, CommandQueue, CommandSigner,
    MissionRepository,
};

/// Timing and availability policy for the trusted core.
#[derive(Debug, Clone)]
pub struct ServiceConfig {
    /// Signed-command lifetime.
    pub command_ttl: Duration,
    /// Maximum heartbeat age for assignment.
    pub heartbeat_timeout: Duration,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            command_ttl: Duration::from_secs(30),
            heartbeat_timeout: Duration::from_secs(10),
        }
    }
}

/// Body registration input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterBodyRequest {
    /// Stable identity.
    pub id: BodyId,
    /// Operator-facing name.
    pub display_name: String,
    /// Physical category.
    pub kind: BodyKind,
    /// Explicit capabilities.
    pub capabilities: BTreeSet<lattice_domain::Capability>,
    /// Adapter software version.
    pub adapter_version: String,
}

/// Authenticated body heartbeat.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatRequest {
    /// Current readiness.
    pub status: BodyStatus,
    /// Current battery.
    pub battery: BatteryPercent,
    /// Semantic location.
    pub location: String,
    /// Optional map-frame telemetry; legacy mock bodies omit this field.
    #[serde(default)]
    pub pose: Option<lattice_domain::BodyPose>,
}

/// New mission input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMissionRequest {
    /// Operator-facing title.
    pub title: String,
    /// Typed skill.
    pub command: SkillCommand,
}

/// Application facade used by transports.
#[derive(Clone)]
pub struct LatticeService {
    pub(crate) bodies: Arc<dyn BodyRepository>,
    pub(crate) missions: Arc<dyn MissionRepository>,
    pub(crate) commands: Arc<dyn CommandQueue>,
    pub(crate) signer: Arc<dyn CommandSigner>,
    pub(crate) audit: Arc<dyn AuditSink>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) config: ServiceConfig,
    pub(crate) proposals: Arc<dyn crate::ProposalRepository>,
    pub(crate) rounds: Option<Arc<dyn crate::RoundRepository>>,
    pub(crate) observations: Option<Arc<dyn crate::ObservationRepository>>,
    pub(crate) handoffs: Option<Arc<dyn crate::HandoffRepository>>,
    pub(crate) approval_lock: Arc<tokio::sync::Mutex<()>>,
}

impl LatticeService {
    /// Creates the application facade.
    pub fn new(
        bodies: Arc<dyn BodyRepository>,
        missions: Arc<dyn MissionRepository>,
        commands: Arc<dyn CommandQueue>,
        signer: Arc<dyn CommandSigner>,
        audit: Arc<dyn AuditSink>,
        clock: Arc<dyn Clock>,
        config: ServiceConfig,
    ) -> Self {
        Self {
            rounds: None,
            observations: None,
            handoffs: None,
            proposals: Arc::new(crate::proposal::Proposals::default()),
            approval_lock: Arc::default(),
            bodies,
            missions,
            commands,
            signer,
            audit,
            clock,
            config,
        }
    }

    /// Replaces the disposable proposal store with the current transaction.
    pub fn with_proposals(mut self, proposals: Arc<dyn crate::ProposalRepository>) -> Self {
        self.proposals = proposals;
        self
    }

    /// Rebinds persistence ports to one database transaction, retaining policy and signer.
    pub fn in_transaction<T>(&self, unit: Arc<T>) -> Self
    where
        T: BodyRepository
            + MissionRepository
            + CommandQueue
            + AuditSink
            + crate::ProposalRepository
            + crate::RoundRepository
            + crate::ObservationRepository
            + crate::HandoffRepository
            + 'static,
    {
        Self::new(
            unit.clone(),
            unit.clone(),
            unit.clone(),
            self.signer.clone(),
            unit.clone(),
            self.clock.clone(),
            self.config.clone(),
        )
        .with_proposals(unit.clone())
        .with_rounds(unit.clone())
        .with_observations(unit.clone())
        .with_handoffs(unit)
    }

    /// Installs the transaction-scoped round store.
    pub fn with_rounds(mut self, rounds: Arc<dyn crate::RoundRepository>) -> Self {
        self.rounds = Some(rounds);
        self
    }

    /// Installs shared observation storage on the same transaction as mission results.
    pub fn with_observations(
        mut self,
        observations: Arc<dyn crate::ObservationRepository>,
    ) -> Self {
        self.observations = Some(observations);
        self
    }

    /// Installs durable reviewed handoff and body-fence storage.
    pub fn with_handoffs(mut self, handoffs: Arc<dyn crate::HandoffRepository>) -> Self {
        self.handoffs = Some(handoffs);
        self
    }

    /// Registers or updates a body identity.
    pub async fn register_body(
        &self,
        request: RegisterBodyRequest,
        actor: AuditActor,
    ) -> Result<BodySnapshot, ApplicationError> {
        self.ensure_not_fenced(&request.id).await?;
        validate_display_name(&request.display_name)?;
        validate_version(&request.adapter_version)?;

        let now = self.clock.now();
        let body = BodySnapshot {
            id: request.id,
            display_name: request.display_name.trim().to_owned(),
            kind: request.kind,
            status: BodyStatus::Online,
            battery: BatteryPercent::new(100)?,
            location: "registration".to_owned(),
            pose: None,
            capabilities: request.capabilities,
            last_seen: now,
            adapter_version: request.adapter_version,
        };

        self.bodies.save(body.clone()).await?;
        self.audit
            .append(AuditRecord {
                occurred_at: now,
                actor,
                event_type: "body.registered".to_owned(),
                object_id: body.id.to_string(),
                metadata: json!({
                    "kind": body.kind,
                    "capabilities": body.capabilities,
                    "adapter_version": body.adapter_version,
                }),
            })
            .await?;

        Ok(body)
    }

    /// Applies a body heartbeat.
    pub async fn heartbeat(
        &self,
        body_id: &BodyId,
        request: HeartbeatRequest,
    ) -> Result<BodySnapshot, ApplicationError> {
        self.ensure_not_fenced(body_id).await?;
        let Some(mut body) = self.bodies.get(body_id).await? else {
            return Err(ApplicationError::NotFound { entity: "body" });
        };

        validate_location(&request.location)?;
        if let Some(pose) = request.pose {
            pose.validate()?;
        }
        body.status = request.status;
        body.battery = request.battery;
        body.location = request.location.trim().to_owned();
        body.pose = request.pose;
        body.last_seen = self.clock.now();
        self.bodies.save(body.clone()).await?;
        Ok(body)
    }

    /// Lists known bodies.
    pub async fn list_bodies(&self) -> Result<Vec<BodySnapshot>, ApplicationError> {
        let mut bodies = self.bodies.list().await?;
        bodies.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(bodies)
    }

    /// Creates and, when possible, dispatches a mission.
    pub async fn create_mission(
        &self,
        request: CreateMissionRequest,
        actor: AuditActor,
    ) -> Result<Mission, ApplicationError> {
        let now = self.clock.now();
        let mission_id = MissionId::new(format!("mission-{}", Uuid::new_v4().simple()))?;
        let mut mission = Mission::new(mission_id, request.title, request.command, now)?;

        if let Some(body) = self.select_body(&mission, None).await? {
            self.assign_and_enqueue(&mut mission, body.id, actor)
                .await?;
        } else {
            self.missions.save(mission.clone()).await?;
            self.audit
                .append(AuditRecord {
                    occurred_at: now,
                    actor,
                    event_type: "mission.queued".to_owned(),
                    object_id: mission.id.to_string(),
                    metadata: json!({
                        "required_capability": mission.command.required_capability(),
                    }),
                })
                .await?;
        }

        Ok(mission)
    }

    /// Lists missions newest first.
    pub async fn list_missions(&self) -> Result<Vec<Mission>, ApplicationError> {
        let mut missions = self.missions.list().await?;
        missions.sort_by_key(|mission| std::cmp::Reverse(mission.created_at));
        Ok(missions)
    }

    /// Retrieves the next valid command for one body.
    pub async fn next_command(
        &self,
        body_id: &BodyId,
    ) -> Result<Option<SignedCommand>, ApplicationError> {
        let now = self.clock.now();

        self.ensure_not_fenced(body_id).await?;
        while let Some(command) = self.commands.dequeue(body_id).await? {
            if command.envelope.body_id != *body_id {
                self.audit_rejection(
                    "command.wrong_body_rejected",
                    &command.envelope.command_id,
                    body_id,
                )
                .await?;
                continue;
            }

            let Some(mut mission) = self.missions.get(&command.envelope.mission_id).await? else {
                continue;
            };
            if mission.active_command_id.as_ref() != Some(&command.envelope.command_id)
                || !matches!(
                    mission.status,
                    MissionStatus::Assigned | MissionStatus::Running
                )
            {
                continue;
            }
            if command.envelope.is_expired(now) {
                mission.require_recovery(now);
                mission.status_detail =
                    Some("Command expired before delivery. Review a recovery proposal.".into());
                self.hold_round(&mission).await?;
                self.missions.save(mission).await?;
                self.audit_rejection("command.expired", &command.envelope.command_id, body_id)
                    .await?;
                continue;
            }

            return Ok(Some(command));
        }

        Ok(None)
    }

    /// Applies a result after the transport resolves the parent mission.
    pub async fn report_result(
        &self,
        mission_id: &MissionId,
        result: CommandResult,
    ) -> Result<Mission, ApplicationError> {
        if result.progress_pct > 100 {
            return Err(ApplicationError::Conflict(
                "progress_pct must not exceed 100".to_owned(),
            ));
        }

        let Some(mut mission) = self.missions.get(mission_id).await? else {
            return Err(ApplicationError::NotFound { entity: "mission" });
        };

        if mission.assigned_body_id.as_ref() != Some(&result.body_id) {
            return Err(ApplicationError::Conflict(
                "result body does not own the mission".to_owned(),
            ));
        }

        if mission.active_command_id.as_ref() != Some(&result.command_id) {
            return Err(ApplicationError::Conflict(
                "result command does not own the mission".into(),
            ));
        }
        if matches!(
            mission.status,
            MissionStatus::RecoveryRequired | MissionStatus::Cancelled
        ) {
            self.audit_rejection(
                "command.late_result_ignored",
                &result.command_id,
                &result.body_id,
            )
            .await?;
            return Ok(mission);
        }
        if let Some(context) = &mission.continuation {
            if result.context_digest.as_deref() != Some(context.digest.as_str()) {
                return Err(ApplicationError::Conflict(
                    "continuation context receipt is missing or different".into(),
                ));
            }
        } else if result.context_digest.is_some() {
            return Err(ApplicationError::Conflict(
                "unexpected continuation context receipt".into(),
            ));
        }
        // Retrying a terminal acknowledgement must not lose an already committed result.
        if matches!(
            (mission.status, result.status),
            (MissionStatus::Succeeded, CommandResultStatus::Succeeded)
                | (
                    MissionStatus::Failed,
                    CommandResultStatus::Failed | CommandResultStatus::Rejected
                )
        ) {
            return Ok(mission);
        }
        let now = self.clock.now();
        if let Some(evidence) = &result.evidence {
            use base64::{Engine, engine::general_purpose::STANDARD};
            use sha2::{Digest, Sha256};
            let bad = || ApplicationError::Conflict("invalid inspection evidence".into());
            if !matches!(mission.command, SkillCommand::Inspect { .. })
                || !matches!(
                    result.status,
                    CommandResultStatus::Succeeded | CommandResultStatus::Failed
                )
                || evidence.image_base64.len() > 54_000
                || evidence.detections.len() > 16
                || evidence.model_id.len() > 120
                || evidence.confidence_domain.len() > 150
                || evidence.captured_at_ms < mission.created_at.timestamp_millis()
                || evidence.captured_at_ms > now.timestamp_millis() + 2000
                || now.timestamp_millis() - evidence.captured_at_ms > 30_000
                || evidence.frame_sha256.len() != 64
                || !evidence.frame_sha256.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(bad());
            }
            let image = STANDARD.decode(&evidence.image_base64).map_err(|_| bad())?;
            if image.len() > 40_000
                || !image.starts_with(&[0xff, 0xd8, 0xff])
                || format!("{:x}", Sha256::digest(&image)) != evidence.image_sha256
            {
                return Err(bad());
            }
            for detection in &evidence.detections {
                let [x, y, w, h] = detection.r#box;
                if detection.label != "octagonal_safety_marker"
                    || !detection.confidence.is_finite()
                    || !(0.8..=1.0).contains(&detection.confidence)
                    || w == 0
                    || h == 0
                    || x >= 320
                    || y >= 240
                    || w > 320 - x
                    || h > 240 - y
                {
                    return Err(bad());
                }
            }
        }
        if matches!(mission.command, SkillCommand::Inspect { .. })
            && result.status == CommandResultStatus::Succeeded
            && result
                .evidence
                .as_ref()
                .is_none_or(|e| e.detections.is_empty())
        {
            return Err(ApplicationError::Conflict(
                "successful inspection requires detection evidence".into(),
            ));
        }
        match result.status {
            CommandResultStatus::Running => {
                mission.mark_running(&result.command_id, result.progress_pct, now)?;
            }
            CommandResultStatus::Succeeded => {
                mission.mark_succeeded(&result.command_id, now)?;
            }
            CommandResultStatus::Failed | CommandResultStatus::Rejected => {
                mission.mark_failed(
                    &result.command_id,
                    result
                        .detail
                        .clone()
                        .unwrap_or_else(|| "body reported failure".to_owned()),
                    now,
                )?;
            }
        }

        if result.evidence.is_some() {
            mission.evidence = result.evidence.clone();
        }
        self.missions.save(mission.clone()).await?;
        self.audit
            .append(AuditRecord {
                occurred_at: now,
                actor: AuditActor::Body(result.body_id.to_string()),
                event_type: format!("command.result.{:?}", result.status).to_lowercase(),
                object_id: result.command_id.to_string(),
                metadata: json!({
                    "mission_id": mission.id,
                    "progress_pct": result.progress_pct,
                    "reported_at": result.reported_at,
                    "evidence_sha256": result.evidence.as_ref().map(|e| &e.image_sha256),
                }),
            })
            .await?;

        self.record_observation(&mission).await?;
        self.acknowledge_handoff(&mission).await?;
        self.advance_round(&mission).await?;
        Ok(mission)
    }

    /// Reassigns queued or interrupted missions and work owned by stale bodies.
    pub async fn reassign_unavailable(
        &self,
        actor: AuditActor,
    ) -> Result<Vec<Mission>, ApplicationError> {
        let now = self.clock.now();
        let mut changed = Vec::new();

        for mut mission in self.missions.list().await? {
            if matches!(
                mission.status,
                MissionStatus::Succeeded
                    | MissionStatus::Failed
                    | MissionStatus::Cancelled
                    | MissionStatus::RecoveryRequired
            ) {
                continue;
            }

            let old_body_id = mission.assigned_body_id.clone();
            let current_is_eligible = match &old_body_id {
                Some(body_id) => self.bodies.get(body_id).await?.is_some_and(|body| {
                    body.is_eligible(
                        mission.command.required_capability(),
                        now,
                        self.config.heartbeat_timeout,
                    )
                }),
                None => false,
            };

            if current_is_eligible {
                continue;
            }

            if self.rounds.as_ref().is_some() {
                let is_round = self.round_store()?.list().await?.iter().any(|r| {
                    r.current_mission_id.as_ref() == Some(&mission.id)
                        && matches!(r.status.as_str(), "active" | "recovery_required")
                });
                if is_round {
                    mission.require_recovery(now);
                    mission.status_detail = Some("Assigned rover became unavailable. Review same-body recovery or a body handoff.".into());
                    self.hold_round(&mission).await?;
                    self.missions.save(mission.clone()).await?;
                    changed.push(mission);
                    continue;
                }
            }

            if matches!(
                mission.status,
                MissionStatus::Assigned | MissionStatus::Running
            ) {
                mission.interrupt("assigned body became unavailable", now)?;
                self.missions.save(mission.clone()).await?;
            }

            if let Some(replacement) = self.select_body(&mission, old_body_id.as_ref()).await? {
                self.assign_and_enqueue(&mut mission, replacement.id, actor.clone())
                    .await?;
            } else if mission.status == MissionStatus::Interrupted {
                mission.queue_after_interruption(now)?;
                self.missions.save(mission.clone()).await?;
            }

            changed.push(mission);
        }

        Ok(changed)
    }

    /// Returns the current command-verification key.
    pub async fn verification_key(&self) -> Result<VerificationKey, ApplicationError> {
        self.signer.verification_key().await
    }

    /// Lists development audit records.
    pub async fn list_audit(&self) -> Result<Vec<AuditRecord>, ApplicationError> {
        self.audit.list().await
    }

    pub(crate) async fn assign_and_enqueue(
        &self,
        mission: &mut Mission,
        body_id: BodyId,
        actor: AuditActor,
    ) -> Result<(), ApplicationError> {
        let now = self.clock.now();
        let sequence = self.commands.next_sequence(&body_id).await?;
        let command_id = CommandId::new(format!("command-{}", Uuid::new_v4().simple()))?;
        let ttl = ChronoDuration::from_std(self.config.command_ttl)
            .map_err(|_| ApplicationError::Conflict("invalid command TTL".to_owned()))?;

        self.ensure_not_fenced(&body_id).await?;
        if let Some(context) = &mission.continuation {
            context.validate()?;
            if context.target_body_id != body_id {
                return Err(ApplicationError::Security);
            }
        }
        mission.assign(body_id.clone(), command_id.clone(), now)?;
        mission.command_expires_at = Some(now + ttl);
        let envelope = CommandEnvelope {
            command_id,
            mission_id: mission.id.clone(),
            body_id,
            sequence,
            command: mission.command.clone(),
            issued_at: now,
            expires_at: now + ttl,
            continuation: mission.continuation.clone(),
        };
        let signed = self.signer.sign(envelope.clone()).await?;

        self.missions.save(mission.clone()).await?;
        self.commands.enqueue(signed).await?;
        self.audit
            .append(AuditRecord {
                occurred_at: now,
                actor,
                event_type: "command.authorized".to_owned(),
                object_id: envelope.command_id.to_string(),
                metadata: json!({
                    "mission_id": envelope.mission_id,
                    "body_id": envelope.body_id,
                    "sequence": envelope.sequence,
                    "expires_at": envelope.expires_at,
                }),
            })
            .await?;
        Ok(())
    }

    pub(crate) async fn select_body(
        &self,
        mission: &Mission,
        exclude: Option<&BodyId>,
    ) -> Result<Option<BodySnapshot>, ApplicationError> {
        let now = self.clock.now();
        let capability = mission.command.required_capability();

        let mut candidates = self
            .bodies
            .list()
            .await?
            .into_iter()
            .filter(|body| exclude != Some(&body.id))
            .filter(|body| body.is_eligible(capability, now, self.config.heartbeat_timeout))
            .collect::<Vec<_>>();

        candidates.sort_by(|left, right| {
            right
                .battery
                .cmp(&left.battery)
                .then_with(|| left.id.cmp(&right.id))
        });

        for candidate in candidates {
            if self.body_available(&candidate.id, &mission.command).await? {
                return Ok(Some(candidate));
            }
        }
        Ok(None)
    }

    async fn audit_rejection(
        &self,
        event_type: &str,
        command_id: &CommandId,
        body_id: &BodyId,
    ) -> Result<(), ApplicationError> {
        self.audit
            .append(AuditRecord {
                occurred_at: self.clock.now(),
                actor: AuditActor::Service("command-broker".to_owned()),
                event_type: event_type.to_owned(),
                object_id: command_id.to_string(),
                metadata: json!({ "body_id": body_id }),
            })
            .await
    }
}

fn validate_display_name(value: &str) -> Result<(), ApplicationError> {
    let trimmed = value.trim();
    if !(2..=80).contains(&trimmed.len()) || trimmed.chars().any(char::is_control) {
        return Err(ApplicationError::Conflict(
            "display_name must contain 2 to 80 printable characters".to_owned(),
        ));
    }
    Ok(())
}

fn validate_version(value: &str) -> Result<(), ApplicationError> {
    if value.is_empty()
        || value.len() > 40
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
    {
        return Err(ApplicationError::Conflict(
            "adapter_version has an invalid format".to_owned(),
        ));
    }
    Ok(())
}

fn validate_location(value: &str) -> Result<(), ApplicationError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 100 || trimmed.chars().any(char::is_control) {
        return Err(ApplicationError::Conflict(
            "location must contain 1 to 100 printable characters".to_owned(),
        ));
    }
    Ok(())
}
