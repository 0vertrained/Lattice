use lattice_domain::DomainError;
use thiserror::Error;

/// Stable application errors suitable for transport mapping.
#[derive(Debug, Error)]
pub enum ApplicationError {
    /// Requested entity is absent.
    #[error("{entity} not found")]
    NotFound {
        /// Entity category.
        entity: &'static str,
    },

    /// Request conflicts with current state or policy.
    #[error("conflict: {0}")]
    Conflict(String),

    /// A cryptographic operation failed.
    #[error("security operation failed")]
    Security,

    /// An infrastructure dependency failed.
    #[error("infrastructure unavailable")]
    Infrastructure,

    /// A domain invariant failed.
    #[error(transparent)]
    Domain(#[from] DomainError),
}
