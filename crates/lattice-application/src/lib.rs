#![doc = "Lattice application use cases. Infrastructure is accessed only through ports."]

mod error;
mod ports;
mod service;

pub use error::ApplicationError;
pub use ports::{AuditSink, BodyRepository, Clock, CommandQueue, CommandSigner, MissionRepository};
pub use service::{
    CreateMissionRequest, HeartbeatRequest, LatticeService, RegisterBodyRequest, ServiceConfig,
};
