use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use lattice_application::{
    CreateMissionRequest, HeartbeatRequest, LatticeService, RegisterBodyRequest,
};
use lattice_domain::{BodyId, CommandId, CommandResult, MissionId};
use lattice_infrastructure::{PostgresPlatform, PostgresUnit};
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

use crate::auth::{Principal, authenticate};
use crate::config::{AppConfig, ConfigError};
use crate::error::ApiError;

/// Shared transport state.
#[derive(Clone)]
pub struct ApiState {
    pub(crate) postgres: Option<PostgresPlatform>,
    pub(crate) transaction: Option<Arc<PostgresUnit>>,
    pub(crate) oidc: Option<crate::oidc::OidcVerifier>,
    oidc_config: Option<crate::oidc::OidcConfig>,
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
    oidc: Option<crate::oidc::OidcVerifier>,
) -> Result<Router, ConfigError> {
    let state = ApiState {
        transaction: None,
        oidc,
        oidc_config: config.oidc.clone(),
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
            axum::http::header::AUTHORIZATION,
            HeaderName::from_static("x-lattice-api-key"),
        ]);

    let authenticated = Router::new()
        .route("/bodies", get(list_bodies))
        .route("/bodies/register", post(register_body))
        .route("/bodies/{body_id}/heartbeat", post(heartbeat))
        .route("/bodies/{body_id}/route-conditions", post(body_route_condition))
        .route("/bodies/{body_id}/commands/next", get(next_command))
        .route("/missions", get(list_missions))
        .route("/rounds", get(list_rounds).post(propose_round))
        .route("/rounds/{id}/approve", post(approve_round))
        .route("/rounds/{id}/transfer-options", get(route_transfer_options))
        .route("/rounds/{id}/abandon", post(abandon_round))
        .route("/rounds/{id}/replan-proposal", post(propose_route_replan))
        .route("/replans", get(list_route_replans))
        .route("/replans/{id}/approve", post(approve_route_replan))
        .route("/navigation/conditions", get(route_conditions).post(report_route_condition))
        .route("/navigation/map", get(navigation_map))
        .route("/navigation/plans", get(list_route_plans).post(propose_route_plan))
        .route("/navigation/plans/{id}/approve", post(approve_route_plan))
        .route("/rounds/{id}/handoff-proposal", post(propose_handoff))
        .route("/handoffs", get(list_handoffs))
        .route("/handoffs/{id}/approve", post(approve_handoff))
        .route("/observations", get(list_observations))
        .route("/observations/last-seen", get(last_seen))
        .route("/observations/{id}/evidence", get(observation_evidence))
        .route("/bodies/{body_id}/missions/{mission_id}/observations/{id}/evidence", get(handoff_evidence))
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
        .route("/auth/me", get(identity))
        .route("/devices", get(crate::devices::list).post(crate::devices::issue))
        .route("/devices/{id}/revoke", post(crate::devices::revoke))
        .route_layer(middleware::from_fn_with_state(state.clone(), unit_of_work))
        // Inference runs outside the serialized database transaction, so it cannot
        // delay body heartbeats. Only freezing the returned proposal opens a unit.
        .route("/proposals/plan", post(plan_proposal).layer(Extension(state.clone())))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            authenticate,
        ));

    Ok(Router::new()
        .route("/health", get(health))
        .route("/ready", get(readiness))
        .route("/v1/auth/config", get(auth_config))
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
        if let Some(Principal::Device { hash, .. }) = request.extensions().get::<Principal>() {
            match tx.authenticate_device(hash).await {
                Ok(Some(_)) => {}
                Ok(None) => return StatusCode::UNAUTHORIZED.into_response(),
                Err(e) => return ApiError::from(e).into_response(),
            }
        }
        state.service = state.service.in_transaction(tx.clone());
        state.transaction = Some(tx.clone());
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RoundRequest {
    steps: Vec<lattice_application::RoundStep>,
}
async fn list_rounds(
    Extension(state): Extension<ApiState>,
) -> Result<Json<Vec<lattice_application::InspectionRound>>, ApiError> {
    Ok(Json(state.service.list_rounds().await?))
}
async fn propose_round(
    Extension(state): Extension<ApiState>,
    Json(input): Json<RoundRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(state.service.propose_round(input.steps).await?),
    ))
}
async fn approve_round(
    Extension(state): Extension<ApiState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(input): Json<ApprovalRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state
            .service
            .approve_round(&id, &input.digest, principal.actor())
            .await?,
    ))
}

