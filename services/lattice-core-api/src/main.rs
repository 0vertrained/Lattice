#![doc = "Trusted Lattice HTTP control-plane process."]

mod api;
mod auth;
mod config;
mod error;

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

    let signer = Arc::new(match &config.signing_key_file {
        Some(path) => Ed25519CommandSigner::load_file(path)?,
        None => Ed25519CommandSigner::generate_ephemeral("lattice-dev-key-1"),
    });
    let epoch = uuid::Uuid::new_v4().to_string();
    let postgres = match &config.database_url {
        Some(url) => {
            let db = PostgresPlatform::connect(url).await?;
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
    let service = LatticeService::new(
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

    let app = api::router(service, config.clone(), postgres, epoch)?;
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
