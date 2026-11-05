#!/usr/bin/env bash
# Disposable integration environment; no project credentials or production resources.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR=$PWD
python3 - <<'PY'
import socket
for port in (8000,5173,18080,55434,18180,18181,18182):
 with socket.socket() as s:s.bind(('127.0.0.1',port))
PY
cargo build --locked -p lattice-core-api
work=$(mktemp -d "$ROOT_DIR/target/identity-test.XXXXXX")
chmod 700 "$work"
db="lattice-identity-db-$UID-$$"
idp="lattice-identity-idp-$UID-$$"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  docker logs "$idp" > "$work/identity.log" 2>&1 || true
  docker rm -f "$db" "$idp" >/dev/null 2>&1 || true
  rm -f "$work/postgres.env" "$work/keycloak.env" "$work/lattice-realm.json" "$work/password" "$work/signing.key"
}
trap cleanup EXIT INT TERM
python3 - "$work" <<'PY'
import json,secrets,sys
from pathlib import Path
root=Path(sys.argv[1]);password=secrets.token_hex(24)
realm=json.loads(Path('infrastructure/identity/realm.json').read_text().replace('__SITE__','http://localhost:5173'))
realm['sslRequired']='none'
realm['users']=[{'username':role,'enabled':True,'email':role+'@test.invalid','emailVerified':True,'firstName':'Test','lastName':role,'realmRoles':['lattice-'+role],'credentials':[{'type':'password','value':password,'temporary':False}]} for role in ['viewer','operator','admin']]
files={'lattice-realm.json':json.dumps(realm),'password':password,'postgres.env':f'POSTGRES_PASSWORD={password}\nPOSTGRES_DB=lattice_auth\n','keycloak.env':f'KC_BOOTSTRAP_ADMIN_USERNAME=bootstrap\nKC_BOOTSTRAP_ADMIN_PASSWORD={secrets.token_hex(24)}\n'}
for name,content in files.items():
 p=root/name;p.write_text(content);p.chmod(0o600)
p=root/'signing.key';p.write_bytes(secrets.token_bytes(32));p.chmod(0o600)
# Keycloak runs as an unprivileged UID and needs to read its generated import file.
(root/'lattice-realm.json').chmod(0o644)
PY
export LATTICE_TEST_PASSWORD="$(cat "$work/password")"
docker run -d --name "$db" --env-file "$work/postgres.env" -p 127.0.0.1:55434:5432 postgres:18.4-alpine >/dev/null
docker run -d --name "$idp" --env-file "$work/keycloak.env" -p 127.0.0.1:18080:8080 -v "$work/lattice-realm.json:/opt/keycloak/data/import/lattice-realm.json:ro" quay.io/keycloak/keycloak:26.4.7 start-dev --import-realm --hostname http://localhost:18080 >/dev/null
for _ in $(seq 1 90); do
  if curl --noproxy '*' --fail --silent http://localhost:18080/realms/lattice/.well-known/openid-configuration >/dev/null && docker exec "$db" pg_isready -U postgres >/dev/null; then break; fi
  sleep 1
done
docker exec "$db" createdb -U postgres lattice_security
export LATTICE_TEST_DATABASE_URL="postgres://postgres:$LATTICE_TEST_PASSWORD@127.0.0.1:55434/lattice_security"
python3 scripts/smoke-identities.py
export LATTICE_AUTH_MODE=oidc LATTICE_BIND_ADDRESS=127.0.0.1:8000 LATTICE_ALLOWED_ORIGIN=http://localhost:5173
export LATTICE_OIDC_ISSUER=http://localhost:18080/realms/lattice LATTICE_OIDC_JWKS_URL=http://localhost:18080/realms/lattice/protocol/openid-connect/certs
export LATTICE_OIDC_CLIENT_ID=lattice-ui LATTICE_OIDC_AUDIENCE=lattice-api
export LATTICE_DATABASE_URL="postgres://postgres:$LATTICE_TEST_PASSWORD@127.0.0.1:55434/lattice_auth"
export LATTICE_SIGNING_KEY_FILE="$work/signing.key" NO_PROXY="${NO_PROXY:-},localhost,127.0.0.1"
unset LATTICE_SIGNING_SEED_BASE64 LATTICE_ALLOW_CORE_TAKEOVER
./target/debug/lattice-core-api > "$work/core.log" 2>&1 & pids+=("$!")
node apps/control-center/node_modules/vite/bin/vite.js apps/control-center --host 127.0.0.1 > "$work/frontend.log" 2>&1 & pids+=("$!")
for _ in $(seq 1 30); do
  if curl --noproxy '*' --fail --silent http://localhost:8000/ready >/dev/null && curl --noproxy '*' --fail --silent http://localhost:5173/operator.html >/dev/null; then break; fi
  sleep 1
done
node tests/browser/identity.cjs

node tests/browser/visitor.cjs
node tests/browser/accessibility.cjs
node tests/browser/console-accessibility.cjs
node tests/browser/handoff-ui.cjs
node tests/browser/route-planner.cjs
node tests/browser/adaptive-route-ui.cjs
node tests/browser/handoff-visitor.cjs
LATTICE_VISITOR_URL=http://localhost:5173/ LATTICE_EXPECT_OPERATOR_LINK=1 node tests/browser/handoff-recording.cjs
LATTICE_VISITOR_URL=http://localhost:5173/ node tests/browser/capability-recording.cjs
LATTICE_VISITOR_URL=http://localhost:5173/ LATTICE_REQUIRE_ADAPTIVE_VIDEO=1 node tests/browser/adaptive-recording.cjs
