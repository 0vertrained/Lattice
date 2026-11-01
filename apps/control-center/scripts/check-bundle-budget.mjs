import fs from 'node:fs';
import path from 'node:path';

const assetsDirectory = path.resolve('dist/assets');
const files = fs.readdirSync(assetsDirectory);
const budgets = [
  {
    label: 'initial JavaScript',
    match: (name) => name.startsWith('index-') && name.endsWith('.js'),
    maximumBytes: 400_000,
  },
  {
    label: 'lazy digital twin JavaScript',
    match: (name) => name.startsWith('DigitalTwin-') && name.endsWith('.js'),
    maximumBytes: 950_000,
  },
  {
    label: 'application CSS',
    match: (name) => name.endsWith('.css'),
    maximumBytes: 20_000,
  },
];

let failed = false;
for (const budget of budgets) {
  const file = files.find(budget.match);
  if (file === undefined) {
    console.error(`Missing bundle for budget: ${budget.label}`);
    failed = true;
    continue;
  }
  const bytes = fs.statSync(path.join(assetsDirectory, file)).size;
  console.log(`${budget.label}: ${bytes.toLocaleString()} / ${budget.maximumBytes.toLocaleString()} bytes`);
  if (bytes > budget.maximumBytes) {
    console.error(`Bundle budget exceeded: ${budget.label}`);
    failed = true;
  }
}

if (failed) process.exit(1);
