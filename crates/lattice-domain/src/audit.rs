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
