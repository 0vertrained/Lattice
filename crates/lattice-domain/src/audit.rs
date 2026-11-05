use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Actor responsible for an audited decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditActor {
    /// Human operator.
    Operator(String),
    /// Trusted internal service.
    Service(String),
    /// Registered body.
    Body(String),
}

/// Append-only security and operations record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditRecord {
    /// Event timestamp.
    pub occurred_at: DateTime<Utc>,
    /// Responsible principal.
    pub actor: AuditActor,
    /// Stable event name.
    pub event_type: String,
    /// Affected object identifier.
    pub object_id: String,
    /// Redacted structured context.
    pub metadata: serde_json::Value,
}

/// A record's link in the audit hash chain: SHA-256 over the previous record's hash, when
/// there is one, then this record's JSON. Every store computes it the same way, so the core
/// can recompute any stored link.
pub fn chain_hash(
    previous: Option<&[u8]>,
    record: &AuditRecord,
) -> Result<Vec<u8>, serde_json::Error> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    if let Some(bytes) = previous {
        hash.update(bytes);
    }
    hash.update(serde_json::to_vec(record)?);
    Ok(hash.finalize().to_vec())
}
