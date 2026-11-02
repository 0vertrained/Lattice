# Two real rover bodies in one warehouse

The multi-rover demo runs two Gazebo differential-drive models in the same physics world. Each has its own lidar, camera, Nav2 stack, localization, local motion gate, Gazebo deadman, Unix socket and real `lattice-ros2-body` process. Both connect to the same core and local inference service. This establishes continuity between two real simulated body instances; heterogeneous robot types and autonomous fleet planning remain separate work.

Use the durable launcher after the standard [warehouse setup](ROBOTICS_DEMO.md):

```bash
./scripts/run-durable-multi-warehouse.sh
```

It reuses the protected `.lattice-state` credentials and existing PostgreSQL volume. The simulator exits on Ctrl-C; PostgreSQL and its records remain. The original `run-warehouse.sh` and `run-durable-warehouse.sh` still launch one rover. For an ephemeral development run, use `./scripts/run-multi-warehouse.sh`; alternatively pass `LATTICE_DATABASE_URL` and `LATTICE_SIGNING_KEY_FILE` to that runner for an existing durable core configuration. Keep these values in protected environment/configuration files.

Shared observations and reviewed handoffs require the PostgreSQL-backed core. The ephemeral runner supports basic body/navigation development, but the handoff recorder deliberately rejects that mode. Neither launcher clears prior rounds or observations. Before another recording, complete or explicitly recover any prior active round, wait for its source command deadline, and start a fresh simulator scene; retained completed records remain available.

Open `http://localhost:5173/operator.html` with the development API key from `.env`. The runner refuses occupied core, inference and UI ports and cleans up only the processes and simulator container it creates. It uses one instance of the existing pinned Nav2 image and shared build caches, not separate ROS containers per rover. The default command lifetime is 60 seconds; `LATTICE_COMMAND_TTL_SECONDS` can override it.

| Property | Rover A | Rover B |
| --- | --- | --- |
| Core body ID | `gazebo-rover-a` | `gazebo-rover-b` |
| ROS namespace / Gazebo model | `rover_a` | `rover_b` |
| Initial world pose, metres | `(0, 0, 0)` | `(-1.5, -1.5, 0)` |
| TF base / odometry | `rover_a/base_link`, `rover_a/odom` | `rover_b/base_link`, `rover_b/odom` |
| Gateway socket inside container | `/run/lattice/rover_a/gateway.sock` | `/run/lattice/rover_b/gateway.sock` |
| Replay sequence file | `rover_a/sequence.json` | `rover_b/sequence.json` |
| Appearance | Blue | Gold |

Each map server reads the same generated occupancy map. AMCL initializes from that rover's Gazebo world spawn pose and publishes `map → rover_*/odom`. Shared `/tf` transport carries distinct frame IDs, so the gateway's standalone TF listener cannot accidentally read the other body's pose. A pose stored in `map` means the same warehouse coordinates for either body. Costmaps subscribe explicitly to their own `/rover_*/scan`, and the navigator uses its own odometry. Each rover has a small visible sensor housing at lidar height so the other rover can appear in its obstacle layer.

Only each local gateway publishes its rover's bridged `cmd_vel`; Nav2 publishes `cmd_vel_nav`. Each model's watchdog translates that one command stream into its private `motor_cmd_vel` and sends zero after 250 ms without input. Motion leases, localization freshness and emergency stop topics are independent. This does not provide fleet traffic scheduling: a parked rover can obstruct a narrow approach, so park A clear of B's continuation route before the reviewed handoff.

Runtime files are retained under `target/multi-warehouse-run.*`: generated world and bridge/Nav2 configuration, `core.log`, `ai.log`, `frontend.log`, and per-rover body logs, camera captures and sequence state. `ros.log` is saved on exit; while running use the displayed `docker logs` command. The launcher exports `LATTICE_MULTI_RUN_DIR`, `LATTICE_ROS_CONTAINER`, `LATTICE_ROVER_A_SOCKET`, `LATTICE_ROVER_B_SOCKET`, `LATTICE_BODY_A_PID`, `LATTICE_BODY_B_PID` and `LATTICE_CORE_PID` to a child recording script and saves those non-secret values in `runtime.json` for separately invoked checks.

To run the shared-memory handoff recorder with durable storage:

```bash
LATTICE_HANDOFF_SHOWCASE=1 ./scripts/run-durable-multi-warehouse.sh
```

Configuration regression checks run without ROS:

```bash
python3 -m unittest simulation.test_model simulation.test_multi_robot -v
```

The checks cover wheel geometry, collision-free spawns, disjoint motor/sensor/frame names, independent watchdog routing, lidar-visible rover housing, and namespaced Nav2 parameters. A live verification also needs both gateways localized at their distinct initial poses, A moving while B stays still, B independently navigating in the same coordinates, and one body's watchdog stopping motion without affecting the other's gate. A shared simulator process remains a common failure boundary; independent per-model deadmen are not a claim of separate hardware fault domains.

The actual durable two-rover acceptance run passed on 2026-11-02. Both bodies registered online at their specified map poses; isolated lidar frames had 360 samples and no near-field self-obstacles. Measured simulation speed was 0.877 of wall time. The four-step objective completed in 141.039 seconds with 996 recorded poses: A travelled 2.34 m, its source motion stopped 1.453 seconds after fencing with 0.0204 m subsequent drift, and B travelled 12.93 m while completing the three unfinished steps. B verified A's retained image before dispatch, recorded a valid no-marker observation at the dock, and returned to charge. Seven simulation configuration/geometry tests and the compiled gateway motion-gate test passed. See [validation evidence](VALIDATION.md) for the broader API, persistence, UI and publication checks; recorded assets are in `apps/control-center/public/demo/handoff*`.
