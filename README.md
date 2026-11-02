# Lattice

**One intelligence. Many bodies.**

Lattice is a simulation-first, security-first embodiment control plane. A persistent intelligence can assign typed missions to interchangeable simulated or physical bodies while preserving identity, world state, audit history, and mission continuity.

The current demo combines a local trained intent classifier, backend approval, signed commands, real Gazebo navigation and camera-based safety-marker inspection:

- **Rust modular monolith** for the trusted control plane
- **React + TypeScript + Vite** for the operator product
- **TanStack Query** for authoritative server state
- **Backend approval** bound to immutable proposal digests
- **React Three Fiber** for the digital-twin viewport
- **C++ / ROS 2** behind a local gateway
- **Python / scikit-learn / OpenCV** for untrusted intent and marker inference
- **Typed, signed, expiring commands** between core and bodies
- **PostgreSQL, NATS JetStream, and OpenTelemetry** prepared for the durable platform phase

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
robots/lattice-mock-body/      Signature-verifying simulated rover
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

- Control Center: `http://localhost:8080`
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

The implemented demo is described in `docs/INTELLIGENCE_DEMO.md`. Durable core state, per-user/device identities, general LLM/VLM planning, SLAM, and physical hardware remain future milestones.

## Safety status

This is a secure development foundation, **not a safety-certified robot controller**. Read `docs/SECURITY.md` and `docs/THREAT_MODEL.md` before connecting physical hardware.
