//! Shared, immutable station observations derived from authenticated inspection results.
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use lattice_domain::{
    AuditActor, AuditRecord, BodyId, BodyPose, BodySnapshot, CommandId, Detection,
    InspectionEvidence, Mission, MissionId, MissionStatus, SkillCommand,
};
use serde::{Deserialize, Serialize};

use crate::{ApplicationError, LatticeService};

/// Whether the supported visual marker was present in the inspected camera frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationOutcome {
    /// At least one supported marker passed the validated detector threshold.
    Detected,
    /// The inspected frame had no supported detections; this is not proof of absence.
    NotDetected,
}

/// A bounded metadata record; image bytes remain on the original mission evidence.
/// Identity groups the marker class at a named station, not a tracked physical instance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    /// Deterministic identity derived from the source command.
    pub id: String,
    /// Stable class-at-station key, e.g. `safety-marker:inspection_bay`.
    pub subject_key: String,
    /// Detector class, currently `octagonal_safety_marker`.
    pub subject_class: String,
    /// Positive sighting or an inspected frame with no marker detected.
    pub outcome: ObservationOutcome,
    /// Named inspection station from the signed mission command.
    pub location: String,
    /// Shared localization frame of the observer pose.
    pub map_frame: String,
    /// Latest authenticated observer pose, never an inferred object coordinate.
    pub observer_pose: Option<BodyPose>,
    /// Heartbeat timestamp of the pose; it is not synchronized to the camera frame.
    pub observer_pose_at: Option<DateTime<Utc>>,
    /// Source mission retaining the actual annotated JPEG.
    pub mission_id: MissionId,
    /// Source authorized command; at most one observation is stored per command.
    pub command_id: CommandId,
    /// Authenticated observing body.
    pub body_id: BodyId,
    /// Body-side host receipt time of the captured ROS camera frame.
    pub captured_at: DateTime<Utc>,
    /// Core acceptance time of the source terminal result.
    pub received_at: DateTime<Utc>,
    /// Exact detector version reported by the body.
    pub model_id: String,
    /// Explicit confidence calibration scope; synthetic scores do not imply field accuracy.
    pub confidence_domain: String,
    /// Maximum supported detection score; absent for a no-marker observation.
    pub confidence: Option<f64>,
    /// SHA-256 of the annotated JPEG retained by the source mission.
    pub image_sha256: String,
    /// SHA-256 of the original PPM frame retained in the simulator run directory.
    pub frame_sha256: String,
    /// Original image-space detections, without any RGB-to-world-coordinate inference.
    pub detections: Vec<Detection>,
}

impl Observation {
    /// Projects a result after the result use case has validated its body, image and detections.
    /// Capture/navigation failures without a valid image create no negative observation.
    pub fn from_validated_inspection(
        mission: &Mission,
        body: &BodySnapshot,
        received_at: DateTime<Utc>,
    ) -> Result<Option<Self>, ApplicationError> {
        let SkillCommand::Inspect { location } = &mission.command else {
            return Ok(None);
        };
        if !matches!(
            mission.status,
            MissionStatus::Succeeded | MissionStatus::Failed
        ) {
            return Ok(None);
        }
        let Some(evidence) = &mission.evidence else {
            return Ok(None);
        };
        if mission.assigned_body_id.as_ref() != Some(&body.id) {
            return Err(conflict(
                "observation body does not match the source mission",
            ));
        }
        let command_id = mission
            .active_command_id
            .clone()
            .ok_or_else(|| conflict("observation requires an authorized source command"))?;
        if let Some(pose) = body.pose {
            pose.validate()?;
        }
        let captured_at = DateTime::from_timestamp_millis(evidence.captured_at_ms)
            .ok_or_else(|| conflict("invalid observation capture timestamp"))?;
        let detected = !evidence.detections.is_empty();
        if mission.status == MissionStatus::Succeeded && !detected {
            return Err(conflict(
                "successful inspection requires a positive detection",
            ));
        }
        Ok(Some(Self {
            id: format!("observation-{command_id}"),
            subject_key: format!("safety-marker:{location}"),
            subject_class: "octagonal_safety_marker".into(),
            outcome: if detected {
                ObservationOutcome::Detected
            } else {
                ObservationOutcome::NotDetected
            },
            location: location.clone(),
            map_frame: "map".into(),
            observer_pose: body.pose,
            observer_pose_at: body.pose.map(|_| body.last_seen),
            mission_id: mission.id.clone(),
            command_id,
            body_id: body.id.clone(),
            captured_at,
            received_at,
            model_id: evidence.model_id.clone(),
            confidence_domain: evidence.confidence_domain.clone(),
            confidence: evidence
                .detections
                .iter()
                .map(|d| d.confidence)
                .reduce(f64::max),
            image_sha256: evidence.image_sha256.clone(),
            frame_sha256: evidence.frame_sha256.clone(),
            detections: evidence.detections.clone(),
        }))
    }
}

