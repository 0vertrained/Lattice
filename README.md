# Lattice

**One intelligence. Many bodies.**

Lattice is a simulation-first, security-first embodiment control plane. Its goal is to keep identity, memory, planning and mission continuity centralized while interchangeable simulated or physical bodies execute bounded capabilities.

The current demo completes one approved warehouse objective across two Gazebo rovers. Rover A inspects the bay, then stops for a reviewed handoff. Rover B verifies A's retained camera evidence, completes the three remaining steps, records a missing-marker anomaly and returns to charge. The measured run finished in 141.039 seconds without repeating the completed inspection. A separate single-rover recording demonstrates recovery after a core restart. See [validation](docs/VALIDATION.md) for the evidence behind each release.

- **Rust modular monolith** for the trusted control plane
- **React + TypeScript + Vite** for the operator product
- **TanStack Query** for authoritative server state
- **Backend approval** bound to immutable proposal digests
- **React Three Fiber** for the digital-twin viewport
- **C++ / ROS 2** behind a local gateway
- **Python / scikit-learn / OpenCV** for untrusted intent and marker inference
- **Typed, signed, expiring commands** between core and bodies
- **PostgreSQL** for durable mission history and restart recovery; NATS and OpenTelemetry configuration for later deployment work

## Trust boundary

```text
Operator UI / AI model
        |
        | authenticated intent or typed proposal
        v
Lattice Core (Rust)
  - validate
  - authorize
  - select body
  - transition mission state
  - sign expiring command
        |
        | signed typed command
        v
Body Agent / ROS Gateway
  - verify signature
  - reject replay/expiry/wrong body
  - enforce body-local limits
        |
        v
Local Safety Controller
  - watchdog
  - E-stop
  - collision handling
  - manual override
```

No browser, LLM, cloud API, or fleet-level service can publish actuator commands.

## Repository

```text
apps/control-center/           React operator UI and digital twin
crates/lattice-domain/         Pure entities, values, and state machines
crates/lattice-application/    Use cases and infrastructure ports
crates/lattice-infrastructure/ Development adapters and signing
services/lattice-core-api/     Trusted Rust HTTP API
services/lattice-ai-gateway/   Untrusted typed-proposal service
services/lattice-ros2-gateway/ C++ Nav2, camera and local motion gateway
robots/lattice-mock-body/      Signature-verifying mock bodies
robots/lattice-ros2-body/      Signed mission execution through the ROS gateway
proto/                         Versioned cross-language contracts
docs/                          Architecture, security, ADRs, roadmap
infrastructure/                PostgreSQL, NATS, and telemetry config
```

## Start locally

### 1. Configure

```bash
cp .env.example .env
```

Replace `LATTICE_DEV_API_KEY` with at least 32 random characters.

### 2. Run the mock-body stack with Docker Compose

```bash
docker compose --profile ai up --build
```

- Public guided tour: `http://localhost:8080`
- Control Center: `http://localhost:8080/operator.html`
- Core health: `http://localhost:8000/health`
- AI proposal service when enabled: `http://localhost:8100`

This Compose stack uses mock bodies; camera inspections require the warehouse runner below. Enter the development API key in Control Center. It is held in memory only and disappears on page reload.

### 3. Native development

Rust:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
```

Frontend:

```bash
cd apps/control-center
npm ci
npm run check
npm run build
```

Python boundary:

```bash
python -m compileall services/lattice-ai-gateway/app
```

## Full portfolio demo: ROS 2 warehouse and local ML

The navigation adapter connects signed Rust missions to ROS 2 Jazzy, Nav2 and
Gazebo Harmonic, with map-frame telemetry in Control Center. See the
[warehouse demo guide](docs/ROBOTICS_DEMO.md) for setup, the live functional check,
and the local watchdog/stop behavior. Follow the [language and inspection walkthrough](docs/INTELLIGENCE_DEMO.md) for model evaluation, backend approval and camera evidence.

## Guided showcase

Open `http://localhost:5173/` for the public walkthroughs or `/operator.html` for the live operator UI. The two-rover story replays the [recorded handoff](apps/control-center/public/demo/handoff.json), with measured paths and original camera evidence. Record a fresh run with `LATTICE_HANDOFF_SHOWCASE=1 ./scripts/run-durable-multi-warehouse.sh`; see the [multi-rover guide](docs/MULTI_ROBOT_SIM.md).

