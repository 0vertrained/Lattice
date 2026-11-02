#!/usr/bin/env bash
# Linux development runner. Owns and cleans up only processes it creates.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR=$PWD
NAV2_IMAGE=ghcr.io/ros-navigation/navigation2@sha256:243dec3ba8c7d7af47c27bd87056e8271c3a894d578d7860919e2d395a43724c
NAV2_COMMIT=d5d768b7b38a05e7cfd2b6c693b786b402161bed
command -v cargo >/dev/null
command -v docker >/dev/null
if [[ -f .env ]]; then set -a; source .env; set +a; fi
: "${LATTICE_DEV_API_KEY:?Set the development API key in .env or the environment before running the demo}"
export LATTICE_DEV_API_KEY
mkdir -p target/nav2-source
if [[ ! -f target/nav2-source/nav2_common/CMakeLists.txt ]]; then
  git -C target/nav2-source init -q
  git -C target/nav2-source fetch --depth 1 https://github.com/ros-navigation/navigation2.git "$NAV2_COMMIT"
  git -C target/nav2-source checkout --detach FETCH_HEAD
fi
[[ "$(git -C target/nav2-source rev-parse HEAD)" == "$NAV2_COMMIT" ]] || {
  echo 'Cached Nav2 source differs from the tested commit; preserve it and select a fresh cache.' >&2; exit 1;
}
cargo build --locked -p lattice-core-api -p lattice-ros2-body
# Docker inherits the configured proxy. This build uses bundled dependencies only.
docker run --rm -v "$ROOT_DIR:/work" \
  -v "$ROOT_DIR/target/nav2-source:/opt/overlay_ws/src/navigation2:ro" \
  "$NAV2_IMAGE" bash /work/simulation/build-ros.sh
run_dir=$(mktemp -d "$ROOT_DIR/target/warehouse-run.XXXXXX")
container="lattice-warehouse-$UID-$$"
owned_pids=()
cleanup() {
  for pid in "${owned_pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${owned_pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  docker logs "$container" > "$run_dir/ros.log" 2>&1 || true
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
export LATTICE_BIND_ADDRESS=127.0.0.1:8000 LATTICE_CORE_URL=http://127.0.0.1:8000
export LATTICE_ALLOWED_ORIGIN=http://localhost:5173 LATTICE_COMMAND_TTL_SECONDS=120
export NO_PROXY="${NO_PROXY:-},localhost,127.0.0.1"
# Refuse occupied ports; never reuse an unrelated core or simulator.
python3 - <<'PY'
import socket
for port in (8000,8001,5173):
 with socket.socket() as sock: sock.bind(('127.0.0.1',port))
PY
AI_PYTHON="$ROOT_DIR/services/lattice-ai-gateway/.venv/bin/python"
[[ -x "$AI_PYTHON" ]] || { echo 'Install services/lattice-ai-gateway/requirements.txt into its .venv first.' >&2; exit 1; }
# Inference is loopback-only and receives no body/control credentials.
env -u LATTICE_DEV_API_KEY -u GH_TOKEN -u AZURE_FEDERATED_TOKEN_FILE -u AZURE_TOKEN_CREDENTIALS \
  OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 "$AI_PYTHON" -m uvicorn app.main:app \
  --app-dir services/lattice-ai-gateway --host 127.0.0.1 --port 8001 > "$run_dir/ai.log" 2>&1 & owned_pids+=("$!")
python3 - <<'PYREADY'
import time,urllib.request
client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _ in range(60):
 try:
  with client.open('http://127.0.0.1:8001/health',timeout=1) as response: assert response.status == 200
  break
 except (OSError,AssertionError): time.sleep(.5)
else: raise SystemExit('Local inference did not start; inspect ai.log')
PYREADY
target/debug/lattice-core-api > "$run_dir/core.log" 2>&1 & owned_pids+=("$!")
docker run -d --init --name "$container" --user "$(id -u):$(id -g)" \
  -v "$ROOT_DIR:/work" -v "$ROOT_DIR/target/nav2-source:/opt/overlay_ws/src/navigation2:ro" \
  -v "$run_dir:/run/lattice" -e ROS_LOG_DIR=/tmp/ros-logs \
  "$NAV2_IMAGE" bash /work/simulation/start-ros.sh >/dev/null
export LATTICE_ROS_SOCKET="$run_dir/gateway.sock" LATTICE_SEQUENCE_FILE="$run_dir/sequence.json"
python3 - <<'PY'
import os,socket,time
for _ in range(180):
 try:
  with socket.socket(socket.AF_UNIX) as sock: sock.connect(os.environ['LATTICE_ROS_SOCKET'])
  break
 except OSError: time.sleep(1)
else: raise SystemExit('Gateway socket did not start; inspect docker logs.')
PY
target/debug/lattice-ros2-body > "$run_dir/body.log" 2>&1 & owned_pids+=("$!")
node apps/control-center/node_modules/vite/bin/vite.js apps/control-center --host 127.0.0.1 > "$run_dir/frontend.log" 2>&1 & owned_pids+=("$!")
export LATTICE_BODY_PID="${owned_pids[2]}"
echo "Warehouse started. Logs: $run_dir; ROS logs: docker logs $container"
echo 'Use the API key from your existing .env in Control Center. Ctrl-C stops this run.'
if [[ "${LATTICE_SMOKE:-0}" == 1 ]]; then
  python3 scripts/smoke-navigation.py
  python3 scripts/smoke-watchdog.py
  python3 scripts/smoke-intelligence.py
else
  wait -n "${owned_pids[@]}"
fi
