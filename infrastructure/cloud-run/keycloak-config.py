#!/usr/bin/env python3
"""Prepare password-free realm/client imports for an existing managed Keycloak."""
import argparse
import json
from pathlib import Path

from render import ROOT, https


def imports(site):
    site = https({"site": site}, "site", origin=True)
    template = json.loads((ROOT / "infrastructure/identity/realm.json").read_text())
    def replace(value):
        if isinstance(value, dict):
            return {key: replace(child) for key, child in value.items()}
        if isinstance(value, list):
            return [replace(child) for child in value]
        return value.replace("__SITE__", site) if isinstance(value, str) else value
    return replace(template)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-origin", required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "target/identity-import")
    args = parser.parse_args()
    try:
        realm = imports(args.site_origin)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "lattice-realm.json").write_text(json.dumps(realm, indent=2) + "\n")
    (args.output / "lattice-client.json").write_text(json.dumps(realm["clients"][0], indent=2) + "\n")
    print(f"Password-free realm and client import files written to {args.output}")


if __name__ == "__main__":
    main()
