# Hosted Lattice: Netlify + Cloud Run

Start with the [Cloud Shell quickstart](HOSTING_QUICKSTART.md) if you are new to
Google Cloud. It asks for only your project, actual Netlify origin and managed
Keycloak issuer, and derives the remaining deployment bindings.

The public guided tour and authenticated operator interface share one frontend.
The tour plays checked-in simulator telemetry, images and provenance-bound video;
it never calls a robot API.
The operator interface requires OIDC authorization code + PKCE sign-in. Tokens
stay in memory, and temporary PKCE state is removed from session storage after
sign-in. Reloading requires sign-in again (the provider can reuse its SSO session).

This follows Caduceus's Netlify/Cloud Run split, with dedicated Lattice resources.
The hosted configuration is prepared; it has **not** been deployed or tested on
GCP in this workspace. Local real-Keycloak browser tests and PostgreSQL identity,
round and fencing integration tests exercise the implemented authentication path.

The current deployment package includes the adaptive semantic map and supports
distinct scoped credentials for the Gazebo rover and MuJoCo Go1. Live conditions
and reviewed replans live in PostgreSQL; they do not rewrite the trusted map in
the image or grant a browser permission to change command geometry.

## Deployment inputs and preflight

The managed session currently has no configured GCP or Netlify deployment identity,
target project/site or production OIDC issuer. The package can be checked locally,
but it cannot provision or claim a live authenticated deployment without those
bindings. Existing Git transport access does not establish cloud deployment access.

Choose a dedicated GCP project with billing, an exact Netlify site origin, and a
maintained HTTPS OIDC issuer. Provisioning below creates Lattice-specific service
accounts and a GitHub federation provider; do not reuse a Caduceus deployment
identity. Also choose a persistent Linux host for the physics simulators: Cloud
Run does not run Gazebo or MuJoCo in this architecture.

Copy [config.example.json](../infrastructure/cloud-run/config.example.json) to a
private working directory and replace the deployment metadata. It contains no
passwords, signing seeds or access tokens. After the setup script prints the WIF
bindings, validate a complete review bundle:

```bash
python3 infrastructure/cloud-run/preflight.py \
  --config /private/lattice-deployment.json --require-wif \
  --output target/hosted-release
python3 -m unittest discover -s tests/hosted -v
```

The bundle records workflow variables, the exact route-map bytes and file hash,
and Netlify build-variable names. The API origin remains an explicit placeholder
until Cloud Run returns the deployed service URL. The report distinguishes valid
configuration from authenticated access and deployment; the command makes no
network requests and provisions nothing. With `LATTICE_CORE_IMAGE` and
`LATTICE_INFERENCE_IMAGE` set to exact digest references in the dedicated registry,
`--manifest` also writes the Cloud Run service manifest. Missing inputs exit with
a structured list and do not produce a partial bundle.

The deployment workflow runs this preflight before authenticating, deploys immutable
image digests, then checks readiness, durable OIDC configuration, and rejection of
unauthenticated mission/condition requests. Its artifact contains the reviewed
configuration and deployed manifest. These probes do not replace the role, device
and moving-robot acceptance checks below.

## 1. Publish the public tour on Netlify

Import `0vertrained/Lattice`, branch `main`, with the repository's `netlify.toml`.
No environment variables are needed for the recorded tour. The build omits the
operator link and provides an explanatory operator page until its services are
connected. A preview deployment must also use its own exact OIDC redirect URI if
you enable sign-in there; wildcard redirect URIs are intentionally unsupported.

## 2. Configure the identity provider

Use a maintained HTTPS Keycloak deployment (the local test uses 26.4.7). Replace
`__SITE__` in `infrastructure/identity/realm.json` with the exact Netlify site origin,
then import it into the provider. The template contains no users or passwords.
Create named users and assign `lattice-viewer`, `lattice-operator` or
`lattice-admin`; enable MFA and the provider's account recovery policy there.
Public registration, password grant and implicit flow are disabled.

