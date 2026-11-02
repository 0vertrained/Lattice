//! Insert-only shared observation storage, bound to the source result transaction.
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use lattice_application::{
    ApplicationError, Observation, ObservationOutcome, ObservationRepository,
    validate_observation_query,
};
use tokio_postgres::Row;

use crate::postgres::{PostgresUnit, failure};

fn decode(row: Row) -> Result<Observation, ApplicationError> {
    serde_json::from_value(row.get(0)).map_err(failure)
}

#[async_trait]
impl ObservationRepository for PostgresUnit {
    async fn insert_observation(&self, observation: Observation) -> Result<bool, ApplicationError> {
        let outcome = match observation.outcome {
            ObservationOutcome::Detected => "detected",
            ObservationOutcome::NotDetected => "not_detected",
        };
        let data = serde_json::to_value(&observation).map_err(failure)?;
        let inserted = self.client().execute(
            "INSERT INTO observations(observation_id, command_id, mission_id, body_id, subject_key, outcome, captured_at, received_at, observation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
            &[&observation.id, &observation.command_id.as_str(), &observation.mission_id.as_str(),
                &observation.body_id.as_str(), &observation.subject_key, &outcome,
                &observation.captured_at, &observation.received_at, &data],
        ).await.map_err(failure)?;
        if inserted == 1 {
            return Ok(true);
        }
        let existing = self
            .client()
            .query_opt(
                "SELECT observation FROM observations WHERE command_id=$1",
                &[&observation.command_id.as_str()],
            )
            .await
            .map_err(failure)?
            .map(decode)
            .transpose()?;
        if existing.as_ref() == Some(&observation) {
            Ok(false)
        } else {
            Err(ApplicationError::Conflict(
                "source command already has a different immutable observation".into(),
            ))
        }
    }

    async fn list_observations(
        &self,
        limit: u32,
        subject: Option<&str>,
    ) -> Result<Vec<Observation>, ApplicationError> {
        validate_observation_query(limit, subject)?;
        self.client().query(
            "SELECT observation FROM observations WHERE ($1::text IS NULL OR subject_key=$1) ORDER BY captured_at DESC, received_at DESC, observation_id DESC LIMIT $2",
            &[&subject, &i64::from(limit)],
        ).await.map_err(failure)?.into_iter().map(decode).collect()
    }

    async fn get_observation(&self, id: &str) -> Result<Option<Observation>, ApplicationError> {
        self.client()
            .query_opt(
                "SELECT observation FROM observations WHERE observation_id=$1",
                &[&id],
            )
            .await
            .map_err(failure)?
            .map(decode)
            .transpose()
    }

    async fn latest_positive(
        &self,
        subject: Option<&str>,
    ) -> Result<Option<Observation>, ApplicationError> {
        validate_observation_query(1, subject)?;
        self.client().query_opt(
            "SELECT observation FROM observations WHERE outcome='detected' AND ($1::text IS NULL OR subject_key=$1) ORDER BY captured_at DESC, received_at DESC, observation_id DESC LIMIT 1",
            &[&subject],
        ).await.map_err(failure)?.map(decode).transpose()
    }

    async fn latest_negative(
        &self,
        subject: &str,
        after: DateTime<Utc>,
    ) -> Result<Option<Observation>, ApplicationError> {
        validate_observation_query(1, Some(subject))?;
        self.client().query_opt(
            "SELECT observation FROM observations WHERE outcome='not_detected' AND subject_key=$1 AND captured_at>$2 ORDER BY captured_at DESC, received_at DESC, observation_id DESC LIMIT 1",
            &[&subject, &after],
        ).await.map_err(failure)?.map(decode).transpose()
    }
}