async fn identity(Extension(principal): Extension<Principal>) -> Json<crate::auth::Identity> {
    Json(principal.identity())
}

async fn navigation_map(
    Extension(state): Extension<ApiState>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.service.navigation_map()?))
}
async fn route_conditions(
    Extension(state): Extension<ApiState>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.service.route_conditions().await?))
}
async fn report_route_condition(
    Extension(state): Extension<ApiState>,
    Extension(principal): Extension<Principal>,
    Json(input): Json<lattice_application::RouteConditionInput>,
) -> Result<impl IntoResponse, ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(
            state
                .service
                .report_route_condition(input, principal.actor())
                .await?,
        ),
    ))
}
async fn body_route_condition(
    Extension(state): Extension<ApiState>,
    Extension(principal): Extension<Principal>,
    Path(body_id): Path<String>,
    Json(input): Json<lattice_application::RouteConditionInput>,
) -> Result<impl IntoResponse, ApiError> {
    let body_id = BodyId::new(body_id).map_err(lattice_application::ApplicationError::from)?;
    principal.require_body(&body_id)?;
    Ok((
        StatusCode::CREATED,
        Json(
            state
                .service
                .report_body_route_condition(&body_id, input)
                .await?,
        ),
    ))
}
async fn list_route_replans(
    Extension(state): Extension<ApiState>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.service.list_route_replans().await?))
}
async fn propose_route_replan(
    Extension(state): Extension<ApiState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(input): Json<ApprovalRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(
            state
                .service
                .propose_route_replan(&id, &input.digest, principal.actor())
                .await?,
        ),
    ))
}
async fn approve_route_replan(
    Extension(state): Extension<ApiState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(input): Json<ApprovalRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state
            .service
            .approve_route_replan(&id, &input.digest, principal.actor())
            .await?,
    ))
}
async fn list_route_plans(
    Extension(state): Extension<ApiState>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.service.list_route_plans().await?))
}
async fn propose_route_plan(
    Extension(state): Extension<ApiState>,
    Json(input): Json<lattice_application::RouteObjectiveRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(state.service.propose_route_plan(input).await?),
    ))
}
async fn approve_route_plan(
    Extension(state): Extension<ApiState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(input): Json<ApprovalRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state
            .service
            .approve_route_plan(&id, &input.digest, principal.actor())
            .await?,
    ))
}
async fn route_transfer_options(
    Extension(state): Extension<ApiState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.service.route_transfer_options(&id).await?))
}
async fn abandon_round(
    Extension(state): Extension<ApiState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(input): Json<ApprovalRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state
            .service
            .abandon_round(&id, &input.digest, principal.actor())
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ObservationQuery {
    limit: Option<u32>,
    subject: Option<String>,
}
async fn list_observations(
    Extension(state): Extension<ApiState>,
    Query(query): Query<ObservationQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state
            .service
            .observations(query.limit.unwrap_or(20), query.subject.as_deref())
            .await?,
    ))
}
async fn last_seen(
    Extension(state): Extension<ApiState>,
    Query(query): Query<ObservationQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state.service.last_seen(query.subject.as_deref()).await?,
    ))
}
async fn observation_evidence(
    Extension(state): Extension<ApiState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let observation = state.service.observation(&id).await?;
    let evidence = state.service.source_evidence(&observation).await?;
    Ok(Json(evidence))
}
async fn handoff_evidence(
    Extension(state): Extension<ApiState>,
    Extension(principal): Extension<Principal>,
    Path((body_id, mission_id, id)): Path<(String, String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let body_id = BodyId::new(body_id).map_err(lattice_application::ApplicationError::from)?;
    let mission_id =
        MissionId::new(mission_id).map_err(lattice_application::ApplicationError::from)?;
    principal.require_body(&body_id)?;
    let (observation, evidence) = state
        .service
        .handoff_evidence(&body_id, &mission_id, &id)
        .await?;
    Ok(Json(
        serde_json::json!({"observation":observation,"evidence":evidence}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HandoffRequest {
    target_body_id: BodyId,
}
async fn list_handoffs(
    Extension(state): Extension<ApiState>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.service.list_handoffs().await?))
}
async fn propose_handoff(
    Extension(state): Extension<ApiState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(input): Json<HandoffRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(
            state
                .service
                .propose_handoff(&id, input.target_body_id, principal.actor())
                .await?,
        ),
    ))
}
async fn approve_handoff(
    Extension(state): Extension<ApiState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(input): Json<ApprovalRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state
            .service
            .approve_handoff(&id, &input.digest, principal.actor())
            .await?,
    ))
}
async fn auth_config(State(state): State<ApiState>) -> Json<serde_json::Value> {
    Json(match state.oidc_config {
        Some(c) => {
            serde_json::json!({"mode":"oidc","issuer":c.issuer,"client_id":c.client_id,"audience":c.audience,"durable":state.postgres.is_some()})
        }
        None => serde_json::json!({"mode":"development","durable":state.postgres.is_some()}),
    })
}
async fn readiness(State(state): State<ApiState>) -> StatusCode {
    match state.postgres {
        Some(db) => match tokio::time::timeout(Duration::from_secs(2), db.ready()).await {
            Ok(Ok(())) => StatusCode::OK,
            _ => StatusCode::SERVICE_UNAVAILABLE,
        },
        None => StatusCode::OK,
    }
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
    Extension(principal): Extension<Principal>,
    Extension(state): Extension<ApiState>,
    Json(request): Json<RegisterBodyRequest>,
) -> Result<impl IntoResponse, ApiError> {
    principal.require_body(&request.id)?;
    let body = state
        .service
        .register_body(request, principal.actor())
        .await?;
    Ok((StatusCode::CREATED, Json(body)))
}

