# ADR 0006: Verified Rust body agent with a local ROS navigation bridge

## Context

Lattice's first robotics milestone needs to execute the existing `Navigate`
command in ROS 2 Jazzy / Gazebo Harmonic. The current HTTP and Rust JSON signing
contract already works. The Protobuf body stream is a future contract, not an
implemented transport.

## Decision

Use a separate Rust `lattice-ros2-body` process to authenticate to the core,
verify Ed25519 signatures, body binding, key identity, timestamps, sequence and
skill bounds, and persist the accepted sequence before dispatch. Forward only
verified navigation goals to a C++ lifecycle node over an owner-only Unix socket.
The socket and its directory are shared only by these two local processes.
Python remains simulator launch/tooling only; it receives no body credentials.

The C++ node resolves named map destinations, sends Nav2 `NavigateToPose` actions,
returns map-frame TF localization and action feedback/results, and gates outgoing
velocity. The gate uses steady time for its core-connection lease, localization
freshness and signed-command deadline. Clearing an E-stop cannot restart a goal.
A Gazebo system plugin independently zeros the motor command when the gateway or
ROS bridge stops sending commands. It is simulation infrastructure, not a
physical safety controller.

## Tradeoffs and limits

- HTTP polling is retained for this milestone. gRPC/mTLS and device identity
  authorization remain future work; the shared development API key is local-only.
- The core still uses ephemeral signing keys and in-memory mission state. A key
  change fails closed at the body agent; restart the entire disposable simulation
  with fresh sequence storage after an intentional core reset.
- A locally compromised ROS graph can publish directly to topics; the demo is an
  isolated simulator, not a hardened physical deployment.
- World geometry, static occupancy map and named destinations are deterministic.
  AMCL localizes against the known map; this milestone does not claim SLAM.
- Only Navigate is advertised. Inspect/perception, language planning and multi-body
  handoff are separate future increments.
- Pose is optional in heartbeat/body contracts for compatibility with mock bodies.
  A missing pose is displayed as missing localization, never fabricated movement.

## Validation

Rust tests cover signature tampering, wrong identity/key, replay, expiry and
future issue times. C++ motion-gate tests cover lost lease, stale localization,
expiry, finite speed bounds and stop latching. `scripts/smoke-navigation.py`
checks actual live mission completion, measured displacement and unknown-goal
rejection. The Gazebo run uses a matching generated occupancy map and obstacle.
