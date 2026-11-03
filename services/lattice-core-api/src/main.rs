#![doc = "Trusted Lattice HTTP control-plane process."]

mod api;
mod auth;
mod config;
mod devices;
mod error;
mod oidc;

use std::sync::Arc;

use lattice_application::{ApplicationError, CommandSigner, LatticeService, ServiceConfig};
use lattice_infrastructure::{
    Ed25519CommandSigner, InMemoryPlatform, PostgresPlatform, SystemClock,
};
use tracing::info;

use crate::config::AppConfig;

#[tokio::main]
async fn main() -> std::process::ExitCode {
    init_tracing();
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(reason) => {
            // A host such as Cloud Run reports only that the container stopped or failed its
            // startup probe. This line says which step stopped it; no reason quotes a secret.
            tracing::error!(%reason, "Lattice Core stopped");
            std::process::ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), String> {
    let config = AppConfig::from_env().map_err(|error| format!("configuration: {error}"))?;

    let signer = Arc::new(match (&config.signing_key_file, &config.signing_seed) {
        (Some(path), _) => Ed25519CommandSigner::load_file(path)
            .map_err(|_| format!("signing key: {} could not be loaded", path.display()))?,
        (_, Some(seed)) => Ed25519CommandSigner::from_base64(seed).map_err(|_| {
            "signing key: LATTICE_SIGNING_SEED_BASE64 must be standard base64 of exactly 32 bytes"
                .to_owned()
        })?,
        _ => Ed25519CommandSigner::generate_ephemeral("lattice-dev-key-1"),
    });
    let oidc = match &config.oidc {
        Some(c) => Some(
            crate::oidc::OidcVerifier::new(c.clone())
                .await
                .map_err(|error| format!("identity provider: {error}"))?,
        ),
        None => None,
    };
    let epoch = uuid::Uuid::new_v4().to_string();
    let postgres = match &config.database_url {
        Some(url) => {
            let db = PostgresPlatform::connect_for_runtime(url, config.allow_takeover)
                .await
                .map_err(|error| match error {
                    ApplicationError::Infrastructure => {
                        "database: connection or schema setup failed; the PostgreSQL line \
                         before this one names the cause"
                            .to_owned()
                    }
                    error => format!("database: {error}"),
                })?;
            let public_key = signer
                .verification_key()
                .await
                .map_err(|error| format!("signing key: {error}"))?
                .public_key_base64;
            db.recover(&public_key, &epoch)
                .await
                .map_err(|error| match error {
                    // The database records the key its history was signed with and refuses
                    // any other, whose signatures that history would not verify against.
                    ApplicationError::Security => {
                        "database: its history is signed with a different key than \
                         LATTICE_SIGNING_SEED_BASE64 holds; restore the seed it first started with"
                            .to_owned()
                    }
                    error => format!("database recovery: {error}"),
                })?;
            Some(db)
        }
        None => {
            tracing::warn!("disposable memory mode: mission history is lost on restart");
            None
        }
    };
    let platform = Arc::new(InMemoryPlatform::default());
    let mut service = LatticeService::new(
        platform.clone(),
        platform.clone(),
        platform.clone(),
        signer,
        platform,
        Arc::new(SystemClock),
        ServiceConfig {
            command_ttl: config.command_ttl,
            heartbeat_timeout: config.heartbeat_timeout,
        },
    );

    if let Some(path) = &config.navigation_map_file {
        let map = load_navigation_map(path)
            .map_err(|error| format!("navigation map {}: {error}", path.display()))?;
        info!(map_id = %map.id, revision = map.revision, digest = %map.digest().map_err(|error| error.to_string())?, "trusted semantic navigation map loaded");
        service = service.with_navigation_map(Arc::new(map));
    }

    let monitor_service = service.clone();
    let monitor_db = postgres
        .clone()
        .filter(|_| config.navigation_map_file.is_some());
    let app = api::router(service, config.clone(), postgres, epoch, oidc)
        .map_err(|error| format!("routes: {error}"))?;
    let listener = tokio::net::TcpListener::bind(config.bind_address)
        .await
        .map_err(|error| format!("listening on {}: {error}", config.bind_address))?;
    info!(address = %config.bind_address, "Lattice Core listening");

    // Route availability changes are observed independently of UI reads. Each
    // sweep uses the same transactional writer fencing as an HTTP operation.
    let monitor = monitor_db.map(|db| {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                match db.begin().await {
                    Ok(tx) => {
                        let result = monitor_service
                            .in_transaction(tx.clone())
                            .hold_unavailable_route_work()
                            .await;
                        let committed = tx.finish(result.is_ok()).await;
                        match (result, committed) {
                            (Ok(held), Ok(())) if held > 0 => {
                                info!(held, "unavailable route bodies held for explicit review")
                            }
                            (Ok(_), Ok(())) => {}
                            (Err(error), _) | (_, Err(error)) => {
                                tracing::warn!(%error, "route availability sweep failed closed")
                            }
                        }
                    }
                    Err(error) => {
                        tracing::warn!(%error, "route availability transaction unavailable")
                    }
                }
            }
        })
    });

    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    if let Some(monitor) = monitor {
        monitor.abort();
    }
    result.map_err(|error| format!("serving: {error}"))
}

fn load_navigation_map(
    path: &std::path::Path,
) -> Result<lattice_domain::navigation::SemanticMap, Box<dyn std::error::Error>> {
    if std::fs::metadata(path)?.len() > 65_536 {
        return Err("exceeds 64 KiB".into());
    }
    let map: lattice_domain::navigation::SemanticMap =
        serde_json::from_slice(&std::fs::read(path)?)?;
    map.validate()?;
    Ok(map)
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,lattice=debug"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .with_current_span(true)
        .with_span_list(true)
        .init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "failed to install Ctrl+C handler");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!(%error, "failed to install terminate handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    info!("shutdown signal received");
}