/// An evidence-backed answer that preserves a positive sighting after a later negative frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastSeen {
    /// Optional exact subject key used to scope the query.
    pub subject_key: Option<String>,
    /// Most recent positive observation by camera capture time, if any.
    pub last_seen: Option<Observation>,
    /// Latest later no-marker frame at that same station, if any.
    pub later_negative: Option<Observation>,
    /// Core query time, allowing the consumer to show how old the evidence is.
    pub queried_at: DateTime<Utc>,
    /// Bounded explanation that avoids claiming current object presence or absence.
    pub explanation: String,
}

/// Transaction-scoped persistence for immutable shared observations.
#[async_trait]
pub trait ObservationRepository: Send + Sync {
    /// Inserts once per source command. Exact replay returns false; changed replay fails.
    async fn insert_observation(&self, observation: Observation) -> Result<bool, ApplicationError>;
    /// Lists one to one hundred newest records, optionally filtered by exact subject key.
    async fn list_observations(
        &self,
        limit: u32,
        subject: Option<&str>,
    ) -> Result<Vec<Observation>, ApplicationError>;
    /// Loads one observation without its image bytes.
    async fn get_observation(&self, id: &str) -> Result<Option<Observation>, ApplicationError>;
    /// Finds the latest positive capture, regardless of newer negative observations.
    async fn latest_positive(
        &self,
        subject: Option<&str>,
    ) -> Result<Option<Observation>, ApplicationError>;
    /// Finds the latest negative capture at a station strictly after a positive capture.
    async fn latest_negative(
        &self,
        subject: &str,
        after: DateTime<Utc>,
    ) -> Result<Option<Observation>, ApplicationError>;
}

impl LatticeService {
    /// Lists bounded observation metadata, with original source provenance.
    pub async fn observations(
        &self,
        limit: u32,
        subject: Option<&str>,
    ) -> Result<Vec<Observation>, ApplicationError> {
        validate_observation_query(limit, subject)?;
        self.observation_store()?
            .list_observations(limit, subject)
            .await
    }

    /// Loads immutable metadata. Image retrieval must verify the original mission evidence.
    pub async fn observation(&self, id: &str) -> Result<Observation, ApplicationError> {
        if id.len() > 80 || !id.starts_with("observation-") {
            return Err(conflict("invalid observation id"));
        }
        self.observation_store()?
            .get_observation(id)
            .await?
            .ok_or(ApplicationError::NotFound {
                entity: "observation",
            })
    }

    /// Resolves the original evidence only when all source metadata and JPEG bytes agree.
    /// Transports must authorize the caller before returning the image payload.
    pub async fn source_evidence(
        &self,
        observation: &Observation,
    ) -> Result<InspectionEvidence, ApplicationError> {
        use base64::{Engine, engine::general_purpose::STANDARD};
        use sha2::{Digest, Sha256};

        let mission = self.missions.get(&observation.mission_id).await?.ok_or(
            ApplicationError::NotFound {
                entity: "observation source mission",
            },
        )?;
        let evidence = mission
            .evidence
            .as_ref()
            .ok_or_else(|| conflict("observation source evidence is unavailable"))?;
        let captured_at = DateTime::from_timestamp_millis(evidence.captured_at_ms);
        let confidence = evidence
            .detections
            .iter()
            .map(|d| d.confidence)
            .reduce(f64::max);
        let outcome = if evidence.detections.is_empty() {
            ObservationOutcome::NotDetected
        } else {
            ObservationOutcome::Detected
        };
        if mission.assigned_body_id.as_ref() != Some(&observation.body_id)
            || mission.active_command_id.as_ref() != Some(&observation.command_id)
            || !matches!(
                mission.status,
                MissionStatus::Succeeded | MissionStatus::Failed
            )
            || !matches!(&mission.command, SkillCommand::Inspect { location } if location == &observation.location)
            || observation.id != format!("observation-{}", observation.command_id)
            || observation.subject_key != format!("safety-marker:{}", observation.location)
            || observation.subject_class != "octagonal_safety_marker"
            || observation.map_frame != "map"
            || observation.received_at != mission.updated_at
            || captured_at != Some(observation.captured_at)
            || evidence.model_id != observation.model_id
            || evidence.confidence_domain != observation.confidence_domain
            || evidence.image_sha256 != observation.image_sha256
            || evidence.frame_sha256 != observation.frame_sha256
            || evidence.detections != observation.detections
            || confidence != observation.confidence
            || outcome != observation.outcome
            || evidence.image_base64.len() > 54_000
        {
            return Err(conflict("observation source provenance does not match"));
        }
        let image = STANDARD
            .decode(&evidence.image_base64)
            .map_err(|_| conflict("observation image integrity check failed"))?;
        if image.len() > 40_000
            || !image.starts_with(&[0xff, 0xd8, 0xff])
            || format!("{:x}", Sha256::digest(&image)) != observation.image_sha256
        {
            return Err(conflict("observation image integrity check failed"));
        }
        Ok(evidence.clone())
    }

