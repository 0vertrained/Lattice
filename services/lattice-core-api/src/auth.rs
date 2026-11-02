use crate::api::ApiState;
use axum::{
    body::Body,
    extract::State,
    http::{Method, Request, StatusCode},
    middleware::Next,
    response::Response,
};
use lattice_domain::{AuditActor, BodyId};
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Verified request identity. Device hashes stay internal and never enter responses.
#[derive(Clone)]
pub enum Principal {
    Development,
    Operator {
        subject: String,
        roles: Vec<String>,
    },
    Device {
        id: String,
        body: BodyId,
        hash: String,
    },
}
#[derive(Serialize)]
pub struct Identity {
    pub subject: String,
    pub roles: Vec<String>,
    pub mode: &'static str,
}
impl Principal {
    pub fn actor(&self) -> AuditActor {
        match self {
            Self::Development => AuditActor::Operator("development-user".into()),
            Self::Operator { subject, .. } => AuditActor::Operator(subject.clone()),
            Self::Device { body, .. } => AuditActor::Body(body.to_string()),
        }
    }
    pub fn identity(&self) -> Identity {
        match self {
            Self::Development => Identity {
                subject: "development-user".into(),
                roles: vec!["viewer".into(), "operator".into(), "admin".into()],
                mode: "development",
            },
            Self::Operator { subject, roles } => Identity {
                subject: subject.clone(),
                roles: roles.clone(),
                mode: "oidc",
            },
            Self::Device { id, .. } => Identity {
                subject: id.clone(),
                roles: vec!["device".into()],
                mode: "device",
            },
        }
    }
    pub fn require_body(&self, body: &BodyId) -> Result<(), lattice_application::ApplicationError> {
        if matches!(self, Self::Development)
            || matches!(self,Self::Device{body:own,..} if own==body)
        {
            Ok(())
        } else {
            Err(lattice_application::ApplicationError::Security)
        }
    }
    fn permits(&self, method: &Method, path: &str) -> bool {
        if matches!(self, Self::Development) {
            return true;
        }
        if path == "/auth/me" {
            return method == Method::GET;
        }
        let device_route = path == "/bodies/register"
            || (method == Method::GET
                && path.starts_with("/bodies/")
                && path.contains("/missions/")
                && path.contains("/observations/")
                && path.ends_with("/evidence"))
            || path.ends_with("/heartbeat")
            || path.ends_with("/commands/next")
            || path.ends_with("/result");
        match self {
            Self::Device { .. } => {
                device_route || (path == "/security/verification-key" && method == Method::GET)
            }
            Self::Operator { roles, .. } => {
                if device_route {
                    return false;
                }
                let has = |role: &str| roles.iter().any(|r| r == role);
                if path.starts_with("/devices") {
                    return has("admin");
                }
                if method == Method::GET {
                    return has("viewer") || has("operator") || has("admin");
                }
                has("operator") || has("admin")
            }
            Self::Development => true,
        }
    }
}
pub fn digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
/// Verifies credentials before request processing; authorization is enforced again by body binding.
pub async fn authenticate(
    State(state): State<ApiState>,
    mut request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let principal = if let Some(verifier) = &state.oidc {
        let token = request
            .headers()
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
            .ok_or(StatusCode::UNAUTHORIZED)?;
        if token.starts_with("lattice_device_") {
            if token.len() > 200 {
                return Err(StatusCode::UNAUTHORIZED);
            }
            let hash = digest(token);
            let db = state
                .postgres
                .as_ref()
                .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
            let tx = db
                .begin()
                .await
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
            let (id, body) = tx
                .authenticate_device(&hash)
                .await
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
                .ok_or(StatusCode::UNAUTHORIZED)?;
            tx.finish(true)
                .await
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
            Principal::Device { id, body, hash }
        } else {
            let claims = verifier.verify(token).await?;
            let roles = claims
                .realm_access
                .map(|r| {
                    r.roles
                        .into_iter()
                        .filter_map(|v| {
                            v.strip_prefix("lattice-")
                                .filter(|v| matches!(*v, "viewer" | "operator" | "admin"))
                                .map(str::to_owned)
                        })
                        .collect()
                })
                .unwrap_or_default();
            Principal::Operator {
                subject: claims.sub,
                roles,
            }
        }
    } else {
        let supplied = request
            .headers()
            .get("x-lattice-api-key")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        if state.dev_api_key.is_empty()
            || !constant_time_equal(supplied.as_bytes(), state.dev_api_key.as_bytes())
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        Principal::Development
    };
    let path = request
        .uri()
        .path()
        .strip_prefix("/v1")
        .unwrap_or(request.uri().path());
    if !principal.permits(request.method(), path) {
        return Err(StatusCode::FORBIDDEN);
    }
    request.extensions_mut().insert(principal);
    Ok(next.run(request).await)
}
fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    bool::from(Sha256::digest(left).ct_eq(&Sha256::digest(right)))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn equal_values_match() {
        assert!(constant_time_equal(b"same", b"same"));
    }
    #[test]
    fn different_values_do_not_match() {
        assert!(!constant_time_equal(b"same", b"different"));
    }
    #[test]
    fn roles_do_not_grant_body_impersonation_or_viewer_mutations() {
        let viewer = Principal::Operator {
            subject: "viewer".into(),
            roles: vec!["viewer".into()],
        };
        assert!(viewer.permits(&Method::GET, "/missions"));
        assert!(!viewer.permits(&Method::POST, "/proposals"));
        let admin = Principal::Operator {
            subject: "admin".into(),
            roles: vec!["admin".into()],
        };
        assert!(!admin.permits(&Method::POST, "/bodies/register"));
        assert!(!admin.permits(&Method::GET, "/bodies/rover/commands/next"));
    }
}
