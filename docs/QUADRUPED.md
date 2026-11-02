# Bounded Go1 stair simulator

Lattice can hand a reviewed stair segment to a genuinely different simulated
body: a 12-joint Unitree Go1 model in MuJoCo, driven by the pretrained **Walk
These Ways** locomotion policy. This is a small, reproducible simulation release,
not hardware deployment or unrestricted quadruped navigation.

## What moves the robot

The existing policy runs as two NumPy ELU networks on CPU, with 30 observations
of history and the upstream adaptation network. It proposes joint targets at
50 Hz. PD controllers apply at most **33.5 Nm** per actuator; MuJoCo integrates
contacts at 200 Hz. After the initial scene reset, the implementation never
writes the free-base position or velocity. Three physical box steps, each
**5 cm high and 40 cm deep**, raise the platform by **15 cm**.

The policy's zero-velocity command still crept in initial experiments. The
gateway therefore uses a separate stationary support mode: default joint
targets with proportional/derivative gains 30/1.5 and the same torque bounds.
Physics continues in idle, stopped, failed and completed states. Stopping is
measured as physical drift, not implemented by freezing simulation time.

The upstream checkpoint, assets, license text, tensor shape checks and hashes
are documented in [THIRD_PARTY.md](../simulation/quadruped/THIRD_PARTY.md).
The installer checks the checkpoint before a restricted tensor-only conversion;
runtime policy loading uses `allow_pickle=False`. No Torch or GPU is required.

## Coordinate and simulation limits

The rover runs in Gazebo and the quadruped runs in a **separate MuJoCo world**.
Their semantic coordinates align; they do not share contact dynamics, a clock,
or inter-body collision physics. This demonstrates authenticated mission and
evidence transfer between different simulated bodies, not a jointly simulated
physical exchange between robots.

The fixed transform is `map_x = base_x + 1`, `map_y = base_y - 2`, and
`map_z = base_z - 0.262`. The last term is a documented nominal base-to-navigation
reference offset, not a value snapped to the expected floor. Raw measured base
height remains in every physics snapshot. The support stance is slightly taller
than the walking stance, so navigation-reference height can differ from the
platform height by a few centimetres.

The checked map is [warehouse-stairs.json](../simulation/routes/warehouse-stairs.json).
The quadruped starts near `stair_transfer` `(1, -2, 0)` and can execute the
reviewed `stairs_to_upper` segment to `upper_inspection` `(4.5, -2, 0.15)`.
The gateway rejects unrelated geometries, mismatched endpoints, map revisions,
digests, capabilities and source positions. A direct inspect command is accepted
only after the robot is already within the upper arrival region.

## Installation and checks

From the repository root, with Python 3.12, `uv`, and a working Mesa/EGL CPU
renderer available (`libegl1`/Mesa on Debian-family Linux):

```bash
./scripts/install-quadruped.sh
target/quadruped-venv/bin/python simulation/quadruped/prove.py \
  --assets target/quadruped-assets \
  --map simulation/routes/warehouse-stairs.json \
  --output target/quadruped-proof.json \
  --summary-output evaluation/quadruped-2026-11-02.json
target/quadruped-venv/bin/python simulation/quadruped/smoke.py \
  --assets target/quadruped-assets \
  --map simulation/routes/warehouse-stairs.json \
  --output /tmp/lattice-quadruped-arrival --mode arrival
target/quadruped-venv/bin/python simulation/quadruped/smoke.py \
  --assets target/quadruped-assets \
  --map simulation/routes/warehouse-stairs.json \
  --output /tmp/lattice-quadruped-lease --mode lease
```

`prove.py` uses a controlled 20 ms test clock while advancing genuine joint and
contact dynamics faster than wall time. It covers three initial-yaw/friction
variants, lease expiry and explicit stopping on stairs. `smoke.py` starts the
production gateway, runs physics in wall time, communicates over its private
Unix socket, and checks either camera evidence or lease-loss stopping. It owns
and cleans up only the gateway subprocess it starts.
The optional summary output retains compact metrics and the source trace hash;
the checked-in [six-case report](../evaluation/quadruped-2026-11-02.json) records
the measured validation run without committing the large per-tick trace.

