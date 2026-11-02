#!/usr/bin/env bash
# Two simulator bodies, two scoped credentials, one existing HTTPS control plane.
# This never starts a local core or reads the development .env file.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR=$PWD
: "${LATTICE_CORE_URL:?Set the deployed HTTPS core origin}"
: "${LATTICE_ROVER_DEVICE_TOKEN_FILE:?Set the private gazebo-rover credential file}"
: "${LATTICE_QUADRUPED_DEVICE_TOKEN_FILE:?Set the private mujoco-go1 credential file}"
export LATTICE_NAVIGATION_MAP_FILE="${LATTICE_NAVIGATION_MAP_FILE:-$ROOT_DIR/simulation/routes/warehouse-adaptive.json}"
python3 - <<'PY'
import json,os,stat
from pathlib import Path
from urllib.parse import urlparse
def require(condition,message):
 if not condition:raise SystemExit(message)
url=urlparse(os.environ['LATTICE_CORE_URL'])
require(url.scheme=='https' and url.hostname and not url.username and not url.password and not url.path and not url.query and not url.fragment, 'Core must be an exact HTTPS origin')
tokens=[]
for name in ('LATTICE_ROVER_DEVICE_TOKEN_FILE','LATTICE_QUADRUPED_DEVICE_TOKEN_FILE'):
 p=Path(os.environ[name]);s=p.stat()
 require(p.is_file() and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)&0o077==0, 'Each device credential must be a private user-owned file')
 value=p.read_text().strip()
 require(value.startswith('lattice_device_') and len(value)<=200, 'Expected a scoped robot credential')
 tokens.append(value)
