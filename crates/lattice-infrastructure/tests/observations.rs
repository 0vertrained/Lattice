//! Run with LATTICE_TEST_DATABASE_URL pointing to an isolated, empty database.
#![allow(clippy::unwrap_used)]
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use lattice_application::{
    AuditSink, Clock, CommandSigner, CreateMissionRequest, HeartbeatRequest, LatticeService,
    MissionRepository, ObservationOutcome, ObservationRepository, RegisterBodyRequest,
    ServiceConfig,
};
use lattice_domain::{
    AuditActor, BatteryPercent, BodyId, BodyKind, BodyPose, BodyStatus, Capability, CommandResult,
    CommandResultStatus, Detection, InspectionEvidence, Mission, MissionStatus, SkillCommand,
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
    .with_observations(tx)
}

fn actor() -> AuditActor {
    AuditActor::Operator("observation-test".into())
}

async fn heartbeat(app: &LatticeService, body: &BodyId) {
    app.heartbeat(
        body,
        HeartbeatRequest {
            status: BodyStatus::Online,
            battery: BatteryPercent::new(90).unwrap(),
            location: "inspection_bay".into(),
            pose: Some(BodyPose {
                x: 1.2,
                y: -0.3,
                yaw: 0.2,
            }),
        },
    )
    .await
    .unwrap();
}

