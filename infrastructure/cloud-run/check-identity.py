#!/usr/bin/env python3
"""Check that the core will be able to load the identity provider's signing keys.

The core reads the realm's key set when it starts and stops if the set holds no
RSA signing key, which Cloud Run reports only as a failed startup probe. This
applies the same rule from the deploy runner, before any image is built. Both
documents are public, so nothing secret is sent or printed.
"""
import json
import os
import urllib.error
import urllib.request

from render import https


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(url, limit, redirects=False):
    # The core fetches only the key set and does not follow redirects, so a moved key set must
    # fail here too. Discovery is read only by this check and browsers, which both follow them.
    opener = urllib.request.build_opener() if redirects else urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(url, timeout=15) as response:
            body = response.read(limit + 1)
    except urllib.error.HTTPError as error:
        raise ValueError(f"{url} answered HTTP {error.code} {error.reason}") from None
    except (urllib.error.URLError, OSError) as error:
        raise ValueError(f"{url} could not be reached: {getattr(error, 'reason', error)}") from None
    if len(body) > limit:
        raise ValueError(f"{url} returned more than {limit // 1024} KiB")
    try:
        return json.loads(body)
    except ValueError:
        raise ValueError(f"{url} did not return JSON") from None


def signing_keys(key_set):
    """The key IDs the core would trust: RSA keys for signatures that carry an ID."""
    keys = key_set.get("keys") if isinstance(key_set, dict) else None
    if not isinstance(keys, list):
        raise ValueError("the response is not a JSON Web Key Set")
    usable = [key["kid"] for key in keys[:32]
              if isinstance(key, dict) and key.get("kty") == "RSA" and key.get("use") in (None, "sig")
              and isinstance(key.get("kid"), str) and key["kid"]
              and isinstance(key.get("n"), str) and isinstance(key.get("e"), str)]
    if not usable:
        raise ValueError(f"none of its {len(keys)} keys is an RSA signing key with a key ID")
    return usable


def check(issuer, jwks_url, fetch=fetch):
    discovery = fetch(issuer.rstrip("/") + "/.well-known/openid-configuration", 64 * 1024, redirects=True)
    if not isinstance(discovery, dict) or discovery.get("issuer") != issuer:
        raise ValueError(f"discovery at {issuer} names a different issuer; check LATTICE_OIDC_ISSUER")
    if discovery.get("jwks_uri") != jwks_url:
        raise ValueError(f"the realm publishes its keys at {discovery.get('jwks_uri')}, not LATTICE_OIDC_JWKS_URL; "
                         "rerun configure-github.py with --apply")
    key_set = fetch(jwks_url, 128 * 1024)
    try:
        return signing_keys(key_set)
    except ValueError as error:
        raise ValueError(f"{jwks_url}: {error}") from None


def main():
    try:
        issuer = https(os.environ, "LATTICE_OIDC_ISSUER")
        jwks_url = https(os.environ, "LATTICE_OIDC_JWKS_URL")
        keys = check(issuer, jwks_url)
    except ValueError as error:
        raise SystemExit(f"The core would stop at startup: {error}") from None
    print(f"Identity provider ready: RSA signing key {', '.join(keys)} at {jwks_url}")


if __name__ == "__main__":
    main()
