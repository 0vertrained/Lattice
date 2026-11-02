//! Run with LATTICE_TEST_DATABASE_URL pointing to an isolated, empty database.
#![allow(clippy::unwrap_used)]
use lattice_application::{
    AuditSink, BodyRepository, CommandQueue, CommandSigner, HeartbeatRequest, LatticeService,
    MissionRepository, ProposalInput, ProposalRepository, RegisterBodyRequest, ServiceConfig,
};
use lattice_domain::{
    AuditActor, BatteryPercent, BodyId, BodyKind, BodyStatus, Capability, MissionStatus,
    SkillCommand,
};
use lattice_infrastructure::{Ed25519CommandSigner, PostgresPlatform, PostgresUnit, SystemClock};
use std::{collections::BTreeSet, sync::Arc};
fn service(tx: Arc<PostgresUnit>, signer: Arc<Ed25519CommandSigner>) -> LatticeService {
    LatticeService::new(
        tx.clone(),
        tx.clone(),
        tx.clone(),
        signer,
        tx.clone(),
        Arc::new(SystemClock),
        ServiceConfig::default(),
    )
    .with_proposals(tx)
}
fn input(title: &str) -> ProposalInput {
    ProposalInput {
        user_intent: title.into(),
        decision: "ready".into(),
        command: Some(SkillCommand::Navigate {
            destination: "loading_dock".into(),
            max_speed_mps: 0.3,
        }),
        model_id: "manual-v1".into(),
        policy_version: "warehouse-v1".into(),
        confidence: 1.,
        rationale: "Integration test".into(),
    }
}
fn actor() -> AuditActor {
    AuditActor::Operator("integration-test".into())
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn transaction_cancellation_restart_and_concurrent_recovery() {
    let url = std::env::var("LATTICE_TEST_DATABASE_URL").unwrap();
    let db = PostgresPlatform::connect(&url).await.unwrap();
    assert!(
        PostgresPlatform::connect(&url).await.is_err(),
        "second core must be fenced"
    );
    let signer = Arc::new(Ed25519CommandSigner::generate_ephemeral("test"));
    let key = signer.verification_key().await.unwrap().public_key_base64;
    db.recover(&key, "first-boot").await.unwrap();
    let body = BodyId::new("integration-rover").unwrap();
    let tx = db.begin().await.unwrap();
    let app = service(tx.clone(), signer.clone());
    app.register_body(
        RegisterBodyRequest {
            id: body.clone(),
            display_name: "Test rover".into(),
            kind: BodyKind::Rover,
            capabilities: BTreeSet::from([Capability::Navigate]),
            adapter_version: "test-1".into(),
        },
        actor(),
    )
    .await
    .unwrap();
    let p = app
        .propose(input("Cancelled transaction must not dispatch"))
        .await
        .unwrap();
    tx.finish(true).await.unwrap();
    drop(app);
    drop(tx);

    // Abort the task after all writes (including signing/enqueue/audit), before commit.
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn({
        let db = db.clone();
        let signer = signer.clone();
        let p = p.clone();
        async move {
            let tx = db.begin().await.unwrap();
            let app = service(tx, signer);
            app.approve_proposal(&p.id, &p.digest, actor())
                .await
                .unwrap();
            ready_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        }
    });
    ready_rx.await.unwrap();
    task.abort();
    let _ = task.await;
    let tx = tokio::time::timeout(std::time::Duration::from_secs(5), db.begin())
        .await
        .unwrap()
        .unwrap();
    assert!(
        MissionRepository::list(tx.as_ref())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        CommandQueue::dequeue(tx.as_ref(), &body)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        ProposalRepository::get(tx.as_ref(), &p.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        "pending"
    );
    assert!(
        !AuditSink::list(tx.as_ref())
            .await
            .unwrap()
            .iter()
            .any(|r| r.event_type == "proposal.approved")
    );
    tx.finish(true).await.unwrap();
    drop(tx);

    // Two concurrent approvals must commit one mission and one command sequence.
    let approve = |p: lattice_application::Proposal| {
        let db = db.clone();
        let signer = signer.clone();
        async move {
            let tx = db.begin().await.unwrap();
            let app = service(tx.clone(), signer);
            let result = app.approve_proposal(&p.id, &p.digest, actor()).await;
            tx.finish(result.is_ok()).await.unwrap();
            result
        }
    };
    let (a, b) = tokio::join!(approve(p.clone()), approve(p.clone()));
    let m = a.unwrap();
    assert_eq!(m.id, b.unwrap().id);
    let tx = db.begin().await.unwrap();
    let original = CommandQueue::dequeue(tx.as_ref(), &body)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original.envelope.sequence, 1);
    assert!(
        CommandQueue::dequeue(tx.as_ref(), &body)
            .await
            .unwrap()
            .is_none()
    );
    let stale = service(tx.clone(), signer.clone())
        .propose(input("Old review must be invalidated"))
        .await
        .unwrap();
    tx.finish(true).await.unwrap();
    drop(tx);

    assert!(db.recover("wrong-key", "bad-boot").await.is_err());
    db.recover(&key, "second-boot").await.unwrap();
    let tx = db.begin().await.unwrap();
    let app = service(tx.clone(), signer.clone());
    assert_eq!(
        MissionRepository::get(tx.as_ref(), &m.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        MissionStatus::RecoveryRequired
    );
    assert_eq!(
        BodyRepository::get(tx.as_ref(), &body)
            .await
            .unwrap()
            .unwrap()
            .status,
        BodyStatus::Offline
    );
    assert!(
        app.approve_proposal(&stale.id, &stale.digest, actor())
            .await
            .is_err()
    );
    assert!(app.reassign_unavailable(actor()).await.unwrap().is_empty());
    assert!(
        CommandQueue::dequeue(tx.as_ref(), &body)
            .await
            .unwrap()
            .is_none()
    );
    app.heartbeat(
        &body,
        HeartbeatRequest {
            status: BodyStatus::Online,
            battery: BatteryPercent::new(100).unwrap(),
            location: "warehouse".into(),
            pose: None,
        },
    )
    .await
    .unwrap();
    let review1 = app.propose_recovery(&m.id).await.unwrap();
    let review2 = app.propose_recovery(&m.id).await.unwrap();
    assert!(
        app.approve_proposal(&review1.id, "changed-digest", actor())
            .await
            .is_err()
    );
    tx.finish(true).await.unwrap();
    drop(app);
    drop(tx);
    let (a, b) = tokio::join!(approve(review1.clone()), approve(review2));
    assert!(
        a.is_ok() ^ b.is_ok(),
        "only one recovery proposal may dispatch"
    );
    let tx = db.begin().await.unwrap();
    let command = CommandQueue::dequeue(tx.as_ref(), &body)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(command.envelope.sequence, 2);
    assert_ne!(command.envelope.command_id, original.envelope.command_id);
    assert_eq!(
        MissionRepository::get(tx.as_ref(), &m.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        MissionStatus::Cancelled
    );
    assert!(
        CommandQueue::dequeue(tx.as_ref(), &body)
            .await
            .unwrap()
            .is_none()
    );
    tx.finish(true).await.unwrap();
    drop(tx);

    // Verify the full audit chain and that every record has a transactional outbox row.
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        connection.await.unwrap();
    });
    let rows = client
        .query(
            "SELECT record,previous_hash,record_hash FROM audit_log ORDER BY position",
            &[],
        )
        .await
        .unwrap();
    let mut previous: Option<Vec<u8>> = None;
    use sha2::{Digest, Sha256};
    for row in &rows {
        assert_eq!(row.get::<_, Option<Vec<u8>>>(1), previous);
        let record: lattice_domain::AuditRecord = serde_json::from_value(row.get(0)).unwrap();
        let mut hash = Sha256::new();
        if let Some(p) = &previous {
            hash.update(p);
        }
        hash.update(serde_json::to_vec(&record).unwrap());
        previous = Some(hash.finalize().to_vec());
        assert_eq!(row.get::<_, Vec<u8>>(2), previous.clone().unwrap());
    }
    assert_eq!(
        client
            .query_one("SELECT count(*) FROM outbox", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        rows.len() as i64
    );
}
