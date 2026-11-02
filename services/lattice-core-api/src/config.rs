use std::env;
use std::net::SocketAddr;
use std::time::Duration;

/// Validated process configuration.
#[derive(Debug, Clone)]
pub struct AppConfig {
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

        let dev_api_key = env::var("LATTICE_DEV_API_KEY")
            .map_err(|_| ConfigError("LATTICE_DEV_API_KEY is required".to_owned()))?;
        if dev_api_key.len() < 32 {
            return Err(ConfigError(
                "LATTICE_DEV_API_KEY must contain at least 32 characters".to_owned(),
            ));
        }

        let allowed_origin = env::var("LATTICE_ALLOWED_ORIGIN")
            .unwrap_or_else(|_| "http://localhost:8080".to_owned());
        if !(allowed_origin.starts_with("http://") || allowed_origin.starts_with("https://")) {
            return Err(ConfigError(
                "LATTICE_ALLOWED_ORIGIN must be an absolute HTTP(S) origin".to_owned(),
            ));
        }

        Ok(Self {
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
