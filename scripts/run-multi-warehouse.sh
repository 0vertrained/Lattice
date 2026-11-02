#!/usr/bin/env bash
# One world, two real ROS body adapters, independent local safety gateways.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR=$PWD
NAV2_IMAGE=ghcr.io/ros-navigation/navigation2@sha256:243dec3ba8c7d7af47c27bd87056e8271c3a894d578d7860919e2d395a43724c
NAV2_COMMIT=d5d768b7b38a05e7cfd2b6c693b786b402161bed
command -v cargo >/dev/null || { echo 'Cargo is not on PATH; load the repository development environment first.' >&2; exit 1; }
command -v docker >/dev/null || { echo 'Docker is required for the warehouse simulator.' >&2; exit 1; }
if [[ -f .env ]]; then set -a; source .env; set +a; fi
: "${LATTICE_DEV_API_KEY:?Set the development API key in .env or the environment before running the demo}"
export LATTICE_DEV_API_KEY
export LATTICE_AUTH_MODE="${LATTICE_AUTH_MODE:-development}"
export LATTICE_BIND_ADDRESS=127.0.0.1:8000 LATTICE_CORE_URL=http://127.0.0.1:8000
export LATTICE_ALLOWED_ORIGIN=http://localhost:5173
export LATTICE_COMMAND_TTL_SECONDS="${LATTICE_COMMAND_TTL_SECONDS:-60}"
export NO_PROXY="${NO_PROXY:-},localhost,127.0.0.1"
# Refuse occupied ports; never borrow another run's core, inference or UI.
python3 - <<'PY'
import socket
for port in (8000, 8001, 5173):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', port))
PY
AI_PYTHON="$ROOT_DIR/services/lattice-ai-gateway/.venv/bin/python"
[[ -x "$AI_PYTHON" ]] || { echo 'Install services/lattice-ai-gateway/requirements.txt into its .venv first.' >&2; exit 1; }
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
# Reuse the single-rover pinned image and build caches; no second ROS image.
docker run --rm -v "$ROOT_DIR:/work" \
  -v "$ROOT_DIR/target/nav2-source:/opt/overlay_ws/src/navigation2:ro" \
  "$NAV2_IMAGE" bash /work/simulation/build-ros.sh
