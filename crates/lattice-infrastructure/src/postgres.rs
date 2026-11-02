//! Single-core PostgreSQL unit of work. HTTP responses are released only after commit.
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use lattice_application::{
    ApplicationError, AuditSink, BodyRepository, CommandQueue, HandoffRepository, InspectionRound,
    MissionRepository, Proposal, ProposalRepository, RoundRepository, RoutePlanRepository,
};
use lattice_domain::{
    AuditActor, AuditRecord, BodyId, BodySnapshot, Mission, MissionId, SignedCommand,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{Mutex, OwnedMutexGuard, RwLock};
use tokio_postgres::{Client, NoTls};

pub(crate) fn failure(error: impl std::fmt::Display) -> ApplicationError {
    tracing::error!(%error, "PostgreSQL operation failed");
    ApplicationError::Infrastructure
}
fn encode(value: &impl Serialize) -> Result<Value, ApplicationError> {
    serde_json::to_value(value).map_err(failure)
}
fn decode<T: DeserializeOwned>(value: Value) -> Result<T, ApplicationError> {
    serde_json::from_value(value).map_err(failure)
}

/// One active writer. Local mode holds a session lock; hosted rollouts use epoch fencing.
/// The connection must use a local socket/loopback, including a managed Cloud SQL connector.
#[derive(Clone)]
pub struct PostgresPlatform {
    client: Arc<Mutex<Client>>,
    owner_epoch: Arc<RwLock<Option<String>>>,
}
impl PostgresPlatform {
    /// Connects to local PostgreSQL, migrates atomically, and acquires sole ownership.
    /// The connection string must select a Unix socket or loopback host (no TLS here).
    pub async fn connect(url: &str) -> Result<Self, ApplicationError> {
        Self::connect_for_runtime(url, false).await
    }

    /// Cloud revisions may explicitly transfer ownership. Every old request is fenced.
    pub async fn connect_for_runtime(
        url: &str,
        allow_takeover: bool,
    ) -> Result<Self, ApplicationError> {
        let config: tokio_postgres::Config = url.parse().map_err(failure)?;
        if config.get_hosts().is_empty()
            || config.get_hosts().iter().any(|host| match host {
                tokio_postgres::config::Host::Tcp(name) => {
                    !matches!(name.as_str(), "127.0.0.1" | "::1" | "localhost")
                }
                #[cfg(unix)]
                tokio_postgres::config::Host::Unix(_) => false,
            })
        {
            return Err(ApplicationError::Conflict(
                "PostgreSQL currently requires a local socket or loopback host".into(),
            ));
        }
        let (client, connection) = config.connect(NoTls).await.map_err(failure)?;
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                tracing::error!(%e, "PostgreSQL connection closed");
            }
        });
        let owned: bool = client
            .query_one("SELECT pg_try_advisory_lock(710683028831)", &[])
            .await
            .map_err(failure)?
            .get(0);
        if !owned {
            return Err(ApplicationError::Conflict(
                "another core owns this database".into(),
            ));
        }
        if allow_takeover {
            client
                .simple_query("SELECT pg_advisory_unlock(710683028831)")
                .await
                .map_err(failure)?;
        }
        let platform = Self {
            client: Arc::new(Mutex::new(client)),
            owner_epoch: Arc::new(RwLock::new(None)),
        };
        let tx = platform.begin().await?;
        tx.client().batch_execute("CREATE TABLE IF NOT EXISTS lattice_schema_migrations (version integer PRIMARY KEY)").await.map_err(failure)?;
        for (version, sql) in [
            (
                1_i32,
                include_str!("../../../infrastructure/postgres/migrations/0001_initial.sql"),
            ),
            (
                2_i32,
                include_str!("../../../infrastructure/postgres/migrations/0002_runtime.sql"),
            ),
            (
                3_i32,
                include_str!(
                    "../../../infrastructure/postgres/migrations/0003_device_identities.sql"
                ),
            ),
            (
                4_i32,
                include_str!("../../../infrastructure/postgres/migrations/0004_core_fencing.sql"),
            ),
            (
                5_i32,
                include_str!(
                    "../../../infrastructure/postgres/migrations/0005_inspection_rounds.sql"
                ),
            ),
            (
                6_i32,
                include_str!(
                    "../../../infrastructure/postgres/migrations/0006_observation_memory.sql"
                ),
            ),
            (
                7_i32,
                include_str!("../../../infrastructure/postgres/migrations/0007_handoffs.sql"),
            ),
            (
                8_i32,
                include_str!("../../../infrastructure/postgres/migrations/0008_route_plans.sql"),
            ),
        ] {
            if tx
                .client()
                .query_opt(
                    "SELECT version FROM lattice_schema_migrations WHERE version=$1",
                    &[&version],
                )
                .await
                .map_err(failure)?
                .is_none()
            {
                // The original bootstrap migration also supports standalone psql execution.
                let sql = sql.replace("BEGIN;", "").replace("COMMIT;", "");
                tx.client().batch_execute(&sql).await.map_err(failure)?;
                tx.client()
                    .execute(
                        "INSERT INTO lattice_schema_migrations VALUES ($1)",
                        &[&version],
                    )
                    .await
                    .map_err(failure)?;
            }
        }
        tx.finish(true).await?;
        drop(tx);
        Ok(platform)
    }

    /// Readiness checks the actual database connection without mutating state.
    pub async fn ready(&self) -> Result<(), ApplicationError> {
        let tx = self.begin().await?;
        tx.finish(false).await
    }

    /// Begins an isolated use case. Cancellation retains the connection until rollback.
    pub async fn begin(&self) -> Result<Arc<PostgresUnit>, ApplicationError> {
        let unit = Arc::new(PostgresUnit {
            client: Some(self.client.clone().lock_owned().await),
            finished: AtomicBool::new(false),
        });
        unit.client().batch_execute("BEGIN; SET LOCAL statement_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '15s'").await.map_err(failure)?;
        unit.client()
            .simple_query("SELECT pg_advisory_xact_lock(710683028832)")
            .await
            .map_err(failure)?;
        if let Some(expected) = self.owner_epoch.read().await.as_ref() {
            let current: Option<String> = unit
                .client()
                .query_one("SELECT owner_epoch FROM core_identity", &[])
                .await
                .map_err(failure)?
                .get(0);
            if current.as_ref() != Some(expected) {
                return Err(ApplicationError::Infrastructure);
            }
        }
        Ok(unit)
    }

    /// Checks stable signing identity and invalidates every pre-restart dispatch.
    pub async fn recover(&self, public_key: &str, epoch: &str) -> Result<(), ApplicationError> {
        let tx = self.begin().await?;
        if let Some(row) = tx
            .client()
            .query_opt("SELECT public_key FROM core_identity", &[])
            .await
            .map_err(failure)?
        {
            if row.get::<_, String>(0) != public_key {
                return Err(ApplicationError::Security);
            }
        } else {
            tx.client()
                .execute(
                    "INSERT INTO core_identity(public_key) VALUES ($1)",
                    &[&public_key],
                )
                .await
                .map_err(failure)?;
        }
        let now = chrono::Utc::now();
        let mut held = 0;
        for mut m in MissionRepository::list(tx.as_ref()).await? {
            let before = m.status;
            m.require_recovery(now);
            if m.status != before {
                MissionRepository::save(tx.as_ref(), m).await?;
                held += 1;
            }
        }
        for mut round in RoundRepository::list(tx.as_ref()).await? {
            match round.status.as_str() {
                "pending" => round.status = "invalidated".into(),
                "active" => round.status = "recovery_required".into(),
                _ => {}
            }
            RoundRepository::save(tx.as_ref(), round).await?;
        }
        for mut handoff in HandoffRepository::list_handoffs(tx.as_ref()).await? {
            if handoff.status == "pending" {
                handoff.status = "invalidated".into();
                HandoffRepository::save_handoff(tx.as_ref(), handoff).await?;
            }
        }
        // Body fences are retained across core restart until their signed-command deadline.
        for mut plan in RoutePlanRepository::list_route_plans(tx.as_ref()).await? {
            if plan.status == "pending" {
                plan.status = "invalidated".into();
                RoutePlanRepository::save_route_plan(tx.as_ref(), plan).await?;
            }
        }
        for mut b in BodyRepository::list(tx.as_ref()).await? {
            b.status = lattice_domain::BodyStatus::Offline;
            BodyRepository::save(tx.as_ref(), b).await?;
        }
        for mut p in ProposalRepository::list(tx.as_ref()).await? {
            if p.status == "pending" || p.status == "approving" {
                p.status = "invalidated".into();
                ProposalRepository::save(tx.as_ref(), p).await?;
            }
        }
        tx.client()
            .execute(
                "UPDATE commands SET status='invalidated' WHERE status IN ('queued','delivered') AND mission_id IN (SELECT mission_id FROM missions WHERE status='recovery_required')",
                &[],
            )
            .await
            .map_err(failure)?;
        AuditSink::append(
            tx.as_ref(),
            AuditRecord {
                occurred_at: now,
                actor: AuditActor::Service("core".into()),
                event_type: "core.started".into(),
                object_id: epoch.into(),
                metadata: serde_json::json!({"missions_held":held}),
            },
        )
        .await?;
        tx.client()
            .execute("UPDATE core_identity SET owner_epoch=$1", &[&epoch])
            .await
            .map_err(failure)?;
        tx.finish(true).await?;
        *self.owner_epoch.write().await = Some(epoch.to_owned());
        Ok(())
    }
}