The API expects RS256 access tokens, `aud=lattice-api`, the configured issuer,
a stable `sub`, `exp`, `iat`, and roles in `realm_access.roles`. The `basic` scope
is required by current Keycloak versions to include the subject claim. A
standards-compatible provider can be used if it emits these exact claims. The
API pins its issuer/audience and obtains keys only from its configured JWKS URL;
client-supplied key URLs are never used. Revoked operator sessions can retain
access until the five-minute access token expires. Robot revocation is checked
on every operation, including again inside its database transaction.

Keycloak is an independent identity service; the deployment script does not create
an insecure development-mode identity provider on Cloud Run. The test realm and
bootstrap credentials generated by `test-hosted.sh` are disposable local fixtures.

## 3. Provision GCP and deploy

Use an authenticated Cloud Shell with billing enabled. A dedicated demo project
keeps the deployment identity's `run.admin` permission away from unrelated apps.
The script creates Cloud SQL, an Artifact Registry repository, Secret Manager
entries, and two service accounts. Cloud SQL and the always-on Cloud Run instance
incur charges. The database has deletion protection, daily backups and PITR.

```bash
git clone https://github.com/0vertrained/Lattice.git
cd Lattice
# Obtain the immutable repository ID from GitHub (gh must be authenticated).
repo_id=$(gh api repos/0vertrained/Lattice --jq .id)
bash infrastructure/cloud-run/setup-gcp.sh YOUR_PROJECT_ID "$repo_id" us-central1
```

The script prints the GitHub repository variables to configure. Add:

- `LATTICE_SITE_ORIGIN`: exact Netlify origin, e.g. `https://YOUR-SITE.netlify.app`.
- `LATTICE_OIDC_ISSUER`: `https://YOUR-IDP/realms/lattice`.
- `LATTICE_OIDC_JWKS_URL`: the provider's `jwks_uri` from its discovery document.
- `LATTICE_ROUTE_MAP`: `warehouse-adaptive` (default) or `warehouse-stairs`.
- `LATTICE_SECRET_VERSION`: a positive numeric Secret Manager version (default `1`).

Run **Deploy hosted Lattice** manually from `main`. Workload Identity Federation
is restricted to Lattice's immutable GitHub repository ID and `main`; no stored
Google service-account key is used. Image digests are deployed, not mutable tags.
Database and signing credentials are referenced from Secret Manager (numeric
version 1), never embedded in the manifest or frontend. Preserve the signing seed
when restoring a database. Rotating it requires an explicit migration; changing
the secret alone prevents startup against the existing identity.

The Rust image includes the trusted JSON maps as read-only files under
`/app/routes`. `LATTICE_NAVIGATION_MAP_FILE` selects the same map that the local
body adapters validate. A map deployment change creates a new core epoch and
holds unfinished work; update simulator map configuration before approving a
replacement plan. Dynamic segment conditions are durable records separate from
this static map. The manifest renderer rejects floating image tags, images from
another project, unknown map names, and unpinned secret versions.

The core's `/ready` probe checks PostgreSQL and current writer ownership. `/health`
is process liveness. Cloud SQL's managed Unix socket provides the authenticated,
encrypted network connection; Rust only opens the local socket. Direct remote
plaintext PostgreSQL remains rejected. Inference is a private localhost sidecar,
receives no database/signing credentials, and has no public ingress port.

Cloud Run ingress is public at the network layer so both the browser proxy and
robot agents can reach it. Every control endpoint requires application credentials;
health, readiness and public sign-in configuration are the only unauthenticated
routes. This replaces Caduceus's shared proxy-signing secret with per-user and
per-device authorization. Never pass a service-account credential to a browser.

## 4. Connect Netlify and the simulated bodies

Set these Netlify build variables, then redeploy:

- `LATTICE_API_ORIGIN`: Cloud Run's service URL, without a trailing slash.
- `LATTICE_IDENTITY_ORIGIN`: the provider's origin, without its realm path.

The build validates both origins, writes the `/api/*` proxy and security headers,
and enables operator sign-in. The identity origin is permitted by `connect-src`;
all scripts remain same-origin. Inline styles are allowed because the React/Three
operator viewport uses them. Tokens are not placed in URLs or persistent storage.

