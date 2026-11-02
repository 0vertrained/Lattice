#!/usr/bin/env python3
"""Render a Cloud Run v1 service manifest as JSON (valid YAML), with secret references only."""
import json
import os
import re
from urllib.parse import urlparse


def required(name):
    value = os.environ.get(name, '')
    if not value:
        raise SystemExit(f'{name} is required')
    return value


def https(name, origin=False):
    value = required(name)
    url = urlparse(value)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.fragment or url.query or (origin and url.path):
        raise SystemExit(f'{name} must be a valid HTTPS {"origin" if origin else "URL"}')
    return value


project = required('GCP_PROJECT')
region = os.environ.get('GCP_REGION', 'us-central1')
if not re.fullmatch(r'[a-z][a-z0-9-]{4,61}[a-z0-9]', project):
    raise SystemExit('Invalid project ID')
connection = f'{project}:{region}:lattice-db'
env = {
    'LATTICE_AUTH_MODE': 'oidc', 'LATTICE_BIND_ADDRESS': '0.0.0.0:8080',
    'LATTICE_ALLOWED_ORIGIN': https('LATTICE_SITE_ORIGIN', True),
    'LATTICE_OIDC_ISSUER': https('LATTICE_OIDC_ISSUER'),
    'LATTICE_OIDC_JWKS_URL': https('LATTICE_OIDC_JWKS_URL'),
    'LATTICE_OIDC_CLIENT_ID': 'lattice-ui', 'LATTICE_OIDC_AUDIENCE': 'lattice-api',
    'LATTICE_AI_GATEWAY_URL': 'http://127.0.0.1:8100',
    'LATTICE_COMMAND_TTL_SECONDS': '120', 'LATTICE_ALLOW_CORE_TAKEOVER': '1',
    'RUST_LOG': 'info',
}
secrets = {'LATTICE_DATABASE_URL': 'lattice-database-url', 'LATTICE_SIGNING_SEED_BASE64': 'lattice-signing-seed'}
version = os.environ.get('LATTICE_SECRET_VERSION', '1')
if not version.isdigit():
    raise SystemExit('Pin LATTICE_SECRET_VERSION to a numeric version')
manifest = {
    'apiVersion': 'serving.knative.dev/v1', 'kind': 'Service',
    'metadata': {'name': 'lattice-core', 'labels': {'cloud.googleapis.com/location': region}, 'annotations': {'run.googleapis.com/ingress': 'all', 'run.googleapis.com/invoker-iam-disabled': 'true'}},
    'spec': {'template': {
        'metadata': {'annotations': {'autoscaling.knative.dev/minScale': '1', 'autoscaling.knative.dev/maxScale': '1', 'run.googleapis.com/cpu-throttling': 'false', 'run.googleapis.com/startup-cpu-boost': 'true', 'run.googleapis.com/cloudsql-instances': connection, 'run.googleapis.com/container-dependencies': '{"core":["inference"]}'}},
        'spec': {'serviceAccountName': f'lattice-runtime@{project}.iam.gserviceaccount.com', 'containerConcurrency': 40, 'timeoutSeconds': 30,
            'containers': [
                {'name': 'core', 'image': required('LATTICE_CORE_IMAGE'), 'ports': [{'containerPort': 8080}],
                 'resources': {'limits': {'cpu': '1', 'memory': '512Mi'}},
                 'env': [{'name': k, 'value': v} for k, v in env.items()] + [{'name': k, 'valueFrom': {'secretKeyRef': {'name': v, 'key': version}}} for k, v in secrets.items()],
                 'volumeMounts': [{'name': 'cloudsql', 'mountPath': '/cloudsql'}],
                 'startupProbe': {'httpGet': {'path': '/ready', 'port': 8080}, 'periodSeconds': 2, 'failureThreshold': 30, 'timeoutSeconds': 1},
                 'livenessProbe': {'httpGet': {'path': '/health', 'port': 8080}, 'periodSeconds': 30, 'failureThreshold': 3, 'timeoutSeconds': 1}},
                {'name': 'inference', 'image': required('LATTICE_INFERENCE_IMAGE'), 'resources': {'limits': {'cpu': '1', 'memory': '512Mi'}},
                 'startupProbe': {'httpGet': {'path': '/health', 'port': 8100}, 'periodSeconds': 2, 'failureThreshold': 30, 'timeoutSeconds': 1}},
            ], 'volumes': [{'name': 'cloudsql', 'cloudSqlInstance': {'instances': [connection]}}]},
    }, 'traffic': [{'latestRevision': True, 'percent': 100}]},
}
print(json.dumps(manifest, indent=2))
