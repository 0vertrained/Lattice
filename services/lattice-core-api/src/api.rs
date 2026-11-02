use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use lattice_application::{
    CreateMissionRequest, HeartbeatRequest, LatticeService, RegisterBodyRequest,
};
use lattice_domain::{AuditActor, BodyId, CommandId, CommandResult, MissionId};
use lattice_infrastructure::PostgresPlatform;
use serde::{Deserialize, Serialize};
use tower::ServiceBuilder;
use tower::limit::ConcurrencyLimitLayer;
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::auth::require_api_key;
use crate::config::{AppConfig, ConfigError};
use crate::error::ApiError;

/// Shared transport state.
#[derive(Clone)]
pub struct ApiState {
    postgres: Option<PostgresPlatform>,
    /// Application facade.
    pub service: LatticeService,
    /// Development-only API key.
    pub dev_api_key: Arc<str>,
    /// Internal inference address; never supplied by a request.
    pub ai_gateway_url: Arc<str>,
}

/// Creates the HTTP router.
pub fn router(
    service: LatticeService,
    config: AppConfig,
    postgres: Option<PostgresPlatform>,
    epoch: String,
) -> Result<Router, ConfigError> {
    let state = ApiState {
        postgres,
        service,
        dev_api_key: Arc::from(config.dev_api_key),
        ai_gateway_url: Arc::from(config.ai_gateway_url),
    };

    let origin = HeaderValue::from_str(&config.allowed_origin)
        .map_err(|_| ConfigError::new("LATTICE_ALLOWED_ORIGIN is not a valid header origin"))?;
    let cors = CorsLayer::new()
        .allow_origin(origin)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            HeaderName::from_static("x-lattice-api-key"),
        ]);

    let authenticated = Router::new()
        .route("/bodies", get(list_bodies))
        .route("/bodies/register", post(register_body))
        .route("/bodies/{body_id}/heartbeat", post(heartbeat))
        .route("/bodies/{body_id}/commands/next", get(next_command))
        .route("/missions", get(list_missions))
        .route("/proposals", get(list_proposals).post(create_proposal))
        .route("/proposals/{proposal_id}/approve", post(approve_proposal))
        .route("/missions/reassign", post(reassign))
        .route(
            "/missions/{mission_id}/recovery-proposal",
            post(recovery_proposal),
        )
        .route(
            "/missions/{mission_id}/commands/{command_id}/result",
            post(report_result),
        )
        .route("/security/verification-key", get(verification_key))
        .route("/audit", get(list_audit))
        .route_layer(middleware::from_fn_with_state(state.clone(), unit_of_work))
        // Inference runs outside the serialized database transaction, so it cannot
        // delay body heartbeats. Only freezing the returned proposal opens a unit.
        .route("/proposals/plan", post(plan_proposal).layer(Extension(state.clone())))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_api_key,
        ));

    Ok(Router::new()
        .route("/health", get(health))
        .nest("/v1", authenticated)
        .with_state(state)
        .layer(
            ServiceBuilder::new()
                .layer(SetResponseHeaderLayer::overriding(
                    HeaderName::from_static("x-lattice-core-epoch"),
                    HeaderValue::from_str(&epoch)
                        .map_err(|_| ConfigError::new("invalid core epoch"))?,
                ))
                .layer(SetRequestIdLayer::new(
                    HeaderName::from_static("x-request-id"),
                    MakeRequestUuid,
                ))
                .layer(PropagateRequestIdLayer::new(HeaderName::from_static(
                    "x-request-id",
                )))
                .layer(TraceLayer::new_for_http())
                .layer(ConcurrencyLimitLayer::new(256))
                .layer(RequestBodyLimitLayer::new(64 * 1024))
                .layer(CompressionLayer::new())
                .layer(cors)
                .layer(SetResponseHeaderLayer::if_not_present(
                    axum::http::header::X_CONTENT_TYPE_OPTIONS,
                    HeaderValue::from_static("nosniff"),
                ))
                .layer(SetResponseHeaderLayer::if_not_present(
                    axum::http::header::CACHE_CONTROL,
                    HeaderValue::from_static("no-store"),
                ))
                .layer(TimeoutLayer::with_status_code(
                    StatusCode::REQUEST_TIMEOUT,
                    Duration::from_secs(10),
                )),
        ))
}