require(tokens[0]!=tokens[1], 'Rover and Go1 require distinct scoped credentials')
p=Path(os.environ['LATTICE_NAVIGATION_MAP_FILE'])
require(p.stat().st_size<=65536, 'Trusted map exceeds 64KiB')
m=json.loads(p.read_text());require(m['frame_id']=='map', 'Trusted map must use the map frame')
require({s['id'] for s in m['segments']} >= {'stairs_to_upper'}, 'Trusted map lacks the Go1 stair segment')
print('Local hosted configuration validated: distinct device credentials and map '+m['id'])
PY
if [[ "${1:-}" == '--check' ]]; then exit 0; fi
[[ $# == 0 ]] || { echo 'Usage: run-hosted-heterogeneous.sh [--check]' >&2; exit 1; }
export LATTICE_ROVER_DEVICE_TOKEN_FILE="$(realpath "$LATTICE_ROVER_DEVICE_TOKEN_FILE")"
export LATTICE_QUADRUPED_DEVICE_TOKEN_FILE="$(realpath "$LATTICE_QUADRUPED_DEVICE_TOKEN_FILE")"
export LATTICE_NAVIGATION_MAP_FILE="$(realpath "$LATTICE_NAVIGATION_MAP_FILE")"
python3 - <<'PY'
import json,os,socket,urllib.request
with socket.socket() as s:s.bind(('127.0.0.1',8001))
# Use configured TLS trust and proxy; never bypass an egress denial.
with urllib.request.urlopen(os.environ['LATTICE_CORE_URL']+'/v1/auth/config',timeout=10) as r:
 c=json.load(r)
if c['mode']!='oidc' or not c['durable']:raise SystemExit('Hosted bodies require the durable OIDC core')
with urllib.request.urlopen(os.environ['LATTICE_CORE_URL']+'/ready',timeout=10) as r:
 if r.status!=200:raise SystemExit('Hosted core is not ready')
PY
AI_PYTHON="$ROOT_DIR/services/lattice-ai-gateway/.venv/bin/python"
QUAD_PYTHON="${LATTICE_QUADRUPED_VENV:-$ROOT_DIR/target/quadruped-venv}/bin/python"
QUAD_ASSETS="${LATTICE_QUADRUPED_ASSETS:-$ROOT_DIR/target/quadruped-assets}"
[[ -x "$AI_PYTHON" && -x "$QUAD_PYTHON" ]] || { echo 'Install warehouse inference and scripts/install-quadruped.sh first.' >&2; exit 1; }
"$QUAD_PYTHON" simulation/quadruped/assets.py --output "$QUAD_ASSETS" --verify
NAV2_IMAGE=ghcr.io/ros-navigation/navigation2@sha256:243dec3ba8c7d7af47c27bd87056e8271c3a894d578d7860919e2d395a43724c
NAV2_COMMIT=d5d768b7b38a05e7cfd2b6c693b786b402161bed
mkdir -p target/nav2-source .lattice-state/hosted
chmod 700 .lattice-state .lattice-state/hosted
if [[ ! -f target/nav2-source/nav2_common/CMakeLists.txt ]]; then
  git -C target/nav2-source init -q
  git -C target/nav2-source fetch --depth 1 https://github.com/ros-navigation/navigation2.git "$NAV2_COMMIT"
  git -C target/nav2-source checkout --detach FETCH_HEAD
fi
[[ "$(git -C target/nav2-source rev-parse HEAD)" == "$NAV2_COMMIT" ]] || { echo 'Nav2 source differs from the pinned commit' >&2; exit 1; }
cargo build --locked -p lattice-ros2-body
docker run --rm -v "$ROOT_DIR:/work" -v "$ROOT_DIR/target/nav2-source:/opt/overlay_ws/src/navigation2:ro" "$NAV2_IMAGE" bash /work/simulation/build-ros.sh
run_dir=$(mktemp -d "$ROOT_DIR/target/hosted-heterogeneous.XXXXXX")
mkdir -m 700 "$run_dir/rover" "$run_dir/quadruped"
container="lattice-hosted-heterogeneous-$UID-$$"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  docker logs "$container" > "$run_dir/ros.log" 2>&1 || true
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# These processes only read installed local assets and bind private/loopback sockets.
# They receive no inherited Lattice, cloud, repository or device credentials.
env -i PATH="$PATH" OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  "$AI_PYTHON" -m uvicorn app.main:app --app-dir services/lattice-ai-gateway \
  --host 127.0.0.1 --port 8001 > "$run_dir/ai.log" 2>&1 & pids+=("$!")
docker run -d --init --name "$container" --user "$(id -u):$(id -g)" \
  -v "$ROOT_DIR/simulation:/work/simulation:ro" \
  -v "$ROOT_DIR/target/nav2-install:/work/target/nav2-install:ro" \
  -v "$ROOT_DIR/target/gateway-install:/work/target/gateway-install:ro" \
  -v "$ROOT_DIR/target/nav2-watchdog:/work/target/nav2-watchdog:ro" \
  -v "$ROOT_DIR/target/nav2-source:/opt/overlay_ws/src/navigation2:ro" \
  -v "$run_dir/rover:/run/lattice" -e ROS_LOG_DIR=/tmp/ros-logs \
  "$NAV2_IMAGE" bash /work/simulation/start-ros.sh >/dev/null
docker wait "$container" > "$run_dir/container-exit-code" & pids+=("$!")
export LATTICE_ROVER_SOCKET="$run_dir/rover/gateway.sock" LATTICE_QUADRUPED_SOCKET="$run_dir/quadruped/gateway.sock"
env -i PATH="$PATH" OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MUJOCO_GL=egl \
  "$QUAD_PYTHON" simulation/quadruped/gateway.py --socket "$LATTICE_QUADRUPED_SOCKET" \
  --map "$LATTICE_NAVIGATION_MAP_FILE" --assets "$QUAD_ASSETS" > "$run_dir/quadruped/gateway.log" 2>&1 & pids+=("$!")
python3 - <<'PY'
import json,os,socket,time,urllib.request
client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _ in range(180):
 try:
  for name in ('LATTICE_ROVER_SOCKET','LATTICE_QUADRUPED_SOCKET'):
   with socket.socket(socket.AF_UNIX) as s:
    s.settimeout(1);s.connect(os.environ[name]);s.sendall(b'{"op":"status"}\n')
    state=json.loads(s.makefile('r').readline());assert state['ready'] and state['pose']
  with client.open('http://127.0.0.1:8001/health',timeout=1) as r:assert r.status==200
  break
 except (OSError,ValueError,AssertionError):time.sleep(1)
else:raise SystemExit('Both localized simulators did not become ready; inspect run logs')
PY
export LATTICE_AI_GATEWAY_URL=http://127.0.0.1:8001
export NO_PROXY="${NO_PROXY:-},localhost,127.0.0.1"
body_env=(env -u LATTICE_DEV_API_KEY -u LATTICE_DATABASE_URL -u LATTICE_SIGNING_KEY_FILE
  -u LATTICE_SIGNING_SEED_BASE64 -u LATTICE_DEVICE_TOKEN -u LATTICE_DEVICE_TOKEN_FILE
  -u LATTICE_ROVER_DEVICE_TOKEN_FILE -u LATTICE_QUADRUPED_DEVICE_TOKEN_FILE
  -u GH_TOKEN -u GOOGLE_APPLICATION_CREDENTIALS -u AZURE_FEDERATED_TOKEN_FILE -u AZURE_TOKEN_CREDENTIALS)
"${body_env[@]}" LATTICE_DEVICE_TOKEN_FILE="$LATTICE_ROVER_DEVICE_TOKEN_FILE" \
  LATTICE_BODY_ID=gazebo-rover LATTICE_BODY_KIND=rover LATTICE_ROS_SOCKET="$LATTICE_ROVER_SOCKET" \
  LATTICE_SEQUENCE_FILE="$ROOT_DIR/.lattice-state/hosted/gazebo-rover.sequence.json" \
  target/debug/lattice-ros2-body > "$run_dir/rover/body.log" 2>&1 & pids+=("$!")
"${body_env[@]}" LATTICE_DEVICE_TOKEN_FILE="$LATTICE_QUADRUPED_DEVICE_TOKEN_FILE" \
  LATTICE_BODY_ID=mujoco-go1 LATTICE_BODY_KIND=quadruped LATTICE_ROS_SOCKET="$LATTICE_QUADRUPED_SOCKET" \
  LATTICE_SEQUENCE_FILE="$ROOT_DIR/.lattice-state/hosted/mujoco-go1.sequence.json" \
  target/debug/lattice-ros2-body > "$run_dir/quadruped/body.log" 2>&1 & pids+=("$!")
echo "Hosted body adapters started; verify both scoped identities online in the operator UI. Logs: $run_dir"
echo 'Gazebo and MuJoCo remain separate physics worlds. Ctrl-C stops this run; sequence state is retained.'
wait -n "${pids[@]}"