/// Transaction-scoped implementations of every state port. Do not retain after `finish`.
pub struct PostgresUnit {
    client: Option<OwnedMutexGuard<Client>>,
    finished: AtomicBool,
}
impl PostgresUnit {
    pub(crate) fn client(&self) -> &Client {
        self.client
            .as_deref()
            .unwrap_or_else(|| unreachable!("connection retained until drop"))
    }
    /// Commits a successful use case or rolls back an error response.
    pub async fn finish(&self, commit: bool) -> Result<(), ApplicationError> {
        if self.finished.load(Ordering::SeqCst) {
            return Err(ApplicationError::Infrastructure);
        }
        self.client()
            .batch_execute(if commit { "COMMIT" } else { "ROLLBACK" })
            .await
            .map_err(failure)?;
        self.finished.store(true, Ordering::SeqCst);
        Ok(())
    }
}
impl Drop for PostgresUnit {
    fn drop(&mut self) {
        if !self.finished.load(Ordering::SeqCst)
            && let Some(client) = self.client.take()
        {
            // Retain the exclusive guard while rolling back; the next request cannot
            // accidentally commit changes left by a cancelled or panicking handler.
            tokio::spawn(async move {
                let _ = client.batch_execute("ROLLBACK").await;
            });
        }
    }
}

