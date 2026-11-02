use std::env;
use std::net::SocketAddr;
use std::time::Duration;

/// Validated process configuration.
#[derive(Clone)]
pub struct AppConfig {
    /// OIDC is the default; development mode must be explicitly selected.
    pub oidc: Option<crate::oidc::OidcConfig>,
    /// Secret-manager signing seed; never logged.
    pub signing_seed: Option<String>,
    /// Allow a new Cloud Run revision to fence the previous writer.
    pub allow_takeover: bool,
    /// Optional local PostgreSQL connection string; never log this value.
    pub database_url: Option<String>,
    /// Stable local development signing seed (required with PostgreSQL).
    pub signing_key_file: Option<std::path::PathBuf>,
    /// Trusted semantic route map; absent keeps route planning unavailable.
    pub navigation_map_file: Option<std::path::PathBuf>,
    /// Listener address.
    pub bind_address: SocketAddr,
    /// Development-only shared key.
    pub dev_api_key: String,
    /// Exact allowed browser origin.
    pub allowed_origin: String,
    /// Trusted deployment setting for the internal inference adapter.
    pub ai_gateway_url: String,
    /// Signed-command lifetime.
    pub command_ttl: Duration,
    /// Heartbeat freshness window.
    pub heartbeat_timeout: Duration,
}

impl AppConfig {
    /// Loads and validates environment configuration.
    pub fn from_env() -> Result<Self, ConfigError> {
        let bind_address = env::var("LATTICE_BIND_ADDRESS")
            .unwrap_or_else(|_| "0.0.0.0:8000".to_owned())
            .parse()
            .map_err(|_| ConfigError("LATTICE_BIND_ADDRESS is invalid".to_owned()))?;

        let mode = env::var("LATTICE_AUTH_MODE").unwrap_or_else(|_| "oidc".into());
        let (dev_api_key, oidc) = match mode.as_str() {
            "development" => {
                let key = env::var("LATTICE_DEV_API_KEY").map_err(|_| {
                    ConfigError("LATTICE_DEV_API_KEY is required in development mode".into())
                })?;
                if key.len() < 32 {
                    return Err(ConfigError(
                        "development key must contain at least 32 characters".into(),
                    ));
                }
                (key, None)
            }
            "oidc" => {
                let required = |name: &str| {
                    env::var(name)
                        .map_err(|_| ConfigError(format!("{name} is required in OIDC mode")))
                };
                let issuer = required("LATTICE_OIDC_ISSUER")?;
                let jwks_url = required("LATTICE_OIDC_JWKS_URL")?;
                for address in [&issuer, &jwks_url] {
                    let url = reqwest::Url::parse(address)
                        .map_err(|_| ConfigError("invalid OIDC URL".into()))?;
                    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
                    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || url.fragment().is_some()
                    {
                        return Err(ConfigError(
                            "OIDC URLs require HTTPS, except local tests".into(),
                        ));
                    }
                }
                (
                    String::new(),
                    Some(crate::oidc::OidcConfig {
                        issuer,
                        audience: required("LATTICE_OIDC_AUDIENCE")?,
                        client_id: required("LATTICE_OIDC_CLIENT_ID")?,
                        jwks_url,
                    }),
                )
            }
            _ => {
                return Err(ConfigError(
                    "LATTICE_AUTH_MODE must be oidc or development".into(),
                ));
            }
        };

        let allowed_origin = env::var("LATTICE_ALLOWED_ORIGIN")
            .unwrap_or_else(|_| "http://localhost:8080".to_owned());
        if !(allowed_origin.starts_with("http://") || allowed_origin.starts_with("https://")) {
            return Err(ConfigError(
                "LATTICE_ALLOWED_ORIGIN must be an absolute HTTP(S) origin".to_owned(),
            ));
        }

        let database_url = env::var("LATTICE_DATABASE_URL").ok();
        let signing_key_file =
            env::var_os("LATTICE_SIGNING_KEY_FILE").map(std::path::PathBuf::from);
        let signing_seed = env::var("LATTICE_SIGNING_SEED_BASE64").ok();
        if signing_seed.is_some() && signing_key_file.is_some() {
            return Err(ConfigError("select one signing-key source".into()));
        }
        if database_url.is_some() && signing_key_file.is_none() && signing_seed.is_none() {
            return Err(ConfigError(
                "LATTICE_SIGNING_KEY_FILE is required with PostgreSQL".into(),
            ));
        }
        if oidc.is_some() && database_url.is_none() {
            return Err(ConfigError("OIDC mode requires PostgreSQL".into()));
        }
        let allow_takeover = env::var("LATTICE_ALLOW_CORE_TAKEOVER").is_ok_and(|v| v == "1");
        if allow_takeover && oidc.is_none() {
            return Err(ConfigError("core takeover requires OIDC mode".into()));
        }
        Ok(Self {
            oidc,
            signing_seed,
            allow_takeover,
            database_url,
            signing_key_file,
            navigation_map_file: env::var_os("LATTICE_NAVIGATION_MAP_FILE")
                .map(std::path::PathBuf::from),
            bind_address,
            dev_api_key,
            allowed_origin,
            ai_gateway_url: env::var("LATTICE_AI_GATEWAY_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8001".into()),
            command_ttl: parse_seconds("LATTICE_COMMAND_TTL_SECONDS", 30, 5, 300)?,
            heartbeat_timeout: parse_seconds("LATTICE_HEARTBEAT_TIMEOUT_SECONDS", 10, 2, 120)?,
        })
    }
}

fn parse_seconds(
    name: &'static str,
    default: u64,
    minimum: u64,
    maximum: u64,
) -> Result<Duration, ConfigError> {
    let value = match env::var(name) {
        Ok(raw) => raw
            .parse::<u64>()
            .map_err(|_| ConfigError(format!("{name} must be an integer")))?,
        Err(_) => default,
    };

    if !(minimum..=maximum).contains(&value) {
        return Err(ConfigError(format!(
            "{name} must be between {minimum} and {maximum}"
        )));
    }

    Ok(Duration::from_secs(value))
}

/// Startup configuration error.
#[derive(Debug)]
pub struct ConfigError(String);

impl ConfigError {
    /// Creates a startup configuration error.
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}
