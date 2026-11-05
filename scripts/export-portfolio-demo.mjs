// Rebuild the recorded tour into the portfolio's lattice/ directory, served by GitHub Pages under /lattice/.
// The operator console is not part of this copy. Set LATTICE_HOSTED_ORIGIN to the hosted site's HTTPS origin
// and lattice/operator.html points visitors to the console there.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portfolio = path.resolve(process.argv[2] || '../Portfolio');
if (!existsSync(path.join(portfolio, 'index.html')) || !existsSync(path.join(portfolio, '.git')))
  throw new Error('Pass the existing portfolio Git checkout path');
const hosted = process.env.LATTICE_HOSTED_ORIGIN ? new URL(process.env.LATTICE_HOSTED_ORIGIN) : null;
if (hosted && (hosted.protocol !== 'https:' || hosted.origin !== process.env.LATTICE_HOSTED_ORIGIN))
  throw new Error('LATTICE_HOSTED_ORIGIN must be an HTTPS origin without a path or trailing slash');
const app = path.join(root, 'apps/control-center');
const output = path.join(app, 'dist-visitor');
const built = spawnSync('node', ['node_modules/vite/bin/vite.js', 'build', '--base=/lattice/', '--outDir=dist-visitor'], {
  cwd: app, stdio: 'inherit', env: { ...process.env, VITE_OPERATOR_ENABLED: 'false' },
});
if (built.status !== 0) process.exit(built.status ?? 1);
const destination = path.join(portfolio, 'lattice');
const marker = path.join(destination, '.lattice-generated');
if (existsSync(destination) && !existsSync(marker)) throw new Error('Refusing to replace an unmarked portfolio directory');
mkdirSync(destination, { recursive: true });
// This directory contains only this script's generated build; source portfolio files are untouched.
for (const file of readdirSync(destination)) rmSync(path.join(destination, file), { recursive: true, force: true });
// theme.js must be a same-origin file (the CSP forbids inline scripts) and sets the theme before first paint.
for (const file of ['index.html', 'theme.js', 'favicon.svg', 'assets', 'demo']) cpSync(path.join(output, file), path.join(destination, file), { recursive: true });
writeFileSync(marker, 'Generated from 0vertrained/Lattice using scripts/export-portfolio-demo.mjs\n');
const whereConsole = hosted
  ? `<p>It runs on the <a href="${hosted.origin}/operator.html">hosted site</a>, behind a sign-in.</p>`
  : '<p>This copy is the recorded tour only.</p>';
writeFileSync(path.join(destination, 'operator.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lattice operator console</title><main><h1>The operator console isn’t part of this copy</h1>${whereConsole}<p><a href="./">Explore the recorded tour</a></p></main></html>`);
console.log(`Exported public walkthrough to ${destination}`);
