const { chromium } = require('../../apps/control-center/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Test-owned UI fixture only. These invented times/poses are never saved as public demo evidence.
const captured = '2026-11-02T04:00:00Z';
const image = fs.readFileSync(path.join(__dirname, '../../apps/control-center/public/demo/inspection-1.jpg'));
const observation = {
  id: 'fixture-observation-a', subject_key: 'safety-marker:inspection_bay',
  subject_class: 'octagonal_safety_marker', outcome: 'detected', location: 'inspection_bay',
  map_frame: 'map', observer_pose: { x: 0, y: 2.1, yaw: 1.57 }, observer_pose_at: captured,
  mission_id: 'fixture-mission-a', command_id: 'fixture-command-a', body_id: 'gazebo-rover-a',
  captured_at: captured, received_at: captured, model_id: 'browser-fixture-model',
  confidence_domain: 'UI fixture — not model validation', confidence: 0.94,
  image_sha256: crypto.createHash('sha256').update(image).digest('hex'), frame_sha256: 'f'.repeat(64),
  detections: [{ label: 'octagonal_safety_marker', confidence: 0.94, box: [30, 30, 70, 70] }],
  image: 'inspection-1.jpg',
};
const fixture = {
  schema: 'lattice.handoff.v1', recorded_at: captured, duration_s: 20,
  round_id: 'fixture-round', digest: 'a'.repeat(64), outcome: 'completed', anomaly_count: 1,
  steps: [
    { title: 'Inspect the bay', command: { type: 'inspect', location: 'inspection_bay' }, continue_on_missing_marker: false },
    { title: 'Navigate to the dock', command: { type: 'navigate', destination: 'loading_dock', max_speed_mps: 0.3 }, continue_on_missing_marker: false },
    { title: 'Inspect the dock', command: { type: 'inspect', location: 'loading_dock' }, continue_on_missing_marker: true },
    { title: 'Return to charge', command: { type: 'navigate', destination: 'charging_station', max_speed_mps: 0.3 }, continue_on_missing_marker: false },
  ],
  poses: Array.from({ length: 21 }, (_, t) => [
    { t, body_id: 'gazebo-rover-a', x: Math.min(t, 5) / 5, y: 2, yaw: 0, status: t < 5 ? 'running' : 'recovery_required' },
    { t, body_id: 'gazebo-rover-b', x: Math.max(0, t - 8) / 5, y: -1, yaw: 0, status: t < 8 ? 'idle' : 'running' },
  ]).flat(),
  events: [
    { t: 0, title: 'Fixture round begins', detail: 'Test-owned replay fixture.', kind: 'fixture' },
    { t: 5, title: 'Handoff proposed', detail: 'A is held; no automatic continuation.', kind: 'handoff' },
    { t: 8, title: 'B acknowledges context', detail: 'A retained observation is referenced in the reviewed context.', kind: 'acknowledgement' },
    { t: 20, title: 'Round completed', detail: 'Fixture final state.', kind: 'completed' },
  ],
  observations: [observation, { ...observation, id: 'fixture-observation-b', subject_key: 'safety-marker:loading_dock', location: 'loading_dock', body_id: 'gazebo-rover-b', outcome: 'not_detected', confidence: null, detections: [], image: 'inspection-2.jpg' }],
  handoff: {
    id: 'fixture-handoff', source_body_id: 'gazebo-rover-a', target_body_id: 'gazebo-rover-b',
    context_digest: 'b'.repeat(64), completed_steps: 1, remaining_steps: 3,
    source_stop_observed_after_s: 2.4, post_stop_drift_m: 0.006,
    context_acknowledged_at: captured, not_before_at: captured, approved_at: captured,
  },
  distance_by_body_m: { 'gazebo-rover-a': 1, 'gazebo-rover-b': 2.4 },
};

(async () => {
  const base = process.env.LATTICE_VISITOR_URL || 'http://localhost:5173/';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
    const errors = [], calls = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (/\/(?:api\/)?v1\//.test(new URL(request.url()).pathname)) calls.push(request.url()); });
    await page.route('**/demo/handoff.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture) }));
    await page.goto(new URL('#single', base).href);
    await page.getByRole('heading', { name: 'Briefing', exact: true }).waitFor();
    await page.getByRole('navigation', { name: 'Recorded stories' }).getByRole('button', { name: 'Two-rover handoff', exact: true }).click();
    await page.getByRole('heading', { name: 'Shared objective', exact: true }).waitFor();
    const chapters = ['Shared objective', 'Two-rover replay', 'Shared memory', 'Handoff proof'];
    async function chapter(name) {
      await page.getByRole('navigation', { name: 'Two-rover chapters', exact: true }).getByRole('button', { name: new RegExp(name) }).click();
      await page.getByRole('heading', { name, exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.tagName === 'H2');
    }
    await chapter('Two-rover replay');
    await page.getByRole('img', { name: 'Recorded paths of rover A and rover B in the shared warehouse map', exact: true }).waitFor();
    await page.getByRole('slider', { name: 'Handoff replay time', exact: true }).fill('12');
    await page.getByRole('button', { name: 'Play handoff replay', exact: true }).click();
    await page.getByRole('button', { name: 'Pause handoff replay', exact: true }).click();
    await page.getByRole('button', { name: '3D replay', exact: true }).click();
    await page.locator('canvas').waitFor();
    await page.getByRole('button', { name: 'Map view', exact: true }).click();
    await chapter('Shared memory');
    await page.getByText('Last positive sighting', { exact: true }).waitFor();
    await page.getByLabel('Recorded memory query', { exact: true }).selectOption('loading_dock');
    await page.getByText('No positive safety-marker sighting was recorded at this station.', { exact: true }).waitFor();
    await page.getByText('No supported marker', { exact: true }).waitFor();
    assert.ok(await page.locator('.camera-grid img').evaluate((element) => element.complete && element.naturalWidth > 0));
    await page.getByText('Shared observation provenance', { exact: true }).click();
    await page.getByText('browser-fixture-model', { exact: true }).waitFor();
    await chapter('Handoff proof');
    await page.getByText('Inspect the recorded approval and acknowledgement', { exact: true }).click();
    await page.getByText(fixture.handoff.context_digest, { exact: true }).waitFor();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const name of chapters) {
        await chapter(name);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Overflow ${width} ${name}`);
      }
    }
    if (process.env.LATTICE_CAPTURE) {
      await chapter('Two-rover replay');
      await page.screenshot({ path: '/tmp/lattice-handoff-visitor.png', fullPage: true });
    }
    await page.getByRole('navigation', { name: 'Recorded stories' }).getByRole('button', { name: 'Core restart', exact: true }).click();
    await page.getByRole('heading', { name: 'Briefing', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, []);
    const fallback = await browser.newPage();
    await fallback.route('**/demo/handoff.json', (route) => route.fulfill({ status: 404, body: 'not recorded yet' }));
    await fallback.goto(new URL('#single', base).href);
    await fallback.getByRole('heading', { name: 'Briefing', exact: true }).waitFor();
    assert.equal(await fallback.getByRole('navigation', { name: 'Recorded stories' }).getByRole('button', { name: 'Two-rover handoff', exact: true }).count(), 0);
    console.log('PASS: fixture-backed two-rover map/3D replay, memory query and negative evidence, context provenance, chapter focus, four viewport widths, original walkthrough and optional-recording fallback; no robot API requests');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
