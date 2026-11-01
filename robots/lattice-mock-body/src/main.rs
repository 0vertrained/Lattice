#![doc = "Signature-verifying simulated Lattice embodiment."]

use std::collections::BTreeSet;
use std::env;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chrono::Utc;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use lattice_application::{HeartbeatRequest, RegisterBodyRequest};
use lattice_domain::{
    BatteryPercent, BodyId, BodyKind, BodyStatus, Capability, CommandResult, CommandResultStatus,
    SignedCommand, VerificationKey,
};
use reqwest::{Client, StatusCode};
use tracing::{info, warn};

#[derive(Clone)]
struct Config {
    core_url: String,
    api_key: String,
    body_id: BodyId,
    body_name: String,
    body_kind: BodyKind,
    capabilities: BTreeSet<Capability>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .json()
        .init();

    let config = load_config()?;
    let client = Client::builder().timeout(Duration::from_secs(5)).build()?;
    wait_for_core(&client, &config.core_url).await;
    register(&client, &config).await?;
    let verification_key = get_verification_key(&client, &config).await?;
    let public_key = decode_verification_key(&verification_key)?;

    info!(body_id = %config.body_id, "mock body online");
    let mut battery = 100_u8;
    let mut highest_sequence = 0_u64;

    loop {
        heartbeat(&client, &config, battery).await?;

        if let Some(command) = next_command(&client, &config).await? {
            validate_command(&command, &config.body_id, &public_key, highest_sequence)?;
            highest_sequence = command.envelope.sequence;

            report(
                &client,
                &config,
                &command,
                CommandResultStatus::Running,
                10,
                Some("mock controller accepted command"),
            )
            .await?;
            tokio::time::sleep(Duration::from_secs(2)).await;
            battery = battery.saturating_sub(2);
            report(
                &client,
                &config,
                &command,
                CommandResultStatus::Succeeded,
                100,
                Some("mock execution complete"),
            )
            .await?;
        }

        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

fn load_config() -> Result<Config, Box<dyn std::error::Error>> {
    let api_key = env::var("LATTICE_DEV_API_KEY")?;
    if api_key.len() < 32 {
        return Err("LATTICE_DEV_API_KEY must contain at least 32 characters".into());
    }

    Ok(Config {
        core_url: env::var("LATTICE_CORE_URL")
            .unwrap_or_else(|_| "http://localhost:8000".to_owned()),
        api_key,
        body_id: BodyId::new(
            env::var("LATTICE_BODY_ID").unwrap_or_else(|_| "rover-r1".to_owned()),
        )?,
        body_name: env::var("LATTICE_BODY_NAME").unwrap_or_else(|_| "Rover R1".to_owned()),
        body_kind: parse_body_kind(
            &env::var("LATTICE_BODY_KIND").unwrap_or_else(|_| "rover".to_owned()),
        )?,
        capabilities: parse_capabilities(
            &env::var("LATTICE_BODY_CAPABILITIES")
                .unwrap_or_else(|_| "navigate,inspect,follow,carry".to_owned()),
        )?,
    })
}

fn parse_body_kind(value: &str) -> Result<BodyKind, Box<dyn std::error::Error>> {
    match value.trim().to_ascii_lowercase().as_str() {
        "rover" => Ok(BodyKind::Rover),
        "quadruped" => Ok(BodyKind::Quadruped),
        "drone" => Ok(BodyKind::Drone),
        "humanoid" => Ok(BodyKind::Humanoid),
        "spider" => Ok(BodyKind::Spider),
        "simulation" => Ok(BodyKind::Simulation),
        _ => Err("LATTICE_BODY_KIND is unsupported".into()),
    }
}

fn parse_capabilities(value: &str) -> Result<BTreeSet<Capability>, Box<dyn std::error::Error>> {
    let mut capabilities = BTreeSet::new();
    for raw in value.split(',') {
        let capability = match raw.trim().to_ascii_lowercase().as_str() {
            "navigate" => Capability::Navigate,
            "inspect" => Capability::Inspect,
            "follow" => Capability::Follow,
            "carry" => Capability::Carry,
            "stairs" => Capability::Stairs,
            "aerial" => Capability::Aerial,
            "rough_terrain" | "rough-terrain" => Capability::RoughTerrain,
            "" => continue,
            _ => return Err("LATTICE_BODY_CAPABILITIES contains an unsupported value".into()),
        };
        capabilities.insert(capability);
    }
    if capabilities.is_empty() {
        return Err("LATTICE_BODY_CAPABILITIES must not be empty".into());
    }
    Ok(capabilities)
}

async fn wait_for_core(client: &Client, core_url: &str) {
    loop {
        let healthy = match client.get(format!("{core_url}/health")).send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        };
        if healthy {
            return;
        }
        warn!("waiting for Lattice Core");
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn register(client: &Client, config: &Config) -> Result<(), reqwest::Error> {
    let request = RegisterBodyRequest {
        id: config.body_id.clone(),
        display_name: config.body_name.clone(),
        kind: config.body_kind,
        capabilities: config.capabilities.clone(),
        adapter_version: env!("CARGO_PKG_VERSION").to_owned(),
    };

    client
        .post(format!("{}/v1/bodies/register", config.core_url))
        .header("x-lattice-api-key", &config.api_key)
        .json(&request)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn heartbeat(
    client: &Client,
    config: &Config,
    battery: u8,
) -> Result<(), Box<dyn std::error::Error>> {
    let request = HeartbeatRequest {
        status: BodyStatus::Online,
        battery: BatteryPercent::new(battery)?,
        location: "simulation-lab".to_owned(),
    };

    client
        .post(format!(
            "{}/v1/bodies/{}/heartbeat",
            config.core_url, config.body_id
        ))
        .header("x-lattice-api-key", &config.api_key)
        .json(&request)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn get_verification_key(
    client: &Client,
    config: &Config,
) -> Result<VerificationKey, reqwest::Error> {
    client
        .get(format!("{}/v1/security/verification-key", config.core_url))
        .header("x-lattice-api-key", &config.api_key)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
}

async fn next_command(
    client: &Client,
    config: &Config,
) -> Result<Option<SignedCommand>, reqwest::Error> {
    let response = client
        .get(format!(
            "{}/v1/bodies/{}/commands/next",
            config.core_url, config.body_id
        ))
        .header("x-lattice-api-key", &config.api_key)
        .send()
        .await?;

    if response.status() == StatusCode::NO_CONTENT {
        return Ok(None);
    }

    response.error_for_status()?.json().await.map(Some)
}

fn decode_verification_key(
    key: &VerificationKey,
) -> Result<VerifyingKey, Box<dyn std::error::Error>> {
    if key.algorithm != "Ed25519" {
        return Err("unsupported verification algorithm".into());
    }
    let bytes = STANDARD.decode(&key.public_key_base64)?;
    let key_bytes: [u8; 32] = bytes.try_into().map_err(|_| "invalid public key length")?;
    Ok(VerifyingKey::from_bytes(&key_bytes)?)
}

fn validate_command(
    command: &SignedCommand,
    expected_body: &BodyId,
    public_key: &VerifyingKey,
    highest_sequence: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    if &command.envelope.body_id != expected_body {
        return Err("command targets another body".into());
    }
    if command.envelope.is_expired(Utc::now()) {
        return Err("command expired".into());
    }
    if command.envelope.sequence <= highest_sequence {
        return Err("command sequence was replayed or reordered".into());
    }
    command.envelope.command.validate()?;

    let signature_bytes = STANDARD.decode(&command.signature_base64)?;
    let signature = Signature::from_slice(&signature_bytes)?;
    public_key.verify(&command.envelope.signing_bytes()?, &signature)?;
    Ok(())
}

async fn report(
    client: &Client,
    config: &Config,
    command: &SignedCommand,
    status: CommandResultStatus,
    progress_pct: u8,
    detail: Option<&str>,
) -> Result<(), reqwest::Error> {
    let result = CommandResult {
        command_id: command.envelope.command_id.clone(),
        body_id: config.body_id.clone(),
        status,
        progress_pct,
        detail: detail.map(str::to_owned),
        reported_at: Utc::now(),
    };

    client
        .post(format!(
            "{}/v1/missions/{}/commands/{}/result",
            config.core_url, command.envelope.mission_id, command.envelope.command_id
        ))
        .header("x-lattice-api-key", &config.api_key)
        .json(&result)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}
