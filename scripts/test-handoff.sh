#!/usr/bin/env bash
# Build and run transport-level continuity tests using a fresh disposable database.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --locked -p lattice-core-api
python3 - <<'PY'
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time

root = Path.cwd()
env = os.environ.copy()
for name in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'):
    env.pop(name, None)
docker = ['docker', '--host=unix:///var/run/docker.sock']
subprocess.run(docker + ['info', '--format', '{{.ServerVersion}}'], env=env, check=True, stdout=subprocess.DEVNULL)
name = 'lattice-handoff-test-' + secrets.token_hex(6)
python = env.get('LATTICE_TEST_PYTHON', str(root / 'services/lattice-ai-gateway/.venv/bin/python'))
if not Path(python).is_file():
    python = 'python3'
subprocess.run([python, '-c', 'import cryptography'], check=True)
with tempfile.TemporaryDirectory(prefix='lattice-handoff-db-') as directory:
    password = secrets.token_hex(24)
    config = Path(directory) / 'postgres.env'
    config.write_text('POSTGRES_PASSWORD=' + password + '\nPOSTGRES_DB=lattice_handoff_test\n')
    config.chmod(0o600)
    try:
        subprocess.run(docker + ['run', '-d', '--name', name, '--env-file', str(config),
            '-p', '127.0.0.1::5432', 'postgres:18.4-alpine'], env=env, check=True, stdout=subprocess.DEVNULL)
        port = subprocess.check_output(docker + ['port', name, '5432/tcp'], env=env, text=True).strip().rsplit(':', 1)[1]
        for _ in range(45):
            # The bootstrap server accepts Unix sockets before the final TCP
            # listener starts; only TCP readiness matches the core's connection.
            if subprocess.run(docker + ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Disposable PostgreSQL readiness timed out')
        env['LATTICE_TEST_DATABASE_URL'] = 'postgresql://postgres:' + password + '@127.0.0.1:' + port + '/lattice_handoff_test'
        subprocess.run([python, str(root / 'scripts/smoke-handoff.py')], env=env, check=True)
    finally:
        subprocess.run(docker + ['rm', '-fv', name], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
PY
