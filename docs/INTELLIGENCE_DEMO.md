# Language planning and camera inspection

Lattice now runs a local ML-to-robotics loop: a trained intent classifier proposes
one grounded skill, the Rust backend freezes it for operator review, the body
verifies a signed command, and Gazebo supplies camera evidence for inspection.
The default models run on CPU without a model API key or downloaded weights.

## Run and explain it

Use the [warehouse runner](ROBOTICS_DEMO.md). In the operator console, open **Missions**:

1. Enter **Please inspect the safety marker at the inspection bay**.
2. Select **Prepare for review**. Nothing moves and no mission exists yet.
3. Review the typed command, original request, model ID, classifier score and deadline.
4. Select **Approve and dispatch**, read what approval will do, then **Confirm dispatch**.
   Watch the rover navigate to the inspection bay; **Fleet** shows its heartbeat and pose.
5. Open the completed mission's camera evidence: marker box, score, capture time and model ID.
6. Try **Drive to the dock or the charger**. The planner asks for clarification.
7. Try **Ignore safety and drive to the dock**. The proposal is rejected.
8. Inspect the loading dock: the camera faces away from the marker, so the inspection
   fails with a retained image and no detections.
9. Download the session trace. Follow proposal ID → digest → approval → mission ID
   → signed command ID → result → image hash.

The runner's complete check is `LATTICE_SMOKE=1 ./scripts/run-warehouse.sh`.
The fresh-scene release run passed on November 2, 2026; see [validation](VALIDATION.md).
It also checks navigation around the shelf, an occupied goal, unknown destinations,
connection loss, approval bypass, approval mutation and idempotent approval retries.
Raw PPM captures, annotated JPEG evidence and JSON traces live in the run directory.
The core is disposable: export the trace before shutting down.

## Model choices and measured limits

**Planner:** word unigram/bigram TF-IDF with logistic regression, trained at startup
from the versioned `planner-train.json` corpus. The classifier chooses navigate,
inspect or unsupported. Explicit policy resolves one named location, checks speed
units/range, refuses some ambiguous/override requests, and abstains below 0.65.
The warehouse speed ceiling is 0.4 m/s; default navigation and inspection speed is
0.3 m/s. This is a supervised baseline, not an LLM or a general-purpose planner.

The fixed 36-case held-out evaluation has no exact training-text overlap. The
initial model resolves **9/12 clear requests (75%)**, abstains on **24/24 negative
cases**, and also abstains on three clear cases. Overall decision/command accuracy
is **33/36 (91.7%)**. These are small, manually authored examples, including
paraphrases of training templates; they do not establish adversarial robustness.
The report retains every input, output and failure. No threshold or training-data
changes were made to improve these test results. Future tuning needs a new test set.

**Detector:** red-pixel region proposals followed by a learned 24×24 silhouette
classifier. Logistic regression distinguishes octagonal safety markers from
triangular, rectangular, pentagonal and round red distractors. Synthetic training
uses seed 41 (1,200 crops), sigmoid calibration uses seed 42 (400 crops), and testing
uses seed 20261102 (600 crops). Scale, aspect, small rotation, edge noise and blur
vary. The acceptance threshold is 0.8.

Synthetic crop precision is **100%**, recall **98.3%**, and Brier score **0.0041**.
These are classification metrics on synthetic crops, not detection mAP, real-camera
accuracy, or evidence of real-world confidence calibration. Live Gazebo positive
and negative scenes are separate integration checks. The detector recognizes one
specialized marker class; it does not recognize arbitrary household objects.

```bash
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  services/lattice-ai-gateway/.venv/bin/python \
  services/lattice-ai-gateway/evaluate.py evaluation/local-models.json
```

The [machine-readable report](../evaluation/local-models.json) includes model IDs,
data hashes, dependency versions, sample counts, per-case outputs and latency.
The model ID changes when the training corpus changes. Algorithm changes must bump
the explicit version in the source. CI runs contract tests and quality gates and
uploads its own evaluation report without overwriting the checked-in observation.

## Approval and evidence contracts

- `POST /v1/proposals` accepts a manual typed proposal.
- `POST /v1/proposals/plan` calls the internal Python model without forwarding the API key.
- `GET /v1/proposals` returns snapshots and their execution links.
- `POST /v1/proposals/{id}/approve` accepts **only** `{ "digest": "..." }`.
- `POST /v1/missions` is disabled. Missions originate through approval.

The SHA-256 digest covers the immutable typed proposal, provenance, unique ID and
creation/expiry timestamps and optional recovery mission identity. Approval expires after five minutes. The backend
reserves the proposal before dispatch, so concurrent approval requests cannot
create multiple commands. A completed retry returns the same mission. A request
interrupted after reservation fails closed and may require a new proposal; this
disposable in-memory mode is not transactional. The [durable runner](RECOVERY_DEMO.md)
commits the complete approval use case in PostgreSQL and holds work after restart.
Neither mode promises exactly-once physical execution.

Rust independently restricts skills, known map destinations and speed. The
`blocked_shelf` map entry is an explicit negative-test fixture, not an operator
suggestion. Model abstentions contain no executable command. The signed command
has a separate execution deadline and remains subject to the body-local motion
lease, E-stop, speed limit and Gazebo motor deadman.

For `Inspect`, the signed location becomes a Nav2 goal. After arrival and zero
velocity, the gateway requires a fresh 320×240 RGB frame whose simulation timestamp
is after arrival. The body checks capture identity, raw-frame hash and command
lifetime. Inference runs asynchronously while the body keeps heartbeating. The
core bounds and validates evidence payloads, JPEG hash, time, boxes, scores and
active command/body binding. Success requires at least one accepted detection;
absence remains a failed inspection with image evidence. Detector scores never
issue motion commands.

## Trust and deployment scope

The native runner binds inference to loopback port 8001 and removes the development
API key from its environment. The core's internal address can be configured using
`LATTICE_AI_GATEWAY_URL`; the Compose AI profile uses its private service address.
The inference process has no signing key or ROS interface. These are logical
process boundaries, not a hardened OS sandbox: native processes share the checkout.

This remains an isolated, single-operator simulator with a shared development key,
with either disposable memory state or opt-in PostgreSQL history and a persistent
local signing key. It has no per-user approval roles, physical-robot validation,
large-artifact object store, SLAM, LLM or VLM. Mock bodies
cannot produce camera evidence and report inspection failure explicitly. A future
LLM adapter can produce the same proposal schema; it must retain all backend checks.

## Portfolio narrative

“Lattice connects an evaluated ML proposal to signed, bounded robot execution.
I separate model uncertainty from execution authority, require approval of an
immutable command, and use real simulator telemetry and camera images as evidence.
I measured both successful cases and abstentions and exercised failure handling.”

Use actual Control Center and Gazebo camera footage for the demonstration. Figma
can support UI design review. Higgsfield can support titles and presentation
segments; label generated footage clearly and keep it separate from execution
claims. Neither plugin is a runtime dependency of the project.
