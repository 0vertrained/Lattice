const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require('../../apps/control-center/node_modules/playwright');

// Actual shipped adaptive evidence only. No request interception or invented motion/observations.
(async () => {
  const base = process.env.LATTICE_VISITOR_URL || 'http://localhost:4174/';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
    const errors = [], calls = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && /Encountered|Error:/.test(message.text())) errors.push(message.text()); });
    page.on('request', (request) => { if (/\/(?:api\/)?v1\//.test(new URL(request.url()).pathname)) calls.push(request.url()); });
    const response = await page.request.get(new URL('demo/adaptive-route.json', base).href);
    assert.ok(response.ok(), 'A complete actual adaptive recording is required');
    const run = await response.json();
    assert.equal(run.schema, 'lattice.adaptive-route.v1'); assert.equal(run.outcome, 'completed');
    assert.equal(run.replan.round_id, run.round_id); assert.equal(run.replan.status, 'approved');
    assert.equal(run.adaptation.repeated_inspections, 0);
    assert.equal(run.replan.completed_steps.length, run.adaptation.completed_steps_preserved);
    assert.deepEqual(run.steps.slice(0, run.replan.completed_steps.length), run.replan.completed_steps);
    assert.equal(run.steps.length, run.step_body_ids.length);
    assert.ok(run.initial_plan.legs.some((leg) => leg.segment_id === run.adaptation.blocked_segment_id));
    assert.ok(!run.plan.legs.some((leg) => leg.segment_id === run.adaptation.blocked_segment_id));
    assert.equal(run.plan.destination_place_id, run.objective.route.destination_place_id);
    assert.ok(Date.parse(run.replan.approved_at) >= Date.parse(run.replan.not_before_at));
    assert.ok(Date.parse(run.handoff.approved_at) >= Date.parse(run.handoff.not_before_at));
    assert.ok(Date.parse(run.handoff.context_acknowledged_at) >= Date.parse(run.handoff.approved_at));
    assert.equal(run.condition_observation.actor.body, run.handoff.source_body_id);
    assert.equal(run.condition_observation.status, 'blocked');
    assert.ok(run.condition_observation.evidence.blocked_samples >= 3);
    assert.equal(run.lidar_scan.sha256, run.condition_observation.evidence.scan_sha256);
    assert.ok(run.mission_duration_s < run.duration_s && run.poses.length > 100);
    const scanResponse = await page.request.get(new URL(`demo/${run.lidar_scan.file}`, base).href);
    assert.ok(scanResponse.ok());
    const scanBytes = await scanResponse.body();
    assert.equal(createHash('sha256').update(scanBytes).digest('hex'), run.lidar_scan.sha256);
    const scan = JSON.parse(scanBytes);
    assert.equal(scan.ranges.length, run.lidar_scan.samples);
    assert.equal(scan.sensor_frame_id, run.lidar_scan.sensor_frame_id);
    assert.ok(scan.ranges.every((range) => range === null || Number.isFinite(range)));
    assert.ok(Number.isFinite(scan.sensor_map_pose.x) && Number.isFinite(scan.sensor_map_pose.yaw));
    for (const observation of run.observations) {
      const imageResponse = await page.request.get(new URL(`demo/${observation.image}`, base).href);
      assert.ok(imageResponse.ok());
      assert.equal(createHash('sha256').update(await imageResponse.body()).digest('hex'), observation.image_sha256);
    }
    const retained = run.observations.filter((observation) => run.replan.retained_observation_ids.includes(observation.id));
    assert.equal(retained.length, run.replan.retained_observation_ids.length);
    assert.ok(retained.length > 0 && retained.every((observation) => observation.body_id === run.handoff.source_body_id));
    const mediaResponse = await page.request.get(new URL('demo/adaptive-quadruped.provenance.json', base).href);
    let video = null;
    if (mediaResponse.ok() && /application\/json/.test(mediaResponse.headers()['content-type'] || '')) {
      video = await mediaResponse.json();
      assert.equal(video.source_kind, 'recorded_gateway_physics');
      assert.equal(video.source_round_id, run.round_id, 'Only this adaptive mission can supply its physics replay');
      assert.equal(video.map_digest, run.plan.map_digest);
      const media = await page.request.get(new URL('demo/adaptive-quadruped.mp4', base).href);
      assert.ok(media.ok()); const bytes = await media.body();
      assert.equal(bytes.length, video.video.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), video.video.sha256);
    } else assert.notEqual(process.env.LATTICE_REQUIRE_ADAPTIVE_VIDEO, '1', 'Final publish requires same-run adaptive video');
    await page.goto(new URL('.', base).href);
    await page.getByRole('heading', { name: 'A new route condition', exact: true }).waitFor();
    await page.goto(new URL('#adaptive', base).href);
    await page.getByRole('heading', { name: 'A new route condition', exact: true }).waitFor();
    await page.getByText(/Original scan hash verified/).waitFor();
    await page.getByRole('img', { name: 'Original route with measured blockage scan returns', exact: true }).waitFor();
    // The scan plot reproduces the gateway's corridor test from the recorded ranges.
    const scanPlot = page.getByRole('img', { name: /^Recorded lidar scan around the rover/ });
    assert.equal(await scanPlot.locator('.polar-return.hit').count(), run.condition_observation.evidence.blocked_samples);
    await page.getByRole('img', { name: /^Detail of the route corridor ahead of the rover/ }).waitFor();
    await page.getByRole('button', { name: 'Reviewed detour', exact: true }).click();
    await page.getByRole('img', { name: 'Reviewed detour with measured blockage scan returns', exact: true }).waitFor();
    const chapters = ['A new route condition', 'Reviewed continuity', 'Measured continuation', 'Evidence and limits'];
    async function chapter(name) {
      await page.getByRole('navigation', { name: 'Adaptive route chapters', exact: true }).getByRole('button', { name: new RegExp(name) }).click();
      await page.getByRole('heading', { name, exact: true }).waitFor();
    }
    await chapter('Reviewed continuity');
    const image = page.getByRole('img', { name: 'Original bay inspection retained across the route replan', exact: true });
    await image.waitFor(); assert.ok(await image.evaluate((element) => element.complete && element.naturalWidth > 0));
    await page.getByText('Inspect the preserved objective and new review binding', { exact: true }).click();
    await page.getByText(run.replan.digest, { exact: true }).waitFor();
    await chapter('Measured continuation');
    if (video) {
      const player = page.getByLabel('Recorded Go1 joint-state replay from the adaptive mission', { exact: true });
      await player.waitFor(); await player.evaluate(async (element) => { await element.play(); });
      await page.waitForFunction(() => document.querySelector('.capability-video video')?.currentTime > 0);
      await player.evaluate((element) => element.pause());
    }
    await page.getByRole('slider', { name: 'Adaptive replay time', exact: true }).fill(String(run.duration_s));
    await page.getByRole('heading', { name: run.events.find((event) => event.kind === 'complete').title, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Play adaptive replay', exact: true }).click();
    await page.getByRole('button', { name: 'Pause adaptive replay', exact: true }).click();
    await chapter('Evidence and limits');
    for (const img of await page.locator('.camera-grid img').all()) { await img.waitFor(); assert.ok(await img.evaluate((element) => element.complete && element.naturalWidth > 0)); }
    await page.getByText('Inspect scan, context and route provenance', { exact: true }).click();
    await page.getByText(run.lidar_scan.sha256, { exact: true }).waitFor();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1080 });
      for (const name of chapters) {
        await chapter(name);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Adaptive overflow ${width} ${name}`);
        if (name === chapters[0]) {
          // Every place is labelled on the route drawing itself, at every width.
          assert.equal(await page.locator('.adaptive-story .replay-plate .d-label').count(), run.map.places.length);
        }
      }
    }
    await chapter('A new route condition');
    await page.getByRole('button', { name: 'Reviewed detour', exact: true }).click();
    await page.locator('.adaptive-story').screenshot({ path: '/tmp/lattice-adaptive-public.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.adaptive-story').screenshot({ path: '/tmp/lattice-adaptive-public-mobile.png' });
    await page.getByRole('navigation', { name: 'Recorded stories' }).getByRole('button', { name: 'Rover to quadruped', exact: true }).click();
    await page.getByRole('heading', { name: 'Capability decision', exact: true }).waitFor();
    await page.getByRole('navigation', { name: 'Recorded stories' }).getByRole('button', { name: 'Two-rover handoff', exact: true }).click();
    await page.getByRole('heading', { name: 'Shared objective', exact: true }).waitFor();
    await page.getByRole('navigation', { name: 'Recorded stories' }).getByRole('button', { name: 'Core restart', exact: true }).click();
    await page.getByRole('heading', { name: 'Briefing', exact: true }).waitFor();
    assert.deepEqual(errors, []); assert.deepEqual(calls, []);
    // Absence is a test-only network failure; never replace public mission evidence.
    const fallback = await browser.newPage();
    await fallback.route('**/demo/adaptive-route.json', (route) => route.fulfill({ status: 404, body: 'recording unavailable' }));
    await fallback.goto(new URL('.', base).href);
    await fallback.getByRole('heading', { name: 'Briefing', exact: true }).waitFor();
    assert.equal(await fallback.getByRole('navigation', { name: 'Recorded stories' }).getByRole('button', { name: 'Blocked aisle', exact: true }).count(), 0);
    await fallback.close();
    console.log(`PASS: actual adaptive round ${run.round_id}, ${run.mission_duration_s}s completion/${run.duration_s}s recording, ${scan.ranges.length} SHA-bound scan samples, ${run.observations.length} original JPEGs, preserved work, approved detour, ${video ? 'verified same-run video' : 'optional video not yet published'}, four viewport widths and all prior stories`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
