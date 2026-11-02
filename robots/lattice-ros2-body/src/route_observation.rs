//! Converts local measured scan evidence into an authenticated, command-bound report.
use chrono::{DateTime, Utc};
use lattice_application::{RouteConditionEvidence, RouteConditionInput, RouteConditionStatus};
use lattice_domain::{BodyPose, SignedCommand, SkillCommand};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

type Error = Box<dyn std::error::Error + Send + Sync>;

/// Actual scan samples; nonfinite no-return values are represented as null.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedScan {
    /// Original ROS sensor frame.
    pub sensor_frame_id: String,
    /// Simulator acquisition seconds.
    pub stamp_sec: i32,
    /// Simulator acquisition nanoseconds.
    pub stamp_nanosec: u32,
    /// Bearing of the first beam in the sensor frame.
    pub angle_min: f64,
    /// Bearing increment per beam.
    pub angle_increment: f64,
    /// Sensor minimum range.
    pub range_min: f64,
    /// Sensor maximum range.
    pub range_max: f64,
    /// Sensor transform at acquisition, in the map frame.
    pub sensor_map_pose: BodyPose,
    /// Measured ranges; null means no finite return.
    pub ranges: Vec<Option<f64>>,
}

/// Observation frozen by the gateway before stopping local motion.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalRouteObservation {
    /// Local command that was stopped.
    pub command_id: String,
    /// Signed base-map digest.
    pub map_digest: String,
    /// Signed segment identity.
    pub segment_id: String,
    /// UTC receive time of the measured scan.
    pub observed_unix_ms: i64,
    /// Last fresh body localization.
    pub observer_pose: BodyPose,
    /// Nearest return inside the forward corridor.
    pub distance_m: f64,
    /// Number of measured corridor returns.
    pub blocked_samples: u32,
    /// Full bounded acquisition used by the local detector.
    pub scan: RecordedScan,
}

/// Validates binding to the already-verified command and hashes reproducible scan bytes.
/// The core independently validates freshness; retries retain the original timestamp.
pub fn prepare(
    observation: &LocalRouteObservation,
    command: &SignedCommand,
) -> Result<(RouteConditionInput, Vec<u8>), Error> {
    let SkillCommand::TraverseRoute { traversal } = &command.envelope.command else {
        return Err("route observation requires an active traversal".into());
    };
    if observation.command_id != command.envelope.command_id.to_string()
        || observation.map_digest != traversal.map_digest
        || observation.segment_id != traversal.segment_id
    {
        return Err("route observation does not belong to the signed command".into());
    }
    observation.observer_pose.validate()?;
    observation.scan.sensor_map_pose.validate()?;
    let scan = &observation.scan;
    if !observation.distance_m.is_finite()
        || !(0.18..=1.0).contains(&observation.distance_m)
        || !(3..=720).contains(&observation.blocked_samples)
        || scan.ranges.len() < observation.blocked_samples as usize
        || scan.ranges.len() > 720
        || scan.sensor_frame_id.is_empty()
        || scan.sensor_frame_id.len() > 80
        || scan.stamp_nanosec >= 1_000_000_000
        || !scan.angle_min.is_finite()
        || !scan.angle_increment.is_finite()
        || !(0.0..=std::f64::consts::TAU).contains(&scan.angle_increment)
        || scan.angle_increment == 0.0
        || !scan.range_min.is_finite()
        || !scan.range_max.is_finite()
        || scan.range_min <= 0.0
        || scan.range_max <= scan.range_min
        || scan.range_max > 100.0
        || scan
            .ranges
            .iter()
            .flatten()
            .any(|value| !value.is_finite() || *value < 0.0)
    {
        return Err("invalid bounded laser observation".into());
    }
    let bytes = serde_json::to_vec(scan)?;
    if bytes.len() > 12_000 {
        return Err("laser evidence exceeds the local record bound".into());
    }
    let observed_at = DateTime::<Utc>::from_timestamp_millis(observation.observed_unix_ms)
        .ok_or("invalid laser observation timestamp")?;
    let command_digest = format!("{:x}", Sha256::digest(observation.command_id.as_bytes()));
    let input = RouteConditionInput {
        event_id: format!("route-block-{}", &command_digest[..32]),
        map_digest: observation.map_digest.clone(),
        segment_id: observation.segment_id.clone(),
        status: RouteConditionStatus::Blocked,
        reason: "Measured laser returns block the reviewed route corridor; local motion stopped"
            .into(),
        observed_at,
        command_id: Some(command.envelope.command_id.clone()),
        expected_revision: None,
        evidence: Some(RouteConditionEvidence {
            sensor: "laser_scan".into(),
            frame_id: "map".into(),
            distance_m: observation.distance_m,
            blocked_samples: observation.blocked_samples,
            scan_sha256: format!("{:x}", Sha256::digest(&bytes)),
            observer_pose: observation.observer_pose,
        }),
    };
    Ok((input, bytes))
}

