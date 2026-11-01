use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use lattice_application::{
    CreateMissionRequest, HeartbeatRequest, LatticeService, RegisterBodyRequest,
};
use lattice_domain::{AuditActor, BodyId, CommandId, CommandResult, MissionId};
use serde::Serialize;
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
    /// Application facade.
    pub service: LatticeService,
    /// Development-only API key.
    pub dev_api_key: Arc<str>,
}

/// Creates the HTTP router.
pub fn router(service: LatticeService, config: AppConfig) -> Result<Router, ConfigError> {
    let state = ApiState {
        service,
        dev_api_key: Arc::from(config.dev_api_key),
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
        .route("/missions", get(list_missions).post(create_mission))
        .route("/missions/reassign", post(reassign))
        .route(
            "/missions/{mission_id}/commands/{command_id}/result",
            post(report_result),
        )
        .route("/security/verification-key", get(verification_key))
        .route("/audit", get(list_audit))
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
    State(state): State<ApiState>,
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
    State(state): State<ApiState>,
    Path(body_id): Path<String>,
    Json(request): Json<HeartbeatRequest>,
) -> Result<Json<lattice_domain::BodySnapshot>, ApiError> {
    let body_id = BodyId::new(body_id).map_err(lattice_application::ApplicationError::from)?;
    Ok(Json(state.service.heartbeat(&body_id, request).await?))
}

async fn list_bodies(
    State(state): State<ApiState>,
) -> Result<Json<Vec<lattice_domain::BodySnapshot>>, ApiError> {
    Ok(Json(state.service.list_bodies().await?))
}

async fn create_mission(
    State(state): State<ApiState>,
    Json(request): Json<CreateMissionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let mission = state
        .service
        .create_mission(request, AuditActor::Operator("development-user".to_owned()))
        .await?;
    Ok((StatusCode::CREATED, Json(mission)))
}

async fn list_missions(
    State(state): State<ApiState>,
) -> Result<Json<Vec<lattice_domain::Mission>>, ApiError> {
    Ok(Json(state.service.list_missions().await?))
}

async fn next_command(
    State(state): State<ApiState>,
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
    State(state): State<ApiState>,
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
        detail.truncate(500);
        detail
    });

    Ok(Json(
        state.service.report_result(&mission_id, result).await?,
    ))
}

async fn reassign(
    State(state): State<ApiState>,
) -> Result<Json<Vec<lattice_domain::Mission>>, ApiError> {
    Ok(Json(
        state
            .service
            .reassign_unavailable(AuditActor::Operator("development-user".to_owned()))
            .await?,
    ))
}

async fn verification_key(
    State(state): State<ApiState>,
) -> Result<Json<lattice_domain::VerificationKey>, ApiError> {
    Ok(Json(state.service.verification_key().await?))
}

async fn list_audit(
    State(state): State<ApiState>,
) -> Result<Json<Vec<lattice_domain::AuditRecord>>, ApiError> {
    Ok(Json(state.service.list_audit().await?))
}
