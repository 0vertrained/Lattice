#!/usr/bin/env python3
"""Render a reviewed Cloud Run service manifest; no credentials or API calls."""
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
MAPS = ("warehouse-stairs", "warehouse-adaptive")
REQUIRED_INPUTS = ("GCP_PROJECT", "LATTICE_SITE_ORIGIN", "LATTICE_OIDC_ISSUER", "LATTICE_OIDC_JWKS_URL")


def required(environment, name):
    value = environment.get(name, "")
    if not value:
        raise ValueError(f"{name} is required")
    return value


def https(environment, name, origin=False):
    value = required(environment, name)
    url = urlparse(value)
    try:
        url.port
    except ValueError as error:
        raise ValueError(f"{name} has an invalid port") from error
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.fragment or url.query or any(c.isspace() for c in value)
            or (origin and url.path)):
        raise ValueError(f"{name} must be a valid HTTPS {'origin' if origin else 'URL'}")
    return value


def configuration(environment):
    project = required(environment, "GCP_PROJECT")
    region = environment.get("GCP_REGION") or "us-central1"
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        raise ValueError("GCP_PROJECT must be a 6–30 character project ID")
    if not re.fullmatch(r"[a-z]+-[a-z]+[1-9][0-9]*", region):
        raise ValueError("GCP_REGION must be an explicit GCP region")
    route_map = environment.get("LATTICE_ROUTE_MAP") or "warehouse-adaptive"
    if route_map not in MAPS:
        raise ValueError(f"LATTICE_ROUTE_MAP must be one of {', '.join(MAPS)}")
    map_file = ROOT / "simulation" / "routes" / f"{route_map}.json"
    if not map_file.is_file() or map_file.stat().st_size > 65536:
        raise ValueError("Selected trusted route map is missing or exceeds 64 KiB")
    semantic_map = json.loads(map_file.read_text())
    if semantic_map.get("frame_id") != "map":
        raise ValueError("Selected trusted route map must use the map frame")
    version = environment.get("LATTICE_SECRET_VERSION") or "1"
    if not re.fullmatch(r"[1-9][0-9]*", version):
        raise ValueError("Pin LATTICE_SECRET_VERSION to a positive numeric version")
    return {
        "GCP_PROJECT": project, "GCP_REGION": region, "LATTICE_ROUTE_MAP": route_map,
        "LATTICE_SECRET_VERSION": version,
        "LATTICE_SITE_ORIGIN": https(environment, "LATTICE_SITE_ORIGIN", True),
        "LATTICE_OIDC_ISSUER": https(environment, "LATTICE_OIDC_ISSUER"),
        "LATTICE_OIDC_JWKS_URL": https(environment, "LATTICE_OIDC_JWKS_URL"),
    }


def pinned_image(environment, name, project, region, image):
    value = required(environment, name)
    expected = rf"{re.escape(region)}-docker\.pkg\.dev/{re.escape(project)}/lattice/{image}@sha256:[a-f0-9]{{64}}"
    if not re.fullmatch(expected, value):
        raise ValueError(f"{name} must pin the dedicated Lattice registry image by SHA-256 digest")
    return value


def render(environment):
    config = configuration(environment)
    project, region = config["GCP_PROJECT"], config["GCP_REGION"]
    connection = f"{project}:{region}:lattice-db"
    env = {
        "LATTICE_AUTH_MODE": "oidc", "LATTICE_BIND_ADDRESS": "0.0.0.0:8080",
        "LATTICE_ALLOWED_ORIGIN": config["LATTICE_SITE_ORIGIN"],
        "LATTICE_OIDC_ISSUER": config["LATTICE_OIDC_ISSUER"],
        "LATTICE_OIDC_JWKS_URL": config["LATTICE_OIDC_JWKS_URL"],
        "LATTICE_OIDC_CLIENT_ID": "lattice-ui", "LATTICE_OIDC_AUDIENCE": "lattice-api",
        "LATTICE_AI_GATEWAY_URL": "http://127.0.0.1:8100",
        "LATTICE_COMMAND_TTL_SECONDS": "120", "LATTICE_ALLOW_CORE_TAKEOVER": "1",
        "LATTICE_NAVIGATION_MAP_FILE": f"/app/routes/{config['LATTICE_ROUTE_MAP']}.json",
        "RUST_LOG": "info",
    }
    secrets = {"LATTICE_DATABASE_URL": "lattice-database-url", "LATTICE_SIGNING_SEED_BASE64": "lattice-signing-seed"}
    return {
        "apiVersion": "serving.knative.dev/v1", "kind": "Service",
        "metadata": {"name": "lattice-core", "labels": {"cloud.googleapis.com/location": region},
                     "annotations": {"run.googleapis.com/ingress": "all", "run.googleapis.com/invoker-iam-disabled": "true"}},
        "spec": {"template": {
            "metadata": {"annotations": {
                # Scale to zero between demos and bill CPU only while requests are in flight. Connected robots
                # heartbeat several times a second, which keeps the instance up for a whole session. The first
                # request after an idle spell waits a few seconds for a new instance, which, like any restart,
                # takes a new epoch and holds unfinished work for review.
                "autoscaling.knative.dev/minScale": "0", "autoscaling.knative.dev/maxScale": "1",
                "run.googleapis.com/cpu-throttling": "true", "run.googleapis.com/startup-cpu-boost": "true",
                # The v1 (Knative) API connects Cloud SQL through this annotation alone; it serves the socket at
                # /cloudsql/<connection>. v1 has no cloudSqlInstance volume and reserves the volume name "cloudsql".
                "run.googleapis.com/cloudsql-instances": connection,
                "run.googleapis.com/container-dependencies": '{"core":["inference"]}'}},
            "spec": {"serviceAccountName": f"lattice-runtime@{project}.iam.gserviceaccount.com",
                     "containerConcurrency": 40, "timeoutSeconds": 30,
                     "containers": [
                         {"name": "core", "image": pinned_image(environment, "LATTICE_CORE_IMAGE", project, region, "core"),
                          "ports": [{"containerPort": 8080}],
                          "resources": {"limits": {"cpu": "1", "memory": "512Mi"}},
                          "env": [{"name": k, "value": v} for k, v in env.items()] + [
                              {"name": k, "valueFrom": {"secretKeyRef": {"name": v, "key": config["LATTICE_SECRET_VERSION"]}}}
                              for k, v in secrets.items()],
                          "startupProbe": {"httpGet": {"path": "/ready", "port": 8080}, "periodSeconds": 2, "failureThreshold": 30, "timeoutSeconds": 1},
                          "livenessProbe": {"httpGet": {"path": "/health", "port": 8080}, "periodSeconds": 30, "failureThreshold": 3, "timeoutSeconds": 1}},
                         {"name": "inference", "image": pinned_image(environment, "LATTICE_INFERENCE_IMAGE", project, region, "inference"),
                          "resources": {"limits": {"cpu": "1", "memory": "512Mi"}},
                          "startupProbe": {"httpGet": {"path": "/health", "port": 8100}, "periodSeconds": 2, "failureThreshold": 30, "timeoutSeconds": 1}},
                     ]},
        }, "traffic": [{"latestRevision": True, "percent": 100}]},
    }


if __name__ == "__main__":
    try:
        print(json.dumps(render(os.environ), indent=2))
    except (ValueError, OSError) as error:
        raise SystemExit(str(error)) from error
