# Lattice Implementation Plan

## Product thesis

Lattice is an embodiment control plane: identity, memory, planning, world state,
and mission continuity stay centralized while interchangeable bodies expose
bounded capabilities through reviewed adapters.

The product is not one robot. It is the durable software layer that allows one
intelligence to select, inhabit, and hand work between many bodies.

## Technology decisions

| Layer | Choice | Rationale |
|---|---|---|
| Trusted control plane | Rust 1.97.1 | Native performance, memory safety, explicit concurrency |
| Core structure | Modular monolith | Strong boundaries without premature distributed complexity |
| Operator product | React 19 + TypeScript + Vite 8 | Best fit for interactive workflows, extensibility, and 3D UI |
| Server state | TanStack Query v5 | Cache, synchronization, polling, and mutation invalidation |
| Workflow state | XState v5 | Explicit legal UI transitions for approvals and mission flows |
| Digital twin | React Three Fiber + Three.js | Componentized 3D scene integrated with product state |
| Robotics boundary | C++20 + ROS 2 Jazzy | Strong ROS, Nav2, SLAM, and vendor-SDK ecosystem |
| AI and research | Python | ML ecosystem, isolated as proposal-only services |
| Durable database | PostgreSQL | Transactions, optimistic concurrency, audit, future PostGIS |
| Event backbone | NATS JetStream | Durable lightweight events and replay |
| Contracts | Protobuf/gRPC | Typed, versioned, cross-language interfaces |
| Diagnostics | Foxglove/MCAP later | Avoid rebuilding raw ROS visualization |
| Desktop shell | Tauri 2 later | Rust-native permissions and local simulator orchestration |

## Non-negotiable rules

1. Core domain code imports no web, database, NATS, ROS, or manufacturer SDK.
2. A mission requests a capability, not a specific robot model.
3. Every executable command is typed, bounded, signed, sequenced, and expiring.
4. No LLM, browser, or cloud API can directly command actuators.
5. Simulation and physical hardware implement the same body contract.
6. Loss of a body does not destroy mission context.
7. High-risk actions require explicit human approval.
8. Local safety always outranks fleet-level orchestration.
9. Every consequential decision emits an auditable record.
10. Modules split into services only after measured operational need.

---

## Milestone 0 — Secure vertical slice

**Status: implemented in this starter.**

Deliverables:

- Rust domain/application/infrastructure workspace
- capability-based body selection
- explicit mission state machine
- active-command binding to prevent stale result updates
- Ed25519-signed command envelopes
- per-body sequence and hard expiry
- body-side signature, body-ID, sequence, and expiry verification
- mock rover, quadruped, and drone containers
- heartbeat freshness and body reassignment
- append-only development audit records
- React control center
- runtime API validation with Zod
- TanStack Query polling and invalidation
- XState mission review/authorization workflow
- lazy-loaded 3D digital twin
- C++ ROS lifecycle-node scaffold
- typed Python proposal service
- PostgreSQL schema, NATS, and OpenTelemetry configuration

Exit test:

1. Start the stack.
2. Three mock bodies register.
3. Create an `inspect` or `navigate` mission.
4. Lattice assigns the best eligible body and signs the command.
5. The body verifies and executes the command.
6. Progress and completion appear in Control Center.
7. Stop the assigned body, wait past the heartbeat timeout, and reassign work.
8. Mission context survives the embodiment change.

---

## Milestone 1 — Durable core

**Local durability and recovery increment implemented:** PostgreSQL transaction-scoped
repositories, frozen proposals, atomic approval/command/outbox writes, stable local
signing identity, hash-chained audit, persisted sequences and explicit restart recovery.
The robot stops on a changed core epoch and the operator reviews a new mission before
continuing. See [the recovery guide](RECOVERY_DEMO.md) and [validation](VALIDATION.md).

This increment uses a serialized single writer. Optimistic multi-writer updates,
NATS delivery/consumers, remote audit replication, OIDC/mTLS, managed key rotation
and deployment telemetry below remain future work; this milestone is not complete.

Replace development in-memory adapters while preserving the same application ports.

Build:

1. PostgreSQL repositories for bodies, missions, commands, and audit.
2. Optimistic concurrency using entity versions.
3. Transactional outbox in the same transaction as state changes.
4. NATS JetStream publisher and idempotent consumers.
5. Durable per-body command sequences.
6. Hash-chained audit records and remote audit replication.
7. OpenTelemetry traces, metrics, and structured logs.
8. Integration tests using ephemeral PostgreSQL and NATS containers.
9. OIDC for human users and mTLS for services/bodies.
10. Key rotation with overlapping verification windows.

Exit test:

- Core restarts without losing missions, sequences, or audit.
- Outbox replay never duplicates a command.
- A stale command result cannot update a reassigned mission.
- Revoked device identity cannot fetch work.

---

## Milestone 2 — ROS 2 and Gazebo rover

**Navigation increment implemented:** the signed Rust body agent, local C++ Nav2
bridge, Gazebo rover, known warehouse map, pose telemetry and local watchdog are
runnable via `scripts/run-warehouse.sh`. See `ROBOTICS_DEMO.md` for live validation.
The intelligence increment adds RGB camera capture, a trained marker detector, backend-approved language proposals and evidence traces; see `INTELLIGENCE_DEMO.md`. The gRPC body stream, SLAM and physical hardware remain future increments. The current adapter retains authenticated HTTP.

Target stack:

- Ubuntu 24.04
- ROS 2 Jazzy
- Gazebo Harmonic
- Nav2
- SLAM Toolbox
- C++20 lifecycle nodes
- MCAP/rosbag evidence capture

Build:

1. Create a differential-drive URDF/Xacro rover.
2. Publish odometry, TF, laser scan, camera, IMU, and battery state.
3. Implement the gRPC body stream in the local body agent.
4. Verify signed commands before entering ROS.
5. Translate `Navigate` into Nav2 `NavigateToPose`.
6. Translate `Inspect` into navigation plus bounded sensor capture.
7. Add local watchdog, E-stop, and manual-control priority.
8. Enforce local speed, acceleration, geofence, and command expiry.
9. Stream normalized progress/results back to Lattice Core.
10. Record deterministic failure scenarios.

Exit test:

- A mission created in React moves a rover in Gazebo.
- Killing the fleet network stops motion locally.
- Restarting the ROS gateway does not replay stale work.
- The same command model remains unchanged above the adapter.

---

## Milestone 3 — World model and digital twin

Build three distinct representations:

### Geometric state

- maps
- poses
- obstacles
- paths
- traversability
- geofences

### Semantic state

- rooms
- zones
- transfer points
- charging docks
- human-readable destinations

### Observation memory

- object identity
- last-seen location
- confidence
- timestamp
- observing body/sensor/model
- evidence hash and retention policy

Implementation:

1. Add PostGIS.
2. Add semantic location and transfer-point models.
3. Store evidence in S3-compatible object storage, metadata in PostgreSQL.
4. Add object last-seen queries.
5. Add mission and observation replay.
6. Stream normalized body poses to the React digital twin.
7. Move heavy geometry processing to Web Workers.
8. Keep Foxglove for raw ROS topics, point clouds, TF, and MCAP debugging.

Exit test:

- Rover maps a simulated property.
- Lattice answers where an object was last seen with provenance.
- A browser replay reconstructs mission and body state over time.

---

## Milestone 4 — Isaac Sim and synthetic perception

Use Isaac Sim for:

- photorealistic cameras and depth
- LiDAR and IMU simulation
- lighting and material variation
- synthetic perception datasets
- rover, quadruped, drone, and humanoid scenes
- sim-to-real validation

Build:

1. Import the same rover model.
2. Namespace multi-robot ROS topics.
3. Add deterministic scenario seeds.
4. Add domain randomization.
5. Add perception benchmark datasets.
6. Compare Gazebo and Isaac behavior through one Lattice mission contract.

Exit test:

- The same Lattice mission runs unmodified in Gazebo and Isaac Sim.
- Perception regressions are measurable in CI or scheduled simulation runs.

---

## Milestone 5 — Intelligence services

**Local baseline implemented:** supervised intent classification, grounded proposals, immutable backend approval, specialized marker detection, camera evidence and held-out evaluation. General LLM/VLM, speech and retrieval remain future work. See `INTELLIGENCE_DEMO.md`.

Python remains outside the trusted command path.

Build:

- speech-to-text
- text-to-speech
- vision-language observation summaries
- constrained planner output
- memory retrieval
- user intent and permissions
- evidence-aware explanations
- approval UI

Control path:

```text
Natural-language request
        ↓
Untrusted typed proposal
        ↓
Rust schema and policy validation
        ↓
Human approval when required
        ↓
Capability match
        ↓
Signed typed command
        ↓
Body-local safety controller
```

Exit test:

- “Inspect the garage” becomes a reviewable typed plan.
- The model cannot invent a new actuator command.
- Every model/version/evidence reference is auditable.

---

## Milestone 6 — First physical rover

Purchase in this order:

1. RC crawler chassis with low gearing
2. motor controller with encoder feedback
3. physical E-stop circuit
4. Jetson Orin Nano
5. IMU
6. depth camera
7. 2D LiDAR
8. microphone and speaker
9. protected compute enclosure
10. Wi-Fi; optional LTE only later
11. charging dock after core navigation is reliable

Required before movement:

- separate physical-hardware trust root
- TPM 2.0 or secure-element key storage
- signed software update pipeline
- local watchdog and network-loss stop
- manual takeover
- body-specific speed/current/thermal limits
- indoor geofence
- simulation-to-hardware conformance tests

Exit test:

- Recorded simulation missions replay safely on hardware.
- Manual takeover and E-stop always win.
- Simulator and physical rover appear side by side in Lattice.

---

## Milestone 7 — Multi-body handoff

Add in this order:

1. spider/hexapod or small quadruped
2. drone with tightly limited mission types
3. research quadruped
4. humanoid

Canonical demo:

```text
Rover maps downstairs
        ↓
Mission reaches stairs
        ↓
Rover stops at transfer point
        ↓
Quadruped receives mission and evidence
        ↓
Quadruped continues upstairs
        ↓
Both update one world model and audit trail
```

Exit test:

- A mission crosses embodiments without losing context, permissions, evidence, or conversation state.

---

## Milestone 8 — Productization

- multi-user OIDC and fine-grained authorization
- body/service mTLS and certificate revocation
- policy-as-code with tested decision bundles
- plugin SDK and compatibility matrix
- Tauri desktop shell
- simulator process management
- signed adapter marketplace packages
- automated SBOM and provenance
- disaster recovery
- external penetration test
- body-specific hazard analysis and certification strategy

## Definition of “done” for each change

A feature is not complete until it includes:

- domain representation and invariants
- authorization and threat review
- typed contract changes
- simulator behavior
- failure and recovery tests
- audit events
- operator UX
- observability
- documentation and ADR update