Initial regression results on this CPU environment: all three closed-loop runs
contacted all three steps and arrived within the 25 cm destination region;
maximum tilt was below 0.20 radians. After verified arrival, another five
simulated seconds of support control produced 1.2–2.8 mm of additional drift.
Lease loss while traversing the stairs failed the command and produced 2.8 cm
of additional stopping drift; an explicit mid-stair stop produced 4.1 cm.
These measurements are bounded simulation evidence, not physical robot safety
certification. A separate 25 cm riser experiment blocked the robot; elapsed time
never counts as successful traversal.

## Local protocol and failure behavior

Run `gateway.py --socket /private/run/gateway.sock --map <map> --assets <assets>`
with a private `0700` run directory. The socket is `0600`. It uses the existing
newline-delimited JSON protocol consumed by the Rust body agent: `status`,
`lease`, `stop`, `traverse_route`, `navigate` for inspection, and `capture`.
The Rust adapter authenticates the signed command and retained handoff evidence
before contacting this local process. The local process also checks the frozen
map and geometric source position; possession of a map alone is not remote
authorization.

A separate wall-clock watchdog enforces a **1.5 second** core/body lease. While a
goal runs, a lease renews it only if it names that goal's command, so a goal the
body agent never authorized, such as one another local client started, stops when
the watchdog fires. This narrows what a same-user process can do through the
socket; it does not authenticate the client. Signed
UTC expiry and a monotonic lifetime bound both apply. Lease loss, expiry,
emergency stop, physical instability, torso collision, stale localization,
leaving the reviewed corridor or six seconds without progress fail the goal
and apply support control. Failure checks precede arrival checks. A goal
completes only inside its measured 3D region after at least 0.5 seconds below
the stationary speed threshold.
The stable window also requires at least three distinct positively loaded feet,
bounded tilt and vertical velocity, and measured foot-contact history on all
three steps. Capture rechecks the lease, monotonic lifetime, current arrival
region and support conditions before and after rendering.

An inspection captures a real `320 × 240` RGB PPM from the robot's forward
MuJoCo camera, after arrival, with the matching command ID. The scene includes
a red octagonal marker on the landing. The existing learned silhouette detector
can classify the rendered frame; the image is neither a fixture nor a generated
success badge. Its calibration remains synthetic, as for the rover camera.

The locomotion controller supports this one forward stair corridor and standing
brake. It does not establish stair descent, arbitrary obstacles, hardware
actuation, payload capacity, or robust operation outside the tested surface
and starting-pose conditions.

## Recorded external-camera video

The gateway exposes read-only complete `qpos`/`qvel` arrays so the mission
recorder can retain all measured joint positions at 20 Hz. The renderer uses
those states in an isolated MuJoCo model, with a side camera that follows the
robot. It does not infer leg poses from map positions, alter the live simulator,
or invent intermediate joint configurations. Camera and lighting settings are
presentation changes; source physics stays unchanged.

```bash
OPENBLAS_NUM_THREADS=1 target/quadruped-venv/bin/python \
  simulation/quadruped/render_demo.py \
  --assets target/quadruped-assets \
  --map simulation/routes/warehouse-stairs.json \
  --trace target/<run>/capability-route-result.json \
  --output target/capability-quadruped.mp4
```

The input must include the recorder's verified `physics_provenance`. Older
recordings can supply a separately verified, source-SHA-bound sidecar through
`--provenance <sidecar.json>`. The renderer validates the map, model/policy pins,
frame transform, monotonically recorded simulator time, complete normalized
states, three step contacts, completed mission, and a supported standing tail.
It rejects mixed runs and incomplete recordings.

Output includes a 960×540 H.264 MP4 below 3 MB, a real video-frame PNG poster,
and a provenance JSON containing the source round/mission IDs, source SHA-256,
video SHA-256, asset pins, timestamps, camera settings and measured metrics.
Without `--trace`, the script runs an independent physical gateway probe and
explicitly labels it `independent_gateway_controller_probe`; that output must
not be described as the authenticated mission recording.