The separate single-rover restart story is recorded with `LATTICE_SHOWCASE=1 ./scripts/run-durable-warehouse.sh`. That recorder deliberately interrupts its own local core and explicitly approves recovery; see [SHOWCASE.md](docs/SHOWCASE.md).

## Shared memory and reviewed handoff

The PostgreSQL core now retains inspection observations across missions and body changes. Operators can retrieve the last positive safety-marker observation at a named station, its source body and timestamps, and its original JPEG with verified hashes. A later no-marker frame remains separate counter-evidence. These are class-at-station observations: the station and observer pose do not identify a unique physical marker or triangulate its position. See [observation memory](docs/OBSERVATION_MEMORY.md).

The handoff workflow pauses and fences the source, then freezes the source and target bodies, completed steps, remaining steps and retained evidence into a review. Approval waits for the source command's expiry window and rechecks the target's readiness. Before submitting a ROS goal, the target retrieves the referenced images, verifies their provenance and hashes, and acknowledges the signed continuation context. This receipt proves receipt and validation of context; it does not imply autonomous reasoning about it.

Run `./scripts/run-durable-multi-warehouse.sh` for two separately namespaced Gazebo rovers with independent localization, motion gates and body agents. Live acceptance recorded 996 poses: Rover A traveled 2.34 m and Rover B 12.93 m. Source motion was observed stopped after 1.453 seconds, with 0.0204 m of reported drift after stopping; approval still waited for the old command's expiry window. These are measurements from one simulator run. The [multi-rover guide](docs/MULTI_ROBOT_SIM.md) describes the launcher. This increment demonstrates continuity between two instances of the same rover type; heterogeneous robot handoff, shared geometric mapping and autonomous planning remain future work.

## Current milestone

The executable foundation provides:

- body registration and authenticated heartbeats
- capability-based assignment
- explicit mission state transitions
- Ed25519 command signing
- command expiry, body binding, and sequence numbers
- body-side signature and replay checks
- mission progress and results
- unavailable-body reassignment
- append-only development audit records
- React fleet and mission UI
- immutable proposals with backend-enforced approval
- trained intent classification with held-out evaluation
- camera evidence and a trained safety-marker detector
- live 3D digital-twin viewport
- transactional PostgreSQL approvals, command queues and audit/outbox records
- persistent signing identity and explicit recovery after core restarts
- immutable station observation memory with authenticated source-image retrieval
- frozen handoff reviews and signed, acknowledged continuation context

The implemented demo is described in `docs/INTELLIGENCE_DEMO.md`. Run `./scripts/run-durable-warehouse.sh` for persistent history and operator-reviewed restart recovery; see the [recovery guide](docs/RECOVERY_DEMO.md). OIDC viewer/operator/admin roles, body-scoped revocable credentials, immutable multi-step rounds and revision fencing are implemented. Netlify and Cloud Run deployment configuration is in [HOSTED_DEMO.md](docs/HOSTED_DEMO.md); an authenticated cloud deployment still needs provisioning. The [implementation plan](docs/IMPLEMENTATION_PLAN.md) tracks the remaining world-model, heterogeneous-body, general LLM/VLM planning, SLAM and physical hardware milestones.

## Safety status

This is a secure development foundation, **not a safety-certified robot controller**. Read `docs/SECURITY.md` and `docs/THREAT_MODEL.md` before connecting physical hardware.
