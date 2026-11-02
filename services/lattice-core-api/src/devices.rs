//! Administrator credential provisioning with transactional audit and one-time secret return.
use crate::{
    api::ApiState,
    auth::{Principal, digest},
    error::ApiError,
};
use axum::{Extension, Json, extract::Path, http::StatusCode};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{Duration, Utc};
use lattice_application::{ApplicationError, AuditSink};
use lattice_domain::{AuditRecord, BodyId};
use lattice_infrastructure::DeviceCredential;
use rand_core::{OsRng, RngCore};
use serde::Deserialize;
use serde_json::json;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IssueRequest {
    body_id: BodyId,
    label: String,
    expires_in_days: u16,
}
pub async fn list(
    Extension(state): Extension<ApiState>,
) -> Result<Json<Vec<DeviceCredential>>, ApiError> {
    Ok(Json(
        state
            .transaction
            .as_ref()
            .ok_or(ApplicationError::Infrastructure)?
            .list_devices()
            .await?,
    ))
}
pub async fn issue(
    Extension(state): Extension<ApiState>,
    Extension(principal): Extension<Principal>,
    Json(input): Json<IssueRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    if !(1..=90).contains(&input.expires_in_days)
        || !(3..=80).contains(&input.label.len())
        || input.label.chars().any(char::is_control)
    {
        return Err(ApplicationError::Conflict("invalid device credential metadata".into()).into());
    }
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = format!("lattice_device_{}", URL_SAFE_NO_PAD.encode(bytes));
    let now = Utc::now();
    let device = DeviceCredential {
        id: format!("device-{}", uuid::Uuid::new_v4().simple()),
        body_id: input.body_id,
        label: input.label,
        created_at: now,
        expires_at: now + Duration::days(i64::from(input.expires_in_days)),
        revoked_at: None,
    };
    let tx = state
        .transaction
        .as_ref()
        .ok_or(ApplicationError::Infrastructure)?;
    tx.issue_device(&device, &digest(&token)).await?;
    tx.append(AuditRecord {
        occurred_at: now,
        actor: principal.actor(),
        event_type: "device.credential_issued".into(),
        object_id: device.id.clone(),
        metadata: json!({"body_id":device.body_id,"expires_at":device.expires_at}),
    })
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"credential":device,"token":token})),
    ))
}
pub async fn revoke(
    Extension(state): Extension<ApiState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let tx = state
        .transaction
        .as_ref()
        .ok_or(ApplicationError::Infrastructure)?;
    if !tx.revoke_device(&id).await? {
        return Err(ApplicationError::NotFound {
            entity: "device credential",
        }
        .into());
    }
    tx.append(AuditRecord {
        occurred_at: Utc::now(),
        actor: principal.actor(),
        event_type: "device.credential_revoked".into(),
        object_id: id,
        metadata: json!({}),
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
