use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use lattice_application::ApplicationError;
use serde::Serialize;
use tracing::error;

/// Transport-safe API error.
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

impl From<ApplicationError> for ApiError {
    fn from(error: ApplicationError) -> Self {
        match error {
            ApplicationError::NotFound { .. } => Self {
                status: StatusCode::NOT_FOUND,
                code: "not_found",
                message: "The requested resource was not found.".into(),
            },
            ApplicationError::Conflict(message) => Self {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "invalid_request",
                message: message.chars().take(500).collect(),
            },
            ApplicationError::Domain(_) => Self {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "invalid_request",
                message: "The request conflicts with current state or safety constraints.".into(),
            },
            ApplicationError::Security => Self {
                status: StatusCode::FORBIDDEN,
                code: "security_failure",
                message: "The security operation was rejected.".into(),
            },
            ApplicationError::Infrastructure => {
                error!("infrastructure error returned to API boundary");
                Self {
                    status: StatusCode::SERVICE_UNAVAILABLE,
                    code: "service_unavailable",
                    message: "A required service is temporarily unavailable.".into(),
                }
            }
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                code: self.code,
                message: self.message,
            }),
        )
            .into_response()
    }
}