    /// Answers historical presence with its source and any later contradictory station frame.
    pub async fn last_seen(&self, subject: Option<&str>) -> Result<LastSeen, ApplicationError> {
        validate_observation_query(1, subject)?;
        let store = self.observation_store()?;
        let last_seen = store.latest_positive(subject).await?;
        let later_negative = match &last_seen {
            Some(positive) => {
                store
                    .latest_negative(&positive.subject_key, positive.captured_at)
                    .await?
            }
            None => None,
        };
        let explanation = match (&last_seen, &later_negative) {
            (Some(positive), Some(negative)) => format!(
                "The marker was last detected at {} by {} at {}. A later frame from {} at {} did not detect it. These are historical camera observations; current presence is unknown.",
                positive.location, positive.body_id, positive.captured_at.to_rfc3339(),
                negative.body_id, negative.captured_at.to_rfc3339(),
            ),
            (Some(positive), None) => format!(
                "The marker was last detected at {} by {} at {}. This is a historical camera observation; current presence is unknown.",
                positive.location, positive.body_id, positive.captured_at.to_rfc3339(),
            ),
            (None, _) => "No positive marker observation has been recorded for this query. No-marker frames do not prove absence.".into(),
        };
        Ok(LastSeen {
            subject_key: subject.map(str::to_owned),
            last_seen,
            later_negative,
            queried_at: self.clock.now(),
            explanation,
        })
    }

    pub(crate) async fn record_observation(
        &self,
        mission: &Mission,
    ) -> Result<(), ApplicationError> {
        let Some(store) = &self.observations else {
            return Ok(());
        };
        if !matches!(mission.command, SkillCommand::Inspect { .. })
            || mission.evidence.is_none()
            || !matches!(
                mission.status,
                MissionStatus::Succeeded | MissionStatus::Failed
            )
        {
            return Ok(());
        }
        let body_id = mission
            .assigned_body_id
            .as_ref()
            .ok_or(ApplicationError::Infrastructure)?;
        let body = self
            .bodies
            .get(body_id)
            .await?
            .ok_or(ApplicationError::NotFound { entity: "body" })?;
        if let Some(observation) =
            Observation::from_validated_inspection(mission, &body, mission.updated_at)?
            && store.insert_observation(observation.clone()).await?
        {
            self.audit.append(AuditRecord {
                occurred_at: observation.received_at,
                actor: AuditActor::Body(body_id.to_string()),
                event_type: "observation.recorded".into(), object_id: observation.id,
                metadata: serde_json::json!({
                    "subject_key": observation.subject_key, "outcome": observation.outcome,
                    "mission_id": observation.mission_id, "command_id": observation.command_id,
                    "image_sha256": observation.image_sha256, "frame_sha256": observation.frame_sha256,
                }),
            }).await?;
        }
        Ok(())
    }

    fn observation_store(&self) -> Result<&dyn ObservationRepository, ApplicationError> {
        self.observations
            .as_deref()
            .ok_or_else(|| conflict("shared observation memory requires durable storage"))
    }
}

/// Bounds queries before persistence work; the same guard protects direct adapter use.
pub fn validate_observation_query(
    limit: u32,
    subject: Option<&str>,
) -> Result<(), ApplicationError> {
    if !(1..=100).contains(&limit) {
        return Err(conflict("observation limit must be between 1 and 100"));
    }
    if subject.is_some_and(|s| s.is_empty() || s.len() > 160 || s.chars().any(char::is_control)) {
        return Err(conflict(
            "subject key must contain 1 to 160 printable characters",
        ));
    }
    Ok(())
}