async fn heartbeat(
    Extension(principal): Extension<Principal>,
    Extension(state): Extension<ApiState>,
    Path(body_id): Path<String>,
    Json(request): Json<HeartbeatRequest>,
) -> Result<Json<lattice_domain::BodySnapshot>, ApiError> {
    let body_id = BodyId::new(body_id).map_err(lattice_application::ApplicationError::from)?;
    principal.require_body(&body_id)?;
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
    Extension(principal): Extension<Principal>,
    Extension(state): Extension<ApiState>,
    Path(id): Path<String>,
    Json(request): Json<ApprovalRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let mission = state
        .service
        .approve_proposal(&id, &request.digest, principal.actor())
        .await?;
    Ok(Json(mission))
}

async fn list_missions(
    Extension(state): Extension<ApiState>,
) -> Result<Json<Vec<lattice_domain::Mission>>, ApiError> {
    Ok(Json(state.service.list_missions().await?))
}

async fn next_command(
    Extension(principal): Extension<Principal>,
    Extension(state): Extension<ApiState>,
    Path(body_id): Path<String>,
) -> Result<Response, ApiError> {
    let body_id = BodyId::new(body_id).map_err(lattice_application::ApplicationError::from)?;
    principal.require_body(&body_id)?;
    let command = state.service.next_command(&body_id).await?;
    Ok(match command {
        Some(command) => Json(command).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    })
}

async fn report_result(
    Extension(principal): Extension<Principal>,
    Extension(state): Extension<ApiState>,
    Path((mission_id, command_id)): Path<(String, String)>,
    Json(mut result): Json<CommandResult>,
) -> Result<Json<lattice_domain::Mission>, ApiError> {
    let mission_id =
        MissionId::new(mission_id).map_err(lattice_application::ApplicationError::from)?;
    let path_command_id =
        CommandId::new(command_id).map_err(lattice_application::ApplicationError::from)?;

    principal.require_body(&result.body_id)?;
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
    Extension(principal): Extension<Principal>,
    Extension(state): Extension<ApiState>,
) -> Result<Json<Vec<lattice_domain::Mission>>, ApiError> {
    Ok(Json(
        state
            .service
            .reassign_unavailable(principal.actor())
            .await?,
    ))
}

async fn verification_key(
    Extension(state): Extension<ApiState>,
) -> Result<Json<lattice_domain::VerificationKey>, ApiError> {
    Ok(Json(state.service.verification_key().await?))
}

