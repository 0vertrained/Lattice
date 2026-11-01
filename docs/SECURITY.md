# Security Architecture

## Fundamental rule

No browser, LLM, cloud API, or fleet-level service can directly command actuators.

## Layers

### Intent

Human requests and AI proposals are untrusted data.

### Policy and mission state

The Rust core validates identity, permissions, skill schema, mission state,
assignment, bounds, and approval requirements.

### Signed command

The core emits an Ed25519-signed envelope containing:

- command ID
- mission ID
- target body ID
- typed skill
- per-body sequence
- issue time
- expiry time

The mission also records the active command ID. A delayed result from an older
body cannot update a reassigned mission.

### Body agent

The body rejects:

- invalid signatures
- a mismatched body ID
- stale or replayed sequences
- expired commands
- unsupported skills
- invalid global or local bounds

### Local safety

The local controller has final authority and must function without the network:

- physical E-stop
- manual override priority
- watchdog
- collision response
- speed and acceleration limits
- geofence
- joint/current/thermal limits
- low-battery behavior
- network-loss stop

## Development authentication

The starter uses a 32+ character shared API key and constant-time hash comparison.
This is intentionally restricted to local development. The browser keeps the key
in memory only.

Before physical deployment:

- issue one X.509 identity per body and service
- use mTLS
- bind authorization to certificate identity
- store private keys in TPM 2.0 or a secure element
- rotate and revoke certificates
- authorize by body, skill, location, speed, and time
- remove shared development keys

## Frontend security

- static Vite build
- same-origin reverse proxy to the Rust API
- restrictive Content Security Policy
- no camera, microphone, geolocation, payment, or USB permissions
- no secrets in local or session storage
- runtime response validation with Zod
- no direct ROS or body network access
- 3D code lazy-loaded outside the login path

## Secrets

- Never commit `.env`, keys, certificates, tokens, or vendor credentials.
- Never expose a signing key to the UI, AI gateway, ROS graph, or logs.
- Redact user context and model prompts from default logs.
- Use separate development, simulation, and physical-hardware trust roots.

## Supply chain

Required CI controls:

- Rust format, Clippy, and tests
- `cargo audit` and `cargo deny`
- TypeScript type checks, Biome, and Vitest
- dependency review and secret scanning
- container scanning
- SBOM generation
- signed images and provenance before release

## Cryptographic migration note

The starter signs a stable JSON representation of a Rust struct. Before protocol
v1 is frozen, signatures move to deterministic Protobuf serialization and include
the contract version in the signed bytes.
