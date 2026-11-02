#![doc = "Lattice application use cases. Infrastructure is accessed only through ports."]

mod adaptive;
mod error;
pub use adaptive::{
    AdaptiveRouteContext, AdaptiveRouteRepository, RouteConditionEvidence, RouteConditionInput,
    RouteConditionObservation, RouteConditionSnapshot, RouteConditionStatus, RouteReplanProposal,
};
mod handoff;
pub use handoff::{HandoffProposal, HandoffRepository};
mod navigation;
pub use navigation::{
    RouteObjectiveRequest, RoutePlanProposal, RoutePlanRepository, RouteTransferOptions,
};
mod observation;
pub use observation::{
    LastSeen, Observation, ObservationOutcome, ObservationRepository, validate_observation_query,
};
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
