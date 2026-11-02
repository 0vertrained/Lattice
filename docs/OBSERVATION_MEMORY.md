# Shared observation memory

Lattice retains camera observations across missions and body changes. The first subject is an **octagonal safety marker at a named warehouse inspection station**. A station key such as `safety-marker:inspection_bay` groups related observations; it does not assert that two camera detections depict the same physical object instance.

## From a body result to shared knowledge

The authenticated body submits a terminal inspection result with a bounded annotated JPEG, detections, detector version, confidence calibration scope, camera-frame capture time and hashes. The existing result boundary validates mission ownership, active command, capture age, image hash, label, score and pixel bounds before deriving an observation. Camera failures without a valid frame produce no observation. A successful inspection requires a detection; a failed inspection with a valid frame and no detections produces a separate `not_detected` record.

The mission result, observation, audit event and any subsequent objective transition share one PostgreSQL transaction. Repeating a terminal result cannot add another observation. The storage key is derived from the command, and the database permits one immutable observation per source command. An altered replay fails; a database trigger prevents updates or deletes from rewriting history. There is no browser observation-write endpoint.

Each metadata record retains:

- Source mission, command and authenticated body IDs.
- Named inspection station, `map` frame, latest observer heartbeat pose and the pose's own timestamp.
- Body-side host receipt time of the ROS frame (`captured_at`) and core terminal-result acceptance time (`received_at`).
- Detector model ID, explicit confidence calibration scope, original image-space detections and maximum positive score. No-marker observations have `confidence: null`, not a fabricated probability of absence.
- Exact SHA-256 values for the original PPM camera frame and annotated JPEG. The original PPM remains in the simulator run directory; its hash is provenance, not a promise of server-side image availability.

The JPEG remains on the original mission and is not duplicated in observation metadata. Authenticated evidence retrieval resolves that mission, verifies source IDs and hashes, and returns the retained JPEG. Metadata lists never contain base64 image data.

## Answering “Where was the marker last seen?”

Queries return the latest positive **capture**, optionally scoped to a station key, with the original body, mission, command, timestamps and evidence hashes. A newer no-marker frame never overwrites that positive sighting. If a later negative frame exists at the same station, the answer includes it as `later_negative` counter-evidence and states that current presence is unknown.

Observation lists are bounded to 1–100 newest records and ordered by capture time, then receipt time and ID for deterministic ties. A station filter is exact. Without a filter, last-seen means the most recent positive marker-class observation across stations; it does not establish movement of one uniquely tracked object. With no positive observations, the response explicitly says no positive sighting is recorded.

`observer_pose` is where the rover was localized at its latest authenticated heartbeat. Its timestamp can differ from the camera capture. The named station comes from the signed inspection command. Neither is a triangulated marker coordinate; monocular RGB detection alone does not provide that measurement. A later negative frame can reflect occlusion, viewpoint or detector error, as well as a changed scene.

## Persistence and verification

Migration `0006_observation_memory.sql` creates the insert-only metadata table, source foreign keys and chronological/subject indexes. Restart recovery retains completed observations and their original mission evidence. Shared memory requires the PostgreSQL-backed service; the legacy in-memory adapter remains suitable for basic disposable development without this feature.

Focused checks:

```sh
cargo test -p lattice-application observation
LATTICE_TEST_DATABASE_URL=postgresql://... cargo test -p lattice-infrastructure --test observations -- --ignored
```

The PostgreSQL test requires an isolated empty database. It checks rejected body/image provenance, idempotent acknowledgements, immutable conflict handling, source-result rollback, bounded station filtering, later negative counter-evidence and retention through core recovery. Fixture detector outputs are test inputs, not a benchmark of real-world perception accuracy.
