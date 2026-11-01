use thiserror::Error;

/// Errors caused by violations of domain invariants.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum DomainError {
    /// A stable identifier is malformed.
    #[error("invalid {kind}: {reason}")]
    InvalidIdentifier {
        /// Identifier category.
        kind: &'static str,
        /// Validation failure.
        reason: String,
    },

    /// A bounded number is outside its accepted range.
    #[error("{field} must be between {minimum} and {maximum}")]
    OutOfRange {
        /// Field name.
        field: &'static str,
        /// Inclusive lower bound.
        minimum: String,
        /// Inclusive upper bound.
        maximum: String,
    },

    /// A mission state transition is illegal.
    #[error("mission cannot transition from {from} to {to}")]
    InvalidMissionTransition {
        /// Current state.
        from: String,
        /// Requested state.
        to: String,
    },

    /// A typed command is malformed or violates global bounds.
    #[error("invalid command: {0}")]
    InvalidCommand(String),
}