/// `limit` asks for the latest records only; without it every record is returned.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AuditQuery {
    limit: Option<usize>,
}

async fn list_audit(
    Extension(state): Extension<ApiState>,
    Query(query): Query<AuditQuery>,
) -> Result<Json<Vec<lattice_application::AuditEntry>>, ApiError> {
    Ok(Json(state.service.audit_ledger(query.limit).await?))
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
        app_on(Arc::new(InMemoryPlatform::default()))
    }
    fn app_on(p: Arc<InMemoryPlatform>) -> Router {
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
                oidc: None,
                signing_seed: None,
                allow_takeover: false,
                database_url: None,
                signing_key_file: None,
                navigation_map_file: None,
                bind_address: "127.0.0.1:8000".parse().unwrap(),
                dev_api_key: "a".repeat(32),
                allowed_origin: "http://localhost:5173".into(),
                ai_gateway_url: "http://127.0.0.1:8001".into(),
                command_ttl: Duration::from_secs(30),
                heartbeat_timeout: Duration::from_secs(10),
            },
            None,
            "test-epoch".into(),
            None,
        )
        .unwrap()
    }
    #[tokio::test]
    async fn the_audit_ledger_returns_rechecked_links_in_bounded_pages() {
        use lattice_application::AuditSink;
        let platform = Arc::new(InMemoryPlatform::default());
        for index in 0..3 {
            platform
                .append(lattice_domain::AuditRecord {
                    occurred_at: chrono::Utc::now(),
                    actor: lattice_domain::AuditActor::Operator("operator-a".into()),
                    event_type: "round.approved".into(),
                    object_id: format!("round-{index}"),
                    metadata: serde_json::json!({}),
                })
                .await
                .unwrap();
        }
        let app = app_on(platform);
        let get = |uri: &'static str| {
            let app = app.clone();
            async move {
                let response = app
                    .oneshot(
                        Request::builder()
                            .uri(uri)
                            .header("x-lattice-api-key", "a".repeat(32))
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                let status = response.status();
                let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                    .await
                    .unwrap();
                (
                    status,
                    serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
                )
            }
        };
        let (status, all) = get("/v1/audit").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(all.as_array().unwrap().len(), 3);
        let (status, page) = get("/v1/audit?limit=2").await;
        assert_eq!(status, StatusCode::OK);
        let page = page.as_array().unwrap();
        assert_eq!(page.len(), 2);
        assert_eq!(page[0]["position"], 2);
        assert_eq!(page[0]["object_id"], "round-1");
        assert_eq!(page[0]["previous_hash"], all[0]["record_hash"]);
        assert!(page.iter().all(|entry| entry["verified"] == true));
        for (uri, expected) in [
            ("/v1/audit?limit=0", StatusCode::UNPROCESSABLE_ENTITY),
            ("/v1/audit?limit=501", StatusCode::UNPROCESSABLE_ENTITY),
            ("/v1/audit?limit=many", StatusCode::BAD_REQUEST),
            ("/v1/audit?offset=2", StatusCode::BAD_REQUEST),
        ] {
            assert_eq!(get(uri).await.0, expected, "{uri}");
        }
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

    #[tokio::test]
    async fn route_reviews_require_authentication_and_immutable_approval_payloads() {
        for (method, path) in [
            ("GET", "/v1/navigation/map"),
            ("GET", "/v1/navigation/plans"),
            ("POST", "/v1/navigation/plans"),
            ("GET", "/v1/rounds/r/transfer-options"),
            ("POST", "/v1/rounds/r/abandon"),
            ("GET", "/v1/navigation/conditions"),
            ("POST", "/v1/navigation/conditions"),
            ("POST", "/v1/bodies/rover/route-conditions"),
            ("POST", "/v1/rounds/r/replan-proposal"),
            ("GET", "/v1/replans"),
        ] {
            let response = app()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        }
        for path in [
            "/v1/navigation/plans/p/approve",
            "/v1/rounds/r/abandon",
            "/v1/rounds/r/replan-proposal",
            "/v1/replans/p/approve",
        ] {
            let response = app()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .header("content-type", "application/json")
                        .header("x-lattice-api-key", "a".repeat(32))
                        .body(Body::from(r#"{"digest":"abc","steps":[]}"#))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "{path}"
            );
        }
    }
}
