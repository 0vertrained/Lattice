"""Offline deployment contracts; fixtures never provision cloud resources."""
import base64
import json
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'infrastructure/cloud-run'))
from render import configuration, render
from preflight import prepare


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'infrastructure/cloud-run' / (name + '.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


github_setup = module('configure-github')
keycloak_setup = module('keycloak-config')

# Stands in for gcloud when running setup-gcp.sh: tracks which resources exist, reports a database that is still
# being created on the first status check, and expands --flags-file the way gcloud does, where a key without its
# leading dashes is an unrecognized argument that gcloud echoes back, value included.
FAKE_GCLOUD = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

path = Path(os.environ['FAKE_GCLOUD_STATE'])
state = json.loads(path.read_text()) if path.exists() else {'created': [], 'calls': [], 'status_checks': 0, 'secrets': {}}
args = sys.argv[1:]
if '--flags-file' in args:
    at = args.index('--flags-file')
    extra = []
    for name, value in json.loads(Path(args[at + 1]).read_text()).items():
        if not name.startswith('--'):
            print(f'ERROR: unrecognized arguments: {name}={value}', file=sys.stderr)
            sys.exit(2)
        extra += [name, value]
    args = args[:at] + args[at + 2:] + extra
state['calls'].append(['<password>' if i and args[i - 1] == '--password' else a for i, a in enumerate(args)])

def done(code=0, out=None):
    path.write_text(json.dumps(state))
    if out is not None:
        print(out)
    sys.exit(code)

verbs = ('describe', 'create', 'create-oidc', 'list', 'enable', 'add-iam-policy-binding')
at = next(i for i, a in enumerate(args) if a in verbs)
verb, resource = args[at], ' '.join(args[:at] + args[at + 1:at + 2]).split('@')[0]
if args[:2] == ['projects', 'describe']:
    done(out='123456789')
if verb in ('enable', 'add-iam-policy-binding'):
    done()
if args[:3] == ['sql', 'users', 'list']:
    done(out='lattice' if 'sql users lattice' in state['created'] else '')
if verb == 'describe':
    if resource not in state['created']:
        done(1)
    if args[:2] == ['sql', 'instances'] and '--format=value(state)' in args:
        state['status_checks'] += 1
        done(out='PENDING_CREATE' if state['status_checks'] == 1 else 'RUNNABLE')
    done()
if args[:3] == ['sql', 'users', 'create'] and not {'--instance', '--password'} <= set(args):
    done(2)
if args[0] == 'secrets':
    data = next(a.split('=', 1)[1] if '=' in a else args[args.index(a) + 1] for a in args if a.startswith('--data-file'))
    state['secrets'][args[at + 1]] = sys.stdin.read() if data == '-' else Path(data).read_text()
state['created'].append(resource)
done()
'''


def inputs():
    project, region = 'lattice-test-123', 'us-central1'
    registry = f'{region}-docker.pkg.dev/{project}/lattice'
    return {'GCP_PROJECT': project, 'GCP_REGION': region, 'LATTICE_SITE_ORIGIN': 'https://lattice-test.netlify.app',
            'LATTICE_OIDC_ISSUER': 'https://identity.example/realms/lattice',
            'LATTICE_OIDC_JWKS_URL': 'https://identity.example/realms/lattice/protocol/openid-connect/certs',
            'LATTICE_ROUTE_MAP': 'warehouse-adaptive',
            'LATTICE_CORE_IMAGE': registry + '/core@sha256:' + 'a' * 64,
            'LATTICE_INFERENCE_IMAGE': registry + '/inference@sha256:' + 'b' * 64,
            'GCP_WIF_PROVIDER': 'projects/123456789/locations/global/workloadIdentityPools/lattice-github/providers/lattice',
            'GCP_DEPLOY_SERVICE_ACCOUNT': f'lattice-deployer@{project}.iam.gserviceaccount.com'}


class DeploymentTests(unittest.TestCase):
    def test_setup_and_runner_shell_syntax(self):
        for script in ('infrastructure/cloud-run/setup-gcp.sh', 'scripts/run-hosted-heterogeneous.sh'):
            subprocess.run(['bash', '-n', str(ROOT / script)], check=True)

    def run_setup(self, directory):
        fake = Path(directory) / 'gcloud'
        if not fake.exists():
            fake.write_text(FAKE_GCLOUD)
            fake.chmod(0o755)
        env = {**os.environ, 'PATH': f'{directory}{os.pathsep}{os.environ["PATH"]}',
               'FAKE_GCLOUD_STATE': str(Path(directory) / 'state.json'), 'LATTICE_POLL_SECONDS': '0'}
        env.pop('LATTICE_PUT_ONLINE', None)
        return subprocess.run(['bash', str(ROOT / 'infrastructure/cloud-run/setup-gcp.sh'), 'lattice-test-123', '987654',
                               'us-central1'], env=env, capture_output=True, text=True, timeout=60)

    def test_setup_creates_the_database_user_without_echoing_its_password(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_setup(directory)
            self.assertEqual(result.returncode, 0, result.stderr)
            state = json.loads((Path(directory) / 'state.json').read_text())
            self.assertIn('sql users lattice', state['created'])
            url = state['secrets']['lattice-database-url']
            password = url.split('postgres://lattice:', 1)[1].split('@', 1)[0]
            self.assertRegex(password, '^[0-9a-f]{64}$')
            self.assertEqual(url, f'postgres://lattice:{password}@/lattice'
                                  '?host=%2Fcloudsql%2Flattice-test-123%3Aus-central1%3Alattice-db')
            self.assertNotIn(password, result.stdout + result.stderr)
            self.assertEqual(len(base64.b64decode(state['secrets']['lattice-signing-seed'])), 32)
            # The database is created in the background and waited for, so a rerun can resume the wait.
            self.assertIn('--async', next(call for call in state['calls'] if call[:3] == ['sql', 'instances', 'create']))
            self.assertIn('Waiting for Cloud SQL', result.stdout)

    def test_setup_rerun_resumes_without_recreating_or_resetting_anything(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.run_setup(directory).returncode, 0)
            path = Path(directory) / 'state.json'
            before = json.loads(path.read_text())
            rerun = self.run_setup(directory)
            self.assertEqual(rerun.returncode, 0, rerun.stderr)
            after = json.loads(path.read_text())
            self.assertEqual(after['created'], before['created'])
            self.assertEqual(after['secrets'], before['secrets'])
            # A database user whose stored connection secret is gone never silently gets a new password.
            after['created'].remove('secrets lattice-database-url')
            path.write_text(json.dumps(after))
            refused = self.run_setup(directory)
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn('refusing to reset credentials', refused.stderr)

    def test_keycloak_import_preserves_pkce_audience_and_exact_site(self):
        realm = keycloak_setup.imports(inputs()['LATTICE_SITE_ORIGIN'])
        client = realm['clients'][0]
        self.assertEqual(client['clientId'], 'lattice-ui')
        self.assertTrue(client['publicClient'])
        self.assertFalse(client['directAccessGrantsEnabled'])
        self.assertEqual(client['redirectUris'], ['https://lattice-test.netlify.app/operator.html'])
        self.assertEqual(client['attributes']['pkce.code.challenge.method'], 'S256')
        self.assertEqual(client['protocolMappers'][0]['config']['included.custom.audience'], 'lattice-api')
        self.assertNotIn('users', realm)
        self.assertEqual({role['name'] for role in realm['roles']['realm']}, {'lattice-viewer', 'lattice-operator', 'lattice-admin'})

    def test_discovery_binds_exact_issuer_and_supported_flow(self):
        issuer = inputs()['LATTICE_OIDC_ISSUER']
        metadata = {'issuer': issuer, 'jwks_uri': inputs()['LATTICE_OIDC_JWKS_URL'],
                    'id_token_signing_alg_values_supported': ['RS256'], 'response_types_supported': ['code']}
        with mock.patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(metadata).encode())):
            self.assertEqual(github_setup.discover_keycloak(issuer), (issuer, metadata['jwks_uri']))
        for changed in [{'issuer': 'https://different.example/realm'}, {'id_token_signing_alg_values_supported': ['HS256']}, {'jwks_uri': 'http://identity.example/keys'}]:
            with self.subTest(changed=changed), mock.patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps({**metadata, **changed}).encode())), self.assertRaises(ValueError):
                github_setup.discover_keycloak(issuer)

    def test_github_helper_previews_and_only_applies_repository_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            args = ['configure-github.py', '--project', inputs()['GCP_PROJECT'], '--site-origin', inputs()['LATTICE_SITE_ORIGIN'],
                    '--issuer', inputs()['LATTICE_OIDC_ISSUER'], '--output', directory]
            with mock.patch.object(github_setup.subprocess, 'check_output', return_value='123456789\n'), mock.patch.object(github_setup, 'discover_keycloak', return_value=(inputs()['LATTICE_OIDC_ISSUER'], inputs()['LATTICE_OIDC_JWKS_URL'])), mock.patch.object(github_setup.subprocess, 'run') as run, contextlib.redirect_stdout(io.StringIO()):
                with mock.patch.object(sys, 'argv', args):
                    github_setup.main()
                run.assert_not_called()
                with mock.patch.object(sys, 'argv', args + ['--apply']):
                    github_setup.main()
                self.assertEqual(run.call_count, 9)
                for call in run.call_args_list:
                    command = call.args[0]
                    self.assertEqual(command[:3], ['gh', 'variable', 'set'])
                    self.assertEqual(command[4:6], ['--repo', '0vertrained/Lattice'])
                    self.assertNotIn('workflow', command)

    def test_manifest_keeps_secrets_in_core_and_trusted_map_pinned(self):
        manifest = render(inputs())
        containers = manifest['spec']['template']['spec']['containers']
        core, inference = containers
        env = {item['name']: item for item in core['env']}
        self.assertEqual(env['LATTICE_NAVIGATION_MAP_FILE']['value'], '/app/routes/warehouse-adaptive.json')
        self.assertEqual(env['LATTICE_AUTH_MODE']['value'], 'oidc')
        self.assertNotIn('env', inference)
        for name in ('LATTICE_DATABASE_URL', 'LATTICE_SIGNING_SEED_BASE64'):
            self.assertNotIn('value', env[name])
            self.assertEqual(env[name]['valueFrom']['secretKeyRef']['key'], '1')
        self.assertEqual(manifest['spec']['template']['metadata']['annotations']['autoscaling.knative.dev/maxScale'], '1')

    def test_refuses_mutable_cross_project_or_swapped_images(self):
        for value in ['registry.example/core:latest', inputs()['LATTICE_CORE_IMAGE'].replace('lattice-test-123', 'other-project'), inputs()['LATTICE_INFERENCE_IMAGE']]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                render({**inputs(), 'LATTICE_CORE_IMAGE': value})

    def test_rejects_unsafe_origins_maps_and_versions(self):
        bad = [('LATTICE_SITE_ORIGIN', 'http://site.example'), ('LATTICE_SITE_ORIGIN', 'https://site.example/'),
               ('LATTICE_SITE_ORIGIN', 'https://user:password@site.example'), ('LATTICE_OIDC_JWKS_URL', 'https://id.example/keys#fragment'),
               ('GCP_PROJECT', 'project-' + 'x' * 31), ('GCP_REGION', 'us-central1/injected'),
               ('LATTICE_ROUTE_MAP', '../../.env'), ('LATTICE_SECRET_VERSION', 'latest'), ('LATTICE_SECRET_VERSION', '0')]
        for name, value in bad:
            with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                configuration({**inputs(), name: value})

    def test_preflight_missing_does_not_create_partial_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bundle'
            report = prepare({}, path, require_wif=True)
            self.assertEqual(report['status'], 'configuration_missing')
            self.assertIn('LATTICE_OIDC_ISSUER', report['missing'])
            self.assertFalse(path.exists())
            self.assertFalse(report['deployment_performed'])

    def test_review_bundle_contains_only_metadata_and_exact_map(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            report = prepare(inputs(), path, include_manifest=True, require_wif=True)
            self.assertEqual(report['status'], 'configuration_valid')
            self.assertFalse(report['cloud_authentication_verified'])
            self.assertFalse(report['deployment_performed'])
            self.assertEqual((path / 'route-map.json').read_bytes(), (ROOT / 'simulation/routes/warehouse-adaptive.json').read_bytes())
            manifest = json.loads((path / 'cloud-run-service.json').read_text())
            self.assertEqual(manifest, render(inputs()))

    def test_existing_project_identity_cannot_be_reused(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            prepare({**inputs(), 'GCP_DEPLOY_SERVICE_ACCOUNT': 'caduceus@other-project.iam.gserviceaccount.com'}, Path(directory), require_wif=True)

    def test_old_manifest_cannot_silently_survive_a_metadata_only_rebuild(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            prepare(inputs(), path, include_manifest=True)
            original = (path / 'cloud-run-service.json').read_bytes()
            with self.assertRaises(ValueError):
                prepare({**inputs(), 'LATTICE_ROUTE_MAP': 'warehouse-stairs'}, path)
            self.assertEqual((path / 'cloud-run-service.json').read_bytes(), original)

    def test_hosted_pair_check_rejects_shared_or_public_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory) / 'rover', Path(directory) / 'go1'
            a.write_text('lattice_device_' + 'a' * 48); a.chmod(0o600)
            b.write_text('lattice_device_' + 'b' * 48); b.chmod(0o600)
            env = {**os.environ, 'LATTICE_CORE_URL': 'https://core.example',
                   'LATTICE_ROVER_DEVICE_TOKEN_FILE': str(a), 'LATTICE_QUADRUPED_DEVICE_TOKEN_FILE': str(b),
                   'LATTICE_NAVIGATION_MAP_FILE': str(ROOT / 'simulation/routes/warehouse-adaptive.json')}
            def check():
                return subprocess.run(['bash', str(ROOT / 'scripts/run-hosted-heterogeneous.sh'), '--check'], env=env, capture_output=True)
            self.assertEqual(check().returncode, 0)
            b.write_text(a.read_text())
            self.assertNotEqual(check().returncode, 0)
            b.write_text('lattice_device_' + 'b' * 48); b.chmod(0o644)
            self.assertNotEqual(check().returncode, 0)
            b.chmod(0o600); env['LATTICE_CORE_URL'] = 'http://core.example'
            self.assertNotEqual(check().returncode, 0)

    def test_netlify_rejects_partial_or_non_origin_configuration_before_build(self):
        for values in [{'LATTICE_API_ORIGIN': 'https://core.example'},
                       {'LATTICE_API_ORIGIN': 'https://core.example/path', 'LATTICE_IDENTITY_ORIGIN': 'https://id.example'}]:
            env = {k: v for k, v in os.environ.items() if k not in ('LATTICE_API_ORIGIN', 'LATTICE_IDENTITY_ORIGIN')}
            result = subprocess.run(['node', str(ROOT / 'scripts/netlify-build.mjs')], env={**env, **values}, cwd=ROOT / 'apps/control-center', capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b'vite v', result.stdout)


if __name__ == '__main__':
    unittest.main()
