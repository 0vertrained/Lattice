// Public tour works without a backend. Setting both origins enables operator sign-in.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const origin = (value, name) => {
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password)
    throw new Error(`${name} must be an HTTPS origin without a path or trailing slash`);
  return url.origin;
};
const api = origin(process.env.LATTICE_API_ORIGIN, 'LATTICE_API_ORIGIN');
const identity = origin(process.env.LATTICE_IDENTITY_ORIGIN, 'LATTICE_IDENTITY_ORIGIN');
if (Boolean(api) !== Boolean(identity)) throw new Error('Set both API and identity origins, or neither for the public tour');
const result = spawnSync('npm', ['run', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_OPERATOR_ENABLED: api ? 'true' : 'false' },
});
if (result.status !== 0) process.exit(result.status ?? 1);
const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${identity ? ` ${identity}` : ''}; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`;
writeFileSync('dist/_headers', `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Strict-Transport-Security: max-age=31536000\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Cross-Origin-Opener-Policy: same-origin\n  Cache-Control: no-cache\n`);
writeFileSync('dist/_redirects', api ? `/api/* ${api}/:splat 200!\n` : '');
if (!api) writeFileSync('dist/operator.html', '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Lattice operator service</title><main><h1>The public walkthrough is ready.</h1><p>The authenticated operator service has not been connected to this deployment.</p><a href="./">Explore the recorded warehouse round</a></main></html>');
console.log(api ? 'Built public tour and authenticated operator interface' : 'Built public guided tour; backend configuration is pending');
