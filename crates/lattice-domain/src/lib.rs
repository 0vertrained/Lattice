#![doc = "Pure Lattice domain entities and invariants. This crate performs no I/O."]

/// Audit records and actors.
pub mod audit;
/// Embodiment identity, capability, health, and eligibility models.
pub mod body;
/// Signed command and result contracts.
pub mod command;
/// Domain validation and state-transition errors.
pub mod error;
/// Validated identifiers.
pub mod id;
/// Mission lifecycle model and invariants.
pub mod mission;
/// Closed, typed robot capability and skill vocabulary.
pub mod skill;

pub use audit::{AuditActor, AuditRecord};
pub use body::{BatteryPercent, BodyKind, BodySnapshot, BodyStatus};
pub use command::{
    CommandEnvelope, CommandResult, CommandResultStatus, SignedCommand, VerificationKey,
};
pub use error::DomainError;
pub use id::{BodyId, CommandId, MissionId};
pub use mission::{Mission, MissionStatus};
pub use skill::{Capability, SkillCommand};
