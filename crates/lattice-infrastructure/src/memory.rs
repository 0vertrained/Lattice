use std::collections::{HashMap, VecDeque};

use async_trait::async_trait;
use lattice_application::{
    ApplicationError, AuditSink, BodyRepository, CommandQueue, MissionRepository,
};
use lattice_domain::{AuditRecord, BodyId, BodySnapshot, Mission, MissionId, SignedCommand};
use tokio::sync::{Mutex, RwLock};

/// Shared deterministic development adapter implementing all persistence ports.
///
/// PostgreSQL replaces this adapter without changing domain or application code.
#[derive(Debug, Default)]
pub struct InMemoryPlatform {
    bodies: RwLock<HashMap<BodyId, BodySnapshot>>,
    missions: RwLock<HashMap<MissionId, Mission>>,
    queues: Mutex<HashMap<BodyId, VecDeque<SignedCommand>>>,
    sequences: Mutex<HashMap<BodyId, u64>>,
    audit: RwLock<Vec<AuditRecord>>,
}

#[async_trait]
impl BodyRepository for InMemoryPlatform {
    async fn save(&self, body: BodySnapshot) -> Result<(), ApplicationError> {
        self.bodies.write().await.insert(body.id.clone(), body);
        Ok(())
    }

    async fn get(&self, id: &BodyId) -> Result<Option<BodySnapshot>, ApplicationError> {
        Ok(self.bodies.read().await.get(id).cloned())
    }

    async fn list(&self) -> Result<Vec<BodySnapshot>, ApplicationError> {
        Ok(self.bodies.read().await.values().cloned().collect())
    }
}

#[async_trait]
impl MissionRepository for InMemoryPlatform {
    async fn save(&self, mission: Mission) -> Result<(), ApplicationError> {
        self.missions
            .write()
            .await
            .insert(mission.id.clone(), mission);
        Ok(())
    }

    async fn get(&self, id: &MissionId) -> Result<Option<Mission>, ApplicationError> {
        Ok(self.missions.read().await.get(id).cloned())
    }

    async fn list(&self) -> Result<Vec<Mission>, ApplicationError> {
        Ok(self.missions.read().await.values().cloned().collect())
    }
}

#[async_trait]
impl CommandQueue for InMemoryPlatform {
    async fn next_sequence(&self, body_id: &BodyId) -> Result<u64, ApplicationError> {
        let mut sequences = self.sequences.lock().await;
        let sequence = sequences.entry(body_id.clone()).or_insert(0);
        *sequence = sequence
            .checked_add(1)
            .ok_or_else(|| ApplicationError::Conflict("command sequence exhausted".to_owned()))?;
        Ok(*sequence)
    }

    async fn enqueue(&self, command: SignedCommand) -> Result<(), ApplicationError> {
        self.queues
            .lock()
            .await
            .entry(command.envelope.body_id.clone())
            .or_default()
            .push_back(command);
        Ok(())
    }

    async fn dequeue(&self, body_id: &BodyId) -> Result<Option<SignedCommand>, ApplicationError> {
        Ok(self
            .queues
            .lock()
            .await
            .get_mut(body_id)
            .and_then(VecDeque::pop_front))
    }
}

#[async_trait]
impl AuditSink for InMemoryPlatform {
    async fn append(&self, record: AuditRecord) -> Result<(), ApplicationError> {
        self.audit.write().await.push(record);
        Ok(())
    }

    async fn list(&self) -> Result<Vec<AuditRecord>, ApplicationError> {
        Ok(self.audit.read().await.clone())
    }
}
