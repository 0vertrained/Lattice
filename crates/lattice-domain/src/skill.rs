use serde::{Deserialize, Serialize};

use crate::DomainError;

/// A capability explicitly advertised by an embodiment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    /// Ground or indoor navigation.
    Navigate,
    /// Visual or sensor inspection.
    Inspect,
    /// Person or target following.
    Follow,
    /// Carrying a bounded payload.
    Carry,
    /// Traversing stairs.
    Stairs,
    /// Aerial movement and sensing.
    Aerial,
    /// Traversal of irregular ground.
    RoughTerrain,
}

/// Closed, typed vocabulary accepted by the trusted command path.
///
/// Adding a variant requires domain review, local safety policy, adapter support,
/// simulator tests, and a protocol-version decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SkillCommand {
    /// Navigate to a semantic destination.
    Navigate {
        /// Stable semantic location.
        destination: String,
        /// Hard speed ceiling passed to the body-local controller.
        max_speed_mps: f32,
    },
    /// Inspect a semantic location.
    Inspect {
        /// Stable semantic location.
        location: String,
    },
    /// Follow a target recognized by perception.
    Follow {
        /// Target identity.
        target: String,
        /// Maximum desired following distance.
        max_distance_m: f32,
    },
    /// Carry a bounded payload.
    Carry {
        /// Item identity.
        item: String,
        /// Stable semantic destination.
        destination: String,
        /// Declared mass used by policy.
        max_mass_kg: f32,
    },
    /// Inspect an area from the air.
    AerialInspect {
        /// Stable semantic location.
        location: String,
        /// Hard altitude ceiling.
        max_altitude_m: f32,
    },
    /// Traverse irregular ground.
    TraverseRoughTerrain {
        /// Stable semantic destination.
        destination: String,
    },
}

impl SkillCommand {
    /// Returns the capability required by this skill.
    pub const fn required_capability(&self) -> Capability {
        match self {
            Self::Navigate { .. } => Capability::Navigate,
            Self::Inspect { .. } => Capability::Inspect,
            Self::Follow { .. } => Capability::Follow,
            Self::Carry { .. } => Capability::Carry,
            Self::AerialInspect { .. } => Capability::Aerial,
            Self::TraverseRoughTerrain { .. } => Capability::RoughTerrain,
        }
    }

    /// Validates body-independent safety bounds.
    pub fn validate(&self) -> Result<(), DomainError> {
        match self {
            Self::Navigate {
                destination,
                max_speed_mps,
            } => {
                validate_semantic_name("destination", destination)?;
                validate_range("max_speed_mps", *max_speed_mps, 0.05, 3.0)
            }
            Self::Inspect { location } => validate_semantic_name("location", location),
            Self::Follow {
                target,
                max_distance_m,
            } => {
                validate_semantic_name("target", target)?;
                validate_range("max_distance_m", *max_distance_m, 0.5, 10.0)
            }
            Self::Carry {
                item,
                destination,
                max_mass_kg,
            } => {
                validate_semantic_name("item", item)?;
                validate_semantic_name("destination", destination)?;
                validate_range("max_mass_kg", *max_mass_kg, 0.01, 25.0)
            }
            Self::AerialInspect {
                location,
                max_altitude_m,
            } => {
                validate_semantic_name("location", location)?;
                validate_range("max_altitude_m", *max_altitude_m, 0.5, 30.0)
            }
            Self::TraverseRoughTerrain { destination } => {
                validate_semantic_name("destination", destination)
            }
        }
    }
}

fn validate_semantic_name(field: &'static str, value: &str) -> Result<(), DomainError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 100 {
        return Err(DomainError::InvalidCommand(format!(
            "{field} must contain 1 to 100 characters"
        )));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(DomainError::InvalidCommand(format!(
            "{field} must not contain control characters"
        )));
    }
    Ok(())
}

fn validate_range(
    field: &'static str,
    value: f32,
    minimum: f32,
    maximum: f32,
) -> Result<(), DomainError> {
    if !value.is_finite() || value < minimum || value > maximum {
        return Err(DomainError::OutOfRange {
            field,
            minimum: minimum.to_string(),
            maximum: maximum.to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Capability, SkillCommand};

    #[test]
    fn rejects_non_finite_speed() {
        let command = SkillCommand::Navigate {
            destination: "garage".to_owned(),
            max_speed_mps: f32::NAN,
        };
        assert!(command.validate().is_err());
    }

    #[test]
    fn exposes_required_capability() {
        let command = SkillCommand::Inspect {
            location: "garage".to_owned(),
        };
        assert_eq!(command.required_capability(), Capability::Inspect);
    }
}
