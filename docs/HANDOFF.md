# Reviewed mission continuation

Lattice can transfer the unfinished suffix of an approved inspection round from
one simulated rover to another. The original round, completed steps, observations,
images and audit history remain linked. This demonstrates continuity between two
body instances; it does not yet demonstrate a rover-to-quadruped or aerial handoff.

Start the durable two-rover environment using
[`scripts/run-durable-multi-warehouse.sh`](../scripts/run-durable-multi-warehouse.sh).
Both bodies must be localized and ready in the same warehouse map. See
[the simulation instructions](MULTI_ROBOT_SIM.md) for requirements and startup.

## Operator workflow

1. Review and approve an inspection round. The first assigned rover remains pinned
   to the round until a separate handoff is approved.
2. Let the first inspection finish. Shared memory now includes its validated camera
   evidence, source body, command, capture time, detector version and confidence scope.
3. During unfinished work, select a different ready rover in the handoff panel and
   choose **Pause source and review handoff**. This action holds the current mission
   and withdraws the source's execution authorization.
4. Review the frozen source, target, completed steps, remaining steps and retained
   observations. Wait for the displayed source authorization deadline.
5. Approve that exact review. The target receives a new signed command for the
   unfinished step, plus references to the original retained evidence. It retrieves
   and verifies those images and acknowledges the context before submitting a ROS goal.
6. Watch the round continue on the target. Finished steps are not dispatched again.
   Later inspections add new observations without replacing earlier evidence.

Preparing another review invalidates the previous pending review. Restarting the
core also invalidates pending reviews and holds unfinished work. A new review is
required after restart; stored observations and source fences survive it.

## Execution boundary

The review digest binds the source mission, target body, cursor, remaining plan,
evidence references and deadlines. Approval accepts only the digest, rechecks
target freshness, availability and capabilities for every remaining step, and
creates at most one replacement mission. Repeated approval returns the same result.

The source cannot register, renew its heartbeat lease or receive another command
while its fence is active. Approval waits through the original signed command's
persisted expiry plus two seconds. This complements the local motion lease and
Gazebo watchdog; a stale heartbeat alone is not treated as proof of a stopped robot.
The simulation uses a common host clock. Independent physical robots would need
validated clock bounds and hardware stop acknowledgement before this timing policy
could serve as a physical safety guarantee.

The replacement command's signature covers the continuation digest and evidence
hashes. A body-scoped endpoint serves only observations explicitly named by that
body's active mission. The ROS adapter verifies the retained JPEG bytes and
provenance, then commits a matching context receipt before motion. A receipt is an
authenticated software acknowledgement, not hardware attestation or proof that
the underlying camera scene is physically real.

Old source results are acknowledged without advancing the held or cancelled
mission. Ordinary round recovery stays on the same body; selecting another body
requires the handoff review. A returning source cannot automatically take later
steps back from the target.

## Shared memory semantics

The current observation identity groups the supported safety-marker class at a
named inspection station. It is not persistent tracking of an individual physical
object. The pose is the observer's latest heartbeat pose, not a triangulated object
position and not guaranteed camera-synchronized telemetry.

“Last seen” returns the latest positive observation and separately shows later
negative evidence at that station. A frame without a detection does not erase a
positive sighting or prove that an object is absent. Confidence values retain the
detector's calibration scope. See [observation memory](OBSERVATION_MEMORY.md).

## Verification

Run the isolated HTTP integration suite:

```sh
./scripts/test-handoff.sh
```

It builds the core and creates a temporary PostgreSQL container, local RSA test
issuer, operator/viewer identities and scoped body credentials. It checks source
fencing across abrupt restart, immutable and concurrent approval, stale or busy
target rejection, wrong-body evidence denial, retained image hashes, required
context receipts, late-result isolation, continuation on the target and durable
observation history. It removes only its own container and processes.

Python requires `cryptography`; the runner uses the AI gateway virtual environment
when present, or `LATTICE_TEST_PYTHON` to select another interpreter. The fixtures
exercise transport and persistence rather than robot motion or detector accuracy.
Actual movement and camera evidence are verified separately by the two-rover
simulation recording.
