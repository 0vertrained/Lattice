//! Immutable, expiring proposals and an atomic approval reservation.
use crate::ProposalRepository;
use crate::{ApplicationError, CreateMissionRequest, LatticeService};
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use lattice_domain::{AuditActor, AuditRecord, Mission, MissionId, SkillCommand};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

/// Provenance supplied by a planning adapter; never grants execution authority.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposalInput {
    /// Operator's original request, retained for evaluation and review.
    pub user_intent: String,
    /// ready, clarify, or rejected.
    pub decision: String,
    /// Optional grounded skill; absent on abstention.
    pub command: Option<SkillCommand>,
    /// Exact model or manual adapter version.
    pub model_id: String,
    /// Grounding/prompt policy version.
    pub policy_version: String,
    /// Model probability; not a safety guarantee.
    pub confidence: f64,
    /// Operator-facing explanation.
    pub rationale: String,
}

/// Frozen review snapshot. Approval never accepts replacement command fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proposal {
    /// Unique proposal identity.
    pub id: String,
    /// SHA-256 of the typed snapshot and timestamps.
    pub digest: String,
    /// Creation timestamp.
    pub created_at: DateTime<Utc>,
    /// Approval deadline; command TTL starts separately after approval.
    pub expires_at: DateTime<Utc>,
    /// Immutable proposal content and provenance.
    pub input: ProposalInput,
    /// pending, approving, approved, failed, invalidated; abstentions cannot be approved.
    pub status: String,
    /// Trace link to execution.
    pub mission_id: Option<MissionId>,
    /// Approval timestamp.
    pub approved_at: Option<DateTime<Utc>>,
    /// Original held mission; included in the immutable digest.
    #[serde(default)]
    pub recovery_of: Option<MissionId>,
}

/// In-memory demo store; deliberately lost with the ephemeral core signing key.
#[derive(Default)]
pub(crate) struct Proposals(tokio::sync::Mutex<BTreeMap<String, Proposal>>);
#[async_trait]
impl ProposalRepository for Proposals {
    async fn save(&self, proposal: Proposal) -> Result<(), ApplicationError> {
        let mut records = self.0.lock().await;
        if records.len() >= 2000 && !records.contains_key(&proposal.id) {
            return Err(conflict("disposable proposal capacity reached"));
        }
        records.insert(proposal.id.clone(), proposal);
        Ok(())
    }
    async fn get(&self, id: &str) -> Result<Option<Proposal>, ApplicationError> {
        Ok(self.0.lock().await.get(id).cloned())
    }
    async fn list(&self) -> Result<Vec<Proposal>, ApplicationError> {
        Ok(self.0.lock().await.values().cloned().collect())
    }
}

fn conflict(message: &str) -> ApplicationError {
    ApplicationError::Conflict(message.into())
}

/// Warehouse-specific policy, enforced independently of model output.
pub fn validate_warehouse_command(command: &SkillCommand) -> Result<(), ApplicationError> {
    command.validate()?;
    let location = match command {
        SkillCommand::Navigate {
            destination,
            max_speed_mps,
        } if *max_speed_mps <= 0.4 => destination,
        SkillCommand::Inspect { location } => location,
        _ => return Err(conflict("unsupported warehouse skill or speed")),
    };
    if !matches!(
        location.as_str(),
        "loading_dock" | "charging_station" | "inspection_bay" | "blocked_shelf"
    ) {
        return Err(conflict("unknown warehouse destination"));
    }
    Ok(())
}

impl LatticeService {
    /// Validates and freezes a proposal without creating or dispatching a mission.
    pub async fn propose(&self, input: ProposalInput) -> Result<Proposal, ApplicationError> {
        self.propose_inner(input, None).await
    }

