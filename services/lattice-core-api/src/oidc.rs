//! OIDC access-token verification: pinned issuer/audience, asymmetric keys, bounded cache.
use axum::http::StatusCode;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct OidcConfig {
    pub issuer: String,
    pub audience: String,
    pub client_id: String,
    pub jwks_url: String,
}
#[derive(Clone)]
pub struct OidcVerifier {
    config: OidcConfig,
    cache: Arc<Mutex<KeyCache>>,
    client: reqwest::Client,
}
struct KeyCache {
    keys: HashMap<String, DecodingKey>,
    fetched: Option<Instant>,
    attempted: Option<Instant>,
}
#[derive(Clone, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: u64,
    pub iat: u64,
    pub realm_access: Option<RealmAccess>,
}
#[derive(Clone, Deserialize)]
pub struct RealmAccess {
    pub roles: Vec<String>,
}
impl OidcVerifier {
    pub async fn new(config: OidcConfig) -> Result<Self, Box<dyn std::error::Error>> {
        let verifier = Self {
            config,
            cache: Arc::new(Mutex::new(KeyCache {
                keys: HashMap::new(),
                fetched: None,
                attempted: None,
            })),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        };
        verifier
            .refresh()
            .await
            .map_err(|_| "OIDC signing keys unavailable")?;
        Ok(verifier)
    }
    async fn refresh(&self) -> Result<(), StatusCode> {
        let mut cache = self.cache.lock().await;
        if cache
            .attempted
            .is_some_and(|t| t.elapsed() < Duration::from_secs(30))
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        cache.attempted = Some(Instant::now());
        let mut response = self
            .client
            .get(&self.config.jwks_url)
            .send()
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
            .error_for_status()
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
        {
            if bytes.len() + chunk.len() > 128 * 1024 {
                return Err(StatusCode::SERVICE_UNAVAILABLE);
            }
            bytes.extend_from_slice(&chunk);
        }
        let set: JwkSet =
            serde_json::from_slice(&bytes).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let mut keys = HashMap::new();
        for key in set.keys.into_iter().take(32) {
            if let Some(id) = &key.common.key_id {
                // Only RSA signing keys are accepted. No symmetric algorithm fallback.
                if matches!(
                    key.algorithm,
                    jsonwebtoken::jwk::AlgorithmParameters::RSA(_)
                ) && key
                    .common
                    .public_key_use
                    .as_ref()
                    .is_none_or(|u| *u == jsonwebtoken::jwk::PublicKeyUse::Signature)
                    && let Ok(decoded) = DecodingKey::from_jwk(&key)
                {
                    keys.insert(id.clone(), decoded);
                }
            }
        }
        if keys.is_empty() {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        cache.keys = keys;
        cache.fetched = Some(Instant::now());
        Ok(())
    }
    pub async fn verify(&self, token: &str) -> Result<Claims, StatusCode> {
        if token.len() > 16_384 {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let header = decode_header(token).map_err(|_| StatusCode::UNAUTHORIZED)?;
        if header.alg != Algorithm::RS256 {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let kid = header.kid.ok_or(StatusCode::UNAUTHORIZED)?;
        let refresh = {
            let c = self.cache.lock().await;
            !c.keys.contains_key(&kid)
                || c.fetched
                    .is_none_or(|t| t.elapsed() > Duration::from_secs(300))
        };
        if refresh {
            self.refresh().await?;
        }
        let key = self
            .cache
            .lock()
            .await
            .keys
            .get(&kid)
            .cloned()
            .ok_or(StatusCode::UNAUTHORIZED)?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.config.issuer]);
        validation.set_audience(&[&self.config.audience]);
        validation.set_required_spec_claims(&["exp", "iat", "iss", "aud", "sub"]);
        validation.validate_nbf = true;
        validation.leeway = 10;
        let claims = decode::<Claims>(token, &key, &validation)
            .map_err(|error| {
                tracing::debug!(kind = ?error.kind(), "OIDC access token rejected");
                StatusCode::UNAUTHORIZED
            })?
            .claims;
        let now = chrono::Utc::now().timestamp().max(0) as u64;
        if claims.sub.is_empty()
            || claims.sub.len() > 256
            || claims.iat > now + 10
            || claims.exp <= claims.iat
            || claims.exp.saturating_sub(claims.iat) > 3600
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        Ok(claims)
    }
}
