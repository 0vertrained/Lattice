#!/usr/bin/env python3
"""Validate deployment inputs and write a reviewable bundle without provisioning.

Values are deployment metadata, never secret contents. Run with repository
variables exported, or supply a non-secret JSON object through --config.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
from urllib.parse import urlparse

from render import ROOT, REQUIRED_INPUTS, configuration, render


def prepare(environment, output, include_manifest=False, require_wif=False):
    missing = [name for name in REQUIRED_INPUTS if not environment.get(name)]
    if require_wif:
        missing += [name for name in ("GCP_WIF_PROVIDER", "GCP_DEPLOY_SERVICE_ACCOUNT") if not environment.get(name)]
    if missing:
        return {"status": "configuration_missing", "missing": missing, "deployment_performed": False}
    config = configuration(environment)
    if require_wif:
        provider = environment["GCP_WIF_PROVIDER"]
        if not re.fullmatch(r"projects/[0-9]+/locations/global/workloadIdentityPools/lattice-github/providers/lattice", provider):
            raise ValueError("GCP_WIF_PROVIDER must identify the dedicated Lattice provider")
        deployer = f"lattice-deployer@{config['GCP_PROJECT']}.iam.gserviceaccount.com"
        if environment["GCP_DEPLOY_SERVICE_ACCOUNT"] != deployer:
            raise ValueError("GCP_DEPLOY_SERVICE_ACCOUNT must be the dedicated project Lattice deployer")
        config.update({"GCP_WIF_PROVIDER": provider, "GCP_DEPLOY_SERVICE_ACCOUNT": deployer})
    source = ROOT / "simulation/routes" / f"{config['LATTICE_ROUTE_MAP']}.json"
    semantic_map = json.loads(source.read_text())
    # Validate all requested outputs before writing a partial bundle.
    manifest = render(environment) if include_manifest else None
    if manifest is None and (output / "cloud-run-service.json").exists():
        raise ValueError("This bundle already contains a manifest; use --manifest or choose a fresh output directory")
    issuer = urlparse(config["LATTICE_OIDC_ISSUER"])
    report = {"status": "configuration_valid", "deployment_performed": False,
              "cloud_authentication_verified": False,
              "manifest_rendered": include_manifest,
              "route_map": {"file": source.name, "id": semantic_map["id"], "revision": semantic_map["revision"],
                            "file_sha256": hashlib.sha256(source.read_bytes()).hexdigest()},
              "required_external_setup": ["dedicated GCP project with billing and deployment access",
                                          "Netlify site with repository import or deploy access",
                                          "HTTPS OIDC provider issuing Lattice roles/audience",
                                          "persistent Linux simulator host with distinct rover and Go1 device credentials"]}
    output.mkdir(parents=True, exist_ok=True)
    (output / "workflow-variables.json").write_text(json.dumps(config, indent=2) + "\n")
    (output / "netlify-build-variables.json").write_text(json.dumps({
        "LATTICE_API_ORIGIN": "REPLACE_WITH_DEPLOYED_CLOUD_RUN_HTTPS_ORIGIN",
        "LATTICE_IDENTITY_ORIGIN": f"{issuer.scheme}://{issuer.netloc}"}, indent=2) + "\n")
    (output / "route-map.json").write_bytes(source.read_bytes())
    if manifest is not None:
        (output / "cloud-run-service.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "preflight.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, help="non-secret JSON deployment metadata; no account credentials")
    parser.add_argument("--output", type=Path, default=ROOT / "target/hosted-release")
    parser.add_argument("--manifest", action="store_true", help="also require immutable image digests and render the service")
    parser.add_argument("--require-wif", action="store_true", help="validate GitHub Actions federation bindings")
    args = parser.parse_args()
    values = dict(os.environ)
    if args.config:
        supplied = json.loads(args.config.read_text())
        if not isinstance(supplied, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in supplied.items()):
            raise SystemExit("Configuration must be an object of non-secret string deployment metadata")
        values.update(supplied)
    try:
        report = prepare(values, args.output, args.manifest, args.require_wif)
    except (ValueError, OSError) as error:
        raise SystemExit(str(error)) from error
    print(json.dumps(report, indent=2))
    if report["status"] != "configuration_valid":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
