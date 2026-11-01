#!/usr/bin/env bash
set -euo pipefail

output_dir="${1:-.dev-pki}"
mkdir -p "${output_dir}"
chmod 700 "${output_dir}"

openssl genpkey -algorithm ED25519 -out "${output_dir}/ca.key"
openssl req -x509 -new -key "${output_dir}/ca.key" \
  -out "${output_dir}/ca.crt" -days 30 \
  -subj "/CN=Lattice Development CA"

echo "Created a development CA in ${output_dir}."
echo "Do not reuse this CA for physical hardware or production."