#[async_trait]
impl BodyRepository for PostgresUnit {
    async fn save(&self, body: BodySnapshot) -> Result<(), ApplicationError> {
        self.client().execute("INSERT INTO bodies(body_id,snapshot,last_seen) VALUES($1,$2,$3) ON CONFLICT(body_id) DO UPDATE SET snapshot=$2,last_seen=$3,updated_at=now(),version=bodies.version+1", &[&body.id.as_str(), &encode(&body)?, &body.last_seen]).await.map_err(failure)?;
        Ok(())
    }
    async fn get(&self, id: &BodyId) -> Result<Option<BodySnapshot>, ApplicationError> {
        self.client()
            .query_opt(
                "SELECT snapshot FROM bodies WHERE body_id=$1",
                &[&id.as_str()],
            )
            .await
            .map_err(failure)?
            .map(|r| decode(r.get(0)))
            .transpose()
    }
    async fn list(&self) -> Result<Vec<BodySnapshot>, ApplicationError> {
        self.client()
            .query("SELECT snapshot FROM bodies ORDER BY body_id", &[])
            .await
            .map_err(failure)?
            .into_iter()
            .map(|r| decode(r.get(0)))
            .collect()
    }
}
#[async_trait]
impl MissionRepository for PostgresUnit {
    async fn save(&self, m: Mission) -> Result<(), ApplicationError> {
        self.client().execute("INSERT INTO missions(mission_id,mission,assigned_body_id,active_command_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(mission_id) DO UPDATE SET mission=$2,assigned_body_id=$3,active_command_id=$4,updated_at=$6,version=missions.version+1", &[&m.id.as_str(), &encode(&m)?, &m.assigned_body_id.as_ref().map(BodyId::as_str), &m.active_command_id.as_ref().map(lattice_domain::CommandId::as_str), &m.created_at, &m.updated_at]).await.map_err(failure)?;
        Ok(())
    }
    async fn get(&self, id: &MissionId) -> Result<Option<Mission>, ApplicationError> {
        self.client()
            .query_opt(
                "SELECT mission FROM missions WHERE mission_id=$1",
                &[&id.as_str()],
            )
            .await
            .map_err(failure)?
            .map(|r| decode(r.get(0)))
            .transpose()
    }
    async fn list(&self) -> Result<Vec<Mission>, ApplicationError> {
        self.client()
            .query("SELECT mission FROM missions ORDER BY created_at DESC", &[])
            .await
            .map_err(failure)?
            .into_iter()
            .map(|r| decode(r.get(0)))
            .collect()
    }
}
#[async_trait]
impl ProposalRepository for PostgresUnit {
    async fn save(&self, p: Proposal) -> Result<(), ApplicationError> {
        self.client().execute("INSERT INTO proposals VALUES($1,$2) ON CONFLICT(proposal_id) DO UPDATE SET proposal=$2", &[&p.id, &encode(&p)?]).await.map_err(failure)?;
        Ok(())
    }
    async fn get(&self, id: &str) -> Result<Option<Proposal>, ApplicationError> {
        self.client()
            .query_opt(
                "SELECT proposal FROM proposals WHERE proposal_id=$1",
                &[&id],
            )
            .await
            .map_err(failure)?
            .map(|r| decode(r.get(0)))
            .transpose()
    }
    async fn list(&self) -> Result<Vec<Proposal>, ApplicationError> {
        self.client()
            .query("SELECT proposal FROM proposals ORDER BY proposal_id", &[])
            .await
            .map_err(failure)?
            .into_iter()
            .map(|r| decode(r.get(0)))
            .collect()
    }
}
#[async_trait]
impl CommandQueue for PostgresUnit {
    async fn next_sequence(&self, body: &BodyId) -> Result<u64, ApplicationError> {
        let seq: i64 = self.client().query_one("INSERT INTO body_sequences VALUES($1,1) ON CONFLICT(body_id) DO UPDATE SET sequence=body_sequences.sequence+1 RETURNING sequence", &[&body.as_str()]).await.map_err(failure)?.get(0);
        u64::try_from(seq).map_err(failure)
    }
    async fn enqueue(&self, c: SignedCommand) -> Result<(), ApplicationError> {
        let e = &c.envelope;
        let seq = i64::try_from(e.sequence).map_err(failure)?;
        let signature = STANDARD.decode(&c.signature_base64).map_err(failure)?;
        self.client().execute("INSERT INTO commands(command_id,mission_id,body_id,sequence,envelope,signature,key_id,contract_version,issued_at,expires_at,signed_command) VALUES($1,$2,$3,$4,$5,$6,$7,'v1',$8,$9,$10)", &[&e.command_id.as_str(), &e.mission_id.as_str(), &e.body_id.as_str(), &seq, &e.signing_bytes().map_err(failure)?, &signature, &c.key_id, &e.issued_at, &e.expires_at, &encode(&c)?]).await.map_err(failure)?;
        Ok(())
    }
    async fn dequeue(&self, body: &BodyId) -> Result<Option<SignedCommand>, ApplicationError> {
        self.client().query_opt("UPDATE commands SET status='delivered',delivered_at=now() WHERE command_id=(SELECT command_id FROM commands WHERE body_id=$1 AND status='queued' ORDER BY sequence LIMIT 1 FOR UPDATE) RETURNING signed_command", &[&body.as_str()]).await.map_err(failure)?.map(|r| decode(r.get(0))).transpose()
    }
}
#[async_trait]
impl AuditSink for PostgresUnit {
    async fn append(&self, r: AuditRecord) -> Result<(), ApplicationError> {
        let previous: Option<Vec<u8>> = self
            .client()
            .query_opt(
                "SELECT record_hash FROM audit_log ORDER BY position DESC LIMIT 1",
                &[],
            )
            .await
            .map_err(failure)?
            .map(|row| row.get(0));
        let mut hash = Sha256::new();
        if let Some(bytes) = &previous {
            hash.update(bytes);
        }
        hash.update(serde_json::to_vec(&r).map_err(failure)?);
        let digest = hash.finalize().to_vec();
        let (kind, id) = match &r.actor {
            AuditActor::Operator(id) => ("operator", id),
            AuditActor::Body(id) => ("body", id),
            AuditActor::Service(id) => ("service", id),
        };
        self.client().execute("INSERT INTO audit_log(occurred_at,actor_type,actor_id,event_type,object_id,metadata,previous_hash,record_hash,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", &[&r.occurred_at, &kind, &id, &r.event_type, &r.object_id, &r.metadata, &previous, &digest, &encode(&r)?]).await.map_err(failure)?;
        // Outbox writes share the decision transaction; delivery to NATS is a later phase.
        self.client()
            .execute(
                "INSERT INTO outbox(subject,payload) VALUES($1,$2)",
                &[&r.event_type, &encode(&r)?],
            )
            .await
            .map_err(failure)?;
        Ok(())
    }
    async fn list(&self) -> Result<Vec<AuditRecord>, ApplicationError> {
        self.client()
            .query("SELECT record FROM audit_log ORDER BY position", &[])
            .await
            .map_err(failure)?
            .into_iter()
            .map(|r| decode(r.get(0)))
            .collect()
    }
}

#[async_trait]
impl RoundRepository for PostgresUnit {
    async fn save(&self, round: InspectionRound) -> Result<(), ApplicationError> {
        self.client().execute("INSERT INTO inspection_rounds VALUES($1,$2) ON CONFLICT(round_id) DO UPDATE SET round=$2",&[&round.id,&encode(&round)?]).await.map_err(failure)?;
        Ok(())
    }
    async fn get(&self, id: &str) -> Result<Option<InspectionRound>, ApplicationError> {
        self.client()
            .query_opt(
                "SELECT round FROM inspection_rounds WHERE round_id=$1",
                &[&id],
            )
            .await
            .map_err(failure)?
            .map(|r| decode(r.get(0)))
            .transpose()
    }
    async fn list(&self) -> Result<Vec<InspectionRound>, ApplicationError> {
        self.client()
            .query("SELECT round FROM inspection_rounds ORDER BY round_id", &[])
            .await
            .map_err(failure)?
            .into_iter()
            .map(|r| decode(r.get(0)))
            .collect()
    }
}
