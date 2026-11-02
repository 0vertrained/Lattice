#![doc = "Verification and local navigation contracts for the ROS 2 body agent."]

use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, VerifyingKey};
use lattice_domain::{BodyId, BodyPose, SignedCommand, SkillCommand, VerificationKey};
use serde::{Deserialize, Serialize};

/// Local gateway response. The gateway owns ROS action state and localization.
#[derive(Debug, Clone, Deserialize)]
pub struct GatewayState {
    /// False when the local request was rejected.
    pub ok: bool,
    /// Nav2 and map localization are available and E-stop is clear.
    pub ready: bool,
    /// idle, running, succeeded, failed, or rejected.
    pub state: String,
    /// Active command identity; prevents stale state completing a new mission.
    pub command_id: String,
    /// Human-readable local failure or completion detail.
    pub detail: String,
    /// Last map localization; absent when localization is stale.
    pub pose: Option<BodyPose>,
    /// Nav2 feedback-derived progress, capped below completion until success.
    pub progress_pct: u8,
    /// Captured frame basename in the shared private run directory.
    pub capture_file: Option<String>,
    /// Wall time when the gateway received the frame.
    pub capture_unix_ms: Option<i64>,
}

/// A locally authorized goal. Only sent after verifying the signed envelope.
#[derive(Debug, Serialize)]
pub struct NavigationGoal<'a> {
    /// Local protocol operation.
    pub op: &'static str,
    /// Signed command identity.
    pub command_id: String,
    /// Named location resolved by the gateway's reviewed map configuration.
    pub destination: &'a str,
    /// Signed speed bound, additionally capped by local policy.
    pub max_speed_mps: f32,
    /// Remaining signed lifetime, enforced on a monotonic local clock.
    pub ttl_ms: i64,
    /// Signed UTC deadline; the gateway subtracts local transport delay.
    pub expires_unix_ms: i64,
    /// Inspection requires a fresh frame after arrival.
    pub inspection: bool,
}

