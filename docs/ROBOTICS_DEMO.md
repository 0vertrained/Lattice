# Warehouse navigation demo

This milestone connects the existing signed `Navigate` command to a differential
rover in Gazebo Harmonic through ROS 2 Jazzy and Nav2. It uses AMCL against a known
map, a simulated 360-degree lidar, wheel odometry, and a NavFn planner with a
regulated pure-pursuit controller. The [intelligence increment](INTELLIGENCE_DEMO.md) adds a trained intent classifier, backend approval, an RGB camera and marker inspection. SLAM, LLM planning and physical hardware remain future work.

## Run on Linux

Requirements: Docker, Rust 1.97.1 with Cargo, Node >=22.12, Python 3.12+ and Git.
Allow about 15 GB with overlay storage; Docker's vfs driver needs substantially
more space (this cloud environment has vfs). The first Nav2 build can take several
minutes. The dependencies and source are pinned to a tested image digest and Git
commit in `scripts/run-warehouse.sh`; subsequent runs reuse build outputs.

From the checkout root:

```bash
# Configure a development key if .env does not exist, per the root README.
# Install the frontend dependencies once.
npm --prefix apps/control-center ci
python3 -m venv services/lattice-ai-gateway/.venv
services/lattice-ai-gateway/.venv/bin/pip install -r services/lattice-ai-gateway/requirements.txt
./scripts/run-warehouse.sh
```

The runner checks that ports 8000, 8001 and 5173 are free, starts an isolated core,
builds/starts the ROS simulation in Docker, starts the verified Rust body agent,
starts the CPU inference service, and starts Vite. Its trap stops only its own processes/container. Run from a
regular Linux user account with Docker access. The simulator container runs as
that user so its private socket can be accessed by the native body agent.

Control Center uses the development key from `.env`. Select **Typed command**, choose **Navigate** and `loading_dock`, prepare the proposal, then approve it. The 3D warehouse renders map telemetry
(x east, y north, yaw counterclockwise). The shelf blocks the straight path to the
dock. Other goals are `charging_station` and `inspection_bay`. The `blocked_shelf` location is a negative-test fixture inside the occupied shelf. The rover advertises
Navigate and Inspect; mock adapters have no camera and explicitly fail inspection.

Logs are under `target/warehouse-run.*`; simulator logs are available from
`docker logs` for the container name printed by the runner. Each fresh run uses
new replay state because the development core generates a new signing key.
Restarting just the core while a body is running is deliberately unsupported.

## Reproduce the functional check

With the runner still active, use another shell at the repository root:

```bash
set -a
source .env
set +a
python3 scripts/smoke-navigation.py
```

This creates a mission, waits for `succeeded`, checks more than one metre of
reported displacement and arrival near the dock, then checks rejection of an
unknown destination and failure of the occupied `blocked_shelf` goal. Run from a fresh scene so the rover does not begin at the
dock. No API credential is printed.

To test the emergency stop during a mission (use the printed container name):

```bash
docker exec --user "$(id -u):$(id -g)" CONTAINER bash -c 'source /opt/ros/jazzy/setup.bash; ros2 topic pub --once /lattice/emergency_stop std_msgs/msg/Bool "{data: true}"'
```

An E-stop cancels the active goal. Publishing `false` clears the stop condition
but never resumes that goal. Stop the body process during a mission to exercise
the 1.5-second connection lease. The Gazebo motor deadman independently expires
after 250 ms without gateway output. Signed command expiry remains a separate
hard deadline (the runner configures 120 seconds).

## Checks and boundaries

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cd apps/control-center && npm run check && npm run build
```

The ROS build script also runs the C++ motion-gate test. See
[ADR 0006](adr/0006-ros-navigation-adapter.md) for trust boundaries, stopped-goal
behavior, replay storage and the intentionally retained HTTP transport.

The shared API key and open ROS graph are for an isolated local simulation.
Persistent core state, device-bound credentials, DDS security, physical motor
watchdogs and hardware validation remain separate work.

## Portfolio walkthrough

1. Show the operator authorizing a bounded destination and speed.
2. Explain verification in Rust and goal translation in the local C++ gateway.
3. Show the rover navigating around the shelf with live pose/progress.
4. Trigger a connection interruption or E-stop and show motion stop.
5. Show the mission outcome and audit history, plus the rejection tests.

This adds a robotics example alongside the portfolio's applied AI work in
Caduceus and inference infrastructure work. Claims should distinguish real
Gazebo/Nav2 execution from mock bodies and the specialized local models and future general LLM/VLM features.

## Automated fresh-run check

```bash
LATTICE_SMOKE=1 ./scripts/run-warehouse.sh
```

This runs navigation, unknown-destination rejection, occupied-goal failure and
connection-loss/reconnection checks, backend approval rejection checks, and positive/negative camera inspections, then cleans up its processes. The watchdog
check suspends only the body process started by this runner and always resumes it
before cleanup. It asserts that reconnection does not resume the failed goal.

## Navigation baseline validation (before intelligence increment)

The implementation was exercised in this cloud environment using the pinned
Nav2 image and Jazzy source. The warehouse generated real Gazebo odometry and
lidar. A signed mission reached the loading dock with 3.322 m of measured
map-frame displacement. Unknown destinations were rejected before ROS execution;
the occupied shelf goal failed through Nav2. Suspending the body agent caused the
connection watchdog to fail the mission after 1.58 seconds in that run, and the
agent reported the failure after resuming without restarting the goal.

The complete `LATTICE_SMOKE=1 ./scripts/run-warehouse.sh` run also passed from a fresh scene. Local checks passed: 11 Rust tests, 6 frontend tests, the C++ motion-gate test and 2 rover-geometry tests, plus Clippy, type checking, linting and production bundle budgets.

These are observations from a development simulator, not guarantees for physical
hardware. Software rendering runs slower than real time on this cloud machine.

The `Robotics integration` GitHub Actions workflow runs the same fresh-scene
checks for robotics-related pull requests and can also be started manually. It
uploads service logs, inspection evidence and traces without the development key or replay state. That workflow
is configured here; a hosted CI run requires these changes to be pushed.
