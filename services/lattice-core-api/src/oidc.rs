//! OIDC access-token verification: pinned issuer/audience, asymmetric keys, bounded cache.
use axum::http::StatusCode;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::Jwk};
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
        verifier.refresh().await.map_err(|error| {
            format!(
                "OIDC signing keys unavailable from {}: {error}",
                verifier.config.jwks_url
            )
        })?;
        Ok(verifier)
    }
    async fn refresh(&self) -> Result<(), KeyFetchError> {
        let mut cache = self.cache.lock().await;
        if cache
            .attempted
            .is_some_and(|t| t.elapsed() < Duration::from_secs(30))
        {
            return Err(KeyFetchError::RateLimited);
        }
        cache.attempted = Some(Instant::now());
        let mut response = self
            .client
            .get(&self.config.jwks_url)
            .send()
            .await
            .map_err(|error| KeyFetchError::Request(chain(&error)))?;
        // Redirects are not followed, so a moved key set arrives here as a 3xx status.
        if !response.status().is_success() {
            return Err(KeyFetchError::Status(response.status()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| KeyFetchError::Request(chain(&error)))?
        {
            if bytes.len() + chunk.len() > 128 * 1024 {
                return Err(KeyFetchError::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        cache.keys = signing_keys(&bytes)?;
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
            self.refresh().await.map_err(|error| match error {
                KeyFetchError::RateLimited => StatusCode::UNAUTHORIZED,
                error => {
                    tracing::warn!(%error, "OIDC signing keys unavailable");
                    StatusCode::SERVICE_UNAVAILABLE
                }
            })?;
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

/// Why the signing keys could not be loaded. Each reason describes the identity provider's public
/// response; none carries a token or a credential.
#[derive(Debug)]
enum KeyFetchError {
    RateLimited,
    Request(String),
    Status(reqwest::StatusCode),
    TooLarge,
    NotKeySet(serde_json::Error),
    NoSigningKeys { published: usize },
}

impl std::fmt::Display for KeyFetchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RateLimited => formatter.write_str("the last attempt was under 30 seconds ago"),
            Self::Request(cause) => write!(formatter, "the request failed: {cause}"),
            Self::Status(status) => write!(formatter, "the server answered HTTP {status}"),
            Self::TooLarge => formatter.write_str("the key set is larger than 128 KiB"),
            Self::NotKeySet(error) => {
                write!(formatter, "the response is not a JSON Web Key Set: {error}")
            }
            Self::NoSigningKeys { published } => write!(
                formatter,
                "none of its {published} keys is an RSA signing key with a key ID"
            ),
        }
    }
}

/// The client's own text ("error sending request") hides the cause, such as a DNS failure, a
/// refused connection, a rejected certificate or a timeout, a few sources down.
fn chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

#[derive(Deserialize)]
struct PublishedKeys {
    keys: Vec<serde_json::Value>,
}

/// Keeps the RSA signing keys that carry a key ID; no symmetric algorithm is ever accepted. A
/// provider can also publish keys this library cannot represent, such as encryption keys on other
/// curves, so each key is read on its own and the ones it cannot read are skipped rather than
/// taking the whole set down with them.
fn signing_keys(body: &[u8]) -> Result<HashMap<String, DecodingKey>, KeyFetchError> {
    let set: PublishedKeys = serde_json::from_slice(body).map_err(KeyFetchError::NotKeySet)?;
    let published = set.keys.len();
    let mut keys = HashMap::new();
    for value in set.keys.into_iter().take(32) {
        let Ok(key) = serde_json::from_value::<Jwk>(value) else {
            continue;
        };
        if let Some(id) = &key.common.key_id
            && matches!(
                key.algorithm,
                jsonwebtoken::jwk::AlgorithmParameters::RSA(_)
            )
            && key
                .common
                .public_key_use
                .as_ref()
                .is_none_or(|u| *u == jsonwebtoken::jwk::PublicKeyUse::Signature)
            && let Ok(decoded) = DecodingKey::from_jwk(&key)
        {
            keys.insert(id.clone(), decoded);
        }
    }
    if keys.is_empty() {
        return Err(KeyFetchError::NoSigningKeys { published });
    }
    Ok(keys)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    // A 2048-bit public modulus; the exponent is 65537.
    const MODULUS: &str = "z18KdShfuE_jdtiLkXwExT4ZQbz8i419aM81woY6EXe27lN208RCiOK0mu55Lh_9PLR-zZ05_I5zOhKygynuyoOWJHVry9eHoaWjG_rkXLKr6ohFiPy_Q23fo26CB7oN8sHz-l7_NFkKvEVUYFlF5qy1c6GelM40SMMlwHUJ6T5b9p1P2C22sVP9JMYBeAHs0OrSlrsBy8EhPmkn0YESPmT571-ySz075a4VStDOkb_tKPwRA416Uihiqcr445XZYfSzJjAQVhhxcPVjZvloVwbqvEFVlEJajkol4KWvRckxTmzEkAriX8VeJ60k6t4wsVEJNHu6PhAIW0sqX3MYUw";

    fn key(fields: serde_json::Value) -> serde_json::Value {
        let mut key = serde_json::json!({"kty": "RSA", "n": MODULUS, "e": "AQAB"});
        key.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        key
    }

    fn set(keys: Vec<serde_json::Value>) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "keys": keys })).unwrap()
    }

    #[test]
    fn keeps_rsa_signing_keys_and_skips_what_it_cannot_use() {
        let body = set(vec![
            key(serde_json::json!({"kid": "enc", "use": "enc", "alg": "RSA-OAEP"})),
            // An Ed448 key: this library has no such curve, so the key cannot be read at all.
            serde_json::json!({"kid": "edwards", "kty": "OKP", "crv": "Ed448", "x": "AAAA", "use": "sig"}),
            serde_json::json!({"kid": "shared", "kty": "oct", "k": "c2VjcmV0", "alg": "HS256"}),
            key(serde_json::json!({"use": "sig", "alg": "RS256"})),
            key(serde_json::json!({"kid": "sig", "use": "sig", "alg": "RS256"})),
            key(serde_json::json!({"kid": "unlabelled"})),
        ]);
        let mut ids: Vec<_> = signing_keys(&body).unwrap().into_keys().collect();
        ids.sort();
        assert_eq!(ids, ["sig", "unlabelled"]);
    }

    #[test]
    fn says_why_no_key_is_usable() {
        let only_encryption = set(vec![key(
            serde_json::json!({"kid": "enc", "use": "enc", "alg": "RSA-OAEP"}),
        )]);
        let error = signing_keys(&only_encryption).err().unwrap();
        assert_eq!(
            error.to_string(),
            "none of its 1 keys is an RSA signing key with a key ID"
        );
        let page = signing_keys(b"<html>Moved</html>").err().unwrap();
        assert!(
            page.to_string()
                .starts_with("the response is not a JSON Web Key Set: ")
        );
        assert_eq!(
            KeyFetchError::Status(reqwest::StatusCode::NOT_FOUND).to_string(),
            "the server answered HTTP 404 Not Found"
        );
    }
}
