#![doc = "Lattice application use cases. Infrastructure is accessed only through ports."]

mod error;
mod ports;
mod proposal;
pub use proposal::{Proposal, ProposalInput, validate_warehouse_command};
mod round;
mod service;
pub use round::{InspectionRound, RoundStep};

pub use error::ApplicationError;
pub use ports::{
    AuditSink, BodyRepository, Clock, CommandQueue, CommandSigner, MissionRepository,
    ProposalRepository, RoundRepository,
};
pub use service::{
    CreateMissionRequest, HeartbeatRequest, LatticeService, RegisterBodyRequest, ServiceConfig,
};
