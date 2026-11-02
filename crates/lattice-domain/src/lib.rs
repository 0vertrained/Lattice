#![doc = "Pure Lattice domain entities and invariants. This crate performs no I/O."]

/// Audit records and actors.
pub mod audit;
/// Embodiment identity, capability, health, and eligibility models.
pub mod body;
/// Signed command and result contracts.
pub mod command;
/// Signed, bounded shared-memory references for reviewed body continuation.
pub mod continuation;
pub use continuation::{ContinuationContext, ObservationReference};
/// Domain validation and state-transition errors.
pub mod error;
/// Inspection evidence contracts.
pub mod evidence;
pub use evidence::{Detection, InspectionEvidence};
/// Validated identifiers.
pub mod id;
/// Mission lifecycle model and invariants.
pub mod mission;
/// Bounded semantic routes and deterministic body capability planning.
pub mod navigation;
/// Signed snapshots of individual approved route segments.
pub mod traversal;
pub use traversal::{RouteEndpoint, RouteTraversal};
/// Closed, typed robot capability and skill vocabulary.
pub mod skill;

pub use audit::{AuditActor, AuditRecord};
pub use body::{BatteryPercent, BodyKind, BodyPose, BodySnapshot, BodyStatus};
pub use command::{
    CommandEnvelope, CommandResult, CommandResultStatus, SignedCommand, VerificationKey,
};
pub use error::DomainError;
pub use id::{BodyId, CommandId, MissionId};
pub use mission::{Mission, MissionStatus};
pub use skill::{Capability, SkillCommand};
