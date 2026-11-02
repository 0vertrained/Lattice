//! Handoff snapshots and lease-withdrawal fences share the mission transaction.
use crate::postgres::{PostgresUnit, failure};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use lattice_application::{ApplicationError, HandoffProposal, HandoffRepository};
use lattice_domain::BodyId;

#[async_trait]
impl HandoffRepository for PostgresUnit {
    async fn save_handoff(&self, proposal: HandoffProposal) -> Result<(), ApplicationError> {
        let data = serde_json::to_value(&proposal).map_err(failure)?;
        self.client().execute("INSERT INTO handoff_proposals(handoff_id,round_id,proposal) VALUES($1,$2,$3) ON CONFLICT(handoff_id) DO UPDATE SET proposal=EXCLUDED.proposal", &[&proposal.id, &proposal.round_id, &data]).await.map_err(failure)?;
        Ok(())
    }
    async fn get_handoff(&self, id: &str) -> Result<Option<HandoffProposal>, ApplicationError> {
        self.client()
            .query_opt(
                "SELECT proposal FROM handoff_proposals WHERE handoff_id=$1",
                &[&id],
            )
            .await
            .map_err(failure)?
            .map(|row| serde_json::from_value(row.get(0)).map_err(failure))
            .transpose()
    }
    async fn list_handoffs(&self) -> Result<Vec<HandoffProposal>, ApplicationError> {
        self.client()
            .query(
                "SELECT proposal FROM handoff_proposals ORDER BY (proposal->>'created_at') DESC",
                &[],
            )
            .await
            .map_err(failure)?
            .into_iter()
            .map(|row| serde_json::from_value(row.get(0)).map_err(failure))
            .collect()
    }
    async fn fence_body(
        &self,
        body: &BodyId,
        until: DateTime<Utc>,
    ) -> Result<(), ApplicationError> {
        self.client().execute("INSERT INTO body_execution_fences(body_id,fenced_until) VALUES($1,$2) ON CONFLICT(body_id) DO UPDATE SET fenced_until=GREATEST(body_execution_fences.fenced_until,EXCLUDED.fenced_until)", &[&body.as_str(), &until]).await.map_err(failure)?;
        Ok(())
    }
    async fn body_fence(&self, body: &BodyId) -> Result<Option<DateTime<Utc>>, ApplicationError> {
        Ok(self
            .client()
            .query_opt(
                "SELECT fenced_until FROM body_execution_fences WHERE body_id=$1",
                &[&body.as_str()],
            )
            .await
            .map_err(failure)?
            .map(|row| row.get(0)))
    }
}
