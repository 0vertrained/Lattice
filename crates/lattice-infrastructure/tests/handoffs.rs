//! Stateful handoff regressions. Set LATTICE_TEST_DATABASE_URL to a disposable empty DB.
#![allow(clippy::unwrap_used)]
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use lattice_application::{
    Clock, CommandSigner, CreateMissionRequest, HandoffRepository, HeartbeatRequest,
    LatticeService, MissionRepository, RegisterBodyRequest, RoundStep, ServiceConfig,
};
use lattice_domain::{
    AuditActor, BatteryPercent, BodyId, BodyKind, BodyStatus, Capability, CommandResult,
    CommandResultStatus, Detection, InspectionEvidence, MissionStatus, SkillCommand,
};
use lattice_infrastructure::{Ed25519CommandSigner, PostgresPlatform, PostgresUnit};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.0.load(Ordering::SeqCst), 0).unwrap()
    }
}
fn service(
    tx: Arc<PostgresUnit>,
    signer: Arc<Ed25519CommandSigner>,
    clock: Arc<TestClock>,
) -> LatticeService {
    LatticeService::new(
        tx.clone(),
        tx.clone(),
        tx.clone(),
        signer,
        tx.clone(),
        clock,
        ServiceConfig::default(),
    )
    .with_proposals(tx.clone())
    .with_rounds(tx.clone())
    .with_observations(tx.clone())
    .with_handoffs(tx)
}
fn actor() -> AuditActor {
    AuditActor::Operator("handoff-test".into())
}
fn registration(id: &str) -> RegisterBodyRequest {
    RegisterBodyRequest {
        id: BodyId::new(id).unwrap(),
        display_name: id.into(),
        kind: BodyKind::Rover,
        capabilities: [Capability::Navigate, Capability::Inspect]
            .into_iter()
            .collect(),
        adapter_version: "test-1".into(),
    }
}
async fn heartbeat(app: &LatticeService, id: &BodyId) {
    app.heartbeat(
        id,
        HeartbeatRequest {
            status: BodyStatus::Online,
            battery: BatteryPercent::new(90).unwrap(),
            location: "inspection_bay".into(),
            pose: None,
        },
    )
    .await
    .unwrap();
}
fn navigate(title: &str, destination: &str) -> RoundStep {
    RoundStep {
        title: title.into(),
        command: SkillCommand::Navigate {
            destination: destination.into(),
            max_speed_mps: 0.2,
        },
        continue_on_missing_marker: false,
    }
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn reviewed_handoff_keeps_evidence_and_suffix_with_durable_fences() {
    let url = std::env::var("LATTICE_TEST_DATABASE_URL").unwrap();
    let db = PostgresPlatform::connect(&url).await.unwrap();
    let signer = Arc::new(Ed25519CommandSigner::generate_ephemeral("test-key"));
    let clock = Arc::new(TestClock(AtomicI64::new(1_800_000_000)));
    let key = signer.verification_key().await.unwrap();
    db.recover(&key.public_key_base64, "handoff-epoch-1")
        .await
        .unwrap();
    let tx = db.begin().await.unwrap();
    let app = service(tx.clone(), signer.clone(), clock.clone());
    let a = BodyId::new("rover-a").unwrap();
    let b = BodyId::new("rover-b").unwrap();
    app.register_body(registration(a.as_str()), actor())
        .await
        .unwrap();
    app.register_body(registration(b.as_str()), actor())
        .await
        .unwrap();
    let round = app
        .propose_round(vec![
            RoundStep {
                title: "Observe bay".into(),
                command: SkillCommand::Inspect {
                    location: "inspection_bay".into(),
                },
                continue_on_missing_marker: false,
            },
            navigate("Navigate to dock", "loading_dock"),
            navigate("Return to charge", "charging_station"),
        ])
        .await
        .unwrap();
    let round = app
        .approve_round(&round.id, &round.digest, actor())
        .await
        .unwrap();
    assert_eq!(round.assigned_body_id, Some(a.clone()));
    let first = app.next_command(&a).await.unwrap().unwrap();
    let jpeg = include_bytes!("../../../apps/control-center/public/demo/inspection-1.jpg");
    let observed = app
        .report_result(
            &first.envelope.mission_id,
            CommandResult {
                command_id: first.envelope.command_id.clone(),
                body_id: a.clone(),
                status: CommandResultStatus::Succeeded,
                progress_pct: 100,
                detail: None,
                reported_at: clock.now(),
                context_digest: None,
                evidence: Some(InspectionEvidence {
                    model_id: "test-marker-v1".into(),
                    captured_at_ms: clock.now().timestamp_millis(),
                    frame_sha256: "a".repeat(64),
                    image_sha256: format!("{:x}", Sha256::digest(jpeg)),
                    image_base64: STANDARD.encode(jpeg),
                    detections: vec![Detection {
                        label: "octagonal_safety_marker".into(),
                        confidence: 0.91,
                        r#box: [1, 2, 30, 40],
                    }],
                    confidence_domain: "synthetic test only".into(),
                }),
            },
        )
        .await
        .unwrap();
    let second = app.next_command(&a).await.unwrap().unwrap();
    let proposal = app
        .propose_handoff(&round.id, b.clone(), actor())
        .await
        .unwrap();
    assert_eq!(proposal.completed_steps.len(), 1);
    assert_eq!(proposal.remaining_steps.len(), 2);
    assert_eq!(proposal.context.observations.len(), 1);
    assert_eq!(
        proposal.context.observations[0].observation_id,
        format!("observation-{}", first.envelope.command_id)
    );
    assert_eq!(
        proposal.not_before_at,
        second.envelope.expires_at + chrono::Duration::seconds(2)
    );
    assert!(
        app.approve_handoff(&proposal.id, &proposal.digest, actor())
            .await
            .is_err()
    );
    assert!(
        app.approve_handoff(&proposal.id, "wrong", actor())
            .await
            .is_err()
    );
    assert!(app.next_command(&a).await.is_err());
    assert!(
        app.register_body(registration(a.as_str()), actor())
            .await
            .is_err()
    );
    assert!(
        app.heartbeat(
            &a,
            HeartbeatRequest {
                status: BodyStatus::Online,
                battery: BatteryPercent::new(90).unwrap(),
                location: "charging_station".into(),
                pose: None
            }
        )
        .await
        .is_err()
    );
    let old_result = CommandResult {
        command_id: second.envelope.command_id.clone(),
        body_id: a.clone(),
        status: CommandResultStatus::Succeeded,
        progress_pct: 100,
        detail: None,
        reported_at: clock.now(),
        evidence: None,
        context_digest: None,
    };
    assert_eq!(
        app.report_result(&second.envelope.mission_id, old_result.clone())
            .await
            .unwrap()
            .status,
        MissionStatus::RecoveryRequired
    );
    let recovery = app
        .propose_recovery(&second.envelope.mission_id)
        .await
        .unwrap();
    assert!(
        app.approve_proposal(&recovery.id, &recovery.digest, actor())
            .await
            .is_err()
    );
    assert!(app.next_command(&b).await.unwrap().is_none());
    tx.finish(true).await.unwrap();
    drop(app);
    drop(tx);

    // Restart invalidates the review while the persisted fence survives.
    db.recover(&key.public_key_base64, "handoff-epoch-2")
        .await
        .unwrap();
    let tx = db.begin().await.unwrap();
    let app = service(tx.clone(), signer.clone(), clock.clone());
    assert_eq!(app.list_handoffs().await.unwrap()[0].status, "invalidated");
    assert!(app.next_command(&a).await.is_err());
    assert_eq!(
        HandoffRepository::body_fence(tx.as_ref(), &a)
            .await
            .unwrap(),
        Some(proposal.not_before_at)
    );
    heartbeat(&app, &b).await;
    let replacement = app
        .propose_handoff(&round.id, b.clone(), actor())
        .await
        .unwrap();
    assert!(
        app.approve_handoff(&proposal.id, &proposal.digest, actor())
            .await
            .is_err()
    );
    clock
        .0
        .store(replacement.not_before_at.timestamp(), Ordering::SeqCst);
    // Freshness is revalidated at approval, not trusted from proposal time.
    assert!(
        app.approve_handoff(&replacement.id, &replacement.digest, actor())
            .await
            .is_err()
    );
    heartbeat(&app, &b).await;
    let approved = app
        .approve_handoff(&replacement.id, &replacement.digest, actor())
        .await
        .unwrap();
    let duplicate = app
        .approve_handoff(&replacement.id, &replacement.digest, actor())
        .await
        .unwrap();
    assert_eq!(approved.resumed_mission_id, duplicate.resumed_mission_id);
    let continuation = app.next_command(&b).await.unwrap().unwrap();
    assert!(app.next_command(&b).await.unwrap().is_none());
    assert_eq!(continuation.envelope.command, second.envelope.command);
    let context = continuation.envelope.continuation.as_ref().unwrap();
    assert_eq!(context.completed_steps, 1);
    let reference = &context.observations[0];
    let (observation, evidence) = app
        .handoff_evidence(
            &b,
            &continuation.envelope.mission_id,
            &reference.observation_id,
        )
        .await
        .unwrap();
    assert_eq!(observation.mission_id, observed.id);
    assert_eq!(evidence.image_sha256, reference.image_sha256);
    assert!(
        app.handoff_evidence(
            &a,
            &continuation.envelope.mission_id,
            &reference.observation_id
        )
        .await
        .is_err()
    );
    assert!(
        app.handoff_evidence(
            &b,
            &continuation.envelope.mission_id,
            "observation-unrelated"
        )
        .await
        .is_err()
    );
    let mut result = CommandResult {
        command_id: continuation.envelope.command_id.clone(),
        body_id: b.clone(),
        status: CommandResultStatus::Running,
        progress_pct: 0,
        detail: None,
        reported_at: clock.now(),
        evidence: None,
        context_digest: None,
    };
    assert!(
        app.report_result(&continuation.envelope.mission_id, result.clone())
            .await
            .is_err()
    );
    result.context_digest = Some("tampered".into());
    assert!(
        app.report_result(&continuation.envelope.mission_id, result.clone())
            .await
            .is_err()
    );
    result.context_digest = Some(context.digest.clone());
    app.report_result(&continuation.envelope.mission_id, result.clone())
        .await
        .unwrap();
    assert!(
        app.list_handoffs()
            .await
            .unwrap()
            .iter()
            .find(|p| p.id == approved.id)
            .unwrap()
            .context_acknowledged_at
            .is_some()
    );
    assert_eq!(
        app.report_result(&second.envelope.mission_id, old_result)
            .await
            .unwrap()
            .status,
        MissionStatus::Cancelled
    );
    // Even if A is fresh again, the next approved step stays on B.
    heartbeat(&app, &a).await;
    result.status = CommandResultStatus::Succeeded;
    result.progress_pct = 100;
    app.report_result(&continuation.envelope.mission_id, result.clone())
        .await
        .unwrap();
    let last = app.next_command(&b).await.unwrap().unwrap();
    assert_eq!(
        last.envelope.command,
        navigate("Return to charge", "charging_station").command
    );
    assert!(app.next_command(&a).await.unwrap().is_none());
    result.command_id = last.envelope.command_id;
    app.report_result(&last.envelope.mission_id, result)
        .await
        .unwrap();
    let completed = app
        .list_rounds()
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.id == round.id)
        .unwrap();
    assert_eq!(completed.status, "completed");
    assert_eq!(completed.mission_ids.len(), 4); // first, held attempt, continued step, final step
    assert_eq!(app.observations(100, None).await.unwrap().len(), 1);
    assert_eq!(
        MissionRepository::get(tx.as_ref(), &observed.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        MissionStatus::Succeeded
    );
    // New ordinary work cannot overlap another active command on its body.
    let one = app
        .create_mission(
            CreateMissionRequest {
                title: "First independent task".into(),
                command: navigate("x", "loading_dock").command,
            },
            actor(),
        )
        .await
        .unwrap();
    let two = app
        .create_mission(
            CreateMissionRequest {
                title: "Second independent task".into(),
                command: navigate("x", "loading_dock").command,
            },
            actor(),
        )
        .await
        .unwrap();
    assert_ne!(one.assigned_body_id, two.assigned_body_id);
    tx.finish(true).await.unwrap();
}