async fn inspect(
    app: &LatticeService,
    body: &BodyId,
    clock: &TestClock,
    detected: bool,
) -> (Mission, CommandResult) {
    heartbeat(app, body).await;
    let mission = app
        .create_mission(
            CreateMissionRequest {
                title: "Observe inspection bay".into(),
                command: SkillCommand::Inspect {
                    location: "inspection_bay".into(),
                },
            },
            actor(),
        )
        .await
        .unwrap();
    let command = app.next_command(body).await.unwrap().unwrap();
    // Real bounded JPEG from the checked-in demo, used only to exercise integrity validation.
    let jpeg = include_bytes!("../../../apps/control-center/public/demo/inspection-1.jpg");
    let result = CommandResult {
        command_id: command.envelope.command_id,
        body_id: body.clone(),
        status: if detected {
            CommandResultStatus::Succeeded
        } else {
            CommandResultStatus::Failed
        },
        progress_pct: 100,
        detail: (!detected).then(|| "no marker detected".into()),
        reported_at: clock.now(),
        context_digest: None,
        evidence: Some(InspectionEvidence {
            model_id: "fixture-marker-v1".into(),
            captured_at_ms: clock.now().timestamp_millis(),
            image_sha256: format!("{:x}", Sha256::digest(jpeg)),
            image_base64: STANDARD.encode(jpeg),
            frame_sha256: "a".repeat(64),
            confidence_domain: "synthetic fixture only".into(),
            detections: if detected {
                vec![Detection {
                    label: "octagonal_safety_marker".into(),
                    confidence: 0.91,
                    r#box: [10, 10, 20, 20],
                }]
            } else {
                vec![]
            },
        }),
    };
    (mission, result)
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn shared_memory_is_atomic_immutable_and_preserves_positive_history_across_restart() {
    let url = std::env::var("LATTICE_TEST_DATABASE_URL").unwrap();
    let db = PostgresPlatform::connect(&url).await.unwrap();
    let signer = Arc::new(Ed25519CommandSigner::generate_ephemeral("observation-test"));
    let key = signer.verification_key().await.unwrap().public_key_base64;
    db.recover(&key, "observations-first-boot").await.unwrap();
    let clock = Arc::new(TestClock(AtomicI64::new(Utc::now().timestamp())));
    let body = BodyId::new("memory-rover-r1").unwrap();

    let tx = db.begin().await.unwrap();
    let app = service(tx.clone(), signer.clone(), clock.clone());
    app.register_body(
        RegisterBodyRequest {
            id: body.clone(),
            display_name: "Memory rover".into(),
            kind: BodyKind::Rover,
            capabilities: [Capability::Inspect].into(),
            adapter_version: "test-v1".into(),
        },
        actor(),
    )
    .await
    .unwrap();
    let (positive_mission, positive_result) = inspect(&app, &body, &clock, true).await;

    // A wrong body or mismatched image cannot create shared knowledge.
    let mut wrong_body = positive_result.clone();
    wrong_body.body_id = BodyId::new("another-rover").unwrap();
    assert!(
        app.report_result(&positive_mission.id, wrong_body)
            .await
            .is_err()
    );
    let mut bad_hash = positive_result.clone();
    bad_hash.evidence.as_mut().unwrap().image_sha256 = "f".repeat(64);
    assert!(
        app.report_result(&positive_mission.id, bad_hash)
            .await
            .is_err()
    );
    assert!(app.observations(20, None).await.unwrap().is_empty());

    app.report_result(&positive_mission.id, positive_result.clone())
        .await
        .unwrap();
    let positive = app.last_seen(None).await.unwrap().last_seen.unwrap();
    assert_eq!(positive.mission_id, positive_mission.id);
    assert_eq!(positive.body_id, body);
    assert_eq!(positive.outcome, ObservationOutcome::Detected);
    assert_eq!(positive.observer_pose.unwrap().x, 1.2);
    assert_eq!(
        app.source_evidence(&positive).await.unwrap().image_sha256,
        positive.image_sha256
    );
    let mut changed_source = positive.clone();
    changed_source.model_id = "changed-provenance".into();
    assert!(app.source_evidence(&changed_source).await.is_err());
    let retained_mission = MissionRepository::get(tx.as_ref(), &positive.mission_id)
        .await
        .unwrap()
        .unwrap();
    let mut corrupt_image = retained_mission.clone();
    corrupt_image.evidence.as_mut().unwrap().image_base64 =
        STANDARD.encode([0xff, 0xd8, 0xff, 0x01]);
    MissionRepository::save(tx.as_ref(), corrupt_image)
        .await
        .unwrap();
    assert!(
        app.source_evidence(&positive).await.is_err(),
        "source bytes must match the immutable JPEG hash"
    );
    MissionRepository::save(tx.as_ref(), retained_mission)
        .await
        .unwrap();
    assert!(
        serde_json::to_value(&positive)
            .unwrap()
            .get("image_base64")
            .is_none()
    );

    // Retrying a terminal acknowledgement and replaying an identical stored record are idempotent.
    app.report_result(&positive_mission.id, positive_result.clone())
        .await
        .unwrap();
    assert!(!tx.insert_observation(positive.clone()).await.unwrap());
    let mut rewritten = positive.clone();
    rewritten.model_id = "different-model".into();
    assert!(tx.insert_observation(rewritten).await.is_err());
    assert_eq!(app.observations(100, None).await.unwrap().len(), 1);
    assert_eq!(
        AuditSink::list(tx.as_ref())
            .await
            .unwrap()
            .iter()
            .filter(|a| a.event_type == "observation.recorded")
            .count(),
        1
    );
    tx.finish(true).await.unwrap();
    drop(app);
    drop(tx);

    // Storage itself rejects mutation even if a future adapter accidentally adds an update.
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    for statement in [
        "UPDATE observations SET observation=observation WHERE observation_id=$1",
        "DELETE FROM observations WHERE observation_id=$1",
    ] {
        let error = client
            .execute(statement, &[&positive.id])
            .await
            .unwrap_err();
        assert!(
            error
                .as_db_error()
                .unwrap()
                .message()
                .contains("observations are immutable")
        );
    }
    drop(client);

    // An accepted image and source mission update roll back as one unit.
    clock.0.fetch_add(2, Ordering::SeqCst);
    let tx = db.begin().await.unwrap();
    let app = service(tx.clone(), signer.clone(), clock.clone());
    let (rolled_back, result) = inspect(&app, &body, &clock, false).await;
    app.report_result(&rolled_back.id, result).await.unwrap();
    assert_eq!(app.observations(20, None).await.unwrap().len(), 2);
    tx.finish(false).await.unwrap();
    drop(app);
    drop(tx);

    let tx = db.begin().await.unwrap();
    let app = service(tx.clone(), signer.clone(), clock.clone());
    assert!(
        MissionRepository::get(tx.as_ref(), &rolled_back.id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(app.observations(20, None).await.unwrap().len(), 1);
    let (negative_mission, negative_result) = inspect(&app, &body, &clock, false).await;
    app.report_result(&negative_mission.id, negative_result)
        .await
        .unwrap();
    let answer = app
        .last_seen(Some("safety-marker:inspection_bay"))
        .await
        .unwrap();
    assert_eq!(answer.last_seen.unwrap().id, positive.id);
    let negative = answer.later_negative.unwrap();
    assert_eq!(negative.mission_id, negative_mission.id);
    assert_eq!(negative.outcome, ObservationOutcome::NotDetected);
    assert_eq!(negative.confidence, None);
    assert!(negative.captured_at > positive.captured_at);
    assert_eq!(app.observations(1, None).await.unwrap()[0].id, negative.id);
    assert!(
        app.observations(100, Some("safety-marker:charging_dock"))
            .await
            .unwrap()
            .is_empty()
    );
    assert!(app.observations(101, None).await.is_err());
    assert!(
        app.last_seen(Some("safety-marker:charging_dock"))
            .await
            .unwrap()
            .last_seen
            .is_none()
    );
    clock.0.fetch_add(2, Ordering::SeqCst);
    let (camera_failure, mut missing_image) = inspect(&app, &body, &clock, false).await;
    missing_image.evidence = None;
    missing_image.detail = Some("camera unavailable".into());
    app.report_result(&camera_failure.id, missing_image)
        .await
        .unwrap();
    assert_eq!(app.observations(20, None).await.unwrap().len(), 2);
    assert_eq!(
        app.last_seen(None)
            .await
            .unwrap()
            .later_negative
            .unwrap()
            .id,
        negative.id
    );
    tx.finish(true).await.unwrap();
    drop(app);
    drop(tx);

    // Core recovery invalidates active work, but completed observations and evidence survive.
    db.recover(&key, "observations-second-boot").await.unwrap();
    let tx = db.begin().await.unwrap();
    let app = service(tx.clone(), signer, clock);
    let answer = app.last_seen(None).await.unwrap();
    assert_eq!(answer.last_seen.unwrap().id, positive.id);
    assert_eq!(answer.later_negative.unwrap().id, negative.id);
    let original = MissionRepository::get(tx.as_ref(), &positive.mission_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original.status, MissionStatus::Succeeded);
    assert_eq!(
        original.evidence.unwrap().image_sha256,
        positive.image_sha256
    );
    assert_eq!(
        app.source_evidence(&positive).await.unwrap().image_sha256,
        positive.image_sha256
    );
    assert_eq!(app.observations(100, None).await.unwrap().len(), 2);
    tx.finish(false).await.unwrap();
}
