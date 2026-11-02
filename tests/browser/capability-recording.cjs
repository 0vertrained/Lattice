const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require('../../apps/control-center/node_modules/playwright');

// Exercises the shipped complete run and original images. No fixture injection or robot APIs.
(async () => {
  const base = process.env.LATTICE_VISITOR_URL || 'http://localhost:4174/';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
    const errors = [], robotCalls = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (/\/(?:api\/)?v1\//.test(new URL(request.url()).pathname)) robotCalls.push(request.url()); });
    const response = await page.request.get(new URL('demo/capability-route.json', base).href);
    assert.ok(response.ok(), 'The completed physical simulation recording must exist');
    const run = await response.json();
    assert.equal(run.schema, 'lattice.capability-route.v1');
    assert.equal(run.outcome, 'completed');
    const { source_body_id: source, target_body_id: target } = run.handoff;
    assert.notEqual(source, target);
    assert.equal(run.plan.source_body_id, source);
    assert.equal(run.plan.destination_body_id, target);
    assert.deepEqual(run.step_body_ids, [source, source, target, target]);
    assert.equal(run.steps.length, run.handoff.completed_steps + run.handoff.remaining_steps);
    assert.ok(run.plan.legs.filter((leg) => leg.required_capabilities.includes('stairs')).every((leg) => leg.body_id === target));
    assert.ok(run.plan.assessments.find((candidate) => candidate.body_id === source).capability_gaps.some((gap) => gap.missing_capabilities.includes('stairs')));
    assert.ok(run.poses.length > 100 && run.distance_by_body_m[source] > 0 && run.distance_by_body_m[target] > 0);
    assert.equal(run.quadruped.contact_steps.length, run.quadruped.step_count);
    assert.equal(run.quadruped.step_count, 3);
    assert.equal(run.quadruped.riser_height_m, 0.05);
    assert.ok(run.quadruped.foot_contacts_at_completion.filter((contact) => contact.normal_force_n > 0).length >= 2);
    assert.ok(Date.parse(run.handoff.approved_at) >= Date.parse(run.handoff.not_before_at));
    assert.ok(Date.parse(run.handoff.context_acknowledged_at) >= Date.parse(run.handoff.approved_at));
    const completion = run.events.find((event) => event.kind === 'complete');
    assert.ok(completion && completion.t < run.duration_s, 'Standing tail must remain distinct from objective completion');
    for (const body of [source, target]) assert.ok(run.observations.some((observation) => observation.body_id === body));
    for (const observation of run.observations) {
      const image = await page.request.get(new URL(`demo/${observation.image}`, base).href);
      assert.ok(image.ok());
      assert.equal(createHash('sha256').update(await image.body()).digest('hex'), observation.image_sha256, 'Published JPEG must match accepted image hash');
    }
    const provenanceResponse = await page.request.get(new URL('demo/capability-quadruped.provenance.json', base).href);
    assert.ok(provenanceResponse.ok(), 'Same-run physics replay provenance must exist');
    const provenance = await provenanceResponse.json();
    assert.equal(provenance.source_kind, 'recorded_gateway_physics');
    assert.equal(provenance.source_round_id, run.round_id);
    assert.equal(provenance.map_digest, run.plan.map_digest);
    const videoResponse = await page.request.get(new URL('demo/capability-quadruped.mp4', base).href);
    assert.ok(videoResponse.ok());
    const videoBytes = await videoResponse.body();
    assert.equal(videoBytes.length, provenance.video.bytes);
    assert.equal(createHash('sha256').update(videoBytes).digest('hex'), provenance.video.sha256);
    await page.goto(new URL('#capability', base).href);
    await page.getByRole('heading', { name: 'Capability decision', exact: true }).waitFor();
    await page.getByText(`${completion.t.toFixed(1)} s objective completed`, { exact: true }).waitFor();
    const chapters = ['Capability decision', 'Measured traversal', 'Camera continuity', 'Approval and limits'];
    async function chapter(name) {
      await page.getByRole('navigation', { name: 'Capability route chapters', exact: true }).getByRole('button', { name: new RegExp(name) }).click();
      await page.getByRole('heading', { name, exact: true }).waitFor();
    }
    await page.getByText('Inspect the planner’s candidate assessment', { exact: true }).click();
    await page.getByText(/Missing stairs for/).waitFor();
    await chapter('Measured traversal');
    const video = page.getByLabel('Recorded MuJoCo Go1 joint-state replay from this mission', { exact: true });
    await video.waitFor();
    await video.evaluate(async (element) => { await element.play(); });
    await page.waitForFunction(() => document.querySelector('.capability-video video')?.currentTime > 0);
    await video.evaluate((element) => element.pause());
    await page.getByRole('slider', { name: 'Capability replay time', exact: true }).fill(String(run.duration_s));
    await page.getByRole('heading', { name: completion.title, exact: true }).waitFor();
    await page.getByText(/polling order does not establish actuation order/).waitFor();
    assert.ok(await page.getByRole('img', { name: 'Measured quadruped map-frame elevation over the recording', exact: true }).count());
    await page.getByRole('button', { name: 'Play capability replay', exact: true }).click();
    await page.getByRole('button', { name: 'Pause capability replay', exact: true }).click();
    await chapter('Camera continuity');
    const images = page.locator('.camera-grid img');
    assert.equal(await images.count(), run.observations.length);
    for (const image of await images.all()) {
      await image.waitFor();
      assert.ok(await image.evaluate((element) => element.complete && element.naturalWidth > 0));
    }
    await page.getByText('Image and observation provenance', { exact: true }).first().click();
    await page.getByText(`JPEG SHA-256: ${run.observations[0].image_sha256}`, { exact: true }).waitFor();
    await chapter('Approval and limits');
    await page.getByText('Inspect the recorded approval and locomotion evidence', { exact: true }).click();
    await page.getByText(run.handoff.context_digest, { exact: true }).waitFor();
    await page.getByText(/pretrained third-party Walk These Ways controller/).waitFor();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1080 });
      for (const name of chapters) {
        await chapter(name);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Overflow ${width}: ${name}`);
      }
    }
    await chapter('Measured traversal');
    await page.getByRole('slider', { name: 'Capability replay time', exact: true }).fill(String(run.duration_s));
    await page.locator('.capability-story').screenshot({ path: '/tmp/lattice-capability-public.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.capability-story').screenshot({ path: '/tmp/lattice-capability-mobile.png' });
    await page.getByRole('button', { name: 'Shared memory · two-rover handoff', exact: true }).click();
    await page.getByRole('heading', { name: 'Shared objective', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Single-rover restart recovery', exact: true }).click();
    await page.getByRole('heading', { name: 'Briefing', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(robotCalls, []);
    console.log(`PASS: actual capability run, ${completion.t.toFixed(3)}s objective / ${run.duration_s}s recording, ${run.poses.length} measured poses, ${run.observations.length} SHA-256 verified images, ${provenance.video.duration_s}s SHA-256 verified same-run joint-state video, capability assignment, core approval/ack timestamps, reported elevation, original scenarios preserved, 4 viewport widths and no robot API requests`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
