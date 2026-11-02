// Rebuild the recorded tour for a GitHub Pages subdirectory while Netlify hosting is pending.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portfolio = path.resolve(process.argv[2] || '../Portfolio');
if (!existsSync(path.join(portfolio, 'index.html')) || !existsSync(path.join(portfolio, '.git')))
  throw new Error('Pass the existing portfolio Git checkout path');
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
for (const file of ['index.html', 'assets', 'demo']) cpSync(path.join(output, file), path.join(destination, file), { recursive: true });
writeFileSync(marker, 'Generated from 0vertrained/Lattice using scripts/export-portfolio-demo.mjs\n');
writeFileSync(path.join(destination, 'operator.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Lattice operator service</title><main><h1>Operator hosting is being connected.</h1><a href="./">Explore the public recorded tour</a></main></html>');
console.log(`Exported public walkthrough to ${destination}`);