/// Verifies authentication, target, sequence, wall-clock validity and skill bounds.
/// The caller persists the accepted sequence before sending anything to ROS.
pub fn verify_navigation<'a>(
    command: &'a SignedCommand,
    key: &VerificationKey,
    body_id: &BodyId,
    highest_sequence: u64,
    now: DateTime<Utc>,
) -> Result<NavigationGoal<'a>, Box<dyn std::error::Error + Send + Sync>> {
    let envelope = &command.envelope;
    if key.algorithm != "Ed25519" || key.key_id != command.key_id {
        return Err("unrecognized signing key".into());
    }
    if envelope.body_id != *body_id || envelope.sequence <= highest_sequence {
        return Err("wrong body or replayed command".into());
    }
    if envelope.is_expired(now) || envelope.issued_at > now {
        return Err("expired or future-dated command".into());
    }
    envelope.command.validate()?;
    let key_bytes: [u8; 32] = STANDARD
        .decode(&key.public_key_base64)?
        .try_into()
        .map_err(|_| "invalid public key length")?;
    let signature = Signature::from_slice(&STANDARD.decode(&command.signature_base64)?)?;
    VerifyingKey::from_bytes(&key_bytes)?.verify_strict(&envelope.signing_bytes()?, &signature)?;
    if let Some(context) = &envelope.continuation {
        context.validate()?;
        if context.target_body_id != *body_id {
            return Err("continuation belongs to a different body".into());
        }
    }
    let (destination, speed, inspection) = match &envelope.command {
        SkillCommand::Navigate {
            destination,
            max_speed_mps,
        } => (destination.as_str(), *max_speed_mps, false),
        SkillCommand::Inspect { location } => (location.as_str(), 0.3, true),
        _ => return Err("ROS adapter supports navigate and inspect only".into()),
    };
    Ok(NavigationGoal {
        op: "navigate",
        command_id: envelope.command_id.to_string(),
        destination,
        max_speed_mps: speed,
        inspection,
        ttl_ms: (envelope.expires_at - now).num_milliseconds(),
        expires_unix_ms: envelope.expires_at.timestamp_millis(),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use chrono::Duration;
    use ed25519_dalek::{Signer, SigningKey};
    use lattice_domain::{CommandEnvelope, CommandId, MissionId};

    fn fixture() -> (SignedCommand, VerificationKey, BodyId, DateTime<Utc>) {
        let now = Utc::now();
        let body = BodyId::new("gazebo-rover").unwrap();
        let signer = SigningKey::from_bytes(&[7; 32]);
        let envelope = CommandEnvelope {
            command_id: CommandId::new("command-test").unwrap(),
            mission_id: MissionId::new("mission-test").unwrap(),
            body_id: body.clone(),
            sequence: 2,
            command: SkillCommand::Navigate {
                destination: "loading_dock".into(),
                max_speed_mps: 0.3,
            },
            issued_at: now - Duration::seconds(1),
            expires_at: now + Duration::seconds(30),
            continuation: None,
        };
        let command = SignedCommand {
            signature_base64: STANDARD
                .encode(signer.sign(&envelope.signing_bytes().unwrap()).to_bytes()),
            envelope,
            key_id: "test-key".into(),
        };
        let key = VerificationKey {
            algorithm: "Ed25519".into(),
            key_id: "test-key".into(),
            public_key_base64: STANDARD.encode(signer.verifying_key().to_bytes()),
        };
        (command, key, body, now)
    }

    #[test]
    fn accepts_signed_navigation_and_preserves_bounds() {
        let (command, key, body, now) = fixture();
        let goal = verify_navigation(&command, &key, &body, 1, now).unwrap();
        assert_eq!(goal.destination, "loading_dock");
        assert_eq!(goal.ttl_ms, 30_000);
        assert_eq!(goal.max_speed_mps, 0.3);
    }

    #[test]
    fn inspection_flag_and_location_are_covered_by_signature() {
        let (mut command, key, body, now) = fixture();
        command.envelope.command = SkillCommand::Inspect {
            location: "inspection_bay".into(),
        };
        assert!(verify_navigation(&command, &key, &body, 0, now).is_err());
        let signer = SigningKey::from_bytes(&[7; 32]);
        command.signature_base64 = STANDARD.encode(
            signer
                .sign(&command.envelope.signing_bytes().unwrap())
                .to_bytes(),
        );
        let goal = verify_navigation(&command, &key, &body, 0, now).unwrap();
        assert!(goal.inspection);
        assert_eq!(goal.destination, "inspection_bay");
        assert_eq!(goal.max_speed_mps, 0.3);
    }

    #[test]
    fn rejects_tampering_replay_expiry_wrong_body_and_key() {
        let (mut command, key, body, now) = fixture();
        assert!(verify_navigation(&command, &key, &body, 2, now).is_err());
        assert!(verify_navigation(&command, &key, &body, 0, now + Duration::seconds(30)).is_err());
        assert!(verify_navigation(&command, &key, &BodyId::new("other").unwrap(), 0, now).is_err());
        assert!(verify_navigation(&command, &key, &body, 0, now - Duration::seconds(2)).is_err());
        command.key_id = "unknown".into();
        assert!(verify_navigation(&command, &key, &body, 0, now).is_err());
        command.key_id = key.key_id.clone();
        command.envelope.command = SkillCommand::Navigate {
            destination: "tampered".into(),
            max_speed_mps: 0.3,
        };
        assert!(verify_navigation(&command, &key, &body, 0, now).is_err());
    }

    #[test]
    fn continuation_is_signed_target_bound_and_backward_compatible() {
        let (mut command, key, body, now) = fixture();
        let legacy = command.envelope.signing_bytes().unwrap();
        assert!(
            !String::from_utf8(legacy.clone())
                .unwrap()
                .contains("continuation")
        );
        let decoded: lattice_domain::CommandEnvelope = serde_json::from_slice(&legacy).unwrap();
        assert_eq!(decoded.signing_bytes().unwrap(), legacy);
        let mut context = lattice_domain::ContinuationContext {
            handoff_id: "handoff-test".into(),
            round_id: "round-test".into(),
            source_body_id: BodyId::new("source-rover").unwrap(),
            target_body_id: body.clone(),
            completed_steps: 1,
            observations: vec![],
            digest: String::new(),
        };
        context.digest = context.compute_digest().unwrap();
        command.envelope.continuation = Some(context);
        assert!(verify_navigation(&command, &key, &body, 0, now).is_err());
        let signer = SigningKey::from_bytes(&[7; 32]);
        command.signature_base64 = STANDARD.encode(
            signer
                .sign(&command.envelope.signing_bytes().unwrap())
                .to_bytes(),
        );
        verify_navigation(&command, &key, &body, 0, now).unwrap();
        let context = command.envelope.continuation.as_mut().unwrap();
        context.target_body_id = BodyId::new("third-rover").unwrap();
        context.digest = context.compute_digest().unwrap();
        command.signature_base64 = STANDARD.encode(
            signer
                .sign(&command.envelope.signing_bytes().unwrap())
                .to_bytes(),
        );
        assert!(verify_navigation(&command, &key, &body, 0, now).is_err());
    }
}
