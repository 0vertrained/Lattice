//! Immutable, expiring proposals and an atomic approval reservation.
use crate::{ApplicationError, CreateMissionRequest, LatticeService};
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
#[derive(Debug, Clone, Serialize)]
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
    /// pending, approving, approved, failed; abstentions cannot be approved.
    pub status: String,
    /// Trace link to execution.
    pub mission_id: Option<MissionId>,
    /// Approval timestamp.
    pub approved_at: Option<DateTime<Utc>>,
}

/// In-memory demo store; deliberately lost with the ephemeral core signing key.
#[derive(Default)]
pub(crate) struct Proposals(pub BTreeMap<String, Proposal>);

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
            ("ready", Some(command)) => validate_warehouse_command(command)?,
            ("clarify" | "rejected", None) => {}
            _ => return Err(conflict("proposal decision and command disagree")),
        }
        let now = self.clock.now();
        let id = format!("proposal-{}", Uuid::new_v4().simple());
        let expires_at = now + Duration::minutes(5);
        let bytes = serde_json::to_vec(&(&id, now, expires_at, &input))
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
        };
        let mut proposals = self.proposals.lock().await;
        // Bounded demo memory. Never silently evict approval/idempotency records.
        if proposals.0.len() >= 2000 {
            return Err(conflict(
                "proposal capacity reached; restart the disposable demo",
            ));
        }
        self.audit.append(AuditRecord { occurred_at: now, actor: AuditActor::Service("proposal-api".into()),
            event_type: "proposal.created".into(), object_id: proposal.id.clone(),
            metadata: json!({"digest":proposal.digest,"model_id":proposal.input.model_id,"decision":proposal.input.decision}) }).await?;
        proposals.0.insert(proposal.id.clone(), proposal.clone());
        Ok(proposal)
    }

    /// Lists review snapshots, including model abstentions and execution links.
    pub async fn list_proposals(&self) -> Vec<Proposal> {
        let mut proposals: Vec<_> = self.proposals.lock().await.0.values().cloned().collect();
        proposals.sort_by_key(|p| std::cmp::Reverse(p.created_at));
        proposals
    }

    /// Atomically reserves one exact snapshot before dispatch. Repeated completed
    /// approvals return the same mission. Interrupted reservations fail closed.
    pub async fn approve_proposal(
        &self,
        id: &str,
        digest: &str,
        actor: AuditActor,
    ) -> Result<Mission, ApplicationError> {
        let input = {
            let mut proposals = self.proposals.lock().await;
            let p = proposals
                .0
                .get_mut(id)
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
            if p.status != "pending"
                || p.input.decision != "ready"
                || self.clock.now() >= p.expires_at
            {
                return Err(conflict("proposal is not pending, executable, or current"));
            }
            p.status = "approving".into();
            p.approved_at = Some(self.clock.now());
            p.input.clone()
        };
        let command = input.command.ok_or_else(|| conflict("missing command"))?;
        validate_warehouse_command(&command)?;
        self.audit
            .append(AuditRecord {
                occurred_at: self.clock.now(),
                actor: actor.clone(),
                event_type: "proposal.approved".into(),
                object_id: id.into(),
                metadata: json!({"digest":digest}),
            })
            .await?;
        let result = self
            .create_mission(
                CreateMissionRequest {
                    title: {
                        let mut title = input.user_intent;
                        while title.len() > 120 {
                            title.pop();
                        }
                        title
                    },
                    command,
                },
                actor,
            )
            .await;
        let mut proposals = self.proposals.lock().await;
        if let Some(p) = proposals.0.get_mut(id) {
            match &result {
                Ok(m) => {
                    p.status = "approved".into();
                    p.mission_id = Some(m.id.clone());
                }
                Err(_) => p.status = "failed".into(),
            }
        }
        result
    }
}