/// What the body does after sending a blockage report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionReply {
    /// The core recorded the condition and holds the affected rounds itself.
    Retained,
    /// The core will not take this report: its command expired or no longer matches. Retrying cannot
    /// change that, so the body reports the traversal as failed, which holds the round for review.
    Declined,
    /// No answer, or a failure on the core's side: stay stopped and send the same report again.
    Retry,
}

/// Classifies the core's HTTP status for a blockage report; `None` means no answer arrived.
pub fn condition_reply(status: Option<u16>) -> ConditionReply {
    match status {
        Some(200..=299) => ConditionReply::Retained,
        Some(400..=499) => ConditionReply::Declined,
        _ => ConditionReply::Retry,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_declined_report_stops_the_retries_and_an_outage_does_not() {
        assert_eq!(condition_reply(Some(201)), ConditionReply::Retained);
        for declined in [400, 403, 404, 409] {
            assert_eq!(condition_reply(Some(declined)), ConditionReply::Declined);
        }
        for transient in [None, Some(500), Some(502), Some(503)] {
            assert_eq!(condition_reply(transient), ConditionReply::Retry);
        }
    }
    use lattice_domain::{BodyId, CommandEnvelope, CommandId, MissionId, RouteTraversal};

    fn fixture() -> (LocalRouteObservation, SignedCommand) {
        let map: lattice_domain::navigation::SemanticMap = serde_json::from_str(include_str!(
            "../../../simulation/routes/warehouse-stairs.json"
        ))
        .unwrap();
        let traversal =
            RouteTraversal::from_segment(&map, map.segment("bay_to_transfer").unwrap()).unwrap();
        let pose = BodyPose {
            x: 0.0,
            y: 2.3,
            yaw: 1.57,
            z: None,
        };
        let now = Utc::now();
        let observation = LocalRouteObservation {
            command_id: "command-laser-test".into(),
            map_digest: traversal.map_digest.clone(),
            segment_id: traversal.segment_id.clone(),
            observed_unix_ms: now.timestamp_millis(),
            observer_pose: pose,
            distance_m: 0.7,
            blocked_samples: 3,
            scan: RecordedScan {
                sensor_frame_id: "laser".into(),
                stamp_sec: 20,
                stamp_nanosec: 100,
                angle_min: -0.02,
                angle_increment: 0.02,
                range_min: 0.08,
                range_max: 12.0,
                sensor_map_pose: pose,
                ranges: vec![Some(0.7), Some(0.7), Some(0.7), None],
            },
        };
        let command = SignedCommand {
            key_id: "already-verified".into(),
            signature_base64: String::new(),
            envelope: CommandEnvelope {
                command_id: CommandId::new("command-laser-test").unwrap(),
                mission_id: MissionId::new("mission-laser-test").unwrap(),
                body_id: BodyId::new("rover").unwrap(),
                sequence: 1,
                issued_at: now,
                expires_at: now + chrono::Duration::seconds(45),
                command: SkillCommand::TraverseRoute { traversal },
                continuation: None,
            },
        };
        (observation, command)
    }

    #[test]
    fn scan_report_is_command_bound_and_identical_on_retry() {
        let (mut observation, command) = fixture();
        let (input, bytes) = prepare(&observation, &command).unwrap();
        let (retry, retained) = prepare(&observation, &command).unwrap();
        assert_eq!(input, retry);
        assert_eq!(bytes, retained);
        assert_eq!(
            input.evidence.as_ref().unwrap().scan_sha256,
            format!("{:x}", Sha256::digest(&bytes))
        );
        assert!(input.expected_revision.is_none());
        observation.command_id = "another-command".into();
        assert!(prepare(&observation, &command).is_err());
        observation.command_id = command.envelope.command_id.to_string();
        observation.map_digest = "0".repeat(64);
        assert!(prepare(&observation, &command).is_err());
    }

    #[test]
    fn malformed_or_non_route_observations_cannot_be_reported() {
        let (mut observation, mut command) = fixture();
        observation.scan.ranges[0] = Some(f64::NAN);
        assert!(prepare(&observation, &command).is_err());
        observation.scan.ranges[0] = Some(0.7);
        observation.blocked_samples = 2;
        assert!(prepare(&observation, &command).is_err());
        observation.blocked_samples = 3;
        command.envelope.command = SkillCommand::Inspect {
            location: "inspection_bay".into(),
        };
        assert!(prepare(&observation, &command).is_err());
    }
}
