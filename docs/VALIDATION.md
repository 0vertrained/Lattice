# Validation

## Portfolio demo release — November 2, 2026

The complete fresh-scene `LATTICE_SMOKE=1 ./scripts/run-warehouse.sh` check
passed in the managed cloud environment. Navigation measured 3.299 m of map-frame
displacement; unknown destinations were rejected and the occupied shelf goal
failed. Suspending the body triggered the connection watchdog after 1.56 s and
reconnection did not resume the goal. Language-to-inspection completed with a
real post-arrival camera frame, a detected safety marker and validated image
hashes. The dock inspection failed with an image and no detections. Direct mission
dispatch, changed approvals and approvals of abstentions were rejected; repeated
approval returned the same mission.

Passed local checks:

- 16 Rust tests, formatting, and Clippy with warnings denied.
- 6 frontend tests, TypeScript, Biome, production build and bundle budgets.
- 3 inference API/contract tests, 2 rover-model tests, and the C++ motion-gate test.
- A fixed 36-case language evaluation and 600-crop synthetic vision evaluation;
  [full results and limitations](INTELLIGENCE_DEMO.md).
- Real-browser approval → execution → evidence, clarification, trace download,
  credential clearing, and mobile overflow checks.
- Portfolio replay, local asset/link checks, original JPEG hash verification,
  desktop/mobile layouts, dark mode and JavaScript-disabled fallback.
- Direct Vite process startup/shutdown, avoiding an npm wrapper in runner cleanup.

The public replay contains 91 measured pose samples from a separate 29.2-second
inspection. Its downloadable JPEG matches the recorded image hash. No API key is
included in the public artifacts. The portfolio checkout is `/workspace/Portfolio`.
Source changes and GitHub Actions workflows have been prepared locally; hosted CI
and GitHub Pages publication have not been performed.

## Historical starter validation

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
