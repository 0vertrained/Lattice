use crate::{BodyId, DomainError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

/// Reference to an immutable observation and the exact retained camera image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationReference {
    /// Durable observation identity.
    pub observation_id: String,
    /// SHA-256 of the original retained JPEG bytes.
    pub image_sha256: String,
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    fn context() -> ContinuationContext {
        let mut value = ContinuationContext {
            handoff_id: "handoff-test".into(),
            round_id: "round-test".into(),
            source_body_id: BodyId::new("rover-a").unwrap(),
            target_body_id: BodyId::new("rover-b").unwrap(),
            completed_steps: 1,
            observations: vec![ObservationReference {
                observation_id: "observation-command-a".into(),
                image_sha256: "ab".repeat(32),
            }],
            digest: String::new(),
        };
        value.digest = value.compute_digest().unwrap();
        value
    }
    #[test]
    fn context_binds_target_cursor_and_each_image() {
        let original = context();
        original.validate().unwrap();
        let mut changed = original.clone();
        changed.target_body_id = BodyId::new("rover-c").unwrap();
        assert!(changed.validate().is_err());
        changed = original.clone();
        changed.completed_steps += 1;
        assert!(changed.validate().is_err());
        changed = original;
        changed.observations[0].image_sha256 = "cd".repeat(32);
        assert!(changed.validate().is_err());
    }
    #[test]
    fn valid_digest_does_not_bypass_bounds_or_duplicate_reference_checks() {
        let mut value = context();
        value.observations.push(value.observations[0].clone());
        value.digest = value.compute_digest().unwrap();
        assert!(value.validate().is_err());
        value = context();
        value.observations[0].observation_id = "../escape".into();
        value.digest = value.compute_digest().unwrap();
        assert!(value.validate().is_err());
    }
}

/// Context frozen by operator approval and covered by the command signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContinuationContext {
    /// Reviewed handoff identity.
    pub handoff_id: String,
    /// Original multi-step objective.
    pub round_id: String,
    /// Previous body whose work and memory are retained.
    pub source_body_id: BodyId,
    /// Only body authorized to receive this continuation.
    pub target_body_id: BodyId,
    /// Number of completed steps; none of these are dispatched again.
    pub completed_steps: usize,
    /// Bounded references to validated observations from this round.
    pub observations: Vec<ObservationReference>,
    /// Digest of all other fields in this structure.
    pub digest: String,
}

impl ContinuationContext {
    /// Computes the canonical context digest without its own digest field.
    pub fn compute_digest(&self) -> Result<String, serde_json::Error> {
        let bytes = serde_json::to_vec(&(
            &self.handoff_id,
            &self.round_id,
            &self.source_body_id,
            &self.target_body_id,
            self.completed_steps,
            &self.observations,
        ))?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }

    /// Checks bounded identifiers, unique evidence references and immutable digest.
    pub fn validate(&self) -> Result<(), DomainError> {
        let valid_id = |id: &str| {
            !id.is_empty()
                && id.len() <= 150
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        };
        let mut ids = BTreeSet::new();
        if !valid_id(&self.handoff_id)
            || !valid_id(&self.round_id)
            || self.source_body_id == self.target_body_id
            || self.completed_steps > 6
            || self.observations.len() > 6
            || self.observations.iter().any(|reference| {
                !valid_id(&reference.observation_id)
                    || !ids.insert(&reference.observation_id)
                    || reference.image_sha256.len() != 64
                    || !reference
                        .image_sha256
                        .bytes()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            })
            || self.compute_digest().ok().as_ref() != Some(&self.digest)
        {
            return Err(DomainError::InvalidCommand(
                "invalid continuation context".into(),
            ));
        }
        Ok(())
    }
}
