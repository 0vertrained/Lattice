import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('dist');
const manifest = JSON.parse(fs.readFileSync(path.join(root, '.vite/manifest.json')));
let failed = false;
const initialFiles = new Set();
function budget(label, files, maximum) {
  const bytes = [...files].reduce((sum, file) => sum + fs.statSync(path.join(root, file)).size, 0);
  console.log(`${label}: ${bytes.toLocaleString()} / ${maximum.toLocaleString()} bytes`);
  if (!files.size || bytes > maximum) failed = true;
}
for (const entry of ['index.html', 'operator.html']) {
  const js = new Set(), css = new Set(), visited = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Missing manifest entry: ${key}`);
    js.add(chunk.file);
    for (const file of chunk.css ?? []) css.add(file);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  }
  visit(entry);
  for (const file of js) initialFiles.add(file);
  budget(`${entry} initial JavaScript (including shared imports)`, js, 400_000);
  budget(`${entry} CSS`, css, 20_000);
}
for (const name of ['DigitalTwin', 'RecordedTwin']) {
  const key = Object.keys(manifest).find(k => manifest[k].file.includes(`${name}-`));
  if (!key) throw new Error(`Missing lazy ${name} bundle`);
  const files = new Set(), visited = new Set();
  function collect(k) {
    if (visited.has(k)) return;
    visited.add(k);
    const chunk = manifest[k];
    // React runtime is already paid for by either initial page entry.
    if (!initialFiles.has(chunk.file)) files.add(chunk.file);
    for (const dependency of chunk.imports ?? []) collect(dependency);
  }
  collect(key);
  budget(`${name} lazy JavaScript including shared 3D dependencies`, files, 950_000);
}
if (failed) process.exit(1);
