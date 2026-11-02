# Capability routes and heterogeneous continuation — November 2, 2026

The [recorded capability route](../apps/control-center/public/demo/capability-route.json)
completed its four-step objective at **37.369 seconds**. The full recording lasts
41.518 seconds including a physical standing interval after completion. A Gazebo
rover inspected the bay and drove to the transfer point. The staged MuJoCo Go1
received an explicitly approved continuation, verified the retained source JPEG,
climbed three physical 5 cm steps and captured the upper marker. Both observations
were retained, with no anomalies and no repeated source inspection.

The recording contains 332 measured poses and the private proof retains 825
physics samples with full joint positions and velocities. Reported paths were
4.32 m for the rover and 3.57 m for Go1. Source drift after the completed approach
and transfer hold was 0.008 m. The Go1 traversal was observed running at 25.488 s
and succeeded at 35.908 s. Its physics history includes contacts on all three
steps, four loaded feet at completion, maximum tilt 0.1934 radians and maximum
motor torque 21.406 Nm. Navigation-reference height was 0.1805 m; raw base height
was 0.4425 m. The fixed reference offset is documented in [QUADRUPED.md](QUADRUPED.md).

The source-frame SHA-256 is
`de0ba5b51cb9b4494a4ff7dd6a025ffeb20e8870199cdef9173e221726283b1c`;
the upper-frame SHA-256 is
`66c6f9ed94d50a037497be38c5d05c67c1b007f143d8e19d2d0e79598994db36`.
The recorder verifies original JPEG bytes against retained observation hashes.
The visual stair clip reconstructs the same run from measured complete joint
states; it is a new camera rendering of that trace, not a separately filmed run.
Its provenance binds the source proof, map, pinned model/policy, frame range and
video hash. Polling timestamps in the event timeline are observation times;
the authoritative handoff receipt timestamp and body command path establish
that context verification preceded local actuation.

Gazebo and MuJoCo use separate physics worlds with aligned semantic coordinates.
This proves a bounded mission/evidence transfer between different simulated
mobility types. It does not prove shared collision dynamics, real hardware,
SLAM, stair descent, general terrain navigation or conversational continuity.
The pretrained Walk These Ways policy and Menagerie model are credited in
[THIRD_PARTY.md](../simulation/quadruped/THIRD_PARTY.md).

Verified checks:

- 42 Rust workspace tests, formatting and all-target/all-feature Clippy passed.
  The final source-eligibility fix also passed focused PostgreSQL and Clippy checks.
- The isolated PostgreSQL route scenario covers frozen map and body assignments,
  unknown elevation, capability requirements, staged transfers, retained-image
  acknowledgment, destination-only transfers, changed maps, explicit abandonment,
  complete expiry fencing, late results and restart invalidation. The existing
  PostgreSQL handoff regression also passed.
- HTTP identity checks passed with real local JWT verification, viewer/operator/
  device restrictions on the new route endpoints, revocation, revision fencing
  and round recovery. Disposable database readiness now waits for TCP, avoiding
  PostgreSQL's temporary bootstrap socket race.
- The [planner evaluation](../evaluation/route-planner-2026-11-02.json) matched all
  20 explicit expectations: seven plans and thirteen refusals, each repeated 100
  times deterministically. Recorded timing is synthetic planner CPU work, not
  locomotion or model-inference latency.
- Eleven quadruped gateway tests passed. The
  [six-case physics report](../evaluation/quadruped-2026-11-02.json) records three
  yaw/friction arrival variants, lease loss, explicit stop and unsupported 25 cm
  riser refusal. A separate real-time socket probe verified traversal, inspection,
  actual image capture and watchdog stopping. None of these use a frozen base or
  paused physics to implement stopping.
- The pinned ROS gateway compiled and both CTests passed, including rejection of
  Nav2 success outside a tighter signed arrival region. The Go1 installer passed
  a repeat run against verified existing assets.
- Operator TypeScript, lint, build/bundle budgets and browser fixtures passed,
  including frozen review, map/expiry errors, unstaged targets, viewer restrictions,
  explicit abandonment, read-only recommendations and a 390 px layout. Fixtures
  test interface behavior; the real mission recording above establishes motion.
- The actual public recording and exported `/lattice/` build passed browser
  verification of JSON/JPEG/video hashes, MP4 playback, approval timestamps,
  four viewport widths and no robot API calls. The prior two-rover and
  single-rover stories also passed their regressions.
- The main portfolio passed local media/link checks, 1440/390 px light and dark
  layouts, and JavaScript-disabled checks. Its existing fonts, buttons, layout,
  CSS and JavaScript were preserved; only the Lattice case study and generated
  demo changed. Public artifacts were checked against local private credentials
  without printing their values; no credentials were found.

The recorder cleaned up its own simulator and application processes, preserving
the durable PostgreSQL database and signing identity. Authenticated Cloud Run /
Netlify provisioning remains unverified. CI jobs are configured; hosted CI results
and the GitHub Pages rollout require separate verification.

---

# Previous shared observation memory and reviewed handoff — November 2, 2026

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
