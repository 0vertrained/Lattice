//! Exact, signed geometry for one segment of an approved semantic route.
use crate::{
    Capability, DomainError,
    navigation::{RoutePose, RouteSegment, SemanticMap},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// A named endpoint with its explicit map-frame arrival region.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteEndpoint {
    /// Stable semantic place identity.
    pub id: String,
    /// Immutable map-frame coordinates in metres.
    pub pose: RoutePose,
    /// Maximum spatial arrival distance in metres.
    pub arrival_radius_m: f64,
}

/// Immutable route snapshot carried inside the signed command envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteTraversal {
    /// Operator-maintained map identity.
    pub map_id: String,
    /// Positive map revision.
    pub map_revision: u64,
    /// SHA-256 binding every place and segment in the reviewed map.
    pub map_digest: String,
    /// Directed segment selected by the planner.
    pub segment_id: String,
    /// Required starting region; checked before actuation.
    pub from: RouteEndpoint,
    /// Required destination region; elapsed time alone cannot establish arrival.
    pub to: RouteEndpoint,
    /// Every capability required for this segment.
    pub required_capabilities: BTreeSet<Capability>,
    /// Signed speed ceiling; local controllers may impose a lower bound.
    pub max_speed_mps: f32,
}

impl RouteTraversal {
    /// Freezes exactly one enabled segment from a validated map.
    pub fn from_segment(map: &SemanticMap, segment: &RouteSegment) -> Result<Self, DomainError> {
        map.validate()?;
        if !segment.enabled || map.segment(&segment.id) != Some(segment) {
            return Err(invalid("segment is not enabled in the authoritative map"));
        }
        let endpoint = |id: &str| -> Result<RouteEndpoint, DomainError> {
            let place = map
                .place(id)
                .ok_or_else(|| invalid("unknown route endpoint"))?;
            Ok(RouteEndpoint {
                id: place.id.clone(),
                pose: place.pose,
                arrival_radius_m: place.arrival_radius_m,
            })
        };
        let result = Self {
            map_id: map.id.clone(),
            map_revision: map.revision,
            map_digest: map.digest()?,
            segment_id: segment.id.clone(),
            from: endpoint(&segment.from)?,
            to: endpoint(&segment.to)?,
            required_capabilities: segment.required_capabilities.clone(),
            max_speed_mps: segment.max_speed_mps,
        };
        result.validate()?;
        Ok(result)
    }

    /// Validates a bounded ground-navigation contract independently of transport.
    pub fn validate(&self) -> Result<(), DomainError> {
        let valid_id = |s: &str| {
            !s.is_empty()
                && s.len() <= 80
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        };
        if ![&self.map_id, &self.segment_id, &self.from.id, &self.to.id]
            .into_iter()
            .all(|id| valid_id(id))
            || self.map_revision == 0
            || self.from.id == self.to.id
            || self.map_digest.len() != 64
            || !self
                .map_digest
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || !self.required_capabilities.contains(&Capability::Navigate)
            || self.required_capabilities.iter().any(|c| {
                !matches!(
                    c,
                    Capability::Navigate | Capability::Stairs | Capability::RoughTerrain
                )
            })
            || !self.max_speed_mps.is_finite()
            || !(0.05..=1.0).contains(&self.max_speed_mps)
        {
            return Err(invalid("invalid bounded route traversal"));
        }
        for endpoint in [&self.from, &self.to] {
            endpoint.pose.validate()?;
            if !endpoint.arrival_radius_m.is_finite()
                || !(0.05..=2.0).contains(&endpoint.arrival_radius_m)
            {
                return Err(invalid("invalid route arrival region"));
            }
        }
        if self.from.pose.distance_to(&self.to.pose) < 0.001 {
            return Err(invalid("route must have distinct endpoints"));
        }
        Ok(())
    }

    /// Rejects changes to geometry, requirements, speed, availability or map revision.
    pub fn validate_against(&self, map: &SemanticMap) -> Result<(), DomainError> {
        self.validate()?;
        let segment = map
            .segment(&self.segment_id)
            .ok_or_else(|| invalid("route segment is absent locally"))?;
        if Self::from_segment(map, segment)? != *self {
            return Err(invalid("signed route snapshot differs from the local map"));
        }
        Ok(())
    }
}

fn invalid(message: &str) -> DomainError {
    DomainError::InvalidCommand(message.into())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn map() -> SemanticMap {
        serde_json::from_str(include_str!(
            "../../../simulation/routes/warehouse-stairs.json"
        ))
        .unwrap()
    }

    #[test]
    fn snapshot_binds_geometry_capabilities_speed_revision_and_availability() {
        let original = map();
        let traversal =
            RouteTraversal::from_segment(&original, original.segment("stairs_to_upper").unwrap())
                .unwrap();
        traversal.validate_against(&original).unwrap();
        let mut modified = original.clone();
        modified.revision += 1;
        assert!(traversal.validate_against(&modified).is_err());
        modified = original.clone();
        modified.places[2].pose.z += 0.1;
        assert!(traversal.validate_against(&modified).is_err());
        modified = original.clone();
        modified.segments[1]
            .required_capabilities
            .remove(&Capability::Stairs);
        assert!(traversal.validate_against(&modified).is_err());
        modified = original.clone();
        modified.segments[1].max_speed_mps = 0.2;
        assert!(traversal.validate_against(&modified).is_err());
        modified = original;
        modified.segments[1].enabled = false;
        assert!(traversal.validate_against(&modified).is_err());
    }

    #[test]
    fn traversal_requires_all_capabilities_and_bounded_geometry() {
        let map = map();
        let traversal =
            RouteTraversal::from_segment(&map, map.segment("stairs_to_upper").unwrap()).unwrap();
        let command = crate::SkillCommand::TraverseRoute {
            traversal: traversal.clone(),
        };
        assert_eq!(command.required_capability(), Capability::Stairs);
        assert_eq!(
            command.required_capabilities(),
            BTreeSet::from([Capability::Navigate, Capability::Stairs])
        );
        let mut changed = traversal.clone();
        changed.to.pose.z = f64::NAN;
        assert!(changed.validate().is_err());
        changed = traversal.clone();
        changed.max_speed_mps = 2.0;
        assert!(changed.validate().is_err());
        changed = traversal;
        changed.required_capabilities.remove(&Capability::Navigate);
        assert!(changed.validate().is_err());
    }
}