// All authenticated use cases, including command dequeue, complete one transaction.
// Error responses and request cancellation roll back. Approval retries are idempotent.
async fn unit_of_work(
    State(mut state): State<ApiState>,
    mut request: axum::extract::Request,
    next: middleware::Next,
) -> Response {
    let tx = match &state.postgres {
        Some(db) => match db.begin().await {
            Ok(tx) => Some(tx),
            Err(e) => return ApiError::from(e).into_response(),
        },
        None => None,
    };
    if let Some(tx) = &tx {
        state.service = state.service.in_transaction(tx.clone());
    }
    request.extensions_mut().insert(state);
    let response = next.run(request).await;
    if let Some(tx) = tx
        && let Err(e) = tx.finish(response.status().is_success()).await
    {
        return ApiError::from(e).into_response();
    }
    response
}

async fn recovery_proposal(
    Extension(state): Extension<ApiState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let id = MissionId::new(id).map_err(lattice_application::ApplicationError::from)?;
    Ok((
        StatusCode::CREATED,
        Json(state.service.propose_recovery(&id).await?),
    ))
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    service: &'static str,
    version: &'static str,
}

async fn health() -> impl IntoResponse {
    Json(Health {
        status: "operational",
        service: "lattice-core-api",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn register_body(
    Extension(state): Extension<ApiState>,
    Json(request): Json<RegisterBodyRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let body = state
        .service
        .register_body(
            request,
            AuditActor::Service("body-registration-api".to_owned()),
        )
        .await?;
    Ok((StatusCode::CREATED, Json(body)))
}

async fn heartbeat(
    Extension(state): Extension<ApiState>,
    Path(body_id): Path<String>,
    Json(request): Json<HeartbeatRequest>,
) -> Result<Json<lattice_domain::BodySnapshot>, ApiError> {
    let body_id = BodyId::new(body_id).map_err(lattice_application::ApplicationError::from)?;
    Ok(Json(state.service.heartbeat(&body_id, request).await?))
}

async fn list_bodies(
    Extension(state): Extension<ApiState>,
) -> Result<Json<Vec<lattice_domain::BodySnapshot>>, ApiError> {
    Ok(Json(state.service.list_bodies().await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanRequest {
    user_intent: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApprovalRequest {
    digest: String,
}

async fn list_proposals(
    Extension(state): Extension<ApiState>,
) -> Result<Json<Vec<lattice_application::Proposal>>, ApiError> {
    Ok(Json(state.service.list_proposals().await?))
}

async fn create_proposal(
    Extension(state): Extension<ApiState>,
    Json(request): Json<CreateMissionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let p = state
        .service
        .propose(lattice_application::ProposalInput {
            user_intent: request.title,
            decision: "ready".into(),
            command: Some(request.command),
            model_id: "manual-v1".into(),
            policy_version: "warehouse-v1".into(),
            confidence: 1.0,
            rationale: "Operator-authored typed proposal; review before approval.".into(),
        })
        .await?;
    Ok((StatusCode::CREATED, Json(p)))
}

async fn plan_proposal(
    Extension(state): Extension<ApiState>,
    Json(request): Json<PlanRequest>,
) -> Result<impl IntoResponse, ApiError> {
    if !(3..=500).contains(&request.user_intent.len()) {
        return Err(lattice_application::ApplicationError::Conflict(
            "invalid intent length".into(),
        )
        .into());
    }
    // The untrusted inference service never receives the development API key.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|_| lattice_application::ApplicationError::Infrastructure)?;
    let response = client
        .post(format!(
            "{}/v1/proposals",
            state.ai_gateway_url.trim_end_matches('/')
        ))
        .json(&serde_json::json!({"user_intent":request.user_intent}))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| lattice_application::ApplicationError::Infrastructure)?;
    // Bound the streamed response even when Content-Length is absent.
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| lattice_application::ApplicationError::Infrastructure)?
    {
        if bytes.len() + chunk.len() > 16_384 {
            return Err(lattice_application::ApplicationError::Infrastructure.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let mut value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| lattice_application::ApplicationError::Infrastructure)?;
    value["user_intent"] = serde_json::Value::String(request.user_intent);
    let input = serde_json::from_value(value)
        .map_err(|_| lattice_application::ApplicationError::Infrastructure)?;
    let tx = match &state.postgres {
        Some(db) => Some(db.begin().await?),
        None => None,
    };
    let service = match &tx {
        Some(tx) => state.service.in_transaction(tx.clone()),
        None => state.service.clone(),
    };
    let proposal = service.propose(input).await?;
    if let Some(tx) = &tx {
        tx.finish(true).await?;
    }
    Ok((StatusCode::CREATED, Json(proposal)))
}

async fn approve_proposal(
    Extension(state): Extension<ApiState>,
    Path(id): Path<String>,
    Json(request): Json<ApprovalRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let mission = state
        .service
        .approve_proposal(
            &id,
            &request.digest,
            AuditActor::Operator("development-user".into()),
        )
        .await?;
    Ok(Json(mission))
}

async fn list_missions(
    Extension(state): Extension<ApiState>,
) -> Result<Json<Vec<lattice_domain::Mission>>, ApiError> {
    Ok(Json(state.service.list_missions().await?))
}

async fn next_command(
    Extension(state): Extension<ApiState>,
    Path(body_id): Path<String>,
) -> Result<Response, ApiError> {
    let body_id = BodyId::new(body_id).map_err(lattice_application::ApplicationError::from)?;
    let command = state.service.next_command(&body_id).await?;
    Ok(match command {
        Some(command) => Json(command).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    })
}

async fn report_result(
    Extension(state): Extension<ApiState>,
    Path((mission_id, command_id)): Path<(String, String)>,
    Json(mut result): Json<CommandResult>,
) -> Result<Json<lattice_domain::Mission>, ApiError> {
    let mission_id =
        MissionId::new(mission_id).map_err(lattice_application::ApplicationError::from)?;
    let path_command_id =
        CommandId::new(command_id).map_err(lattice_application::ApplicationError::from)?;

    if result.command_id != path_command_id {
        return Err(lattice_application::ApplicationError::Conflict(
            "command ID in path and body must match".to_owned(),
        )
        .into());
    }

    result.detail = result.detail.map(|mut detail| {
        detail = detail.chars().take(500).collect();
        detail
    });

    Ok(Json(
        state.service.report_result(&mission_id, result).await?,
    ))
}

async fn reassign(
    Extension(state): Extension<ApiState>,
) -> Result<Json<Vec<lattice_domain::Mission>>, ApiError> {
    Ok(Json(
        state
            .service
            .reassign_unavailable(AuditActor::Operator("development-user".to_owned()))
            .await?,
    ))
}

async fn verification_key(
    Extension(state): Extension<ApiState>,
) -> Result<Json<lattice_domain::VerificationKey>, ApiError> {
    Ok(Json(state.service.verification_key().await?))
}

async fn list_audit(
    Extension(state): Extension<ApiState>,
) -> Result<Json<Vec<lattice_domain::AuditRecord>>, ApiError> {
    Ok(Json(state.service.list_audit().await?))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use lattice_application::ServiceConfig;
    use lattice_infrastructure::{Ed25519CommandSigner, InMemoryPlatform, SystemClock};
    use tower::ServiceExt;
    fn app() -> Router {
        let p = Arc::new(InMemoryPlatform::default());
        let service = LatticeService::new(
            p.clone(),
            p.clone(),
            p.clone(),
            Arc::new(Ed25519CommandSigner::generate_ephemeral("test")),
            p,
            Arc::new(SystemClock),
            ServiceConfig::default(),
        );
        router(
            service,
            AppConfig {
                database_url: None,
                signing_key_file: None,
                bind_address: "127.0.0.1:8000".parse().unwrap(),
                dev_api_key: "a".repeat(32),
                allowed_origin: "http://localhost:5173".into(),
                ai_gateway_url: "http://127.0.0.1:8001".into(),
                command_ttl: Duration::from_secs(30),
                heartbeat_timeout: Duration::from_secs(10),
            },
            None,
            "test-epoch".into(),
        )
        .unwrap()
    }
    #[tokio::test]
    async fn direct_dispatch_and_mutable_approval_payloads_are_rejected() {
        let app = app();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/missions")
                    .header("x-lattice-api-key", "a".repeat(32))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        let response=app.clone().oneshot(Request::builder().method("POST").uri("/v1/proposals/p/approve")
            .header("content-type","application/json").header("x-lattice-api-key","a".repeat(32))
            .body(Body::from(r#"{"digest":"abc","command":{"type":"inspect","location":"inspection_bay"}}"#)).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/proposals")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
