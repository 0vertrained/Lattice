#!/usr/bin/env bash
# Connect a local simulator to an existing HTTPS core using a scoped robot identity.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR=$PWD
: "${LATTICE_CORE_URL:?Set the hosted HTTPS core origin}"
: "${LATTICE_DEVICE_TOKEN_FILE:?Set the private one-time robot credential file}"
python3 - <<'PY'
import os,socket,stat
from pathlib import Path
from urllib.parse import urlparse
url=urlparse(os.environ['LATTICE_CORE_URL'])
assert url.scheme=='https' and url.hostname and not url.username and not url.password and url.path in ('','/') and not url.query and not url.fragment,'Core must be an HTTPS origin'
p=Path(os.environ['LATTICE_DEVICE_TOKEN_FILE']);s=p.stat()
assert s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)&0o077==0,'Credential file must belong to this user and have private permissions'
assert p.read_text().strip().startswith('lattice_device_'),'Expected a scoped robot credential'
with socket.socket() as s:s.bind(('127.0.0.1',8001))
PY
export LATTICE_DEVICE_TOKEN_FILE="$(realpath "$LATTICE_DEVICE_TOKEN_FILE")"
export LATTICE_BODY_ID="${LATTICE_BODY_ID:-gazebo-rover}"
NAV2_IMAGE=ghcr.io/ros-navigation/navigation2@sha256:243dec3ba8c7d7af47c27bd87056e8271c3a894d578d7860919e2d395a43724c
NAV2_COMMIT=d5d768b7b38a05e7cfd2b6c693b786b402161bed
mkdir -p target/nav2-source .lattice-state
chmod 700 .lattice-state
if [[ ! -f target/nav2-source/nav2_common/CMakeLists.txt ]]; then
  git -C target/nav2-source init -q
  git -C target/nav2-source fetch --depth 1 https://github.com/ros-navigation/navigation2.git "$NAV2_COMMIT"
  git -C target/nav2-source checkout --detach FETCH_HEAD
fi
[[ "$(git -C target/nav2-source rev-parse HEAD)" == "$NAV2_COMMIT" ]] || { echo 'Nav2 source differs from the pinned commit' >&2; exit 1; }
cargo build --locked -p lattice-ros2-body
docker run --rm -v "$ROOT_DIR:/work" -v "$ROOT_DIR/target/nav2-source:/opt/overlay_ws/src/navigation2:ro" "$NAV2_IMAGE" bash /work/simulation/build-ros.sh
run_dir=$(mktemp -d "$ROOT_DIR/target/hosted-warehouse.XXXXXX")
container="lattice-hosted-warehouse-$UID-$$"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  docker logs "$container" > "$run_dir/ros.log" 2>&1 || true
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
# Clear all control credentials from the local perception process.
env -i PATH="$PATH" OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  services/lattice-ai-gateway/.venv/bin/python -m uvicorn app.main:app \
  --app-dir services/lattice-ai-gateway --host 127.0.0.1 --port 8001 > "$run_dir/ai.log" 2>&1 & pids+=("$!")
# The simulator gets only what it runs, read-only: never the repository root, .env or .lattice-state.
docker run -d --init --name "$container" --user "$(id -u):$(id -g)" \
  -v "$ROOT_DIR/simulation:/work/simulation:ro" \
  -v "$ROOT_DIR/target/nav2-install:/work/target/nav2-install:ro" \
  -v "$ROOT_DIR/target/gateway-install:/work/target/gateway-install:ro" \
  -v "$ROOT_DIR/target/nav2-watchdog:/work/target/nav2-watchdog:ro" \
  -v "$ROOT_DIR/target/nav2-source:/opt/overlay_ws/src/navigation2:ro" \
  -v "$run_dir:/run/lattice" -e ROS_LOG_DIR=/tmp/ros-logs "$NAV2_IMAGE" bash /work/simulation/start-ros.sh >/dev/null
export LATTICE_ROS_SOCKET="$run_dir/gateway.sock"
export LATTICE_SEQUENCE_FILE="${LATTICE_SEQUENCE_FILE:-$ROOT_DIR/.lattice-state/hosted-sequence.json}"
export LATTICE_AI_GATEWAY_URL=http://127.0.0.1:8001
export NO_PROXY="${NO_PROXY:-},localhost,127.0.0.1"
python3 - <<'PY'
import os,socket,time,urllib.request
client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _ in range(180):
 try:
  with socket.socket(socket.AF_UNIX) as s:s.connect(os.environ['LATTICE_ROS_SOCKET'])
  with client.open('http://127.0.0.1:8001/health',timeout=1) as r:assert r.status==200
  break
 except OSError:time.sleep(1)
else:raise SystemExit('Local simulator did not become ready; inspect printed logs')
PY
env -u LATTICE_DEV_API_KEY -u LATTICE_DATABASE_URL -u LATTICE_SIGNING_KEY_FILE -u LATTICE_SIGNING_SEED_BASE64 \
  target/debug/lattice-ros2-body > "$run_dir/body.log" 2>&1 & pids+=("$!")
echo "Hosted simulator connected; logs: $run_dir. Open the Netlify operator interface. Ctrl-C stops this run."
wait -n "${pids[@]}"
