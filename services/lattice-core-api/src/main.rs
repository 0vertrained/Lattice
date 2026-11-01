#![doc = "Trusted Lattice HTTP control-plane process."]

mod api;
mod auth;
mod config;
mod error;

use std::sync::Arc;

use lattice_application::{LatticeService, ServiceConfig};
use lattice_infrastructure::{Ed25519CommandSigner, InMemoryPlatform, SystemClock};
use tracing::info;

use crate::config::AppConfig;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_tracing();
    let config = AppConfig::from_env()?;

    let platform = Arc::new(InMemoryPlatform::default());
    let service = LatticeService::new(
        platform.clone(),
        platform.clone(),
        platform.clone(),
        Arc::new(Ed25519CommandSigner::generate_ephemeral(
            "lattice-dev-key-1",
        )),
        platform,
        Arc::new(SystemClock),
        ServiceConfig {
            command_ttl: config.command_ttl,
            heartbeat_timeout: config.heartbeat_timeout,
        },
    );

    let app = api::router(service, config.clone())?;
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