    /// Creates a fresh review snapshot for held work. It grants no execution authority.
    pub async fn propose_recovery(&self, id: &MissionId) -> Result<Proposal, ApplicationError> {
        let mission = self
            .missions
            .get(id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "mission" })?;
        if mission.status != lattice_domain::MissionStatus::RecoveryRequired {
            return Err(conflict("mission does not require recovery"));
        }
        let mut rationale="Review the current robot position and surroundings. Approval creates a new command; previous execution will not resume.".to_owned();
        if let Some(store) = &self.rounds
            && let Some(round) = store.list().await?.into_iter().find(|r| {
                r.current_mission_id.as_ref() == Some(id) && r.status == "recovery_required"
            })
        {
            rationale = format!(
                "Recover step {} of {} in the approved inspection round. After this command, the remaining approved steps continue automatically; their failure policies remain in force.",
                round.current_step + 1,
                round.steps.len()
            );
        }
        self.propose_inner(
            ProposalInput {
                user_intent: mission.title,
                decision: "ready".into(),
                command: Some(mission.command),
                model_id: "operator-recovery-v1".into(),
                policy_version: "warehouse-v1".into(),
                confidence: 1.0,
                rationale,
            },
            Some(id.clone()),
        )
        .await
    }

    async fn propose_inner(
        &self,
        input: ProposalInput,
        recovery_of: Option<MissionId>,
    ) -> Result<Proposal, ApplicationError> {
        if !(3..=500).contains(&input.user_intent.len())
            || input.user_intent.chars().any(char::is_control)
            || !input.confidence.is_finite()
            || !(0.0..=1.0).contains(&input.confidence)
            || input.model_id.is_empty()
            || input.model_id.len() > 120
            || input.policy_version.is_empty()
            || input.policy_version.len() > 120
            || input.rationale.len() > 500
        {
            return Err(conflict("invalid proposal metadata"));
        }
        match (input.decision.as_str(), &input.command) {
            ("ready", Some(command)) => {
                let route_recovery = if let Some(id) = &recovery_of {
                    let original = self
                        .missions
                        .get(id)
                        .await?
                        .ok_or(ApplicationError::NotFound { entity: "mission" })?;
                    self.validate_route_recovery(&original, command).await?
                } else {
                    false
                };
                if !route_recovery {
                    validate_warehouse_command(command)?;
                }
            }
            ("clarify" | "rejected", None) => {}
            _ => return Err(conflict("proposal decision and command disagree")),
        }
        let now = self.clock.now();
        let id = format!("proposal-{}", Uuid::new_v4().simple());
        let expires_at = now + Duration::minutes(5);
        let bytes = serde_json::to_vec(&(&id, now, expires_at, &input, &recovery_of))
            .map_err(|_| ApplicationError::Infrastructure)?;
        let proposal = Proposal {
            id,
            digest: format!("{:x}", Sha256::digest(bytes)),
            created_at: now,
            expires_at,
            input,
            status: "pending".into(),
            mission_id: None,
            approved_at: None,
            recovery_of,
        };
        self.audit.append(AuditRecord { occurred_at: now, actor: AuditActor::Service("proposal-api".into()),
            event_type: "proposal.created".into(), object_id: proposal.id.clone(),
            metadata: json!({"digest":proposal.digest,"model_id":proposal.input.model_id,"decision":proposal.input.decision,"recovery_of":proposal.recovery_of}) }).await?;
        self.proposals.save(proposal.clone()).await?;
        Ok(proposal)
    }

    /// Lists review snapshots, including model abstentions and execution links.
    pub async fn list_proposals(&self) -> Result<Vec<Proposal>, ApplicationError> {
        let mut proposals = self.proposals.list().await?;
        proposals.sort_by_key(|p| std::cmp::Reverse(p.created_at));
        Ok(proposals)
    }

    /// Atomically reserves one exact snapshot before dispatch. Repeated completed
    /// approvals return the same mission. Interrupted reservations fail closed.
    pub async fn approve_proposal(
        &self,
        id: &str,
        digest: &str,
        actor: AuditActor,
    ) -> Result<Mission, ApplicationError> {
        let _reservation = self.approval_lock.lock().await;
        let mut p = self
            .proposals
            .get(id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "proposal" })?;
        if p.digest != digest {
            return Err(conflict("approval digest mismatch"));
        }
        if let Some(mission_id) = &p.mission_id {
            return self
                .missions
                .get(mission_id)
                .await?
                .ok_or(ApplicationError::NotFound { entity: "mission" });
        }
        if p.status != "pending" || p.input.decision != "ready" || self.clock.now() >= p.expires_at
        {
            return Err(conflict("proposal is not pending, executable, or current"));
        }
        let mut original = match &p.recovery_of {
            Some(id) => {
                let m = self
                    .missions
                    .get(id)
                    .await?
                    .ok_or(ApplicationError::NotFound { entity: "mission" })?;
                if m.status != lattice_domain::MissionStatus::RecoveryRequired {
                    return Err(conflict("mission recovery was already approved"));
                }
                Some(m)
            }
            None => None,
        };
        p.status = "approving".into();
        p.approved_at = Some(self.clock.now());
        self.proposals.save(p.clone()).await?;
        let input = p.input.clone();
        let command = input.command.ok_or_else(|| conflict("missing command"))?;
        let route_recovery = match &original {
            Some(original) => self.validate_route_recovery(original, &command).await?,
            None => false,
        };
        if !route_recovery {
            validate_warehouse_command(&command)?;
        }
        self.audit
            .append(AuditRecord {
                occurred_at: self.clock.now(),
                actor: actor.clone(),
                event_type: "proposal.approved".into(),
                object_id: id.into(),
                metadata: json!({"digest":digest,"recovery_of":p.recovery_of}),
            })
            .await?;
        let request = CreateMissionRequest {
            title: {
                let mut title = input.user_intent;
                while title.len() > 120 {
                    title.pop();
                }
                title
            },
            command,
        };
        // Existing same-body recovery remains available; changing a round's body requires
        // a dedicated review that freezes its target, cursor and retained observations.
        let recovery_body = if let Some(old) = &original {
            let belongs_to_round = if let Some(rounds) = &self.rounds {
                rounds
                    .list()
                    .await?
                    .iter()
                    .any(|r| r.current_mission_id.as_ref() == Some(&old.id))
            } else {
                false
            };
            if belongs_to_round {
                old.assigned_body_id.clone()
            } else {
                None
            }
        } else {
            None
        };
        let result = if let Some(body_id) = recovery_body {
            self.create_mission_for_body(
                request,
                body_id,
                original.as_ref().and_then(|old| old.continuation.clone()),
                actor,
            )
            .await
        } else {
            self.create_mission(request, actor).await
        };
        match &result {
            Ok(m) => {
                p.status = "approved".into();
                p.mission_id = Some(m.id.clone());
                if let Some(old) = &mut original {
                    old.status = lattice_domain::MissionStatus::Cancelled;
                    old.updated_at = self.clock.now();
                    old.status_detail =
                        Some(format!("Continued after operator review as {}", m.id));
                    self.missions.save(old.clone()).await?;
                    self.recover_round_mission(&old.id, &m.id).await?;
                }
            }
            Err(_) => p.status = "failed".into(),
        }
        self.proposals.save(p).await?;
        result
    }
}
