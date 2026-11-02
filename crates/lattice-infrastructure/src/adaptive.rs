//! Live route conditions are append-only and share the command/round transaction.
use crate::postgres::{PostgresUnit, failure};
use async_trait::async_trait;
use lattice_application::{
    AdaptiveRouteRepository, ApplicationError, RouteConditionObservation, RouteReplanProposal,
};

#[async_trait]
impl AdaptiveRouteRepository for PostgresUnit {
    async fn append_route_condition(
        &self,
        row: RouteConditionObservation,
    ) -> Result<(), ApplicationError> {
        let value = serde_json::to_value(&row).map_err(failure)?;
        let revision = i64::try_from(row.revision).map_err(failure)?;
        self.client().execute("INSERT INTO route_condition_observations(observation_id,event_id,revision,observation) VALUES($1,$2,$3,$4)",
            &[&row.id,&row.input.event_id,&revision,&value]).await.map_err(failure)?;
        Ok(())
    }
    async fn route_condition_event(
        &self,
        event_id: &str,
    ) -> Result<Option<RouteConditionObservation>, ApplicationError> {
        self.client()
            .query_opt(
                "SELECT observation FROM route_condition_observations WHERE event_id=$1",
                &[&event_id],
            )
            .await
            .map_err(failure)?
            .map(|row| serde_json::from_value(row.get(0)).map_err(failure))
            .transpose()
    }
    async fn list_route_condition_observations(
        &self,
    ) -> Result<Vec<RouteConditionObservation>, ApplicationError> {
        self.client()
            .query(
                "SELECT observation FROM route_condition_observations ORDER BY revision DESC",
                &[],
            )
            .await
            .map_err(failure)?
            .into_iter()
            .map(|row| serde_json::from_value(row.get(0)).map_err(failure))
            .collect()
    }
    async fn save_route_replan(
        &self,
        proposal: RouteReplanProposal,
    ) -> Result<(), ApplicationError> {
        let value = serde_json::to_value(&proposal).map_err(failure)?;
        self.client().execute("INSERT INTO route_replan_proposals(replan_id,proposal) VALUES($1,$2) ON CONFLICT(replan_id) DO UPDATE SET proposal=EXCLUDED.proposal",
            &[&proposal.id,&value]).await.map_err(failure)?;
        Ok(())
    }
    async fn get_route_replan(
        &self,
        id: &str,
    ) -> Result<Option<RouteReplanProposal>, ApplicationError> {
        self.client()
            .query_opt(
                "SELECT proposal FROM route_replan_proposals WHERE replan_id=$1",
                &[&id],
            )
            .await
            .map_err(failure)?
            .map(|row| serde_json::from_value(row.get(0)).map_err(failure))
            .transpose()
    }
    async fn list_route_replans(&self) -> Result<Vec<RouteReplanProposal>, ApplicationError> {
        self.client().query("SELECT proposal FROM route_replan_proposals ORDER BY (proposal->>'created_at') DESC", &[]).await.map_err(failure)?
            .into_iter().map(|row| serde_json::from_value(row.get(0)).map_err(failure)).collect()
    }
}
