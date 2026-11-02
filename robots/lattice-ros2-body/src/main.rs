#![doc = "Authenticated Lattice-to-ROS bridge; only verified navigation reaches the local socket."]

use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use lattice_application::{HeartbeatRequest, Observation, RegisterBodyRequest};
use lattice_domain::{
    BatteryPercent, BodyId, BodyKind, BodyStatus, Capability, CommandResult, CommandResultStatus,
    InspectionEvidence, SignedCommand, SkillCommand, VerificationKey,
};
use lattice_ros2_body::{
    GatewayState,
    route_observation::{ConditionReply, condition_reply},
    verify_navigation_with_capabilities,
};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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
        context_digest: command
            .envelope
            .continuation
            .as_ref()
            .map(|context| context.digest.clone()),
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

#[derive(serde::Deserialize)]
struct RetainedEvidence {
    observation: Observation,
    evidence: InspectionEvidence,
}

// Fetch through the body's mission-scoped endpoint, then verify the exact bytes covered
// by the signed context. Historical imagery is never presented as a new observation.
async fn accept_continuation(
    client: &Client,
    url: &str,
    command: &SignedCommand,
    core_epoch: &str,
) -> Result<(), Error> {
    let Some(context) = &command.envelope.continuation else {
        return Ok(());
    };
    context.validate()?;
    for reference in &context.observations {
        let mut response = client
            .get(format!(
                "{url}/v1/bodies/{}/missions/{}/observations/{}/evidence",
                command.envelope.body_id, command.envelope.mission_id, reference.observation_id
            ))
            .send()
            .await?
            .error_for_status()?;
        if response_epoch(&response)? != core_epoch {
            return Err("core changed while receiving continuation".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > 65_536 {
                return Err("retained evidence exceeds bound".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let retained: RetainedEvidence = serde_json::from_slice(&bytes)?;
        verify_retained(&retained, reference)?;
    }
    // The durable acknowledgement is committed before any ROS goal is submitted.
    let result = CommandResult {
        command_id: command.envelope.command_id.clone(),
        body_id: command.envelope.body_id.clone(),
        status: CommandResultStatus::Running,
        progress_pct: 0,
        detail: Some(format!(
            "Verified {} retained observation images before continuation",
            context.observations.len()
        )),
        reported_at: Utc::now(),
        evidence: None,
        context_digest: Some(context.digest.clone()),
    };
    let response = client
        .post(format!(
            "{url}/v1/missions/{}/commands/{}/result",
            command.envelope.mission_id, command.envelope.command_id
        ))
        .json(&result)
        .send()
        .await?
        .error_for_status()?;
    if response_epoch(&response)? != core_epoch {
        return Err("core changed during context acknowledgement".into());
    }
    let mission: lattice_domain::Mission = response.json().await?;
    if mission.status != lattice_domain::MissionStatus::Running
        || mission.active_command_id.as_ref() != Some(&command.envelope.command_id)
        || mission.assigned_body_id.as_ref() != Some(&command.envelope.body_id)
        || mission.continuation.as_ref() != Some(context)
        || command.envelope.is_expired(Utc::now())
    {
        return Err("continuation acknowledgement is no longer authorized".into());
    }
    tracing::info!(handoff_id=%context.handoff_id, observations=context.observations.len(), "retained images verified and context acknowledged before ROS dispatch");
    Ok(())
}

fn verify_retained(
    retained: &RetainedEvidence,
    reference: &lattice_domain::ObservationReference,
) -> Result<(), Error> {
    let observation = &retained.observation;
    let evidence = &retained.evidence;
    let image = STANDARD.decode(&evidence.image_base64)?;
    if observation.id != reference.observation_id
        || observation.image_sha256 != reference.image_sha256
        || evidence.image_sha256 != reference.image_sha256
        || image.len() > 40_000
        || format!("{:x}", Sha256::digest(&image)) != reference.image_sha256
        || evidence.frame_sha256 != observation.frame_sha256
        || evidence.model_id != observation.model_id
        || evidence.confidence_domain != observation.confidence_domain
        || evidence.captured_at_ms != observation.captured_at.timestamp_millis()
        || evidence.detections != observation.detections
    {
        return Err("retained observation provenance or image hash mismatch".into());
    }
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
    let (body_kind, capabilities) =
        match env::var("LATTICE_BODY_KIND").as_deref().unwrap_or("rover") {
            "rover" => (
                BodyKind::Rover,
                BTreeSet::from([Capability::Navigate, Capability::Inspect]),
            ),
            "quadruped" => (
                BodyKind::Quadruped,
                BTreeSet::from([
                    Capability::Navigate,
                    Capability::Inspect,
                    Capability::Stairs,
                ]),
            ),
            _ => return Err("local body kind must be rover or quadruped".into()),
        };
    let navigation_map: Option<lattice_domain::navigation::SemanticMap> =
        match env::var_os("LATTICE_NAVIGATION_MAP_FILE") {
            Some(path) => {
                if fs::metadata(&path)?.len() > 65_536 {
                    return Err("local route map exceeds 64 KiB".into());
                }
                let map: lattice_domain::navigation::SemanticMap =
                    serde_json::from_slice(&fs::read(path)?)?;
                map.validate()?;
                if map.frame_id != "map" {
                    return Err("local gateway requires the map coordinate frame".into());
                }
                Some(map)
            }
            None => None,
        };
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
            display_name: env::var("LATTICE_BODY_NAME").unwrap_or_else(|_| body_id.to_string()),
            kind: body_kind,
            capabilities: capabilities.clone(),
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
        if let (Some(command), Some(observation), None) =
            (&active, &state.route_observation, &pending_report)
        {
            // The gateway already stopped before exposing this observation.
            // Commit its condition/hold before ordinary terminal reporting; a
            // blockage is retained recoverable work, not a completed failed round.
            local(&socket, &json!({"op":"stop"})).await?;
            let (input, bytes) =
                lattice_ros2_body::route_observation::prepare(observation, command)?;
            let parent = Path::new(&state_path)
                .parent()
                .ok_or("sequence parent missing")?;
            let evidence_path = parent.join(format!("{}-scan.json", input.event_id));
            if evidence_path.exists() {
                if fs::read(&evidence_path)? != bytes {
                    return Err("retained laser record changed".into());
                }
            } else {
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&evidence_path)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                fs::File::open(parent)?.sync_all()?;
            }
            let reply = client
                .post(format!("{url}/v1/bodies/{body_id}/route-conditions"))
                .json(&input)
                .send()
                .await;
            let status = reply.as_ref().ok().map(reqwest::Response::status);
            match condition_reply(status.map(|status| status.as_u16())) {
                ConditionReply::Retained => {
                    tracing::info!(segment = %input.segment_id, event = %input.event_id, "laser condition retained; awaiting reviewed route continuation");
                    active = None;
                }
                ConditionReply::Declined => {
                    // Report the traversal as failed instead of retrying a report the core will
                    // never take; the failure holds the round for a reviewed replan.
                    tracing::warn!(
                        ?status,
                        "core declined the laser condition; reporting the traversal as failed"
                    );
                    let mut failed = state.clone();
                    failed.detail = format!(
                        "{}; the core declined the blockage report ({})",
                        state.detail,
                        status.map_or_else(String::new, |status| status.to_string())
                    );
                    pending_report = Some((CommandResultStatus::Failed, failed, None));
                }
                ConditionReply::Retry => match reply {
                    Ok(response) => {
                        tracing::warn!(status = %response.status(), "route observation acknowledgement pending; motion remains stopped");
                    }
                    Err(error) => {
                        tracing::warn!(%error, "route observation acknowledgement pending; motion remains stopped");
                    }
                },
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
            continue;
        }
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
                let goal = match verify_navigation_with_capabilities(
                    &command,
                    &key,
                    &body_id,
                    highest,
                    Utc::now(),
                    &capabilities,
                ) {
                    Ok(goal) => goal,
                    Err(error) => {
                        tracing::warn!(%error, "command rejected before ROS");
                        continue;
                    }
                };
                if let SkillCommand::TraverseRoute { traversal } = &command.envelope.command {
                    let map = navigation_map
                        .as_ref()
                        .ok_or("local trusted route map is required before traversal")?;
                    traversal.validate_against(map)?;
                }
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
                accept_continuation(&client, &url, &command, &core_epoch).await?;
                // Evidence transfer may take longer than a local motion lease. Renew only
                // after a fresh authenticated heartbeat from the same core epoch.
                if command.envelope.continuation.is_some() {
                    let response = client
                        .post(format!("{url}/v1/bodies/{body_id}/heartbeat"))
                        .json(&heartbeat)
                        .send()
                        .await?
                        .error_for_status()?;
                    if response_epoch(&response)? != core_epoch {
                        return Err("core changed before continuation motion".into());
                    }
                    local(&socket, &json!({"op":"lease"})).await?;
                }
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn retained_image_bytes_and_provenance_must_match_signed_reference() {
        // Transport integrity fixture; no detector or real JPEG claim is made here.
        let bytes = b"retained image fixture";
        let hash = format!("{:x}", Sha256::digest(bytes));
        let evidence: InspectionEvidence = serde_json::from_value(json!({
            "model_id":"fixture-model", "captured_at_ms":0, "frame_sha256":"ab".repeat(32),
            "image_sha256":hash, "image_base64":STANDARD.encode(bytes), "detections":[],
            "confidence_domain":"transport-test"
        }))
        .unwrap();
        let observation: Observation = serde_json::from_value(json!({
            "id":"observation-command-a", "subject_key":"safety-marker:inspection_bay",
            "subject_class":"octagonal_safety_marker", "outcome":"not_detected", "location":"inspection_bay",
            "map_frame":"map", "observer_pose":null, "observer_pose_at":null,
            "mission_id":"mission-a", "command_id":"command-a", "body_id":"rover-a",
            "captured_at":"1970-01-01T00:00:00Z", "received_at":"1970-01-01T00:00:01Z",
            "model_id":"fixture-model", "confidence_domain":"transport-test", "confidence":null,
            "image_sha256":hash, "frame_sha256":"ab".repeat(32), "detections":[]
        })).unwrap();
        let reference = lattice_domain::ObservationReference {
            observation_id: observation.id.clone(),
            image_sha256: hash,
        };
        let mut retained = RetainedEvidence {
            observation,
            evidence,
        };
        verify_retained(&retained, &reference).unwrap();
        retained.evidence.image_base64 = STANDARD.encode(b"changed bytes");
        assert!(verify_retained(&retained, &reference).is_err());
        retained.evidence.image_base64 = STANDARD.encode(bytes);
        retained.evidence.model_id = "different-model".into();
        assert!(verify_retained(&retained, &reference).is_err());
        retained.evidence.model_id = "fixture-model".into();
        retained.observation.id = "observation-unassigned".into();
        assert!(verify_retained(&retained, &reference).is_err());
    }
}
