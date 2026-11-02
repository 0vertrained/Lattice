#!/usr/bin/env python3
"""Derive Lattice deployment variables in Cloud Shell; preview before --apply.

Uses the user's existing gcloud/gh login. Never reads or prints credentials.
Requires setup-gcp.sh to have already created the dedicated Lattice resources.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import urllib.request
from urllib.parse import urlparse

from preflight import prepare
from render import ROOT, configuration, https

REPOSITORY = "0vertrained/Lattice"


def discover_keycloak(issuer):
    issuer = https({"issuer": issuer}, "issuer").rstrip("/")
    with urllib.request.urlopen(issuer + "/.well-known/openid-configuration", timeout=15) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise ValueError("Identity discovery document exceeds 64 KiB")
    metadata = json.loads(raw)
    if metadata.get("issuer") != issuer:
        raise ValueError("Identity discovery issuer does not match the supplied issuer")
    if "RS256" not in metadata.get("id_token_signing_alg_values_supported", []):
        raise ValueError("The identity provider must support RS256")
    if "code" not in metadata.get("response_types_supported", []):
        raise ValueError("The identity provider must support authorization code sign-in")
    jwks = https({"jwks": metadata.get("jwks_uri", "")}, "jwks")
    return issuer, jwks


def deployment_variables(project, number, region, site, issuer, jwks, route_map):
    if not re.fullmatch(r"[0-9]+", number):
        raise ValueError("gcloud did not return a numeric project number")
    config = configuration({"GCP_PROJECT": project, "GCP_REGION": region,
                            "LATTICE_SITE_ORIGIN": site, "LATTICE_OIDC_ISSUER": issuer,
                            "LATTICE_OIDC_JWKS_URL": jwks, "LATTICE_ROUTE_MAP": route_map})
    config.update({"GCP_WIF_PROVIDER": f"projects/{number}/locations/global/workloadIdentityPools/lattice-github/providers/lattice",
                   "GCP_DEPLOY_SERVICE_ACCOUNT": f"lattice-deployer@{project}.iam.gserviceaccount.com"})
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", default="us-central1")
    parser.add_argument("--site-origin", required=True, help="the actual Netlify production origin")
    parser.add_argument("--issuer", required=True, help="the managed Keycloak realm issuer")
    parser.add_argument("--route-map", default="warehouse-adaptive")
    parser.add_argument("--output", type=Path, default=ROOT / "target/hosted-release")
    parser.add_argument("--apply", action="store_true", help="write the reviewed non-secret variables to 0vertrained/Lattice")
    args = parser.parse_args()
    try:
        # Validate local inputs before any CLI/network call. The real JWKS URL is
        # derived from HTTPS discovery below, never guessed from a host name.
        configuration({"GCP_PROJECT": args.project, "GCP_REGION": args.region,
                       "LATTICE_SITE_ORIGIN": args.site_origin, "LATTICE_OIDC_ISSUER": args.issuer,
                       "LATTICE_OIDC_JWKS_URL": args.issuer, "LATTICE_ROUTE_MAP": args.route_map})
        number = subprocess.check_output(["gcloud", "projects", "describe", args.project,
                                          "--format=value(projectNumber)"], text=True).strip()
        issuer, jwks = discover_keycloak(args.issuer)
        variables = deployment_variables(args.project, number, args.region, args.site_origin,
                                         issuer, jwks, args.route_map)
        prepare(variables, args.output, require_wif=True)
        print(json.dumps({"repository": REPOSITORY, "workflow_variables": variables,
                          "netlify_identity_origin": f"{urlparse(issuer).scheme}://{urlparse(issuer).netloc}",
                          "deployment_performed": False}, indent=2), flush=True)
        if args.apply:
            for name, value in variables.items():
                subprocess.run(["gh", "variable", "set", name, "--repo", REPOSITORY, "--body", value], check=True)
            print("Lattice repository variables saved. No deployment was started.")
        else:
            print("Preview only. Re-run with --apply to save these non-secret repository variables.")
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