Sign in as an administrator and issue separate credentials for `gazebo-rover`
and `mujoco-go1`. Save each one-time value to a different private file on the
simulator host. Set `LATTICE_CORE_URL` to the exact HTTPS Cloud Run origin.
Keep the local gateway sockets and each body's persistent sequence file.
Only that robot's registration, heartbeat, command poll and results are allowed.
The admin UI can revoke a credential immediately. Operators approve work;
viewers can only observe. Admin credentials cannot impersonate a robot.

Run Gazebo/Nav2 and its body agent on a persistent Linux host with Docker/ROS.
After installing the warehouse prerequisites and `scripts/install-quadruped.sh`, use:

```bash
export LATTICE_CORE_URL=https://YOUR-CLOUD-RUN-ORIGIN
export LATTICE_ROVER_DEVICE_TOKEN_FILE=/private/lattice/rover-credential
export LATTICE_QUADRUPED_DEVICE_TOKEN_FILE=/private/lattice/go1-credential
export LATTICE_NAVIGATION_MAP_FILE="$PWD/simulation/routes/warehouse-adaptive.json"
chmod 600 "$LATTICE_ROVER_DEVICE_TOKEN_FILE" "$LATTICE_QUADRUPED_DEVICE_TOKEN_FILE"
./scripts/run-hosted-heterogeneous.sh --check
./scripts/run-hosted-heterogeneous.sh
```

Cloud Run hosts the control plane; this runner hosts the two separate physics
simulators, local motion watchdogs and camera inference. Each body agent receives
only its own scoped Lattice credential. The signing key and database credential
stay in Cloud Run. Inference and MuJoCo receive a minimal environment without
inherited credentials; the runtime Gazebo container mounts only simulation assets,
installed ROS binaries and its private socket directory.

The runner checks HTTPS, distinct credentials and private file permissions,
requires a durable OIDC core before startup, persists separate body sequences,
and cleans up only its own processes/container. `--check` validates local
configuration only; it does not verify account access or start physics.
Use `run-durable-heterogeneous-warehouse.sh` for local development. The older
single-rover `run-hosted-warehouse.sh` remains available with
`LATTICE_DEVICE_TOKEN_FILE`. Do not expose either Unix gateway as a public TCP
service. Hosted two-body integration still needs verification once a core exists.

## Rollouts and recovery

One active core owns the database. A startup takes a new epoch and atomically
holds unfinished work. Every transaction checks that epoch under a PostgreSQL
advisory transaction lock. A previous revision remains unable to read/write after
it is fenced, even while its process is alive. No work resumes automatically.

The manifest requests one instance with CPU always allocated. Temporary revision
overlap is still possible; database fencing supplies correctness. Deploy while the
simulator is idle. A failed rollout may already have held missions; restoring the
previous image also creates a new epoch and requires fresh recovery approval.
Repeated instance restarts preserve safety by holding work, but reduce availability.
This is a single-writer demo deployment, not a high-availability fleet scheduler.

Before calling the backend live, check sign-in/logout for every role, issue and
revoke a robot credential, perform a complete round, restart the core during motion,
verify stopping and evidence retention, approve recovery and verify arrival. Run
the adaptive blocked-route case, verify the source remains stopped until reviewed
replan approval, and verify the receiving body acknowledges the retained image.
Run backup restoration into a separate database with the original signing identity;
never test restoration by overwriting the active demo database.

## Reproduce the local integration checks

```bash
npm ci --prefix apps/control-center
cd apps/control-center && npx playwright install --with-deps chromium && cd ../..
python3 -m pip install -r tests/identity/requirements.txt
./scripts/test-hosted.sh
```

The script creates disposable PostgreSQL/Keycloak containers, users, credentials
and signing keys, runs browser and API checks, then removes its containers and
secret fixture files. Set `CHROMIUM_PATH` to use an existing Chromium installation.
Ports 8000, 5173, 18080, 55434 and 18180–18182 must be free. It does not use `.env`.
