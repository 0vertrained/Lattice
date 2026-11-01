# Validation

The generated repository was validated in the artifact environment on July 20, 2026.

## Passed

### Rust workspace

- `cargo check --workspace --all-targets --offline`
- `cargo test --workspace --offline`
- `cargo fmt --all --check`
- all 8 Rust unit tests passed
- `cargo build --workspace --bins --offline`

### End-to-end vertical slice

- started the Rust Core API
- started mock rover, quadruped, and drone bodies
- all three bodies registered and sent heartbeats
- created a typed `inspect` mission through the HTTP API
- Core selected an eligible body
- Core issued an Ed25519-signed, sequenced, expiring command
- the mock body verified and executed the command
- mission reached `succeeded` with 100% progress
- audit contained authorization and successful-result records

### React control center

- strict TypeScript compilation
- Biome lint and format validation
- 4 Vitest tests passed
- Vite production build
- bundle-budget checks passed
- production dependency audit reported 0 vulnerabilities

Measured production bundles:

- initial JavaScript: 350,657 / 400,000 bytes
- lazy digital-twin JavaScript: 882,454 / 950,000 bytes
- application CSS: 6,954 / 20,000 bytes

### Supporting services and configuration

- Python AI gateway bytecode compilation
- JSON parsing
- TOML parsing
- archive integrity

## Not run locally

`cargo clippy` could not run because the sandbox Rust distribution does not include the Clippy component. The GitHub Actions workflow installs Clippy and treats warnings as errors. This is the remaining validation gate to run in CI or on a normal Rust toolchain with Clippy installed.

The ROS 2 C++ gateway is a reviewed scaffold, but it was not compiled because ROS 2 Jazzy is not installed in this environment.
