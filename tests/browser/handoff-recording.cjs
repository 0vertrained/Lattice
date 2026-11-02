const { chromium } = require('../../apps/control-center/node_modules/playwright');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

// Verifies the shipped recording and its actual JPEG assets. No routing or fixture injection.
(async () => {
  const base = process.env.LATTICE_VISITOR_URL || 'http://localhost:4174/';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
    const errors = [], calls = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && /Encountered|Error:/.test(message.text())) errors.push(message.text()); });
    page.on('request', (request) => { if (/\/api\//.test(request.url())) calls.push(request.url()); });
    const response = await page.request.get(new URL('demo/handoff.json', base).href);
    assert.equal(response.ok(), true, 'Measured recording must be published');
    const run = await response.json();
    assert.equal(run.schema, 'lattice.handoff.v1');
    assert.equal(run.outcome, 'completed');
    const { source_body_id: source, target_body_id: target } = run.handoff;
    assert.notEqual(source, target);
    assert.deepEqual([...new Set(run.poses.map((pose) => pose.body_id))].sort(), [source, target].sort());
    assert.ok(run.poses.length > 200 && run.duration_s > 0);
    assert.ok(run.distance_by_body_m[source] > 0 && run.distance_by_body_m[target] > 0);
    assert.ok(run.handoff.completed_steps > 0 && run.handoff.remaining_steps > 0);
    assert.equal(run.steps.length, run.handoff.completed_steps + run.handoff.remaining_steps);
    assert.ok(Date.parse(run.handoff.approved_at) >= Date.parse(run.handoff.not_before_at));
    assert.ok(Date.parse(run.handoff.context_acknowledged_at) >= Date.parse(run.handoff.approved_at));
    assert.ok(run.observations.some((observation) => observation.body_id === source && observation.outcome === 'detected'));
    assert.ok(run.observations.some((observation) => observation.body_id === target && observation.outcome === 'not_detected'));
    for (const observation of run.observations) {
      const image = await page.request.get(new URL(`demo/${observation.image}`, base).href);
      assert.equal(image.ok(), true);
      assert.equal(createHash('sha256').update(await image.body()).digest('hex'), observation.image_sha256);
    }
    await page.goto(new URL('#handoff', base).href);
    await page.getByRole('heading', { name: 'Shared objective', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Operator sign-in →', exact: true }).count(), 0, 'Public export must hide operator sign-in');
    const chapters = ['Shared objective', 'Two-rover replay', 'Shared memory', 'Handoff proof'];
    async function chapter(name) {
      await page.getByRole('navigation', { name: 'Two-rover chapters', exact: true }).getByRole('button', { name: new RegExp(name) }).click();
      await page.getByRole('heading', { name, exact: true }).waitFor();
    }
    await chapter('Two-rover replay');
    await page.getByRole('slider', { name: 'Handoff replay time', exact: true }).fill(String(run.duration_s));
    await page.getByRole('heading', { name: 'Objective completed across two bodies', exact: true }).waitFor();
    await page.getByRole('button', { name: '3D replay', exact: true }).click();
    await page.locator('canvas').waitFor();
    await page.getByRole('button', { name: 'Map view', exact: true }).click();
    if (process.env.LATTICE_CAPTURE) {
      await page.locator('.handoff-story').screenshot({ path: '/tmp/lattice-handoff-public.png' });
    }
    await chapter('Shared memory');
    const image = page.locator('.camera-grid img');
    await image.waitFor();
    assert.ok(await image.evaluate((element) => element.complete && element.naturalWidth > 0));
    await page.getByLabel('Recorded memory query', { exact: true }).selectOption('loading_dock');
    await page.getByText('No positive safety-marker sighting was recorded at this station.', { exact: true }).waitFor();
    await page.getByText('No supported marker', { exact: true }).waitFor();
    await chapter('Handoff proof');
    await page.getByText('Inspect the recorded approval and acknowledgement', { exact: true }).click();
    await page.getByText(run.handoff.context_digest, { exact: true }).waitFor();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1080 });
      for (const name of chapters) {
        await chapter(name);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Overflow ${width} ${name}`);
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, []);
    console.log(`PASS: actual ${run.duration_s}s two-body recording, ${run.poses.length} measured poses, ${run.observations.length} SHA-256 verified JPEGs, approval/acknowledgement ordering, production #handoff map/3D replay, memory queries, four viewport widths and no robot API calls`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
