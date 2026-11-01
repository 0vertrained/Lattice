use std::collections::BTreeSet;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{BodyId, Capability, DomainError};

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
