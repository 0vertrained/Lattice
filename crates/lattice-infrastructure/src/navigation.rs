//! Frozen capability route plans share the approval/round/command transaction.
use crate::postgres::{PostgresUnit, failure};
use async_trait::async_trait;
use lattice_application::{ApplicationError, RoutePlanProposal, RoutePlanRepository};

#[async_trait]
impl RoutePlanRepository for PostgresUnit {
    async fn save_route_plan(&self, proposal: RoutePlanProposal) -> Result<(), ApplicationError> {
        let value = serde_json::to_value(&proposal).map_err(failure)?;
        self.client()
            .execute(
                "INSERT INTO route_plan_proposals(route_plan_id,proposal) VALUES($1,$2) \
                 ON CONFLICT(route_plan_id) DO UPDATE SET proposal=EXCLUDED.proposal",
                &[&proposal.id, &value],
            )
            .await
            .map_err(failure)?;
        Ok(())
    }
    async fn get_route_plan(
        &self,
        id: &str,
    ) -> Result<Option<RoutePlanProposal>, ApplicationError> {
        self.client()
            .query_opt(
                "SELECT proposal FROM route_plan_proposals WHERE route_plan_id=$1",
                &[&id],
            )
            .await
            .map_err(failure)?
            .map(|row| serde_json::from_value(row.get(0)).map_err(failure))
            .transpose()
    }
    async fn list_route_plans(&self) -> Result<Vec<RoutePlanProposal>, ApplicationError> {
        self.client()
            .query(
                "SELECT proposal FROM route_plan_proposals ORDER BY (proposal->>'created_at') DESC",
                &[],
            )
            .await
            .map_err(failure)?
            .into_iter()
            .map(|row| serde_json::from_value(row.get(0)).map_err(failure))
            .collect()
    }
}
