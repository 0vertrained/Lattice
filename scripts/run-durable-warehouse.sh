#!/usr/bin/env bash
# Persistent local demo. PostgreSQL stays running when the robot demo exits.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR=$PWD
state_dir="$ROOT_DIR/.lattice-state"
identity=$(printf '%s' "$ROOT_DIR" | sha256sum | cut -c1-12)
container="lattice-postgres-$UID-$identity"
volume="${container}-data"
port="${LATTICE_POSTGRES_PORT:-55433}"
image=postgres:18.4-alpine
mkdir -p "$state_dir"
chmod 700 "$state_dir"
# A lost key/password is a restore operation, never a reason to silently reset identity.
if docker volume inspect "$volume" >/dev/null 2>&1; then
  [[ -f "$state_dir/signing.key" && -f "$state_dir/postgres.env" ]] || {
    echo 'Persistent database exists but local credentials are missing. Restore .lattice-state from backup.' >&2; exit 1;
  }
fi
python3 - "$state_dir" <<'PY'
import os,secrets,sys
from pathlib import Path
root=Path(sys.argv[1])
for name,content in [('signing.key',secrets.token_bytes(32)),('postgres.env',f'POSTGRES_DB=lattice\nPOSTGRES_USER=lattice\nPOSTGRES_PASSWORD={secrets.token_hex(32)}\n'.encode())]:
 path=root/name
 if not path.exists():
  fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'wb') as f: f.write(content);f.flush();os.fsync(f.fileno())
fd=os.open(root,os.O_RDONLY);os.fsync(fd);os.close(fd)
PY
if docker container inspect "$container" >/dev/null 2>&1; then
  [[ "$(docker inspect -f '{{index .Config.Labels "lattice.owner-path"}}' "$container")" == "$ROOT_DIR" ]] || {
    echo 'Database container name is owned by another workspace.' >&2; exit 1;
  }
  [[ "$(docker port "$container" 5432/tcp)" == "127.0.0.1:$port" ]] || {
    echo 'Existing database uses a different port; keep its original LATTICE_POSTGRES_PORT.' >&2; exit 1;
  }
  docker start "$container" >/dev/null
else
  docker run -d --name "$container" --label "lattice.owner-path=$ROOT_DIR" \
    --env-file "$state_dir/postgres.env" -p "127.0.0.1:$port:5432" \
    -v "$volume:/var/lib/postgresql" "$image" >/dev/null
fi
for attempt in $(seq 1 60); do
  if docker exec "$container" pg_isready -U lattice -d lattice >/dev/null; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -U lattice -d lattice >/dev/null
# The generated password is hex; no untrusted shell input is sourced.
password=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$state_dir/postgres.env")
export LATTICE_DATABASE_URL="postgres://lattice:$password@127.0.0.1:$port/lattice"
export LATTICE_SIGNING_KEY_FILE="$state_dir/signing.key"
echo "Persistent database: $container (loopback port $port)."
echo "Keep $state_dir and Docker volume $volume together when backing up."
exec ./scripts/run-warehouse.sh
