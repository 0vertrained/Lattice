#![doc = "Trusted Lattice HTTP control-plane process."]

mod api;
mod auth;
mod config;
mod devices;
mod error;
mod oidc;

use std::sync::Arc;

use lattice_application::{CommandSigner, LatticeService, ServiceConfig};
use lattice_infrastructure::{
    Ed25519CommandSigner, InMemoryPlatform, PostgresPlatform, SystemClock,
};
use tracing::info;

use crate::config::AppConfig;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_tracing();
    let config = AppConfig::from_env()?;

    let signer = Arc::new(match (&config.signing_key_file, &config.signing_seed) {
        (Some(path), _) => Ed25519CommandSigner::load_file(path)?,
        (_, Some(seed)) => Ed25519CommandSigner::from_base64(seed)?,
        _ => Ed25519CommandSigner::generate_ephemeral("lattice-dev-key-1"),
    });
    let oidc = match &config.oidc {
        Some(c) => Some(crate::oidc::OidcVerifier::new(c.clone()).await?),
        None => None,
    };
    let epoch = uuid::Uuid::new_v4().to_string();
    let postgres = match &config.database_url {
        Some(url) => {
            let db = PostgresPlatform::connect_for_runtime(url, config.allow_takeover).await?;
            db.recover(&signer.verification_key().await?.public_key_base64, &epoch)
                .await?;
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
        if std::fs::metadata(path)?.len() > 65_536 {
            return Err("semantic navigation map exceeds 64 KiB".into());
        }
        let map: lattice_domain::navigation::SemanticMap =
            serde_json::from_slice(&std::fs::read(path)?)?;
        map.validate()?;
        info!(map_id = %map.id, revision = map.revision, digest = %map.digest()?, "trusted semantic navigation map loaded");
        service = service.with_navigation_map(Arc::new(map));
    }

    let app = api::router(service, config.clone(), postgres, epoch, oidc)?;
    let listener = tokio::net::TcpListener::bind(config.bind_address).await?;
    info!(address = %config.bind_address, "Lattice Core listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
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
