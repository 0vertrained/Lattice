#![doc = "Authenticated Lattice-to-ROS bridge; only verified navigation reaches the local socket."]

use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use lattice_application::{HeartbeatRequest, RegisterBodyRequest};
use lattice_domain::{
    BatteryPercent, BodyId, BodyKind, BodyStatus, Capability, CommandResult, CommandResultStatus,
    InspectionEvidence, SignedCommand, SkillCommand, VerificationKey,
};
use lattice_ros2_body::{GatewayState, verify_navigation};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use std::{collections::BTreeSet, env, fs, path::Path, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

type Error = Box<dyn std::error::Error + Send + Sync>;

async fn local(socket: &str, request: &impl serde::Serialize) -> Result<GatewayState, Error> {
    tokio::time::timeout(Duration::from_millis(800), async {
        let mut stream = UnixStream::connect(socket).await?;
        let mut bytes = serde_json::to_vec(request)?;
        bytes.push(b'\n');
        stream.write_all(&bytes).await?;
        let mut response = String::new();
        BufReader::new(stream.take(16_384))
            .read_line(&mut response)
            .await?;
        Ok(serde_json::from_str(&response)?)
    })
    .await?
}

fn response_epoch(response: &reqwest::Response) -> Result<&str, Error> {
    let epoch = response
        .headers()
        .get("x-lattice-core-epoch")
        .ok_or("core epoch missing; refusing motion lease")?
        .to_str()?;
    if epoch.is_empty() || epoch.len() > 64 {
        return Err("invalid core epoch".into());
    }
    Ok(epoch)
}

async fn report(
    client: &Client,
    url: &str,
    command: &SignedCommand,
    status: CommandResultStatus,
    state: &GatewayState,
    evidence: Option<InspectionEvidence>,
) -> Result<(), Error> {
    let result = CommandResult {
        evidence,
        command_id: command.envelope.command_id.clone(),
        body_id: command.envelope.body_id.clone(),
        status,
        progress_pct: state.progress_pct.min(100),
        detail: Some(state.detail.clone()),
        reported_at: Utc::now(),
    };
    client
        .post(format!(
            "{url}/v1/missions/{}/commands/{}/result",
            command.envelope.mission_id, command.envelope.command_id
        ))
        .json(&result)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn inspect(socket: String, command: SignedCommand) -> Result<InspectionEvidence, Error> {
    let id = command.envelope.command_id.to_string();
    let expected_file = format!("{id}.ppm");
    let mut capture = None;
    for _ in 0..12 {
        let state = local(&socket, &json!({"op":"capture", "command_id":id})).await?;
        if state.ok {
            capture = Some(state);
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let state = capture.ok_or("fresh post-arrival camera frame unavailable")?;
    if state.capture_file.as_deref() != Some(&expected_file) {
        return Err("capture identity mismatch".into());
    }
    let timestamp = state.capture_unix_ms.ok_or("missing capture timestamp")?;
    if timestamp < command.envelope.issued_at.timestamp_millis()
        || command.envelope.is_expired(Utc::now())
    {
        return Err("capture outside command lifetime".into());
    }
    let path = Path::new(&socket)
        .parent()
        .ok_or("invalid socket path")?
        .join(expected_file);
    if fs::metadata(&path)?.len() > 300_000 {
        return Err("camera file too large".into());
    }
    let frame = fs::read(path)?;
    use sha2::{Digest, Sha256};
    let frame_hash = format!("{:x}", Sha256::digest(&frame));
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()?;
    let mut response = client
        .post("http://127.0.0.1:8001/v1/inspections")
        .json(&json!({"image_base64":STANDARD.encode(frame),"captured_at_ms":timestamp}))
        .send()
        .await?
        .error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 64_000 {
            return Err("inference response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let evidence: InspectionEvidence = serde_json::from_slice(&bytes)?;
    if evidence.captured_at_ms != timestamp
        || evidence.frame_sha256 != frame_hash
        || command.envelope.is_expired(Utc::now())
    {
        return Err("inspection exceeded signed deadline or capture mismatch".into());
    }
    Ok(evidence)
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let url = env::var("LATTICE_CORE_URL").unwrap_or_else(|_| "http://localhost:8000".into());
    let device_token = match env::var("LATTICE_DEVICE_TOKEN_FILE") {
        Ok(path) => Some(fs::read_to_string(path)?.trim().to_owned()),
        Err(_) => env::var("LATTICE_DEVICE_TOKEN").ok(),
    };
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(token) = device_token {
        if !token.starts_with("lattice_device_") {
            return Err("invalid device credential".into());
        }
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {token}").parse()?,
        );
    } else {
        let api_key = env::var("LATTICE_DEV_API_KEY")?;
        if api_key.len() < 32 {
            return Err("development key must have at least 32 characters".into());
        }
        headers.insert("x-lattice-api-key", api_key.parse()?);
    }
    let endpoint = reqwest::Url::parse(&url)?;
    if endpoint.scheme() != "https"
        && !matches!(
            endpoint.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]")
        )
    {
        return Err("remote core requires HTTPS".into());
    }
    let body_id =
        BodyId::new(env::var("LATTICE_BODY_ID").unwrap_or_else(|_| "gazebo-rover".into()))?;
    let socket =
        env::var("LATTICE_ROS_SOCKET").unwrap_or_else(|_| "/run/lattice/gateway.sock".into());
    let state_path = env::var("LATTICE_SEQUENCE_FILE")
        .unwrap_or_else(|_| "/var/lib/lattice/sequence.json".into());
    let client = Client::builder()
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(700))
        .build()?;
    let key_response = client
        .get(format!("{url}/v1/security/verification-key"))
        .send()
        .await?
        .error_for_status()?;
    let mut core_epoch = response_epoch(&key_response)?.to_owned();
    let key: VerificationKey = key_response.json().await?;
    let mut highest = match fs::read_to_string(&state_path) {
        Ok(raw) => {
            let saved: Value = serde_json::from_str(&raw)?;
            if saved["public_key"] != key.public_key_base64
                || saved["body_id"] != body_id.to_string()
            {
                return Err("saved sequence belongs to another body or signing key; stop the simulation and explicitly reset its state".into());
            }
            saved["sequence"].as_u64().ok_or("invalid sequence state")?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e.into()),
    };
    local(&socket, &json!({"op":"stop"})).await?;
    client
        .post(format!("{url}/v1/bodies/register"))
        .json(&RegisterBodyRequest {
            id: body_id.clone(),
            display_name: "Gazebo Rover".into(),
            kind: BodyKind::Rover,
            capabilities: BTreeSet::from([Capability::Navigate, Capability::Inspect]),
            adapter_version: env!("CARGO_PKG_VERSION").into(),
        })
        .send()
        .await?
        .error_for_status()?;
    let mut active: Option<SignedCommand> = None;
    let mut pending_report: Option<(
        CommandResultStatus,
        GatewayState,
        Option<InspectionEvidence>,
    )> = None;
    let mut inspection: Option<tokio::task::JoinHandle<Result<InspectionEvidence, Error>>> = None;
    loop {
        let mut state = local(&socket, &json!({"op":"status"})).await?;
        let heartbeat = HeartbeatRequest {
            status: if state.ready {
                BodyStatus::Online
            } else {
                BodyStatus::Faulted
            },
            battery: BatteryPercent::new(100)?,
            location: "warehouse".into(),
            pose: state.pose,
        };
        // Only a successful authenticated round trip renews the local motion lease.
        let heartbeat_result = client
            .post(format!("{url}/v1/bodies/{body_id}/heartbeat"))
            .json(&heartbeat)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status);
        let response = match heartbeat_result {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(%error, "core unavailable; withholding motion lease");
                tokio::time::sleep(Duration::from_millis(300)).await;
                continue;
            }
        };
        let observed_epoch = response_epoch(&response)?;
        if observed_epoch != core_epoch {
            // Even a restart shorter than the watchdog lease must invalidate motion.
            state = local(&socket, &json!({"op":"stop"})).await?;
            if let Some(task) = inspection.take() {
                task.abort();
            }
            active = None;
            pending_report = None;
            core_epoch = observed_epoch.to_owned();
            tracing::warn!("core restarted; previous motion stopped and execution cleared");
        }
        local(&socket, &json!({"op":"lease"})).await?;
        if let (Some(command), Some((status, old_state, evidence))) = (&active, &pending_report) {
            match report(&client, &url, command, *status, old_state, evidence.clone()).await {
                Ok(()) => {
                    active = None;
                    pending_report = None;
                }
                Err(error) => {
                    local(&socket, &json!({"op":"stop"})).await?;
                    tracing::warn!(%error, "terminal acknowledgement pending; motion held");
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    continue;
                }
            }
        }
        if let Some(command) = &active {
            if state.command_id != command.envelope.command_id.to_string() {
                return Err("gateway lost active command; watchdog will stop motion".into());
            }
            let mut status = match state.state.as_str() {
                "succeeded" => CommandResultStatus::Succeeded,
                "failed" | "rejected" => CommandResultStatus::Failed,
                _ => CommandResultStatus::Running,
            };
            let mut evidence = None;
            if status == CommandResultStatus::Succeeded
                && matches!(command.envelope.command, SkillCommand::Inspect { .. })
            {
                if inspection.is_none() {
                    inspection = Some(tokio::spawn(inspect(socket.clone(), command.clone())));
                }
                if inspection.as_ref().is_some_and(|task| task.is_finished()) {
                    let task = inspection.take().ok_or("inspection task missing")?;
                    match task.await? {
                        Ok(result) => {
                            if result.detections.is_empty() {
                                status = CommandResultStatus::Failed;
                                state.detail =
                                    "inspection completed: no supported safety marker detected"
                                        .into();
                            } else {
                                state.detail = "inspection completed with camera evidence".into();
                            }
                            evidence = Some(result);
                        }
                        Err(error) => {
                            status = CommandResultStatus::Failed;
                            state.detail = format!("inspection failed: {error}");
                        }
                    }
                } else {
                    status = CommandResultStatus::Running;
                    state.progress_pct = 99;
                    state.detail = "capturing and classifying inspection image".into();
                }
            }
            if let Err(error) =
                report(&client, &url, command, status, &state, evidence.clone()).await
            {
                local(&socket, &json!({"op":"stop"})).await?;
                if status != CommandResultStatus::Running {
                    pending_report = Some((status, state, evidence));
                }
                tracing::warn!(%error, "result acknowledgement failed; motion stopped");
                tokio::time::sleep(Duration::from_millis(300)).await;
                continue;
            }
            if status != CommandResultStatus::Running {
                active = None;
            }
        } else {
            let response = client
                .get(format!("{url}/v1/bodies/{body_id}/commands/next"))
                .send()
                .await
                .and_then(reqwest::Response::error_for_status);
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    local(&socket, &json!({"op":"stop"})).await?;
                    tracing::warn!(%error, "command polling failed; motion stopped");
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    continue;
                }
            };
            if response_epoch(&response)? != core_epoch {
                local(&socket, &json!({"op":"stop"})).await?;
                core_epoch = response_epoch(&response)?.to_owned();
            }
            if response.status() != StatusCode::NO_CONTENT {
                let command: SignedCommand = response.json().await?;
                let goal = match verify_navigation(&command, &key, &body_id, highest, Utc::now()) {
                    Ok(goal) => goal,
                    Err(error) => {
                        tracing::warn!(%error, "command rejected before ROS");
                        continue;
                    }
                };
                highest = command.envelope.sequence;
                let parent = Path::new(&state_path)
                    .parent()
                    .ok_or("sequence path requires a parent directory")?;
                fs::create_dir_all(parent)?;
                let temporary = format!("{state_path}.tmp");
                let mut file = fs::File::create(&temporary)?;
                serde_json::to_writer(
                    &mut file,
                    &json!({"body_id":body_id,"public_key":key.public_key_base64,"sequence":highest}),
                )?;
                file.sync_all()?;
                fs::rename(&temporary, &state_path)?;
                fs::File::open(parent)?.sync_all()?;
                let state = local(&socket, &goal).await?;
                if state.ok {
                    active = Some(command);
                } else {
                    report(
                        &client,
                        &url,
                        &command,
                        CommandResultStatus::Rejected,
                        &state,
                        None,
                    )
                    .await?;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}