run_dir=$(mktemp -d "$ROOT_DIR/target/multi-warehouse-run.XXXXXX")
mkdir -p "$run_dir/rover_a" "$run_dir/rover_b"
container="lattice-multi-warehouse-$UID-$$"
owned_pids=()
cleanup() {
  for pid in "${owned_pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${owned_pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  docker logs "$container" > "$run_dir/ros.log" 2>&1 || true
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Inference receives no credentials. Core alone receives durable DB/signing config.
env -u LATTICE_SIGNING_SEED_BASE64 -u LATTICE_DEVICE_TOKEN -u LATTICE_DEVICE_TOKEN_FILE -u LATTICE_DEV_API_KEY -u LATTICE_DATABASE_URL -u LATTICE_SIGNING_KEY_FILE -u GH_TOKEN -u AZURE_FEDERATED_TOKEN_FILE -u AZURE_TOKEN_CREDENTIALS \
  OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 "$AI_PYTHON" -m uvicorn app.main:app \
  --app-dir services/lattice-ai-gateway --host 127.0.0.1 --port 8001 > "$run_dir/ai.log" 2>&1 & owned_pids+=("$!")
python3 - <<'PY'
import time, urllib.request
client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _ in range(60):
    try:
        with client.open('http://127.0.0.1:8001/health', timeout=1) as response:
            assert response.status == 200
        break
    except (OSError, AssertionError):
        time.sleep(.5)
else:
    raise SystemExit('Local inference did not start; inspect ai.log')
PY
target/debug/lattice-core-api > "$run_dir/core.log" 2>&1 &
export LATTICE_CORE_PID=$!
owned_pids+=("$LATTICE_CORE_PID")
# The simulator gets only what it runs, read-only: never the repository root, .env or .lattice-state.
docker run -d --init --name "$container" --user "$(id -u):$(id -g)" \
  -v "$ROOT_DIR/simulation:/work/simulation:ro" \
  -v "$ROOT_DIR/target/nav2-install:/work/target/nav2-install:ro" \
  -v "$ROOT_DIR/target/gateway-install:/work/target/gateway-install:ro" \
  -v "$ROOT_DIR/target/nav2-watchdog:/work/target/nav2-watchdog:ro" \
  -v "$ROOT_DIR/target/nav2-source:/opt/overlay_ws/src/navigation2:ro" \
  -v "$run_dir:/run/lattice" -e ROS_LOG_DIR=/tmp/ros-logs \
  "$NAV2_IMAGE" bash /work/simulation/start-multi-ros.sh >/dev/null
docker wait "$container" > "$run_dir/container-exit-code" & owned_pids+=("$!")
export LATTICE_MULTI_RUN_DIR="$run_dir" LATTICE_ROS_CONTAINER="$container"
export LATTICE_ROVER_A_SOCKET="$run_dir/rover_a/gateway.sock"
export LATTICE_ROVER_B_SOCKET="$run_dir/rover_b/gateway.sock"
python3 - <<'PY'
import json, os, socket, time
pending = {os.environ['LATTICE_ROVER_A_SOCKET'], os.environ['LATTICE_ROVER_B_SOCKET']}
for _ in range(180):
    for path in list(pending):
        try:
            with socket.socket(socket.AF_UNIX) as sock:
                sock.settimeout(1)
                sock.connect(path)
                sock.sendall(b'{"op":"status"}\n')
                state = json.loads(sock.makefile('r').readline())
                if state.get('ready') and state.get('pose'):
                    pending.remove(path)
        except (OSError, ValueError):
            pass
    if not pending:
        break
    time.sleep(1)
else:
    raise SystemExit('Both localized Nav2 gateways did not become ready; inspect ros.log')
PY
env -u LATTICE_SIGNING_SEED_BASE64 -u LATTICE_SIGNING_KEY_FILE -u LATTICE_DATABASE_URL \
  LATTICE_BODY_ID=gazebo-rover-a LATTICE_ROS_SOCKET="$LATTICE_ROVER_A_SOCKET" \
  LATTICE_SEQUENCE_FILE="$run_dir/rover_a/sequence.json" \
  target/debug/lattice-ros2-body > "$run_dir/rover_a/body.log" 2>&1 &
export LATTICE_BODY_A_PID=$!
owned_pids+=("$LATTICE_BODY_A_PID")
env -u LATTICE_SIGNING_SEED_BASE64 -u LATTICE_SIGNING_KEY_FILE -u LATTICE_DATABASE_URL \
  LATTICE_BODY_ID=gazebo-rover-b LATTICE_ROS_SOCKET="$LATTICE_ROVER_B_SOCKET" \
  LATTICE_SEQUENCE_FILE="$run_dir/rover_b/sequence.json" \
  target/debug/lattice-ros2-body > "$run_dir/rover_b/body.log" 2>&1 &
export LATTICE_BODY_B_PID=$!
owned_pids+=("$LATTICE_BODY_B_PID")
env -u LATTICE_SIGNING_SEED_BASE64 -u LATTICE_DEVICE_TOKEN -u LATTICE_DEVICE_TOKEN_FILE -u LATTICE_DEV_API_KEY -u LATTICE_DATABASE_URL -u LATTICE_SIGNING_KEY_FILE -u GH_TOKEN -u AZURE_FEDERATED_TOKEN_FILE -u AZURE_TOKEN_CREDENTIALS \
  node apps/control-center/node_modules/vite/bin/vite.js apps/control-center --host 127.0.0.1 > "$run_dir/frontend.log" 2>&1 & owned_pids+=("$!")
python3 - <<'PY'
import json, os
from pathlib import Path
names = ('LATTICE_MULTI_RUN_DIR', 'LATTICE_ROS_CONTAINER', 'LATTICE_ROVER_A_SOCKET',
         'LATTICE_ROVER_B_SOCKET', 'LATTICE_BODY_A_PID', 'LATTICE_BODY_B_PID', 'LATTICE_CORE_PID')
(Path(os.environ['LATTICE_MULTI_RUN_DIR']) / 'runtime.json').write_text(
    json.dumps({name: os.environ[name] for name in names}, indent=2) + '\n')
PY
echo "Two-rover warehouse started. Logs: $run_dir; ROS logs: docker logs $container"
echo 'Open http://localhost:5173/operator.html and use the API key from your existing .env. Ctrl-C stops this run.'
if [[ "${LATTICE_HANDOFF_SHOWCASE:-0}" == 1 ]]; then
  python3 scripts/record-shared-memory-handoff.py
else
  wait -n "${owned_pids[@]}"
fi
