# The portfolio showcase

The demonstration is an operator-authored inspection round with three immutable
steps. The operator approves the plan digest once, including its failure policy:

1. Inspect the safety marker at the bay. An unsuccessful inspection stops the round.
2. Inspect the loading dock. A validated camera image with no marker records an
   anomaly and permits continuation. A navigation/capture failure still stops it.
3. Return to the charging station at a bounded speed.

The recorder kills its own core process while the third step is moving. It checks
that the body stops, that both images and the signing identity survive, and that
no reassignment bypasses the hold. It then submits a fresh recovery review and
approval, checks the round's remaining step completes, and verifies actual arrival.
The interrupted attempt remains in mission history.

```bash
# Follow ROBOTICS_DEMO.md and INTELLIGENCE_DEMO.md for prerequisites.
LATTICE_SHOWCASE=1 ./scripts/run-durable-warehouse.sh
```

This runs real Gazebo Harmonic, ROS 2 Jazzy, Nav2, the C++ gateway, Rust core/body,
PostgreSQL, and local CPU vision inference. It records measured map poses and
actual annotated camera JPEGs under `apps/control-center/public/demo/`. Full
mission records are also retained in the printed `target/warehouse-run.*/`
directory. The runner's local development key is never exported. The public tour
is an interactive recording; it neither connects to a robot nor authorizes motion.

The multi-step plan is deliberately operator-authored. The evaluated language
classifier is available for individual natural-language proposals in Control
Center; this release does not claim free-form autonomous multi-step planning.
Likewise, the recorded run uses a development identity. Hosted OIDC permissions
are verified separately with real Keycloak browser flows and API boundary tests.

## A short interview walkthrough

- Open the briefing: explain the objective and the one explicitly permitted failure.
- Play or scrub the measured route: compare both inspection locations and return.
- Open camera evidence: explain why an unsuccessful inspection is still useful data.
- Open restart recovery: show the measured stop/drift, preserved images, and fresh approval.
- Open architecture: trace who can propose, authorize, sign, execute and report.

The engineering discussion is about accountability across model, server and robot
boundaries. The classifier's score is calibrated on synthetic marker crops; the
current test set does not establish physical-camera accuracy. Stop timings are
observations from this run, not a hardware safety guarantee. The deployment uses a
single writer and one simulated rover; fleet scheduling, pagination/retention,
external audit anchoring and real hardware validation remain further work.
