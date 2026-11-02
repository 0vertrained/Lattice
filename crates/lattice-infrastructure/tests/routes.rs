//! Stateful route planning and transfer acceptance using explicit transport fixtures.
#![allow(clippy::unwrap_used)]
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use lattice_application::{
    Clock, CommandSigner, HandoffRepository, HeartbeatRequest, LatticeService, RegisterBodyRequest,
    RouteObjectiveRequest, ServiceConfig,
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
    AuditActor::Operator("route-test".into())
}
fn map() -> SemanticMap {
    SemanticMap {
        id: "stairs-test".into(),
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
    }
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
    .with_route_plans(tx)
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
            adapter_version: "route-fixture".into(),
        },
        actor(),
    )
    .await
    .unwrap();
}
async fn pose(app: &LatticeService, id: &str, x: f64, z: Option<f64>) {
    app.heartbeat(
        &BodyId::new(id).unwrap(),
        HeartbeatRequest {
            status: BodyStatus::Online,
            battery: BatteryPercent::new(95).unwrap(),
            location: "transport-fixture".into(),
            pose: Some(BodyPose {
                x,
                y: 0.0,
                yaw: 0.0,
                z,
            }),
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

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn capability_routes_bind_map_bodies_transfer_and_retained_evidence() {
    let db = PostgresPlatform::connect(&std::env::var("LATTICE_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let signer = Arc::new(Ed25519CommandSigner::generate_ephemeral("route-key"));
    let clock = Arc::new(TestClock(AtomicI64::new(1_800_000_000)));
    let key = signer.verification_key().await.unwrap();
    db.recover(&key.public_key_base64, "route-epoch-1")
        .await
        .unwrap();
    let tx = db.begin().await.unwrap();
    let service = app(tx.clone(), signer.clone(), clock.clone(), map());
    let a = BodyId::new("rover-a").unwrap();
    let b = BodyId::new("quad-b").unwrap();
    let mut inconsistent = request();
    inconsistent.inspect_destination = false;
    inconsistent.route.destination_capability = Some(Capability::Inspect);
    assert!(service.propose_route_plan(inconsistent).await.is_err());
    register(
        &service,
        a.as_str(),
        BodyKind::Rover,
        vec![Capability::Navigate, Capability::Inspect],
    )
    .await;
    pose(&service, a.as_str(), 0.0, None).await;
    let blocked = service.propose_route_plan(request()).await.unwrap();
    assert_eq!(blocked.status, "blocked");
    assert!(blocked.failure.is_some());
    assert!(
        service
            .approve_route_plan(&blocked.id, &blocked.digest, actor())
            .await
            .is_err()
    );
    assert!(service.next_command(&a).await.unwrap().is_none());
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
    // A planar-only quadruped pose cannot establish its floor or transfer location.
    pose(&service, b.as_str(), 1.0, None).await;
    assert_eq!(
        service.propose_route_plan(request()).await.unwrap().status,
        "blocked"
    );
    pose(&service, b.as_str(), 1.0, Some(0.0)).await;
    // An immediate transfer leaves the source out of step_body_ids. Its readiness
    // and availability must still be rechecked before creating any held round.
    pose(&service, a.as_str(), 1.0, None).await;
    let mut immediate = request();
    immediate.route.source_place_id = "transfer".into();
    immediate.inspect_source = false;
    let immediate = service.propose_route_plan(immediate).await.unwrap();
    assert_eq!(immediate.step_body_ids, vec![b.clone(), b.clone()]);
    assert_eq!(
        immediate.plan.as_ref().unwrap().transfers[0].before_leg_index,
        0
    );
    service
        .heartbeat(
            &a,
            HeartbeatRequest {
                status: BodyStatus::Faulted,
                battery: BatteryPercent::new(95).unwrap(),
                location: "transfer".into(),
                pose: Some(BodyPose {
                    x: 1.0,
                    y: 0.0,
                    z: None,
                    yaw: 0.0,
                }),
            },
        )
        .await
        .unwrap();
    assert!(
        service
            .approve_route_plan(&immediate.id, &immediate.digest, actor())
            .await
            .is_err()
    );
    assert!(service.list_rounds().await.unwrap().is_empty());
    assert!(service.next_command(&b).await.unwrap().is_none());
    pose(&service, a.as_str(), 1.0, None).await;
    tx.fence_body(&a, clock.now() + chrono::Duration::seconds(2))
        .await
        .unwrap();
    assert!(
        service
            .approve_route_plan(&immediate.id, &immediate.digest, actor())
            .await
            .is_err()
    );
    assert!(service.list_rounds().await.unwrap().is_empty());
    assert!(service.next_command(&b).await.unwrap().is_none());
    clock.0.fetch_add(3, Ordering::SeqCst);
    pose(&service, a.as_str(), 0.0, None).await;
    pose(&service, b.as_str(), 1.0, Some(0.0)).await;
    let proposal = service.propose_route_plan(request()).await.unwrap();
    assert_eq!(proposal.status, "pending");
    assert_eq!(proposal.steps.len(), 4);
    assert_eq!(
        proposal.step_body_ids,
        vec![a.clone(), a.clone(), b.clone(), b.clone()]
    );
    assert_eq!(proposal.plan.as_ref().unwrap().transfers.len(), 1);
    assert!(
        service
            .approve_route_plan(&proposal.id, "changed", actor())
            .await
            .is_err()
    );
    let mut changed = map();
    changed.revision = 2;
    assert!(
        app(tx.clone(), signer.clone(), clock.clone(), changed)
            .approve_route_plan(&proposal.id, &proposal.digest, actor())
            .await
            .is_err()
    );
    pose(&service, b.as_str(), 1.8, Some(0.0)).await;
    assert!(
        service
            .approve_route_plan(&proposal.id, &proposal.digest, actor())
            .await
            .is_err()
    );
    pose(&service, b.as_str(), 1.0, Some(0.0)).await;
    clock.0.fetch_add(11, Ordering::SeqCst);
    pose(&service, a.as_str(), 0.0, None).await;
    assert!(
        service
            .approve_route_plan(&proposal.id, &proposal.digest, actor())
            .await
            .is_err()
    );
    pose(&service, b.as_str(), 1.0, Some(0.0)).await;
    let round = service
        .approve_route_plan(&proposal.id, &proposal.digest, actor())
        .await
        .unwrap();
    assert_eq!(round.route_plan_id.as_deref(), Some(proposal.id.as_str()));
    assert_eq!(
        service
            .approve_route_plan(&proposal.id, &proposal.digest, actor())
            .await
            .unwrap()
            .id,
        round.id
    );
    let inspection = service.next_command(&a).await.unwrap().unwrap();
    assert!(service.next_command(&a).await.unwrap().is_none());
    assert!(service.next_command(&b).await.unwrap().is_none());
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
    let observation = service
        .observations(100, None)
        .await
        .unwrap()
        .pop()
        .unwrap();
    let approach = service.next_command(&a).await.unwrap().unwrap();
    assert!(matches!(
        approach.envelope.command,
        SkillCommand::TraverseRoute { .. }
    ));
    pose(&service, a.as_str(), 1.0, None).await;
    // A configuration change between result and continuation must hold the next
    // step without rolling back the completed command or retained observation.
    let mut changed = map();
    changed.revision = 2;
    app(tx.clone(), signer.clone(), clock.clone(), changed)
        .report_result(
            &approach.envelope.mission_id,
            result(&approach, CommandResultStatus::Succeeded, &clock, None),
        )
        .await
        .unwrap();
    let held = service
        .list_rounds()
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.id == round.id)
        .unwrap();
    assert_eq!(held.current_step, 2);
    assert_eq!(held.status, "recovery_required");
    assert_eq!(
        service
            .list_missions()
            .await
            .unwrap()
            .into_iter()
            .find(|mission| mission.id == approach.envelope.mission_id)
            .unwrap()
            .status,
        MissionStatus::Succeeded
    );
    assert_eq!(
        service.observation(&observation.id).await.unwrap(),
        observation
    );
    assert!(service.next_command(&b).await.unwrap().is_none());
    assert!(
        service
            .propose_recovery(held.current_mission_id.as_ref().unwrap())
            .await
            .is_err()
    );
    let options = service.route_transfer_options(&round.id).await.unwrap();
    assert!(options.required && options.ready);
    assert_eq!(options.recommended_target_body_id, Some(b.clone()));
    assert_eq!(options.transfer_place_id.as_deref(), Some("transfer"));
    register(
        &service,
        "quad-c",
        BodyKind::Quadruped,
        vec![
            Capability::Navigate,
            Capability::Inspect,
            Capability::Stairs,
        ],
    )
    .await;
    pose(&service, "quad-c", 1.0, Some(0.0)).await;
    assert!(
        service
            .propose_handoff(&round.id, BodyId::new("quad-c").unwrap(), actor())
            .await
            .is_err()
    );
    pose(&service, b.as_str(), 1.0, Some(0.6)).await;
    assert!(
        service
            .propose_handoff(&round.id, b.clone(), actor())
            .await
            .is_err()
    );
    pose(&service, b.as_str(), 1.0, Some(0.0)).await;
    let handoff = service
        .propose_handoff(&round.id, b.clone(), actor())
        .await
        .unwrap();
    assert_eq!(
        handoff.retained_observation_ids,
        vec![observation.id.clone()]
    );
    assert!(
        service
            .approve_handoff(&handoff.id, &handoff.digest, actor())
            .await
            .is_err()
    );
    clock.0.fetch_add(3, Ordering::SeqCst);
    pose(&service, a.as_str(), 1.0, None).await;
    pose(&service, b.as_str(), 1.0, Some(0.0)).await;
    let mut changed = map();
    changed.segments[1].enabled = false;
    assert!(
        app(tx.clone(), signer.clone(), clock.clone(), changed)
            .approve_handoff(&handoff.id, &handoff.digest, actor())
            .await
            .is_err()
    );
    pose(&service, b.as_str(), 1.8, Some(0.0)).await;
    assert!(
        service
            .approve_handoff(&handoff.id, &handoff.digest, actor())
            .await
            .is_err()
    );
    pose(&service, b.as_str(), 1.0, Some(0.0)).await;
    let handoff = service
        .approve_handoff(&handoff.id, &handoff.digest, actor())
        .await
        .unwrap();
    let stairs = service.next_command(&b).await.unwrap().unwrap();
    assert!(service.next_command(&a).await.unwrap().is_none());
    assert_eq!(
        stairs.envelope.continuation.as_ref().unwrap().observations[0].observation_id,
        observation.id
    );
    assert!(
        service
            .handoff_evidence(&a, &stairs.envelope.mission_id, &observation.id)
            .await
            .is_err()
    );
    assert_eq!(
        service
            .handoff_evidence(&b, &stairs.envelope.mission_id, &observation.id)
            .await
            .unwrap()
            .1
            .image_sha256,
        observation.image_sha256
    );
    let mut missing = result(&stairs, CommandResultStatus::Running, &clock, None);
    missing.context_digest = None;
    assert!(
        service
            .report_result(&stairs.envelope.mission_id, missing)
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
    pose(&service, b.as_str(), 2.0, Some(0.6)).await;
    service
        .report_result(
            &stairs.envelope.mission_id,
            result(&stairs, CommandResultStatus::Succeeded, &clock, None),
        )
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
    let completed = service
        .list_rounds()
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.id == round.id)
        .unwrap();
    assert_eq!(completed.status, "completed");
    assert_eq!(completed.current_step, 3);
    assert_eq!(completed.mission_ids.len(), 5); // Four steps plus one held transfer placeholder.
    assert_eq!(service.observations(100, None).await.unwrap().len(), 2);
    assert_eq!(
        service.observation(&observation.id).await.unwrap(),
        observation
    );
    let handoff = service
        .list_handoffs()
        .await
        .unwrap()
        .into_iter()
        .find(|h| h.id == handoff.id)
        .unwrap();
    assert!(handoff.context_acknowledged_at.is_some());
    // The legacy manual proposal API does not accept raw route commands.
    let raw = match approach.envelope.command {
        SkillCommand::TraverseRoute { traversal } => SkillCommand::TraverseRoute { traversal },
        _ => unreachable!(),
    };
    assert!(lattice_application::validate_warehouse_command(&raw).is_err());
    // A final-place transfer must hold before the destination inspection too:
    // the body that traversed the last leg may not be the final task's owner.
    let mut terminal_map = map();
    terminal_map.revision = 2;
    terminal_map.segments[1].required_capabilities = [Capability::Navigate].into_iter().collect();
    terminal_map.places[2].transfer_allowed = true;
    let terminal = app(tx.clone(), signer.clone(), clock.clone(), terminal_map);
    register(
        &terminal,
        a.as_str(),
        BodyKind::Rover,
        vec![Capability::Navigate],
    )
    .await;
    register(
        &terminal,
        "quad-c",
        BodyKind::Quadruped,
        vec![Capability::Navigate],
    )
    .await;
    pose(&terminal, a.as_str(), 0.0, None).await;
    pose(&terminal, b.as_str(), 2.0, Some(0.6)).await;
    let mut objective = request();
    objective.inspect_source = false;
    let review = terminal.propose_route_plan(objective).await.unwrap();
    assert_eq!(review.step_body_ids, vec![a.clone(), a.clone(), b.clone()]);
    assert_eq!(
        review.plan.as_ref().unwrap().transfers[0].before_leg_index,
        2
    );
    assert_eq!(review.plan.as_ref().unwrap().destination_body_id, b);
    let terminal_round = terminal
        .approve_route_plan(&review.id, &review.digest, actor())
        .await
        .unwrap();
    for (x, z) in [(1.0, 0.0), (2.0, 0.6)] {
        let command = terminal.next_command(&a).await.unwrap().unwrap();
        assert!(matches!(
            command.envelope.command,
            SkillCommand::TraverseRoute { .. }
        ));
        pose(&terminal, a.as_str(), x, Some(z)).await;
        terminal
            .report_result(
                &command.envelope.mission_id,
                result(&command, CommandResultStatus::Succeeded, &clock, None),
            )
            .await
            .unwrap();
    }
    assert!(terminal.next_command(&b).await.unwrap().is_none());
    let terminal_options = terminal
        .route_transfer_options(&terminal_round.id)
        .await
        .unwrap();
    assert!(terminal_options.required && terminal_options.ready);
    assert_eq!(
        terminal_options.transfer_place_id.as_deref(),
        Some("upper_inspection")
    );
    let terminal_handoff = terminal
        .propose_handoff(&terminal_round.id, b.clone(), actor())
        .await
        .unwrap();
    clock.0.fetch_add(3, Ordering::SeqCst);
    pose(&terminal, a.as_str(), 2.0, Some(0.6)).await;
    pose(&terminal, b.as_str(), 2.0, Some(0.6)).await;
    terminal
        .approve_handoff(&terminal_handoff.id, &terminal_handoff.digest, actor())
        .await
        .unwrap();
    let destination = terminal.next_command(&b).await.unwrap().unwrap();
    assert_eq!(
        destination.envelope.command,
        SkillCommand::Inspect {
            location: "upper_inspection".into()
        }
    );
    terminal
        .report_result(
            &destination.envelope.mission_id,
            result(
                &destination,
                CommandResultStatus::Succeeded,
                &clock,
                Some(image(&clock)),
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        terminal
            .list_rounds()
            .await
            .unwrap()
            .into_iter()
            .find(|round| round.id == terminal_round.id)
            .unwrap()
            .status,
        "completed"
    );
    register(
        &service,
        a.as_str(),
        BodyKind::Rover,
        vec![Capability::Navigate, Capability::Inspect],
    )
    .await;
    pose(&service, a.as_str(), 0.0, None).await;
    pose(&service, b.as_str(), 1.0, Some(0.0)).await;
    // A changed map can be recovered by explicit abandonment and a fresh review,
    // with both the completed observation and source stopping fence preserved.
    let old_map_review = service.propose_route_plan(request()).await.unwrap();
    let old_map_round = service
        .approve_route_plan(&old_map_review.id, &old_map_review.digest, actor())
        .await
        .unwrap();
    assert!(
        service
            .abandon_round(&old_map_round.id, &old_map_round.digest, actor())
            .await
            .is_err()
    );
    let before_change = service.next_command(&a).await.unwrap().unwrap();
    let mut new_map = map();
    new_map.revision = 3;
    let changed_service = app(tx.clone(), signer.clone(), clock.clone(), new_map);
    changed_service
        .report_result(
            &before_change.envelope.mission_id,
            result(
                &before_change,
                CommandResultStatus::Succeeded,
                &clock,
                Some(image(&clock)),
            ),
        )
        .await
        .unwrap();
    let kept_id = format!("observation-{}", before_change.envelope.command_id);
    let kept = service.observation(&kept_id).await.unwrap();
    let replacement = changed_service.propose_route_plan(request()).await.unwrap();
    assert!(
        changed_service
            .approve_route_plan(&replacement.id, &replacement.digest, actor())
            .await
            .is_err()
    );
    assert!(
        changed_service
            .abandon_round(&old_map_round.id, "changed", actor())
            .await
            .is_err()
    );
    let retired = changed_service
        .abandon_round(&old_map_round.id, &old_map_round.digest, actor())
        .await
        .unwrap();
    assert_eq!(retired.status, "cancelled");
    assert_eq!(
        changed_service
            .abandon_round(&old_map_round.id, &old_map_round.digest, actor())
            .await
            .unwrap()
            .status,
        "cancelled"
    );
    assert_eq!(service.observation(&kept_id).await.unwrap(), kept);
    assert!(
        changed_service
            .approve_route_plan(&replacement.id, &replacement.digest, actor())
            .await
            .is_err()
    );
    assert!(changed_service.next_command(&a).await.is_err());
    clock.0.fetch_add(3, Ordering::SeqCst);
    pose(&changed_service, a.as_str(), 0.0, None).await;
    pose(&changed_service, b.as_str(), 1.0, Some(0.0)).await;
    let replacement_round = changed_service
        .approve_route_plan(&replacement.id, &replacement.digest, actor())
        .await
        .unwrap();
    let interrupted = changed_service.next_command(&a).await.unwrap().unwrap();
    clock.0.fetch_add(11, Ordering::SeqCst);
    changed_service.reassign_unavailable(actor()).await.unwrap();
    let retired = changed_service
        .abandon_round(&replacement_round.id, &replacement_round.digest, actor())
        .await
        .unwrap();
    assert_eq!(retired.status, "cancelled");
    // An already-delivered command remains fenced through its original deadline.
    assert!(
        changed_service
            .heartbeat(
                &a,
                HeartbeatRequest {
                    status: BodyStatus::Online,
                    battery: BatteryPercent::new(95).unwrap(),
                    location: "inspection_bay".into(),
                    pose: Some(BodyPose {
                        x: 0.0,
                        y: 0.0,
                        z: None,
                        yaw: 0.0
                    }),
                }
            )
            .await
            .is_err()
    );
    let late = changed_service
        .report_result(
            &interrupted.envelope.mission_id,
            result(
                &interrupted,
                CommandResultStatus::Succeeded,
                &clock,
                Some(image(&clock)),
            ),
        )
        .await
        .unwrap();
    assert_eq!(late.status, MissionStatus::Cancelled);
    assert!(
        changed_service
            .observation(&format!("observation-{}", interrupted.envelope.command_id))
            .await
            .is_err()
    );
    clock.0.store(
        interrupted.envelope.expires_at.timestamp() + 3,
        Ordering::SeqCst,
    );
    pose(&service, a.as_str(), 0.0, None).await;
    pose(&service, b.as_str(), 1.0, Some(0.0)).await;
    // Prepare a later valid review so startup has a pending plan to invalidate.
    let pending = service.propose_route_plan(request()).await.unwrap();
    assert_eq!(pending.status, "pending");
    tx.finish(true).await.unwrap();
    drop(changed_service);
    drop(terminal);
    drop(service);
    drop(tx);
    db.recover(&key.public_key_base64, "route-epoch-2")
        .await
        .unwrap();
    let tx = db.begin().await.unwrap();
    let service = app(tx.clone(), signer, clock, map());
    let retained = service.list_route_plans().await.unwrap();
    assert_eq!(
        retained.iter().find(|p| p.id == pending.id).unwrap().status,
        "invalidated"
    );
    assert_eq!(
        retained
            .iter()
            .find(|p| p.id == proposal.id)
            .unwrap()
            .status,
        "approved"
    );
    assert_eq!(
        service.observation(&observation.id).await.unwrap(),
        observation
    );
    assert_eq!(
        service
            .list_rounds()
            .await
            .unwrap()
            .into_iter()
            .find(|r| r.id == round.id)
            .unwrap()
            .status,
        "completed"
    );
    assert!(
        service
            .list_missions()
            .await
            .unwrap()
            .iter()
            .all(|m| !matches!(m.status, MissionStatus::Assigned | MissionStatus::Running))
    );
    tx.finish(true).await.unwrap();
}
