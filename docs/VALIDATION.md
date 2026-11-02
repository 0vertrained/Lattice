# Shared observation memory and reviewed handoff — November 2, 2026

The current increment implements immutable PostgreSQL observation memory, source
image retrieval, a frozen handoff review, and a signed continuation context that
the target ROS body verifies and acknowledges before motion. The two-rover
launcher creates separate Gazebo models, sensor namespaces, localization stacks,
motion gates and body agents.

The [recorded live handoff](../apps/control-center/public/demo/handoff.json)
completed a four-step warehouse objective in 141.039 s. Its 996 measured pose
samples report 2.34 m traveled by Rover A and 12.93 m by Rover B. A completed the
bay inspection and retained its positive camera frame. The source was then held;
motion was observed stopped after 1.453 s, with 0.0204 m of reported drift after
stopping. Approval waited for the old signed command's expiry window and occurred
75.261 s into the run.

Rover B fetched A's retained JPEG, verified the signed evidence references and
acknowledged the continuation context before ROS dispatch, recorded at 75.596 s.
B completed the three remaining steps without repeating A's finished inspection:
navigate to the dock, inspect it, and return to charge. The dock inspection
retained a no-marker frame as one anomaly under the reviewed continuation policy.
Both original images remain attributed to their observing bodies. These are
measurements from one Gazebo run, not physical-hardware guarantees.

This handoff run did not restart the core. Observation retention through restart
was verified separately in isolated PostgreSQL and HTTP checks; the earlier
single-rover recording below exercised a live simulator restart.

Confirmed checks for this increment:

- Rust workspace check, build and tests passed. Command serialization remains
  backward compatible; continuation tests reject changed signed targets, and the
  ROS body evidence test rejects image, model and reference mismatches.
- Workspace Clippy with all targets/features and warnings denied passed,
  including the final rerun after the body evidence test was added.
- Five observation unit tests passed.
- The observation integration test passed against an isolated PostgreSQL
  database, covering provenance rejection, duplicate acknowledgements, immutable
  records, rollback, station filtering, later negative counter-evidence and
  retention through recovery.
- The handoff PostgreSQL integration test and the existing PostgreSQL recovery
  integration test passed against isolated databases.
- The handoff HTTP suite passed with scoped JWTs and three distinct device
  identities; the existing recovery HTTP suite also passed. These exercise real
  core processes and isolated databases, but do not drive Gazebo bodies.
- The operator Playwright fixture check passed, including read-only memory access,
  explicit handoff review and approval, expiry/readiness feedback, context-receipt
  display and no horizontal overflow at 390 px. Its API responses are fixtures;
  this is interface validation, not evidence of two moving robots.
- Frontend strict TypeScript, Biome, six Vitest tests, the production build and
  bundle budgets passed. The existing public five-chapter tour passed browser
  checks for map/3D replay, camera image hashes and widths from 320 to 1440 px.
- The new public handoff-story fixture passed browser checks for four chapters,
  map/3D replay, observation queries, no robot API requests and widths of 320,
  390, 768 and 1440 px. Fixture checks are separate from the actual simulator
  recording described above.

- The final production story passed browser checks against the actual recorded
  assets: both body paths, exact completion event, map/3D replay, station queries,
  original JPEG hashes, approval/receipt ordering, four viewport widths and no
  robot API calls. The portfolio retains its existing layout, with working media
  and download links, mobile/dark-mode layouts and JavaScript-disabled content.
  The exported `/lattice/` production build passed the same recorded-asset checks.

Authenticated Cloud Run/Netlify deployment remains unverified.

Observations identify a safety-marker class at a station, not a uniquely tracked
object. Observer poses are timestamped rover poses, not triangulated marker
locations; a later negative frame does not establish absence. Both bodies use
the same rover adapter, so this run establishes same-embodiment continuity rather
than heterogeneous robot handoff. See
[observation semantics](OBSERVATION_MEMORY.md) and the
[two-rover setup](MULTI_ROBOT_SIM.md).

The sections below record earlier releases and their separate validation scopes.

---

# Previous single-rover showcase and hosted identity validation (November 2, 2026)

The checked-in round is a fresh Gazebo/ROS 2/Nav2 run, recorded by
`scripts/record-inspection-round.py`. It completed three reviewed steps in 74.471 s,
with 271 measured poses and a 14.21 m reported path. The bay inspection detected a
marker (score 0.991058); the dock retained a failed inspection with no detection.
The reviewed continuation policy recorded one anomaly and advanced to return.

The recorder killed its own core during real return-leg motion. The previous goal
was observed stopped after 0.341 s, with 0.0176 m reported drift during the next
four seconds. Both camera results and the signing identity survived. No motion
resumed automatically. A fresh recovery proposal/approval completed the round
at the charging station. These are simulator measurements, not hardware guarantees.
The interrupted attempt remains in history.

Checks completed for this increment:

- Rust workspace tests: 17 passed; the isolated PostgreSQL test passed separately.
- Rust formatting and Clippy with warnings denied.
- PostgreSQL transaction cancellation, concurrent approval, sole-writer behavior,
  abrupt process restart, evidence/audit retention, key failures and recovery tests.
- JWT signature, issuer, audience, expiry/future claims and development-key rejection.
- Real Keycloak authorization-code/PKCE sign-in and logout for viewer/operator/admin;
  memory-only browser tokens, server-enforced roles, one-body credentials and revocation.
- Immutable round digests/policies, no-image failures stopping a round, conditional
  no-marker continuation, duplicate-result idempotency, old-revision fencing while
  its process remains alive, and reviewed round recovery through completion.
- Separate-database pg_dump/pg_restore, comparing mission/round/audit counts and
  the retained signing identity. No source database was overwritten.
- Frontend strict TypeScript, Biome, six Vitest tests and production bundle budgets.
- Guided tour chapters, focus, replay/3D switching, four viewport widths, exact JPEG
  hashes and no robot API requests; GitHub Pages subdirectory build also tested.
- Portfolio replay, media/download links, captioned video, light/dark layouts,
  mobile widths and JavaScript-disabled content. Its existing design is retained.
- Cloud Run manifest rendering and deployment-script syntax; Netlify static build.

The public tour initially loads approximately 212 KB of JavaScript; the operator
page loads 368 KB. Three.js loads only when requested (903 KB with the replay scene).
The portfolio's captioned walkthrough is 88.6 s and 1.8 MB. All published camera
frames and route samples are actual recorded simulator outputs. The 3D view is
explicitly labeled as a simplified reconstruction.

Cloud Run/Cloud SQL, Netlify deployment, the remote simulator runner and an external
OIDC issuer remain unverified on hosted infrastructure. No GCP/Netlify deployment
credentials are connected to this workspace. GitHub Pages and hosted CI status
cannot be verified through the active network policy. The recorded showcase uses
a local development identity; hosted-role behavior is tested separately above.

---

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
