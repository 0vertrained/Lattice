# One objective across a rover and a quadruped

This release joins the existing durable mission and evidence pipeline to a
bounded semantic route planner. A Gazebo rover inspects the warehouse bay and
drives to the stair transfer point. A staged MuJoCo Go1 verifies the rover's
retained image, traverses three physical 5 cm steps, and inspects the upper
landing after an explicit operator handoff approval.

Gazebo and MuJoCo are separate physics worlds with aligned semantic coordinates.
They do not simulate inter-body contact or a common collision world. The map is
reviewed configuration, not a SLAM result. The locomotion policy is pretrained
third-party work; Lattice supplies the planning, review, command validation,
continuation, observation storage, and local gateway integration.

## Run and record

Install the warehouse prerequisites in [ROBOTICS_DEMO.md](ROBOTICS_DEMO.md), the
AI gateway dependencies, and the Go1 dependencies:

```bash
./scripts/install-quadruped.sh
./scripts/run-durable-heterogeneous-warehouse.sh
```

The runner reuses the local PostgreSQL database and signing identity. It starts
one Gazebo rover, one MuJoCo Go1, the core, inference, and the operator interface.
Open `http://localhost:5173/operator.html` with the existing development key.
Each body uses a separate private gateway socket and sequence file. Inference,
physics, and the frontend receive no Lattice control credentials.

To reproduce the complete recording from a fresh simulator scene:

```bash
LATTICE_CAPABILITY_SHOWCASE=1 ./scripts/run-durable-heterogeneous-warehouse.sh
```

The recorder first reviews and executes a separate rover staging mission. It
then reviews the four-step route, waits for the planned transfer hold, prepares
and approves the exact replacement, and verifies the continuation receipt,
original image hashes, physical stair contacts and final camera evidence. A
failed run retains private diagnostics and leaves the published recording alone.
The runner cleans up its own processes; persistent database state remains.

## Operator flow

1. Choose an available source body at a known semantic place and a destination.
2. Review the immutable route: map revision, exact legs, assigned bodies,
   required capabilities, transfer reasons, and approval expiry.
3. Approve that digest. Each step rechecks the relevant map, body and location.
4. At a body change, the round holds before issuing a target command. The
   transfer recommendation is read-only. Prepare and explicitly approve the
   handoff once its source fence and target staging checks pass.
5. The target retrieves and verifies retained evidence and acknowledges its
   signed continuation context before submitting a local goal.

Unavailable or misplaced replacements, unknown quadruped elevation, disabled
segments, changed maps and missing capabilities block execution. A held round
can be explicitly abandoned when its old map can no longer be used. Abandonment
retains history and the source's full signed-command expiry fence; it never
resumes or replans automatically. A fresh post-fence heartbeat and a new review
are required before using that body again.

## Contracts and limits

- `GET /v1/navigation/map`: configured semantic map, authenticated read.
- `POST /v1/navigation/plans`: bounded objective; the server derives the map,
  body assignments and executable steps.
- `POST /v1/navigation/plans/{id}/approve`: only the frozen digest.
- `GET /v1/rounds/{id}/transfer-options`: read-only recommendation/readiness.
- Existing handoff proposal and approval endpoints perform the actual transfer.
- `POST /v1/rounds/{id}/abandon`: explicit retirement of a held round by digest.

Route proposals require PostgreSQL and `LATTICE_NAVIGATION_MAP_FILE`; legacy
inspection rounds remain available when a route map is not configured. Executable
objectives contain two to six steps. The pure planner has broader graph bounds,
but a single stationary inspection is handled by the ordinary inspection flow.
The Go1 gateway supports only the reviewed forward stair corridor and standing
support controller. It does not establish stair descent or arbitrary terrain.

See [ROUTE_PLANNER.md](ROUTE_PLANNER.md) for planning rules and evaluation,
[QUADRUPED.md](QUADRUPED.md) for physics, stop behavior and upstream attribution,
and [VALIDATION.md](VALIDATION.md) for release evidence. This increment demonstrates
heterogeneous mission continuity; general autonomous reasoning, shared geometric
mapping, conversation transfer, hosted provisioning and hardware remain separate
milestones.
