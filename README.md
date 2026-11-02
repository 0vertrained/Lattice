# Lattice

**One intelligence. Many bodies.**

Lattice is a simulation-first, security-first embodiment control plane. Its goal is to keep identity, memory, planning and mission continuity centralized while interchangeable simulated or physical bodies execute bounded capabilities.

The current demo keeps one inspection objective intact when a real simulated barrier blocks its route. A Gazebo rover detects the obstruction, retains its completed inspection and follows a reviewed detour. A staged MuJoCo Go1 then verifies that original image, climbs three physical steps and inspects the upper landing after a separate approved handoff. The recorded objective completed in 113.166 seconds, including the full authorization wait before approving the replacement route. The simulators share semantic coordinates but have separate physics worlds. Earlier capability-route, two-rover handoff and restart stories remain available. See [validation](docs/VALIDATION.md) for the evidence behind each release.

- **Rust modular monolith** for the trusted control plane
- **React + TypeScript + Vite** for the operator product
- **TanStack Query** for authoritative server state
- **Backend approval** bound to immutable proposal digests
- **React Three Fiber** for the digital-twin viewport
- **C++ / ROS 2** behind a local gateway
- **Python / scikit-learn / OpenCV** for untrusted intent and marker inference
- **MuJoCo / NumPy** for torque-driven Go1 locomotion with a pinned pretrained policy
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

Open `http://localhost:5173/` for the public walkthroughs or `/operator.html` for the live operator UI. The adaptive story opens first and replays the [completed barrier-and-detour recording](apps/control-center/public/demo/adaptive-route.json), with the verified laser scan, retained image, reviewed remainder and measured robot paths. Install the Go1 runtime with `./scripts/install-quadruped.sh`, then record a fresh adaptive run with `LATTICE_ADAPTIVE_SHOWCASE=1 ./scripts/run-durable-adaptive-warehouse.sh`; see the [adaptive guide](docs/ADAPTIVE_DEMO.md).

The earlier capability story at `#capability` replays the [direct rover-to-Go1 route](apps/control-center/public/demo/capability-route.json). Record that case with `LATTICE_CAPABILITY_SHOWCASE=1 ./scripts/run-durable-heterogeneous-warehouse.sh`; see the [capability route guide](docs/CAPABILITY_ROUTES.md).

The earlier two-rover story replays the [recorded handoff](apps/control-center/public/demo/handoff.json). Record that scenario with `LATTICE_HANDOFF_SHOWCASE=1 ./scripts/run-durable-multi-warehouse.sh`; see the [multi-rover guide](docs/MULTI_ROBOT_SIM.md).

The separate single-rover restart story is recorded with `LATTICE_SHOWCASE=1 ./scripts/run-durable-warehouse.sh`. That recorder deliberately interrupts its own local core and explicitly approves recovery; see [SHOWCASE.md](docs/SHOWCASE.md).

## Shared memory and reviewed handoff

The PostgreSQL core now retains inspection observations across missions and body changes. Operators can retrieve the last positive safety-marker observation at a named station, its source body and timestamps, and its original JPEG with verified hashes. A later no-marker frame remains separate counter-evidence. These are class-at-station observations: the station and observer pose do not identify a unique physical marker or triangulate its position. See [observation memory](docs/OBSERVATION_MEMORY.md).

The handoff workflow pauses and fences the source, then freezes the source and target bodies, completed steps, remaining steps and retained evidence into a review. Approval waits for the source command's expiry window and rechecks the target's readiness. Before submitting a ROS goal, the target retrieves the referenced images, verifies their provenance and hashes, and acknowledges the signed continuation context. This receipt proves receipt and validation of context; it does not imply autonomous reasoning about it.

Run `./scripts/run-durable-multi-warehouse.sh` for two separately namespaced Gazebo rovers with independent localization, motion gates and body agents. Its earlier acceptance run recorded 996 poses: Rover A traveled 2.34 m and Rover B 12.93 m. Source motion was observed stopped after 1.453 seconds, with 0.0204 m of reported drift after stopping; approval still waited for the old command's expiry window. These are measurements from one simulator run. The [multi-rover guide](docs/MULTI_ROBOT_SIM.md) describes that launcher.

## Capability-aware routes

The bounded semantic planner assigns each route leg to a capable, available body,
minimizes transfers before path distance, and requires replacement bodies already
staged at allowed transfer points. Frozen reviews bind the map revision, geometry,
speed limits, body assignments and destination task. The core holds at a planned
body change; explicit handoff approval and evidence verification precede motion.
Map changes, unavailable targets and missing capabilities fail closed. Held rounds
can be explicitly abandoned while preserving evidence and the source expiry fence.

The [planner evaluation](evaluation/route-planner-2026-11-02.json) matched all 20
expected scenario outcomes. The [Go1 guide](docs/QUADRUPED.md) documents the existing
Walk These Ways policy, CPU inference, physical contact checks and measured
stopping behavior. Shared collision geometry, general autonomous reasoning and
physical hardware remain future work.

## Adaptive mission continuity

An authenticated laser observation can close a semantic route segment while
preserving the trusted map geometry. Lattice holds the affected round and offers
a frozen review of the unfinished work: the completed inspection and original
image remain, while an alternate route replaces the blocked remainder. Approval
waits for the old command's complete authorization window and rechecks the source
position, current conditions and body readiness. A later body change still needs
its own reviewed handoff and evidence acknowledgment.

The [adaptive demo guide](docs/ADAPTIVE_DEMO.md) explains the physical barrier,
west-aisle detour and repeatable mission evaluator. The
[expanded planner evaluation](evaluation/adaptive-planner-2026-11-02.json) covers
30 explicit plan/refusal scenarios. HTTP and PostgreSQL tests separately cover
scoped sensor reports, stale reviews, complete stop fences, retained evidence,
automatic body-loss holds and restart behavior. A body stopped between known
places remains held until its position supports a valid reviewed route.

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
- reviewed semantic routes with staged capability transitions and safe retirement
- heterogeneous rover-to-quadruped execution with measured stair contacts
- revisioned route conditions from authenticated laser observations
- reviewed remaining-work replans that retain completed steps and source evidence
- automatic holds when the active route body becomes unavailable

Run `./scripts/run-durable-adaptive-warehouse.sh` for the route-condition and replan workflow, or `./scripts/run-durable-warehouse.sh` for operator-reviewed restart recovery; see the [recovery guide](docs/RECOVERY_DEMO.md). OIDC viewer/operator/admin roles, body-scoped revocable credentials, immutable multi-step rounds and revision fencing are implemented. Start with the [Netlify and Cloud Run quickstart](docs/HOSTING_QUICKSTART.md) to put the demo online; [HOSTED_DEMO.md](docs/HOSTED_DEMO.md) explains the deployment contract. An authenticated cloud deployment still needs provisioning. The [implementation plan](docs/IMPLEMENTATION_PLAN.md) tracks the remaining world-model, broader heterogeneous-body, general LLM/VLM planning, SLAM and physical hardware milestones.

## Safety status

This is a secure development foundation, **not a safety-certified robot controller**. Read `docs/SECURITY.md` and `docs/THREAT_MODEL.md` before connecting physical hardware.
