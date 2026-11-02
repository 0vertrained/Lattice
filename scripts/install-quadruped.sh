#!/usr/bin/env bash
# Install pinned CPU-only physics/policy dependencies and verified upstream assets.
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
quad_venv=${LATTICE_QUADRUPED_VENV:-"$repo_root/target/quadruped-venv"}
quad_assets=${LATTICE_QUADRUPED_ASSETS:-"$repo_root/target/quadruped-assets"}
if ! command -v uv >/dev/null 2>&1; then
  echo 'uv is required; install it before running this setup script.' >&2
  exit 1
fi
uv venv --python 3.12 "$quad_venv"
uv pip install --python "$quad_venv/bin/python" -r "$repo_root/simulation/quadruped/requirements.txt"
"$quad_venv/bin/python" "$repo_root/simulation/quadruped/assets.py" --output "$quad_assets"
"$quad_venv/bin/python" -m unittest discover -s "$repo_root/simulation/quadruped" -p 'test_gateway.py' -q
echo "Quadruped Python: $quad_venv/bin/python"
echo "Verified assets: $quad_assets"
