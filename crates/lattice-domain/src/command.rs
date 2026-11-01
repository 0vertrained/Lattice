use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{BodyId, CommandId, MissionId, SkillCommand};

/// Signed command payload sent to exactly one body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandEnvelope {
    /// Stable idempotency identity.
    pub command_id: CommandId,
    /// Parent mission.
    pub mission_id: MissionId,
    /// Only body authorized to execute the command.
    pub body_id: BodyId,
    /// Per-body monotonically increasing sequence.
    pub sequence: u64,
    /// Closed typed skill.
    pub command: SkillCommand,
    /// Creation timestamp.
    pub issued_at: DateTime<Utc>,
    /// Hard expiration timestamp.
    pub expires_at: DateTime<Utc>,
}

impl CommandEnvelope {
    /// Returns whether this command must be rejected as stale.
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        now >= self.expires_at
    }

    /// Returns canonical development signing bytes.
    ///
    /// Before protocol v1 is frozen, this is replaced with deterministic
    /// Protobuf serialization including an explicit contract version.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(self)
    }
}

/// Signed command and key metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SignedCommand {
    /// Typed command envelope.
    pub envelope: CommandEnvelope,
    /// Base64 Ed25519 signature.
    pub signature_base64: String,
    /// Rotation-aware key identifier.
    pub key_id: String,
}

/// Public verification key exposed to authenticated body agents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationKey {
    /// Rotation-aware key identifier.
    pub key_id: String,
    /// Base64 public-key bytes.
    pub public_key_base64: String,
    /// Algorithm identifier.
    pub algorithm: String,
}

/// Body-reported command state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandResultStatus {
    /// Body accepted and started work.
    Running,
    /// Body completed work successfully.
    Succeeded,
    /// Body could not complete the command.
    Failed,
    /// Body rejected the command before execution.
    Rejected,
}

/// Authenticated body result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandResult {
    /// Command being reported.
    pub command_id: CommandId,
    /// Reporting body.
    pub body_id: BodyId,
    /// Result category.
    pub status: CommandResultStatus,
    /// Bounded progress.
    pub progress_pct: u8,
    /// Operator-safe detail.
    pub detail: Option<String>,
    /// Body timestamp.
    pub reported_at: DateTime<Utc>,
}
