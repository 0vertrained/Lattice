//! Approval integration checks against the real in-memory signing/queue adapters.
#![allow(clippy::unwrap_used)]
use chrono::{DateTime, Utc};
use lattice_application::{
    Clock, LatticeService, ProposalInput, RegisterBodyRequest, ServiceConfig,
};
use lattice_domain::{AuditActor, BodyId, BodyKind, Capability, SkillCommand};
use lattice_infrastructure::{Ed25519CommandSigner, InMemoryPlatform};
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
fn setup() -> (LatticeService, Arc<TestClock>) {
    let p = Arc::new(InMemoryPlatform::default());
    let clock = Arc::new(TestClock(AtomicI64::new(Utc::now().timestamp())));
    (
        LatticeService::new(
            p.clone(),
            p.clone(),
            p.clone(),
            Arc::new(Ed25519CommandSigner::generate_ephemeral("test")),
            p,
            clock.clone(),
            ServiceConfig::default(),
        ),
        clock,
    )
}
fn input() -> ProposalInput {
    ProposalInput {
        user_intent: "Drive to the dock".into(),
        decision: "ready".into(),
        command: Some(SkillCommand::Navigate {
            destination: "loading_dock".into(),
            max_speed_mps: 0.3,
        }),
        model_id: "test-model".into(),
        policy_version: "test-v1".into(),
        confidence: 0.9,
        rationale: "fixture".into(),
    }
}
fn actor() -> AuditActor {
    AuditActor::Operator("test".into())
}

#[tokio::test]
async fn immutable_approval_is_required_and_concurrent_retries_do_not_duplicate_commands() {
    let (service, _) = setup();
    let body = BodyId::new("test-rover").unwrap();
    service
        .register_body(
            RegisterBodyRequest {
                id: body.clone(),
                display_name: "Test rover".into(),
                kind: BodyKind::Rover,
                capabilities: [Capability::Navigate].into(),
                adapter_version: "test-v1".into(),
            },
            actor(),
        )
        .await
        .unwrap();
    let p = service.propose(input()).await.unwrap();
    assert!(service.next_command(&body).await.unwrap().is_none());
    assert!(service.list_missions().await.unwrap().is_empty());
    assert!(
        service
            .approve_proposal(&p.id, "changed-digest", actor())
            .await
            .is_err()
    );
    let (a, b) = tokio::join!(
        service.approve_proposal(&p.id, &p.digest, actor()),
        service.approve_proposal(&p.id, &p.digest, actor())
    );
    let mission = a.or(b).unwrap();
    let retry = service
        .approve_proposal(&p.id, &p.digest, actor())
        .await
        .unwrap();
    assert_eq!(mission.id, retry.id);
    assert_eq!(service.list_missions().await.unwrap().len(), 1);
    let command = service.next_command(&body).await.unwrap().unwrap();
    assert_eq!(command.envelope.command, p.input.command.unwrap());
    assert!(service.next_command(&body).await.unwrap().is_none());
    assert_eq!(
        service.list_proposals().await.unwrap()[0].mission_id,
        Some(mission.id)
    );
}

#[tokio::test]
async fn expiry_abstention_and_out_of_map_model_output_cannot_be_approved() {
    let (service, clock) = setup();
    let p = service.propose(input()).await.unwrap();
    clock.0.fetch_add(300, Ordering::SeqCst);
    assert!(
        service
            .approve_proposal(&p.id, &p.digest, actor())
            .await
            .is_err()
    );
    for decision in ["clarify", "rejected"] {
        let p = service
            .propose(ProposalInput {
                decision: decision.into(),
                command: None,
                ..input()
            })
            .await
            .unwrap();
        assert!(
            service
                .approve_proposal(&p.id, &p.digest, actor())
                .await
                .is_err()
        );
    }
    for command in [
        SkillCommand::Navigate {
            destination: "loading_dock".into(),
            max_speed_mps: 0.5,
        },
        SkillCommand::Inspect {
            location: "invented_room".into(),
        },
    ] {
        assert!(
            service
                .propose(ProposalInput {
                    command: Some(command),
                    ..input()
                })
                .await
                .is_err()
        );
    }
    assert!(service.list_missions().await.unwrap().is_empty());
}

#[tokio::test]
async fn inspection_cannot_succeed_without_camera_evidence() {
    use lattice_domain::{CommandResult, CommandResultStatus};
    let (service, clock) = setup();
    let body = BodyId::new("camera-rover").unwrap();
    service
        .register_body(
            RegisterBodyRequest {
                id: body.clone(),
                display_name: "Camera rover".into(),
                kind: BodyKind::Rover,
                capabilities: [Capability::Inspect].into(),
                adapter_version: "test-v1".into(),
            },
            actor(),
        )
        .await
        .unwrap();
    let p = service
        .propose(ProposalInput {
            command: Some(SkillCommand::Inspect {
                location: "inspection_bay".into(),
            }),
            ..input()
        })
        .await
        .unwrap();
    let mission = service
        .approve_proposal(&p.id, &p.digest, actor())
        .await
        .unwrap();
    let command = service.next_command(&body).await.unwrap().unwrap();
    let result = CommandResult {
        command_id: command.envelope.command_id,
        body_id: body,
        status: CommandResultStatus::Succeeded,
        progress_pct: 100,
        detail: None,
        reported_at: clock.now(),
        evidence: None,
    };
    assert!(
        service
            .report_result(&mission.id, result.clone())
            .await
            .is_err()
    );
    let failed = service
        .report_result(
            &mission.id,
            CommandResult {
                status: CommandResultStatus::Failed,
                detail: Some("camera unavailable".into()),
                ..result
            },
        )
        .await
        .unwrap();
    assert_eq!(failed.status, lattice_domain::MissionStatus::Failed);
}
