# Adaptive mission continuity

The adaptive scenario adds one alternate ground route to the reviewed warehouse
map. A real physical barrier is inserted in Gazebo after the rover reaches the
inspection bay. When the approved direct traversal starts, the rover's live
laser scan detects returns inside its forward route corridor. The local gateway
stops, and its authenticated body adapter reports bounded, hash-referenced sensor
evidence. The recorder never writes a sensor result or changes a robot pose.

If that report can't reach the core right away, the rover stays stopped and sends
the same report again. The core accepts it while the command it was observed
under is still active and the body is still where it took the scan. If the core
declines it, because that command expired or no longer matches, the body reports
the traversal as failed, which holds the round for a reviewed replan instead of
leaving it running.

The core retains the completed bay inspection and holds the same round. A frozen
replan proposes two west-aisle legs in place of the blocked direct leg, preserving
the observation and original objective. Explicit approval waits for the original
command deadline and stop margin. The rover executes the revised remainder,
then an independently reviewed handoff lets the staged Go1 verify the original
image, climb the physical steps and inspect the upper station.

## Start and record

Use the warehouse and quadruped prerequisites from
[CAPABILITY_ROUTES.md](CAPABILITY_ROUTES.md). Existing PostgreSQL credentials,
signing identity and history are reused:

```bash
./scripts/run-durable-adaptive-warehouse.sh
```

For the complete recorder, start from a fresh simulator scene without unfinished
rounds or uncleared route conditions:

```bash
LATTICE_ADAPTIVE_SHOWCASE=1 ./scripts/run-durable-adaptive-warehouse.sh
```

It writes public `demo/adaptive-route.json`, two original JPEGs and the original
`adaptive-blockage-scan.json` only after the whole objective passes. The scan's
exact bytes must match the body-attested SHA-256 in the condition. Failed runs
retain their private diagnostics under
`target/heterogeneous-run.*` and leave the public recording alone. The completed
recording includes the revised route, condition evidence, immutable replan,
approval fence, retained observation, original and revised steps, measured paths,
stopping drift and physical step contacts. Full joint states remain in the
private result for reproducible camera rendering.

Render the Go1 clip from that completed run's measured joint states:

```bash
target/quadruped-venv/bin/python simulation/quadruped/render_demo.py \
  --assets target/quadruped-assets --map simulation/routes/warehouse-adaptive.json \
  --trace target/<run>/adaptive-route-result.json \
  --output apps/control-center/public/demo/adaptive-quadruped.mp4
```

The renderer checks the completed round, map digest, pinned controller/model,
continuous joint-state telemetry, stair contacts and loaded standing tail. Its
provenance manifest binds the clip to this adaptive round; a clip from the older
capability scenario cannot stand in for this recording.

The direct semantic edge is `bay_to_transfer`. The alternate edges are
`bay_to_west_bypass` and `west_bypass_to_transfer`, via `(-2, 2.2, 0)`.
The box barrier has dimensions `1.4 × 0.18 × 0.8 m`, centered at
`(0.2, 1.55, 0.4)` in the primary case. It is collision geometry visible to the
real 360-degree lidar; it is absent from the static occupancy map. It remains in
the scene while the rover executes the alternate route.

## Repeatable mission evaluation

```bash
python3 scripts/evaluate-adaptive-missions.py \
  --output evaluation/adaptive-missions.json
```

This runs three complete missions in fresh physics scenes: nominal, a central
barrier, and an offset barrier. Each case checks the expected replan decision,
same-round identity, completed work retained without repetition, original image
hashes, explicit transfer, final inspection and real stair contacts. It measures
wall-clock objective duration, HTTP replan preparation latency, the deliberate
approval wait, source drift, body paths and sample counts. Small sample counts
describe these bounded scenarios; they do not establish a general success rate.

The suite keeps PostgreSQL history and signing identity. A failed case stops the
suite and preserves held work. Between successful cases it can explicitly clear
only exact condition events produced by its own prior result, and only after
the new Gazebo scene reports that the prior barrier is absent. It does not open
a segment merely because an observation is old.

If a prior manually recorded adaptive run left a condition closed, review it in
the operator UI after physically resetting the scene. An evaluation can instead
be given that exact successful result with
`--clear-events-from target/<run>/adaptive-route-result.json`; this authorizes
only its recorded event, and does not clear unrelated observations.

## Recorded evaluation

The [November 2, 2026 evaluation](../evaluation/adaptive-missions-2026-11-02.json)
completed all three bounded scenarios with two expected replans and no repeated
completed inspection. Each case retained both original inspection images and
completed the separately approved Go1 transfer, all three physical step contacts
and the final upper inspection. The report preserves each private result's
SHA-256 and retains the earlier development failure separately.

| Scenario | Objective duration | Reviewed replan | Repeated completed inspections |
| --- | ---: | --- | ---: |
| Nominal, no barrier | 49.441 s | None | 0 |
| Central barrier | 113.166 s | West bypass | 0 |
| Offset barrier | 112.077 s | West bypass | 0 |

Objective duration starts at initial route approval; simulator startup and
source staging are excluded. The obstacle cases include the required original
command fence: 46.758 s and 46.931 s from observed blockage to replan approval.
Replan preparation HTTP calls took 35.020 ms and 42.091 ms. Recorded source drift
while held and after transfer rounded to 0.0000 m in both cases.

The published [adaptive recording](../apps/control-center/public/demo/adaptive-route.json)
uses the central case, round `round-15faaa9871dd4177b157ff5652da0796`.
Its original scan contains 45 corridor returns, nearest 0.677 m; independently
projecting those recorded rays reproduces the reported count and distance.
Its scan SHA-256 is
`72e0a374ddf1535b27949acf154f1e00dd94239dbcf9cf9fcd64c37bfee083ad`.
The offset case produced 43 returns, nearest 0.706 m. These measurements describe
the tested layouts and controller; three scenarios do not establish a general
reliability or obstacle-avoidance rate.

## Boundaries

The semantic map is configured geometry, not SLAM. A blocked segment is a
conservative corridor exclusion supported by body-attested lidar returns; the
core does not independently classify a physical object from those returns.
The gateway retains the raw scan hash and source pose for provenance.

During development acceptance, the first physical blockage produced 47 corridor
returns at a nearest distance of 0.652 m. The bay inspection, durable condition,
completed-work preservation and rejected premature approval all worked. The
first detour then failed closed on a transient transform lookup at the exact
scan timestamp. The failed attempt and held remainder were retained; the test
round was explicitly abandoned, without removing its history or stop fence.
The corrected gateway keeps commanded velocity at zero while waiting at most
500 ms for an acquisition-time transform; a persistent failure remains terminal.
It does not substitute a newer transform for the recorded scan timestamp.
Private diagnostics remain under `target/heterogeneous-run.3LEY5d` in this
workspace. This attempt is not counted as a completed evaluation case.

Replanning requires a fresh, unambiguous source pose at a known semantic place.
This scenario deliberately detects the nearby barrier while the rover is still
within the inspection-bay region. It does not invent a route anchor when a body
stops between known places. The bounded objective fits five steps after replanning.

Gazebo and MuJoCo still use separate aligned physics worlds, so the demo does
not prove inter-body collision handling or a shared physics clock. Go1 uses the
published pretrained controller and the same three-step corridor described in
[QUADRUPED.md](QUADRUPED.md). The sensor and planning decisions are executed by
the product, while the recorder performs the operator's explicit approvals.
