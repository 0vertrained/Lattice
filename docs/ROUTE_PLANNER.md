# Capability-aware semantic routes

The deterministic planner answers a bounded question: which available bodies can
carry one objective through this reviewed semantic map, and where must ownership
change? Its output is a proposal. It never issues commands, approves a handoff,
or treats a declared capability as proof that a controller can physically perform
it.

The map contains named places in one three-dimensional coordinate frame, directed
segments, arrival regions, transfer permissions, required capability sets and
speed ceilings. Stairs require every listed capability, such as both `navigate`
and `stairs`. Every segment requires `navigate`; optional mobility requirements
are `stairs` and `rough_terrain`. Task capabilities such as `inspect` belong to
the destination task, not a traversal. Disabling a segment removes it from executable planning. Map IDs,
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

## Current route conditions

`plan_route_with_blocked_segments` accepts a bounded set of unavailable segment
IDs alongside the trusted map, request and current candidates. It excludes those
edges from reachability, capability feasibility and graph search. The map's
geometry, revision and digest remain unchanged, so each selected leg can still
be frozen into a traversal that the body verifies against its trusted map.
Unknown segment IDs fail validation; clearing the dynamic set cannot reopen a
statically disabled edge.

The application owns observation provenance, persistence and condition revisions.
It must bind the exact closure snapshot to the reviewed proposal and recheck it
before approval and dispatch. A pure plan is not proof that an observation is
fresh or authentic, and elapsed time never clears a closure inside the planner.

For a remaining objective, the application supplies the body's verified current
semantic place and original destination. A blocked earlier edge does not cause
the planner to replay completed legs. Unknown current placement, an unavailable
source, missing capabilities or an unstaged replacement still refuse a route.
Completed inspections, evidence, command expiry fences and explicit approval
belong to the application continuity workflow; this function cannot bypass them.

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

## Reproducible scenario evaluation

The evaluation example runs thirty fixed synthetic scenarios: successful flat,
stair and destination-task transfers; unavailable or incorrectly placed bodies;
missing capabilities; forbidden transfers; closed and disconnected segments;
invalid mobility requirements; the leg bound; cycles and deterministic tie breaks.
Ten current-condition cases add alternate graph paths, blocked alternatives, unknown
closure IDs, detour capability requirements, current-placement suffixes,
unavailable targets and explicit static-edge precedence. Each scenario records
its full input including the closure set, expected outcome, observed plan or refusal,
repeatability, and planning wall time across 100 calls after five warmups.

```sh
cargo run --locked --release -p lattice-domain --example evaluate-routes \
  > evaluation/adaptive-planner-2026-11-02.json
```

The command exits unsuccessfully if a case differs from its expected outcome or
repeated calls produce different output. Timings include pure validation, graph
search, explanations and successful map hashing; they exclude compilation,
serialization and I/O. Hardware, build profile and concurrent system load affect
the measurements. They are neither control-loop timing guarantees nor physical
mission success rates. Expected refusals remain explicitly recorded as refusals.
The zero-leg destination-transfer fixture exercises the domain contract; the
application's two-to-six-step bound can reject that one-task objective.
