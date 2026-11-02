//! Durable adaptive mission acceptance. All sensor/results below are explicit transport fixtures.
#![allow(clippy::unwrap_used)]
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use lattice_application::{
    Clock, CommandSigner, HandoffRepository, HeartbeatRequest, LatticeService, RegisterBodyRequest,
    RouteConditionInput, RouteObjectiveRequest, ServiceConfig,
};
use lattice_domain::{
    AuditActor, BatteryPercent, BodyId, BodyKind, BodyPose, BodyStatus, Capability, CommandResult,
    CommandResultStatus, Detection, InspectionEvidence, MissionStatus, SignedCommand, SkillCommand,
    navigation::{RoutePose, RouteRequest, RouteSegment, SemanticMap, SemanticPlace},
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
fn actor() -> AuditActor {
    AuditActor::Operator("adaptive-test".into())
}
fn map() -> SemanticMap {
    let mut map = SemanticMap {
        id: "adaptive-test".into(),
        revision: 1,
        frame_id: "map".into(),
        places: vec![
            SemanticPlace {
                id: "inspection_bay".into(),
                label: "Inspection bay".into(),
                pose: RoutePose {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
                arrival_radius_m: 0.25,
                transfer_allowed: false,
            },
            SemanticPlace {
                id: "transfer".into(),
                label: "Stair transfer".into(),
                pose: RoutePose {
                    x: 1.0,
                    y: 0.0,
                    z: 0.0,
                },
                arrival_radius_m: 0.25,
                transfer_allowed: true,
            },
            SemanticPlace {
                id: "upper_inspection".into(),
                label: "Upper inspection".into(),
                pose: RoutePose {
                    x: 2.0,
                    y: 0.0,
                    z: 0.6,
                },
                arrival_radius_m: 0.25,
                transfer_allowed: false,
            },
        ],
        segments: vec![
            RouteSegment {
                id: "approach".into(),
                from: "inspection_bay".into(),
                to: "transfer".into(),
                required_capabilities: [Capability::Navigate].into_iter().collect(),
                max_speed_mps: 0.2,
                enabled: true,
            },
            RouteSegment {
                id: "stairs".into(),
                from: "transfer".into(),
                to: "upper_inspection".into(),
                required_capabilities: [Capability::Navigate, Capability::Stairs]
                    .into_iter()
                    .collect(),
                max_speed_mps: 0.2,
                enabled: true,
            },
        ],
    };
    map.places.push(SemanticPlace {
        id: "detour".into(),
        label: "Clear side aisle".into(),
        pose: RoutePose {
            x: 0.0,
            y: 1.0,
            z: 0.0,
        },
        arrival_radius_m: 0.25,
        transfer_allowed: false,
    });
    for (id, from, to) in [
        ("detour_start", "inspection_bay", "detour"),
        ("detour_finish", "detour", "transfer"),
    ] {
        map.segments.push(RouteSegment {
            id: id.into(),
            from: from.into(),
            to: to.into(),
            required_capabilities: [Capability::Navigate].into_iter().collect(),
            max_speed_mps: 0.2,
            enabled: true,
        });
    }
    map
}
fn app(
    tx: Arc<PostgresUnit>,
    signer: Arc<Ed25519CommandSigner>,
    clock: Arc<TestClock>,
    map: SemanticMap,
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
    .with_handoffs(tx.clone())
    .with_route_plans(tx.clone())
    .with_adaptive_routes(tx)
    .with_navigation_map(Arc::new(map))
}
fn request() -> RouteObjectiveRequest {
    RouteObjectiveRequest {
        route: RouteRequest {
            source_body_id: BodyId::new("rover-a").unwrap(),
            source_place_id: "inspection_bay".into(),
            destination_place_id: "upper_inspection".into(),
            destination_capability: None,
        },
        inspect_source: true,
        inspect_destination: true,
    }
}
async fn register(app: &LatticeService, id: &str, kind: BodyKind, caps: Vec<Capability>) {
    app.register_body(
        RegisterBodyRequest {
            id: BodyId::new(id).unwrap(),
            display_name: id.into(),
            kind,
            capabilities: caps.into_iter().collect(),
            adapter_version: "adaptive-fixture".into(),
        },
        actor(),
    )
    .await
    .unwrap();
}
async fn pose(app: &LatticeService, id: &str, x: f64, y: f64, z: Option<f64>) {
    app.heartbeat(
        &BodyId::new(id).unwrap(),
        HeartbeatRequest {
            status: BodyStatus::Online,
            battery: BatteryPercent::new(95).unwrap(),
            location: "transport-fixture".into(),
            pose: Some(BodyPose { x, y, yaw: 0.0, z }),
        },
    )
    .await
    .unwrap();
}
fn result(
    command: &SignedCommand,
    status: CommandResultStatus,
    clock: &TestClock,
    evidence: Option<InspectionEvidence>,
) -> CommandResult {
    CommandResult {
        command_id: command.envelope.command_id.clone(),
        body_id: command.envelope.body_id.clone(),
        status,
        progress_pct: if status == CommandResultStatus::Succeeded {
            100
        } else {
            0
        },
        detail: Some("transport fixture".into()),
        reported_at: clock.now(),
        evidence,
        context_digest: command
            .envelope
            .continuation
            .as_ref()
            .map(|context| context.digest.clone()),
    }
}
fn image(clock: &TestClock) -> InspectionEvidence {
    let jpeg = include_bytes!("../../../apps/control-center/public/demo/inspection-1.jpg");
    InspectionEvidence {
        model_id: "transport-fixture".into(),
        captured_at_ms: clock.now().timestamp_millis(),
        frame_sha256: "ab".repeat(32),
        image_sha256: format!("{:x}", Sha256::digest(jpeg)),
        image_base64: STANDARD.encode(jpeg),
        confidence_domain: "transport fixture, not detector evaluation".into(),
        detections: vec![Detection {
            label: "octagonal_safety_marker".into(),
            confidence: 0.99,
            r#box: [5, 5, 40, 40],
        }],
    }
}

fn body_report(command: &SignedCommand, clock: &TestClock) -> RouteConditionInput {
    serde_json::from_value(serde_json::json!({
        "event_id": "body-obstacle-1", "map_digest": map().digest().unwrap(),
        "segment_id": "approach", "status": "blocked",
        "reason": "Transport fixture: several laser returns block the approach corridor.",
        "observed_at": clock.now(), "command_id": command.envelope.command_id,
        "evidence": { "sensor": "laser_scan", "frame_id": "map", "distance_m": 0.35,
            "blocked_samples": 7, "scan_sha256": "cd".repeat(32),
            "observer_pose": {"x": 0.0, "y": 0.0, "yaw": 0.0} }
    }))
    .unwrap()
}
fn manual_report(
    event: &str,
    segment: &str,
    status: &str,
    clock: &TestClock,
    expected_revision: Option<u64>,
) -> RouteConditionInput {
    serde_json::from_value(serde_json::json!({
        "event_id": event, "map_digest": map().digest().unwrap(), "segment_id": segment,
        "status": status, "reason": "Operator reviewed transport fixture condition.",
        "observed_at": clock.now(), "expected_revision": expected_revision
    }))
    .unwrap()
}
async fn round(app: &LatticeService, id: &str) -> lattice_application::InspectionRound {
    app.list_rounds()
        .await
        .unwrap()
        .into_iter()
        .find(|row| row.id == id)
        .unwrap()
}
fn segment(command: &SignedCommand) -> &str {
    match &command.envelope.command {
        SkillCommand::TraverseRoute { traversal } => &traversal.segment_id,
        _ => panic!("expected a reviewed route traversal"),
    }
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn adaptive_conditions_preserve_completed_work_and_review_a_safe_suffix() {
    let db = PostgresPlatform::connect(&std::env::var("LATTICE_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let signer = Arc::new(Ed25519CommandSigner::generate_ephemeral("adaptive-key"));
    let clock = Arc::new(TestClock(AtomicI64::new(1_800_000_000)));
    let key = signer.verification_key().await.unwrap();
    db.recover(&key.public_key_base64, "adaptive-epoch-1")
        .await
        .unwrap();
    let tx = db.begin().await.unwrap();
    let service = app(tx.clone(), signer.clone(), clock.clone(), map());
    let a = BodyId::new("rover-a").unwrap();
    let b = BodyId::new("quad-b").unwrap();
    register(
        &service,
        a.as_str(),
        BodyKind::Rover,
        vec![Capability::Navigate, Capability::Inspect],
    )
    .await;
    register(
        &service,
        b.as_str(),
        BodyKind::Quadruped,
        vec![
            Capability::Navigate,
            Capability::Inspect,
            Capability::Stairs,
        ],
    )
    .await;
    pose(&service, a.as_str(), 0.0, 0.0, None).await;
    pose(&service, b.as_str(), 1.0, 0.0, Some(0.0)).await;
    let map_digest = map().digest().unwrap();
    let initial_conditions = service.route_conditions().await.unwrap();
    assert_eq!(initial_conditions.revision, 0);
    assert!(initial_conditions.blocked_segment_ids.is_empty());
    let plan = service.propose_route_plan(request()).await.unwrap();
    assert_eq!(plan.plan.as_ref().unwrap().legs[0].segment_id, "approach");
    let original = service
        .approve_route_plan(&plan.id, &plan.digest, actor())
        .await
        .unwrap();
    assert!(
        service
            .propose_route_replan(&original.id, &original.digest, actor())
            .await
            .is_err()
    );
    let inspection = service.next_command(&a).await.unwrap().unwrap();
    service
        .report_result(
            &inspection.envelope.mission_id,
            result(
                &inspection,
                CommandResultStatus::Succeeded,
                &clock,
                Some(image(&clock)),
            ),
        )
        .await
        .unwrap();
    let source_observation = service
        .observations(100, None)
        .await
        .unwrap()
        .pop()
        .unwrap();
    let approach = service.next_command(&a).await.unwrap().unwrap();
    assert_eq!(segment(&approach), "approach");
    let evidence = body_report(&approach, &clock);
    // A colocated body still cannot report evidence against someone else's command.
    pose(&service, b.as_str(), 0.0, 0.0, Some(0.0)).await;
    assert!(
        service
            .report_body_route_condition(&b, evidence.clone())
            .await
            .is_err()
    );
    pose(&service, b.as_str(), 1.0, 0.0, Some(0.0)).await;
    let mut wrong = evidence.clone();
    wrong.map_digest = "ef".repeat(32);
    assert!(
        service
            .report_body_route_condition(&a, wrong)
            .await
            .is_err()
    );
    let mut wrong = evidence.clone();
    wrong.observed_at = clock.now() - chrono::Duration::seconds(6);
    assert!(
        service
            .report_body_route_condition(&a, wrong)
            .await
            .is_err()
    );
    let mut wrong = evidence.clone();
    wrong.evidence.as_mut().unwrap().blocked_samples = 2;
    assert!(
        service
            .report_body_route_condition(&a, wrong)
            .await
            .is_err()
    );
    let mut wrong = evidence.clone();
    wrong.segment_id = "stairs".into();
    assert!(
        service
            .report_body_route_condition(&a, wrong)
            .await
            .is_err()
    );
    assert_eq!(service.route_conditions().await.unwrap().revision, 0);
    assert!(
        service
            .report_route_condition(evidence.clone(), actor())
            .await
            .is_err()
    );
    let mut body_clear = evidence.clone();
    body_clear.status = lattice_application::RouteConditionStatus::Clear;
    assert!(
        service
            .report_body_route_condition(&a, body_clear)
            .await
            .is_err()
    );
    let observation = service
        .report_body_route_condition(&a, evidence.clone())
        .await
        .unwrap();
    assert_eq!(observation.revision, 1);
    assert_eq!(observation.body_id.as_ref(), Some(&a));
    let duplicate = service
        .report_body_route_condition(&a, evidence.clone())
        .await
        .unwrap();
    assert_eq!(duplicate.id, observation.id);
    assert_eq!(
        service.route_conditions().await.unwrap().conditions.len(),
        1
    );
    let mut conflicting = evidence.clone();
    conflicting.reason = "Changed evidence cannot reuse the same event identity.".into();
    assert!(
        service
            .report_body_route_condition(&a, conflicting)
            .await
            .is_err()
    );
    assert!(
        service
            .report_body_route_condition(&b, evidence.clone())
            .await
            .is_err()
    );
    let conditions = service.route_conditions().await.unwrap();
    assert_eq!(conditions.map_digest, map_digest);
    assert_eq!(conditions.blocked_segment_ids, vec!["approach"]);
    let held = round(&service, &original.id).await;
    assert_eq!(held.status, "recovery_required");
    assert_eq!(held.current_step, 1);
    assert_eq!(held.steps, original.steps);
    assert_eq!(
        service.observation(&source_observation.id).await.unwrap(),
        source_observation
    );
    let fence = tx.body_fence(&a).await.unwrap().unwrap();
    assert_eq!(
        fence,
        approach.envelope.expires_at + chrono::Duration::seconds(2)
    );
    assert!(service.next_command(&a).await.is_err());
    assert!(service.next_command(&b).await.unwrap().is_none());
    assert_eq!(
        service
            .report_result(
                &approach.envelope.mission_id,
                result(&approach, CommandResultStatus::Succeeded, &clock, None)
            )
            .await
            .unwrap()
            .status,
        MissionStatus::RecoveryRequired
    );
    assert!(
        service
            .propose_recovery(&approach.envelope.mission_id)
            .await
            .is_err()
    );
    assert!(
        service
            .propose_route_replan(&held.id, "tampered", actor())
            .await
            .is_err()
    );
    let frozen = service
        .propose_route_replan(&held.id, &held.digest, actor())
        .await
        .unwrap();
    assert_eq!(frozen.status, "pending");
    assert_eq!(frozen.completed_steps.len(), 1);
    assert_eq!(frozen.remaining_steps.len(), 4);
    assert_eq!(frozen.retained_mission_ids, held.mission_ids);
    assert_eq!(
        frozen.retained_observation_ids,
        vec![source_observation.id.clone()]
    );
    assert_eq!(frozen.conditions_revision, 1);
    assert_eq!(frozen.not_before_at, fence);
    assert_eq!(frozen.plan.as_ref().unwrap().map_digest, map_digest);
    assert_eq!(
        frozen
            .plan
            .as_ref()
            .unwrap()
            .legs
            .iter()
            .map(|leg| leg.segment_id.as_str())
            .collect::<Vec<_>>(),
        vec!["detour_start", "detour_finish", "stairs"]
    );
    assert!(
        service
            .approve_route_replan(&frozen.id, &frozen.digest, actor())
            .await
            .is_err()
    );
    assert_eq!(
        round(&service, &held.id).await.mission_ids,
        held.mission_ids
    );
    assert_eq!(service.route_conditions().await.unwrap().revision, 1);
    assert!(service.next_command(&b).await.unwrap().is_none());

    // Elapsed time does not clear an obstruction; the old review cannot silently
    // become valid again after additional observations change the revision.
    clock.0.store(fence.timestamp() + 1, Ordering::SeqCst);
    assert!(
        service
            .approve_route_replan(&frozen.id, &frozen.digest, actor())
            .await
            .is_err()
    );
    assert_eq!(
        service
            .route_conditions()
            .await
            .unwrap()
            .blocked_segment_ids,
        vec!["approach"]
    );
    pose(&service, a.as_str(), 0.0, 0.0, None).await;
    pose(&service, b.as_str(), 1.0, 0.0, Some(0.0)).await;
    service
        .report_route_condition(
            manual_report(
                "manual-detour-block",
                "detour_finish",
                "blocked",
                &clock,
                None,
            ),
            actor(),
        )
        .await
        .unwrap();
    let no_route = service
        .propose_route_replan(&held.id, &held.digest, actor())
        .await
        .unwrap();
    assert_eq!(no_route.status, "blocked");
    assert!(no_route.failure.is_some());
    assert!(
        service
            .approve_route_replan(&no_route.id, &no_route.digest, actor())
            .await
            .is_err()
    );
    assert!(
        service
            .report_route_condition(
                manual_report("stale-clear", "detour_finish", "clear", &clock, Some(1)),
                actor()
            )
            .await
            .is_err()
    );
    assert_eq!(service.route_conditions().await.unwrap().revision, 2);
    service
        .report_route_condition(
            manual_report(
                "manual-detour-clear",
                "detour_finish",
                "clear",
                &clock,
                Some(2),
            ),
            actor(),
        )
        .await
        .unwrap();
    assert!(
        service
            .approve_route_replan(&frozen.id, &frozen.digest, actor())
            .await
            .is_err()
    );
    let review = service
        .propose_route_replan(&held.id, &held.digest, actor())
        .await
        .unwrap();
    assert_eq!(review.status, "pending");
    assert_eq!(review.conditions_revision, 3);
    assert!(
        service
            .approve_route_replan(&review.id, "tampered", actor())
            .await
            .is_err()
    );
    pose(&service, a.as_str(), 0.6, 0.0, None).await;
    assert!(
        service
            .approve_route_replan(&review.id, &review.digest, actor())
            .await
            .is_err()
    );
    let unknown_anchor = service
        .propose_route_replan(&held.id, &held.digest, actor())
        .await
        .unwrap();
    assert_eq!(unknown_anchor.status, "blocked");
    assert!(unknown_anchor.source_place_id.is_none());
    pose(&service, a.as_str(), 0.0, 0.0, None).await;
    pose(&service, b.as_str(), 1.0, 0.0, Some(0.6)).await;
    assert!(
        service
            .approve_route_replan(&review.id, &review.digest, actor())
            .await
            .is_err()
    );
    pose(&service, b.as_str(), 1.0, 0.0, Some(0.0)).await;
    register(
        &service,
        a.as_str(),
        BodyKind::Rover,
        vec![Capability::Inspect],
    )
    .await;
    pose(&service, a.as_str(), 0.0, 0.0, None).await;
    assert!(
        service
            .approve_route_replan(&review.id, &review.digest, actor())
            .await
            .is_err()
    );
    register(
        &service,
        a.as_str(),
        BodyKind::Rover,
        vec![Capability::Navigate, Capability::Inspect],
    )
    .await;
    pose(&service, a.as_str(), 0.0, 0.0, None).await;
    let resumed = service
        .approve_route_replan(&review.id, &review.digest, actor())
        .await
        .unwrap();
    assert_eq!(resumed.id, original.id);
    assert_ne!(resumed.digest, original.digest);
    assert_eq!(resumed.current_step, 1);
    assert_eq!(resumed.steps.len(), 5);
    assert_eq!(resumed.steps[0], original.steps[0]);
    assert_eq!(
        service
            .approve_route_replan(&review.id, &review.digest, actor())
            .await
            .unwrap()
            .id,
        resumed.id
    );
    assert_eq!(
        service.observation(&source_observation.id).await.unwrap(),
        source_observation
    );
    let unchanged = service
        .list_route_plans()
        .await
        .unwrap()
        .into_iter()
        .find(|p| p.id == plan.id)
        .unwrap();
    assert_eq!(unchanged.digest, plan.digest);
    assert_eq!(unchanged.steps, plan.steps);
    assert!(
        held.mission_ids
            .iter()
            .all(|id| resumed.mission_ids.contains(id))
    );
    assert_eq!(
        service
            .report_result(
                &approach.envelope.mission_id,
                result(&approach, CommandResultStatus::Succeeded, &clock, None)
            )
            .await
            .unwrap()
            .status,
        MissionStatus::Cancelled
    );
    for (expected_segment, x, y) in [("detour_start", 0.0, 1.0), ("detour_finish", 1.0, 0.0)] {
        let command = service.next_command(&a).await.unwrap().unwrap();
        assert_eq!(segment(&command), expected_segment);
        pose(&service, a.as_str(), x, y, None).await;
        service
            .report_result(
                &command.envelope.mission_id,
                result(&command, CommandResultStatus::Succeeded, &clock, None),
            )
            .await
            .unwrap();
    }
    let at_transfer = round(&service, &original.id).await;
    assert_eq!(at_transfer.status, "recovery_required");
    assert_eq!(at_transfer.current_step, 3);
    assert!(service.next_command(&b).await.unwrap().is_none());
    let options = service
        .route_transfer_options(&at_transfer.id)
        .await
        .unwrap();
    assert!(options.required && options.ready);
    assert_eq!(options.recommended_target_body_id, Some(b.clone()));
    let handoff = service
        .propose_handoff(&at_transfer.id, b.clone(), actor())
        .await
        .unwrap();
    assert_eq!(
        handoff.retained_observation_ids,
        vec![source_observation.id.clone()]
    );
    assert_eq!(handoff.completed_steps.len(), 3);
    assert_eq!(handoff.remaining_steps.len(), 2);
    assert!(
        service
            .approve_handoff(&handoff.id, &handoff.digest, actor())
            .await
            .is_err()
    );
    clock.0.fetch_add(3, Ordering::SeqCst);
    pose(&service, a.as_str(), 1.0, 0.0, None).await;
    pose(&service, b.as_str(), 1.0, 0.0, Some(0.0)).await;
    service
        .approve_handoff(&handoff.id, &handoff.digest, actor())
        .await
        .unwrap();
    let stairs = service.next_command(&b).await.unwrap().unwrap();
    assert_eq!(segment(&stairs), "stairs");
    assert_eq!(
        stairs.envelope.continuation.as_ref().unwrap().observations[0].observation_id,
        source_observation.id
    );
    let mut unacknowledged = result(&stairs, CommandResultStatus::Running, &clock, None);
    unacknowledged.context_digest = None;
    assert!(
        service
            .report_result(&stairs.envelope.mission_id, unacknowledged)
            .await
            .is_err()
    );
    service
        .report_result(
            &stairs.envelope.mission_id,
            result(&stairs, CommandResultStatus::Running, &clock, None),
        )
        .await
        .unwrap();
    pose(&service, b.as_str(), 2.0, 0.0, Some(0.6)).await;
    service
        .report_result(
            &stairs.envelope.mission_id,
            result(&stairs, CommandResultStatus::Succeeded, &clock, None),
        )
        .await
        .unwrap();
    // The periodic coordinator holds an unavailable body even without a sensor
    // report. Repeating the tick must not extend the original stop deadline.
    let awaiting_upper = round(&service, &original.id).await;
    clock.0.fetch_add(11, Ordering::SeqCst);
    assert_eq!(service.hold_unavailable_route_work().await.unwrap(), 1);
    let upper_fence = tx.body_fence(&b).await.unwrap().unwrap();
    assert_eq!(service.hold_unavailable_route_work().await.unwrap(), 0);
    assert_eq!(tx.body_fence(&b).await.unwrap().unwrap(), upper_fence);
    assert!(service.next_command(&b).await.is_err());
    clock.0.store(upper_fence.timestamp() + 1, Ordering::SeqCst);
    pose(&service, b.as_str(), 2.0, 0.0, Some(0.6)).await;
    let final_task = service
        .propose_route_replan(&awaiting_upper.id, &awaiting_upper.digest, actor())
        .await
        .unwrap();
    assert_eq!(final_task.status, "pending");
    assert_eq!(final_task.completed_steps.len(), 4);
    assert!(final_task.plan.as_ref().unwrap().legs.is_empty());
    assert_eq!(final_task.remaining_steps.len(), 1);
    assert_eq!(
        final_task.remaining_steps[0].command,
        SkillCommand::Inspect {
            location: "upper_inspection".into()
        }
    );
    service
        .approve_route_replan(&final_task.id, &final_task.digest, actor())
        .await
        .unwrap();
    let upper = service.next_command(&b).await.unwrap().unwrap();
    assert_eq!(
        upper.envelope.command,
        SkillCommand::Inspect {
            location: "upper_inspection".into()
        }
    );
    service
        .report_result(
            &upper.envelope.mission_id,
            result(
                &upper,
                CommandResultStatus::Succeeded,
                &clock,
                Some(image(&clock)),
            ),
        )
        .await
        .unwrap();
    let complete = round(&service, &original.id).await;
    assert_eq!(complete.status, "completed");
    assert_eq!(complete.current_step, 4);
    assert_eq!(service.observations(100, None).await.unwrap().len(), 2);
    assert_eq!(
        service
            .list_missions()
            .await
            .unwrap()
            .iter()
            .filter(|mission| mission.status == MissionStatus::Succeeded
                && mission.command == inspection.envelope.command)
            .count(),
        1
    );
    assert_eq!(
        service.observation(&source_observation.id).await.unwrap(),
        source_observation
    );
    assert_eq!(service.route_conditions().await.unwrap().revision, 3);

    // A pending review is invalidated on restart; observations and exclusions survive.
    service
        .report_route_condition(
            manual_report(
                "manual-approach-clear",
                "approach",
                "clear",
                &clock,
                Some(3),
            ),
            actor(),
        )
        .await
        .unwrap();
    pose(&service, a.as_str(), 0.0, 0.0, None).await;
    pose(&service, b.as_str(), 1.0, 0.0, Some(0.0)).await;
    let next_plan = service.propose_route_plan(request()).await.unwrap();
    let second_round = service
        .approve_route_plan(&next_plan.id, &next_plan.digest, actor())
        .await
        .unwrap();
    let first = service.next_command(&a).await.unwrap().unwrap();
    service
        .report_result(
            &first.envelope.mission_id,
            result(
                &first,
                CommandResultStatus::Succeeded,
                &clock,
                Some(image(&clock)),
            ),
        )
        .await
        .unwrap();
    let blocked_command = service.next_command(&a).await.unwrap().unwrap();
    let mut second_report = body_report(&blocked_command, &clock);
    second_report.event_id = "body-obstacle-2".into();
    service
        .report_body_route_condition(&a, second_report)
        .await
        .unwrap();
    let pending = service
        .propose_route_replan(&second_round.id, &second_round.digest, actor())
        .await
        .unwrap();
    assert_eq!(pending.status, "pending");
    assert_eq!(service.route_conditions().await.unwrap().revision, 5);
    tx.finish(true).await.unwrap();
    drop(service);
    drop(tx);
    db.recover(&key.public_key_base64, "adaptive-epoch-2")
        .await
        .unwrap();
    let tx = db.begin().await.unwrap();
    let restarted = app(tx.clone(), signer.clone(), clock.clone(), map());
    let saved = restarted
        .list_route_replans()
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.id == pending.id)
        .unwrap();
    assert_eq!(saved.status, "invalidated");
    assert!(
        restarted
            .approve_route_replan(&saved.id, &saved.digest, actor())
            .await
            .is_err()
    );
    let retained = restarted.route_conditions().await.unwrap();
    assert_eq!(retained.revision, 5);
    assert_eq!(retained.conditions.len(), 5);
    assert_eq!(retained.blocked_segment_ids, vec!["approach"]);
    assert_eq!(
        restarted.observation(&source_observation.id).await.unwrap(),
        source_observation
    );
    assert_eq!(round(&restarted, &complete.id).await.status, "completed");
    assert_eq!(
        round(&restarted, &second_round.id).await.status,
        "recovery_required"
    );
    // An unfinished source inspection cannot move to a different named station
    // merely because that station is a valid route anchor.
    let restart_held = round(&restarted, &second_round.id).await;
    clock.0.store(
        tx.body_fence(&a).await.unwrap().unwrap().timestamp() + 1,
        Ordering::SeqCst,
    );
    restarted
        .abandon_round(&restart_held.id, &restart_held.digest, actor())
        .await
        .unwrap();
    clock.0.fetch_add(3, Ordering::SeqCst);
    pose(&restarted, a.as_str(), 0.0, 0.0, None).await;
    pose(&restarted, b.as_str(), 1.0, 0.0, Some(0.0)).await;
    let source_plan = restarted.propose_route_plan(request()).await.unwrap();
    let source_round = restarted
        .approve_route_plan(&source_plan.id, &source_plan.digest, actor())
        .await
        .unwrap();
    clock.0.fetch_add(11, Ordering::SeqCst);
    assert_eq!(restarted.hold_unavailable_route_work().await.unwrap(), 1);
    let source_fence = tx.body_fence(&a).await.unwrap().unwrap();
    assert_eq!(restarted.hold_unavailable_route_work().await.unwrap(), 0);
    assert_eq!(tx.body_fence(&a).await.unwrap().unwrap(), source_fence);
    clock
        .0
        .store(source_fence.timestamp() + 1, Ordering::SeqCst);
    pose(&restarted, a.as_str(), 1.0, 0.0, None).await;
    pose(&restarted, b.as_str(), 1.0, 0.0, Some(0.0)).await;
    let wrong_station = restarted
        .propose_route_replan(&source_round.id, &source_round.digest, actor())
        .await
        .unwrap();
    assert_eq!(wrong_station.source_place_id.as_deref(), Some("transfer"));
    assert_eq!(wrong_station.status, "blocked");
    assert!(wrong_station.remaining_steps.is_empty());
    assert!(
        restarted
            .approve_route_replan(&wrong_station.id, &wrong_station.digest, actor())
            .await
            .is_err()
    );
    pose(&restarted, a.as_str(), 0.0, 0.0, None).await;
    let correct_station = restarted
        .propose_route_replan(&source_round.id, &source_round.digest, actor())
        .await
        .unwrap();
    assert_eq!(correct_station.status, "pending");
    assert_eq!(
        correct_station.remaining_steps[0].command,
        SkillCommand::Inspect {
            location: "inspection_bay".into()
        }
    );
    assert!(restarted.next_command(&a).await.unwrap().is_none());
    // A local navigation failure keeps its original failed result while a new
    // held attempt carries the remaining objective; it does not erase failure
    // evidence or silently replay the completed source inspection.
    restarted
        .approve_route_replan(&correct_station.id, &correct_station.digest, actor())
        .await
        .unwrap();
    let inspect_again = restarted.next_command(&a).await.unwrap().unwrap();
    restarted
        .report_result(
            &inspect_again.envelope.mission_id,
            result(
                &inspect_again,
                CommandResultStatus::Succeeded,
                &clock,
                Some(image(&clock)),
            ),
        )
        .await
        .unwrap();
    let failed_leg = restarted.next_command(&a).await.unwrap().unwrap();
    assert_eq!(segment(&failed_leg), "detour_start");
    let failure = restarted
        .report_result(
            &failed_leg.envelope.mission_id,
            result(&failed_leg, CommandResultStatus::Failed, &clock, None),
        )
        .await
        .unwrap();
    assert_eq!(failure.status, MissionStatus::Failed);
    let failed_round = round(&restarted, &source_round.id).await;
    assert_eq!(failed_round.status, "recovery_required");
    assert_eq!(failed_round.current_step, 1);
    assert_ne!(
        failed_round.current_mission_id.as_ref(),
        Some(&failed_leg.envelope.mission_id)
    );
    assert_eq!(
        restarted
            .list_missions()
            .await
            .unwrap()
            .into_iter()
            .find(|mission| mission.id == failed_leg.envelope.mission_id)
            .unwrap()
            .status,
        MissionStatus::Failed
    );
    let failed_fence = tx.body_fence(&a).await.unwrap().unwrap();
    assert_eq!(
        failed_fence,
        failed_leg.envelope.expires_at + chrono::Duration::seconds(2)
    );
    assert!(restarted.next_command(&a).await.is_err());
    clock
        .0
        .store(failed_fence.timestamp() + 1, Ordering::SeqCst);
    pose(&restarted, a.as_str(), 0.0, 0.0, None).await;
    pose(&restarted, b.as_str(), 1.0, 0.0, Some(0.0)).await;
    let local_failure_review = restarted
        .propose_route_replan(&failed_round.id, &failed_round.digest, actor())
        .await
        .unwrap();
    assert_eq!(local_failure_review.status, "pending");
    assert_eq!(local_failure_review.completed_steps.len(), 1);
    assert!(
        local_failure_review
            .retained_mission_ids
            .contains(&failed_leg.envelope.mission_id)
    );
    assert!(
        local_failure_review
            .remaining_steps
            .iter()
            .all(|step| step.command != inspect_again.envelope.command)
    );
    tx.finish(true).await.unwrap();
}
