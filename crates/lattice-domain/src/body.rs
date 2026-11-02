use std::collections::BTreeSet;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{BodyId, Capability, DomainError};

/// Planar localization in the shared map frame, in metres and radians.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BodyPose {
    /// Map-frame east coordinate.
    pub x: f64,
    /// Map-frame north coordinate.
    pub y: f64,
    /// Counterclockwise heading around the map's vertical axis.
    pub yaw: f64,
}

impl BodyPose {
    /// Rejects non-finite or unbounded telemetry before it enters server state.
    pub fn validate(&self) -> Result<(), DomainError> {
        if !self.x.is_finite()
            || !self.y.is_finite()
            || !self.yaw.is_finite()
            || self.x.abs() > 10_000.0
            || self.y.abs() > 10_000.0
            || self.yaw.abs() > std::f64::consts::PI
        {
            return Err(DomainError::InvalidCommand(
                "invalid map-frame pose".to_owned(),
            ));
        }
        Ok(())
    }
}

/// Bounded battery percentage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BatteryPercent(u8);

impl BatteryPercent {
    /// Creates a battery percentage.
    pub fn new(value: u8) -> Result<Self, DomainError> {
        if value > 100 {
            return Err(DomainError::OutOfRange {
                field: "battery_pct",
                minimum: "0".to_owned(),
                maximum: "100".to_owned(),
            });
        }
        Ok(Self(value))
    }

    /// Returns the numeric percentage.
    pub const fn value(self) -> u8 {
        self.0
    }
}

/// Broad physical embodiment category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BodyKind {
    /// Wheeled ground vehicle.
    Rover,
    /// Four-legged robot.
    Quadruped,
    /// Aerial vehicle.
    Drone,
    /// Human-shaped robot.
    Humanoid,
    /// Multi-legged non-quadruped platform.
    Spider,
    /// Simulator-only body.
    Simulation,
}

/// Connectivity and readiness state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BodyStatus {
    /// Ready to receive work.
    Online,
    /// Not connected.
    Offline,
    /// Connected to a dock.
    Docked,
    /// Charging and unavailable for normal work.
    Charging,
    /// Local controller reported a fault.
    Faulted,
    /// Physical or software E-stop is active.
    EmergencyStopped,
}

/// Latest authoritative body state known by Lattice.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BodySnapshot {
    /// Stable identity.
    pub id: BodyId,
    /// Operator-facing name.
    pub display_name: String,
    /// Physical category.
    pub kind: BodyKind,
    /// Current readiness.
    pub status: BodyStatus,
    /// Current battery level.
    pub battery: BatteryPercent,
    /// Semantic location.
    pub location: String,
    /// Latest map-frame localization, when this adapter provides it.
    #[serde(default)]
    pub pose: Option<BodyPose>,
    /// Explicit capability set.
    pub capabilities: BTreeSet<Capability>,
    /// Last authenticated heartbeat.
    pub last_seen: DateTime<Utc>,
    /// Adapter software version.
    pub adapter_version: String,
}

impl BodySnapshot {
    /// Returns whether the body can receive a mission requiring `capability`.
    pub fn is_eligible(
        &self,
        capability: Capability,
        now: DateTime<Utc>,
        heartbeat_timeout: Duration,
    ) -> bool {
        if self.status != BodyStatus::Online || self.battery.value() < 15 {
            return false;
        }

        let age = now
            .signed_duration_since(self.last_seen)
            .to_std()
            .unwrap_or(Duration::ZERO);

        age <= heartbeat_timeout && self.capabilities.contains(&capability)
    }
}

#[cfg(test)]
mod pose_tests {
    use super::BodyPose;
    #[test]
    fn accepts_map_coordinates_and_rejects_invalid_telemetry() {
        assert!(
            BodyPose {
                x: 3.5,
                y: -2.0,
                yaw: 1.0
            }
            .validate()
            .is_ok()
        );
        for bad in [f64::NAN, f64::INFINITY, 10001.0] {
            assert!(
                BodyPose {
                    x: bad,
                    y: 0.0,
                    yaw: 0.0
                }
                .validate()
                .is_err()
            );
        }
        assert!(
            BodyPose {
                x: 0.0,
                y: 0.0,
                yaw: 4.0
            }
            .validate()
            .is_err()
        );
    }
}
