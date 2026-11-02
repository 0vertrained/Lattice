#!/usr/bin/env bash
# Same protected persistent core; live obstacle observations can revise remaining work.
set -euo pipefail
cd "$(dirname "$0")/.."
export LATTICE_NAVIGATION_MAP_FILE="$PWD/simulation/routes/warehouse-adaptive.json"
export LATTICE_COMMAND_TTL_SECONDS="${LATTICE_COMMAND_TTL_SECONDS:-45}"
exec ./scripts/run-durable-heterogeneous-warehouse.sh
