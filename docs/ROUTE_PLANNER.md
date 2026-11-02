# Capability-aware semantic routes

The deterministic planner answers a bounded question: which available bodies can
carry one objective through this reviewed semantic map, and where must ownership
change? Its output is a proposal. It never issues commands, approves a handoff,
or treats a declared capability as proof that a controller can physically perform
it.

The map contains named places in one three-dimensional coordinate frame, directed
segments, arrival regions, transfer permissions, required capability sets and
speed ceilings. Stairs require every listed capability, such as both `navigate`
and `stairs`. Disabling a segment removes it from executable planning. Map IDs,
revision and a SHA-256 digest bind the reviewed content; the digest is independent
of the order in which places or segments were supplied.

The application supplies candidate identities, verified semantic placements,
adapter capabilities, readiness and availability. A body with unknown placement,
stale readiness, busy state or a source fence is excluded. The pure planner does
not invent a pose from a body name or infer that a second robot can arrive at a
transfer point by itself. A replacement must already be staged there. Arrival and
readiness must be checked again by the execution layer at the actual transfer.

The current search minimizes the number of body transfers first, then the sum of
straight-line three-dimensional graph-edge distances. Stable lexical ordering
breaks equal-cost ties. This distance is a deterministic baseline cost, not a
collision-free trajectory, predicted battery consumption or measured travel.
Local navigation and locomotion controllers still own the physical path.

Each proposed leg freezes the segment, source and target places, endpoint geometry,
arrival tolerance, speed ceiling, required capabilities and selected body. Each
transfer identifies both bodies, the allowed place, the cursor at which it occurs
and the capability reason. The destination body is explicit: a final transfer may
be necessary if the body that reached a place lacks the requested task capability,
such as a camera inspection.

Candidate assessments retain exclusion reasons and per-segment capability gaps.
The planner distinguishes malformed input, an unavailable source, disconnected
places, disabled routes, missing capabilities, unavailable transfer arrangements
and exhausted bounds. Failure produces no partial executable plan.

The graph is bounded to 16 places, 32 segments, four candidate bodies, twelve route
legs and 16,384 expanded search states. A body can be selected only once in a plan;
the planner never silently reuses its original placement after that body has
moved. These constraints make the current planner suitable for small, reviewed
inspection scenarios. The application may impose a smaller objective limit, such
as its existing six-step inspection-round bound, and must reject oversized plans
before dispatch.

## What this establishes

Pure planner tests verify that a rover lacking `stairs` is never assigned a stair
segment; replacements must be ready and physically staged at an allowed transfer
point; blocked routes and unknown placements fail closed; destination-task
capabilities are required; map ordering does not change a plan or digest; and
cycles do not duplicate the selected route. Geometry, identifier and search bounds
are checked independently of the simulator.

These tests validate the planning contract, not quadruped locomotion. A real
heterogeneous demonstration also needs a separately validated controller,
authenticated adapter, motion watchdog, source-stop boundary, reviewed approval,
retained-evidence verification and actual measured stair traversal. Existing
two-rover recordings establish continuity between instances of the same body
type; they are not evidence of stair climbing.

Run the pure checks with:

```sh
cargo test --locked -p lattice-domain navigation
```
