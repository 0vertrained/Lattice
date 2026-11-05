use async_trait::async_trait;
use chrono::{DateTime, Utc};
use lattice_domain::{
    AuditRecord, BodyId, BodySnapshot, CommandEnvelope, Mission, MissionId, SignedCommand,
    VerificationKey,
};

use crate::ApplicationError;

/// Storage boundary for body state.
#[async_trait]
pub trait BodyRepository: Send + Sync {
    /// Inserts or replaces a body snapshot.
    async fn save(&self, body: BodySnapshot) -> Result<(), ApplicationError>;
    /// Finds one body.
    async fn get(&self, id: &BodyId) -> Result<Option<BodySnapshot>, ApplicationError>;
    /// Lists bodies.
    async fn list(&self) -> Result<Vec<BodySnapshot>, ApplicationError>;
}

/// Storage boundary for mission state.
#[async_trait]
pub trait MissionRepository: Send + Sync {
    /// Inserts or replaces a mission.
    async fn save(&self, mission: Mission) -> Result<(), ApplicationError>;
    /// Finds one mission.
    async fn get(&self, id: &MissionId) -> Result<Option<Mission>, ApplicationError>;
    /// Lists missions.
    async fn list(&self) -> Result<Vec<Mission>, ApplicationError>;
}

/// Per-body durable command-delivery boundary.
#[async_trait]
pub trait CommandQueue: Send + Sync {
    /// Allocates the next monotonic sequence for a body.
    async fn next_sequence(&self, body_id: &BodyId) -> Result<u64, ApplicationError>;
    /// Enqueues a signed command.
    async fn enqueue(&self, command: SignedCommand) -> Result<(), ApplicationError>;
    /// Removes and returns the next command.
    async fn dequeue(&self, body_id: &BodyId) -> Result<Option<SignedCommand>, ApplicationError>;
}

/// Proposal storage; callers serialize approval use cases in a transaction.
#[async_trait]
pub trait ProposalRepository: Send + Sync {
    /// Stores the frozen snapshot and approval outcome.
    async fn save(&self, proposal: crate::Proposal) -> Result<(), ApplicationError>;
    /// Looks up a review snapshot.
    async fn get(&self, id: &str) -> Result<Option<crate::Proposal>, ApplicationError>;
    /// Lists review history.
    async fn list(&self) -> Result<Vec<crate::Proposal>, ApplicationError>;
}

/// Cryptographic command-signing boundary.
#[async_trait]
pub trait CommandSigner: Send + Sync {
    /// Signs a typed envelope.
    async fn sign(&self, envelope: CommandEnvelope) -> Result<SignedCommand, ApplicationError>;
    /// Returns the active public verification key.
    async fn verification_key(&self) -> Result<VerificationKey, ApplicationError>;
}

/// Append-only audit boundary.
#[async_trait]
pub trait AuditSink: Send + Sync {
    /// Appends a record, linking it to the hash of the record before it.
    async fn append(&self, record: AuditRecord) -> Result<(), ApplicationError>;
    /// Lists records for the development UI.
    async fn list(&self) -> Result<Vec<AuditRecord>, ApplicationError>;
    /// The latest `latest` records, or all of them, oldest first, as stored with their links.
    async fn chain(
        &self,
        latest: Option<usize>,
    ) -> Result<Vec<StoredAuditRecord>, ApplicationError>;
}

/// An audit record as stored, with its place in the log and its hash-chain link.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredAuditRecord {
    /// Position in the log, counting from 1.
    pub position: u64,
    /// The record.
    pub record: AuditRecord,
    /// Stored hash of the record before it; none for the first record.
    pub previous_hash: Option<Vec<u8>>,
    /// Stored hash of this record.
    pub record_hash: Vec<u8>,
}

/// Testable wall-clock boundary.
pub trait Clock: Send + Sync {
    /// Returns current UTC time.
    fn now(&self) -> DateTime<Utc>;
}

/// Transaction-scoped persistence for multi-step inspection objectives.
#[async_trait]
pub trait RoundRepository: Send + Sync {
    /// Stores an immutable plan and mutable execution cursor.
    async fn save(&self, round: crate::InspectionRound) -> Result<(), ApplicationError>;
    /// Finds one plan.
    async fn get(&self, id: &str) -> Result<Option<crate::InspectionRound>, ApplicationError>;
    /// Lists round history.
    async fn list(&self) -> Result<Vec<crate::InspectionRound>, ApplicationError>;
}
