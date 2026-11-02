#!/usr/bin/env bash
# Reuse the protected credentials, PostgreSQL volume and restore safeguards.
set -euo pipefail
cd "$(dirname "$0")/.."
export LATTICE_HETEROGENEOUS=1
exec ./scripts/run-durable-warehouse.sh
