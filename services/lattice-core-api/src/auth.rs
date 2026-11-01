use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::api::ApiState;

/// Development authentication middleware.
///
/// Physical deployments use certificate-bound mTLS identities rather than this
/// local shared-key mechanism.
pub async fn require_api_key(
    State(state): State<ApiState>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let supplied = request
        .headers()
        .get("x-lattice-api-key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();

    if !constant_time_equal(supplied.as_bytes(), state.dev_api_key.as_bytes()) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(request).await)
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let left_hash = Sha256::digest(left);
    let right_hash = Sha256::digest(right);
    bool::from(left_hash.ct_eq(&right_hash))
}

#[cfg(test)]
mod tests {
    use super::constant_time_equal;

    #[test]
    fn equal_values_match() {
        assert!(constant_time_equal(b"same", b"same"));
    }

    #[test]
    fn different_values_do_not_match() {
        assert!(!constant_time_equal(b"same", b"different"));
    }
}