fn conflict(message: &str) -> ApplicationError {
    ApplicationError::Conflict(message.into())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use lattice_domain::{BatteryPercent, BodyKind, BodyStatus, InspectionEvidence};

    fn fixture(detected: bool) -> (Mission, BodySnapshot) {
        let now = DateTime::from_timestamp(1_800_000_000, 0).unwrap();
        let body = BodySnapshot {
            id: BodyId::new("rover-r1").unwrap(),
            display_name: "Rover 1".into(),
            kind: BodyKind::Rover,
            status: BodyStatus::Online,
            battery: BatteryPercent::new(90).unwrap(),
            location: "inspection_bay".into(),
            pose: Some(BodyPose {
                x: 1.0,
                y: 2.0,
                yaw: 0.5,
            }),
            capabilities: Default::default(),
            last_seen: now - chrono::Duration::seconds(1),
            adapter_version: "test".into(),
        };
        let mut mission = Mission::new(
            MissionId::new("mission-first").unwrap(),
            "Inspect bay",
            SkillCommand::Inspect {
                location: "inspection_bay".into(),
            },
            now,
        )
        .unwrap();
        let command = CommandId::new("command-first").unwrap();
        mission
            .assign(body.id.clone(), command.clone(), now)
            .unwrap();
        if detected {
            mission.mark_succeeded(&command, now).unwrap();
        } else {
            mission
                .mark_failed(&command, "no marker detected", now)
                .unwrap();
        }
        mission.evidence = Some(InspectionEvidence {
            model_id: "safety-marker-v1".into(),
            captured_at_ms: now.timestamp_millis(),
            frame_sha256: "a".repeat(64),
            image_sha256: "b".repeat(64),
            image_base64: "not-copied".into(),
            detections: if detected {
                vec![Detection {
                    label: "octagonal_safety_marker".into(),
                    confidence: 0.91,
                    r#box: [1, 2, 30, 40],
                }]
            } else {
                vec![]
            },
            confidence_domain: "synthetic crops only".into(),
        });
        (mission, body)
    }

    #[test]
    fn preserves_source_and_pose_without_copying_images_or_claiming_object_coordinates() {
        let (mission, body) = fixture(true);
        let observation =
            Observation::from_validated_inspection(&mission, &body, mission.updated_at)
                .unwrap()
                .unwrap();
        assert_eq!(observation.subject_key, "safety-marker:inspection_bay");
        assert_eq!(observation.outcome, ObservationOutcome::Detected);
        assert_eq!(observation.observer_pose, body.pose);
        assert_eq!(observation.observer_pose_at, Some(body.last_seen));
        assert_eq!(observation.mission_id, mission.id);
        assert_eq!(observation.command_id, mission.active_command_id.unwrap());
        assert_eq!(observation.confidence, Some(0.91));
        assert_eq!(observation.image_sha256, "b".repeat(64));
        assert_eq!(observation.frame_sha256, "a".repeat(64));
        let json = serde_json::to_value(observation).unwrap();
        assert!(json.get("image_base64").is_none());
        assert!(json.get("object_pose").is_none());
    }

    #[test]
    fn no_marker_is_a_distinct_observation_without_a_fabricated_confidence() {
        let (mission, mut body) = fixture(false);
        body.pose = None;
        let observation =
            Observation::from_validated_inspection(&mission, &body, mission.updated_at)
                .unwrap()
                .unwrap();
        assert_eq!(observation.outcome, ObservationOutcome::NotDetected);
        assert_eq!(observation.confidence, None);
        assert_eq!(observation.observer_pose_at, None);
    }

    #[test]
    fn missing_images_and_unfinished_work_do_not_become_negative_observations() {
        let (mut mission, body) = fixture(false);
        mission.status = MissionStatus::Running;
        assert!(
            Observation::from_validated_inspection(&mission, &body, mission.updated_at)
                .unwrap()
                .is_none()
        );
        mission.status = MissionStatus::Failed;
        mission.evidence = None;
        assert!(
            Observation::from_validated_inspection(&mission, &body, mission.updated_at)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn mismatched_body_cannot_supply_observation_provenance() {
        let (mission, mut body) = fixture(true);
        body.id = BodyId::new("rover-r2").unwrap();
        assert!(
            Observation::from_validated_inspection(&mission, &body, mission.updated_at).is_err()
        );
    }

    #[test]
    fn query_bounds_are_enforced() {
        assert!(validate_observation_query(0, None).is_err());
        assert!(validate_observation_query(101, None).is_err());
        assert!(validate_observation_query(20, Some("bad\nsubject")).is_err());
        assert!(validate_observation_query(100, Some("safety-marker:inspection_bay")).is_ok());
    }
}
