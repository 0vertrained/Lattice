# Validation

## PostgreSQL recovery increment — November 2, 2026 (UTC)

`LATTICE_RECOVERY_SMOKE=1 ./scripts/run-durable-warehouse.sh` passed in a real
Gazebo warehouse run. After SIGKILL during measured rover motion, the replacement
core became available after 0.504 s and the old goal was observed stopped after
0.520 s, within the 1.5 s motion lease. Map-frame drift over the next three seconds
was 0.019 m. Both committed camera results survived byte-for-byte. The original
mission stayed held, and reassignment did not resume it. A fresh recovery approval
created a new mission which reached the charging station at (-2.889, -1.919).
These are observations from one simulator run, not hardware timing guarantees.
The [recorded result](../evaluation/recovery-2026-11-02.json) contains the measurements.

Also passed locally:

- Real PostgreSQL integration: cancellation rollback after all approval writes,
  concurrent approvals, sole-writer fencing, key mismatch, recovery holds,
  competing recovery approvals, sequences, audit chain and transactional outbox.
- Real HTTP processes: eight concurrent approvals, abrupt restart, stable signing
  identity, evidence/audit preservation, stale-result isolation, explicit recovery,
  missing/wrong/permissive signing-file rejection, terminal acknowledgement retries.
- Real camera positive and negative inspections in durable mode; marker confidence
  0.995856 on this positive frame. The score retains the synthetic-model limitations.
- Chromium desktop/mobile recovery UI: held mission, frozen command and expiry,
  explicit approval, no execution from opening a review, no overflow or page errors.
- 16 standard Rust tests, formatting and Clippy; the PostgreSQL test ran separately
  (ordinary workspace tests intentionally mark it ignored).
- 6 frontend tests, type checking, lint, build and bundle budgets; C++ motion-gate
  CTest during the ROS build. No model training code changed in this increment.

The runner cleaned up its simulator, body, inference and frontend processes. Its
local PostgreSQL volume and private signing identity remain available for reuse.
The recovery CI job is configured; its hosted result has not been verified here.


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
The portfolio source was subsequently pushed to its publishing branch in commit
`2dffd93`, and the corresponding demo code in Lattice commit `1f06d60`. The managed
environment blocks `0vertrained.github.io` and `api.github.com`; live GitHub Pages
deployment and hosted CI results remain unverified.

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
