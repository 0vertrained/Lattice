# Durable missions and restart recovery

The local warehouse demo can retain bodies, proposals, approvals, missions,
inspection JPEGs, command sequences and audit records in PostgreSQL. A core
restart holds unfinished work for explicit operator review. It never resumes an
old command automatically.

## Run

Install the prerequisites in [ROBOTICS_DEMO.md](ROBOTICS_DEMO.md) and
[INTELLIGENCE_DEMO.md](INTELLIGENCE_DEMO.md), then run:

```bash
./scripts/run-durable-warehouse.sh
```

The runner starts PostgreSQL 18 on loopback port 55433 (override with
`LATTICE_POSTGRES_PORT`), creates a private `.lattice-state/` directory and a
Docker data volume, then launches the warehouse stack. Both names appear in the
startup output. Subsequent runs reuse them. PostgreSQL remains running after the
simulator exits; stop it with `docker stop <name-from-startup>` when finished.
The regular `run-warehouse.sh` remains a disposable, in-memory option.

Open `http://localhost:5173/operator.html`, connect using your existing development API key, and approve
a mission. After a core restart, unfinished missions show **recovery required**.
Choose **Review recovery**, check the robot position and command, then **Approve
recovery**. This creates a new mission, command identity, sequence and expiry.
The old mission remains in history with a link to its continuation. A review
expires after five minutes and cannot replace the command during approval.

For a complete automated demonstration with real navigation and camera frames:

```bash
LATTICE_RECOVERY_SMOKE=1 ./scripts/run-durable-warehouse.sh
```

This runs positive/negative camera inspections, starts motion, kills only the
runner's core, starts a replacement, checks retained evidence and the stopped
rover, then explicitly approves recovery and checks arrival. It writes
`recovery-report.json` in the printed run directory. It deliberately interrupts
only this isolated simulator; do not use it against physical robots.

## Transaction and restart behavior

The core uses one PostgreSQL connection and a session advisory lock. A second
core using the same database is refused in the default local mode. Hosted OIDC mode can explicitly transfer ownership using a database epoch fence; see [HOSTED_DEMO.md](HOSTED_DEMO.md). Each authenticated operation uses one
serialized transaction; inference runs outside it so a slow model does not block
heartbeats. The HTTP response is released only after commit. Approval, mission
creation, sequence allocation, signed-command enqueue, audit append and outbox
write commit together. Error responses and cancelled handlers roll back before
the connection becomes available to another operation.

On startup, the core checks the database's signing identity, marks bodies offline,
invalidates outstanding commands and pending reviews, holds unfinished missions,
and records a `core.started` audit event in one transaction. Successful and failed
mission evidence is retained. Original approval retries return the original
mission; they do not dispatch again. Recovery approvals are bound to the held
mission, and only one can create its continuation. Reassignment cannot bypass
this hold. Late results from the old command are acknowledged and audited without
changing the held or cancelled mission.

Every core process has a new epoch header. The body agent stops its local goal
before renewing a lease when that epoch changes, including when the restart takes
less time than the existing watchdog deadline. Longer outages also trigger the
local watchdog. Stable signing identity and persisted body sequences continue to
reject replayed commands.

Command delivery is **at most once**, not exactly-once physical execution. If the
HTTP response is lost after dequeue commits, the command is not redelivered.
Restart recovery provides an explicit path to retry unfinished work; body-only
crash recovery and delivery acknowledgements are future work. A database outage
fails requests closed; restart the core after restoring PostgreSQL connectivity.
`/health` is process liveness, not database readiness.

## Identity and backups

The local signer loads a 32-byte Ed25519 seed with private file permissions.
Missing, permissive or mismatched keys fail startup. Never regenerate a key to
repair an existing database. Back up the PostgreSQL data **and** `.lattice-state/`
together, securely, while the demo is stopped. Preserve the body sequence file
when restarting an agent within the same robot session. A new simulated world is
a new local body session; the server sequence counter still continues upward.
Do not commit these credentials or include them in a trace or screenshot.

For an already provisioned local database, set `LATTICE_DATABASE_URL` and
`LATTICE_SIGNING_KEY_FILE` before starting `lattice-core-api`. The adapter applies
versioned migrations transactionally on an empty database; a database bootstrapped
manually with the old untracked SQL scaffold requires migration review. Direct remote PostgreSQL is rejected. Hosted Cloud SQL uses its managed encrypted connector and a local Unix socket.

## Validation

The PostgreSQL integration test requires an **empty disposable database**:

```bash
export LATTICE_TEST_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/lattice_units'
cargo test --locked -p lattice-infrastructure --test postgres_recovery -- --ignored
```

It checks transaction cancellation after all approval writes, concurrent approvals,
sole-writer fencing, key mismatch, restart holds, competing recovery approvals,
monotonic sequences, the audit hash chain and transactional outbox rows. CI
explicitly runs this test; ordinary `cargo test` reports it as ignored.

The process-level HTTP test needs a separate empty database:

```bash
cargo build --locked -p lattice-core-api
LATTICE_TEST_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/lattice_api' \
  python3 scripts/smoke-recovery.py
```

It kills and restarts real core processes, checks eight simultaneous approval
requests, committed evidence/audit preservation, late-result isolation, explicit
recovery and missing/wrong/permissive key failures. Its JPEG is a transport fixture;
perception validation is the real-camera scenario above.

## Scope

This local runner uses a single core and a development identity. The hosted configuration separately implements OIDC user roles and body-scoped credentials. The shared API key and
file-based development signer are not multi-user authorization or a hardware key
store. Bounded inspection images currently live in mission JSONB; larger artifacts
need object storage and retention controls. Audit entries have a hash chain, but
there is no external integrity anchor. Outbox rows are committed; a NATS publisher,
retention jobs, paginated history, remote database TLS and physical-robot testing
remain later work.
