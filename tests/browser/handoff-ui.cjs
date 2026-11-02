const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('../../apps/control-center/node_modules/playwright');

// UI contracts are tested against isolated fixtures; this script never commands a live body.
const base = process.env.LATTICE_UI_BASE_URL || 'http://localhost:5173/';
const now = Date.now();
const iso = (offset = 0) => new Date(now + offset).toISOString();
const jpeg = fs.readFileSync(path.join(__dirname, '../../apps/control-center/public/demo/inspection-1.jpg'));
const evidence = {
  model_id: 'warehouse-marker-cpu-v1', captured_at_ms: now - 120000,
  frame_sha256: 'f'.repeat(64), image_sha256: createHash('sha256').update(jpeg).digest('hex'),
  image_base64: jpeg.toString('base64'), confidence_domain: 'synthetic warehouse safety markers',
  detections: [{ label: 'octagonal_safety_marker', confidence: 0.94, box: [30, 30, 70, 70] }],
};
const positive = {
  id: 'observation-positive', subject_key: 'safety-marker:inspection_bay',
  subject_class: 'octagonal_safety_marker', outcome: 'detected', location: 'inspection_bay',
  map_frame: 'map', observer_pose: { x: 4.1, y: 1.2, yaw: 0.3 }, observer_pose_at: iso(-120500),
  mission_id: 'mission-first', command_id: 'command-first', body_id: 'gazebo-rover-a',
  captured_at: iso(-120000), received_at: iso(-119000), model_id: evidence.model_id,
  confidence_domain: evidence.confidence_domain, confidence: 0.94,
  image_sha256: evidence.image_sha256, frame_sha256: evidence.frame_sha256,
  detections: evidence.detections,
};
const negative = {
  ...positive, id: 'observation-negative', outcome: 'not_detected',
  body_id: 'gazebo-rover-b', captured_at: iso(-60000), received_at: iso(-59000),
  confidence: null, detections: [], mission_id: 'mission-second', command_id: 'command-second',
};
const bodies = ['a', 'b'].map((name, index) => ({
  id: `gazebo-rover-${name}`, display_name: `Warehouse rover ${name.toUpperCase()}`,
  kind: 'rover', status: index === 0 ? 'offline' : 'online', battery: 95,
  location: 'warehouse', pose: { x: index, y: 0, yaw: 0 }, capabilities: ['navigate', 'inspect'],
  last_seen: iso(index === 0 ? -60000 : 0), adapter_version: 'browser-fixture',
}));
const steps = [
  { title: 'Inspect the bay safety station', command: { type: 'inspect', location: 'inspection_bay' }, continue_on_missing_marker: false },
  { title: 'Check the loading dock', command: { type: 'inspect', location: 'loading_dock' }, continue_on_missing_marker: true },
  { title: 'Return to the charging station', command: { type: 'navigate', destination: 'charging_station', max_speed_mps: 0.3 }, continue_on_missing_marker: false },
];
const round = {
  id: 'round-browser', digest: 'a'.repeat(64), steps, expires_at: iso(300000), status: 'active',
  current_step: 1, current_mission_id: 'mission-source', assigned_body_id: 'gazebo-rover-a',
  mission_ids: ['mission-first', 'mission-source'], anomaly_count: 0,
};
const sourceMission = {
  id: 'mission-source', title: steps[1].title, command: steps[1].command, status: 'running',
  assigned_body_id: 'gazebo-rover-a', active_command_id: 'command-source', progress_pct: 20,
  created_at: iso(-60000), updated_at: iso(), status_detail: null, evidence: null,
};
const proposal = {
  id: 'handoff-browser', digest: 'b'.repeat(64), round_id: round.id,
  source_body_id: 'gazebo-rover-a', target_body_id: 'gazebo-rover-b',
  created_at: iso(), expires_at: iso(300000), not_before_at: iso(-1000), status: 'pending',
  completed_steps: steps.slice(0, 1), remaining_steps: steps.slice(1), retained_observation_ids: [positive.id],
  context: {
    handoff_id: 'handoff-browser', round_id: round.id, source_body_id: 'gazebo-rover-a',
    target_body_id: 'gazebo-rover-b', completed_steps: 1,
    observations: [{ observation_id: positive.id, image_sha256: positive.image_sha256 }], digest: 'c'.repeat(64),
  },
  source_mission_id: sourceMission.id, resumed_mission_id: null, approved_at: null, context_acknowledged_at: null,
};

async function startPage(browser, role, scenario = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  const mutations = [];
  const errors = [];
  let handoff = scenario.expired ? { ...proposal, expires_at: iso(-1000) } : role === 'viewer' ? proposal : null;
  let approvalAttempts = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.replace('/api/v1', '');
    const reply = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (request.method() !== 'GET') {
      mutations.push({ endpoint, body: request.postDataJSON() });
      if (endpoint === `/rounds/${round.id}/handoff-proposal`) {
        assert.deepEqual(request.postDataJSON(), { target_body_id: 'gazebo-rover-b' });
        handoff = { ...proposal, not_before_at: new Date(Date.now() + 2500).toISOString() };
        return reply(handoff, 201);
      }
      if (endpoint === `/handoffs/${proposal.id}/approve`) {
        assert.deepEqual(request.postDataJSON(), { digest: proposal.digest });
        approvalAttempts += 1;
        if (scenario.rejectFirstApproval && approvalAttempts === 1) {
          return reply({ code: 'conflict', message: 'Receiving body heartbeat is stale. Refresh the target before approval.' }, 409);
        }
        handoff = { ...handoff, status: 'approved', approved_at: iso(), resumed_mission_id: 'mission-resumed', context_acknowledged_at: iso() };
        return reply(handoff);
      }
      return reply({ code: 'fixture_mutation_rejected', message: 'Unexpected mutation in browser fixture.' }, 409);
    }
    if (endpoint === '/auth/config') return reply({ mode: 'development', durable: true });
    if (endpoint === '/auth/me') return reply({ subject: `fixture-${role}`, roles: [role], mode: 'development' });
    if (endpoint === '/bodies') return reply(bodies);
    if (endpoint === '/missions') return reply([sourceMission]);
    if (endpoint === '/audit') return reply([]);
    if (endpoint === '/rounds') return reply([round]);
    if (endpoint === '/handoffs') return reply(handoff ? [handoff] : []);
    if (endpoint === '/observations/last-seen') return reply({
      subject_key: url.searchParams.get('subject'), last_seen: positive, later_negative: negative,
      queried_at: iso(), explanation: 'Last positive sighting retained; a later image contains no detection.',
    });
    if (endpoint === '/observations') return reply([negative, positive]);
    if (/^\/observations\/[^/]+\/evidence$/.test(endpoint)) return reply(
      endpoint.includes('negative') ? { ...evidence, detections: [] } : evidence,
    );
    return reply({ code: 'unknown_fixture_endpoint', message: endpoint }, 404);
  });
  await page.goto(new URL('operator.html', base).href);
  await page.getByLabel('Development API key').fill('browser-fixture-key-'.repeat(3));
  await page.getByRole('button', { name: 'Connect to local core', exact: true }).click();
  await page.getByRole('heading', { name: 'Observation memory', exact: true }).waitFor();
  return { context, page, mutations, errors };
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  try {
    const viewer = await startPage(browser, 'viewer');
    const memory = viewer.page.getByRole('region', { name: 'Observation memory', exact: true });
    await memory.getByText('Last positive sighting', { exact: true }).waitFor();
    await memory.getByText('Later observation with no detection', { exact: true }).waitFor();
    assert.equal(await memory.getByText('94.0%', { exact: true }).count(), 1);
    assert.equal(await memory.getByText('No detection score', { exact: true }).count(), 1);
    await memory.getByRole('button', { name: 'View original image', exact: true }).first().click();
    const image = memory.getByRole('img').first();
    await image.waitFor();
    assert.ok(await image.evaluate((element) => element.complete && element.naturalWidth > 0));
    await memory.getByText('Observation provenance', { exact: true }).first().click();
    await memory.getByText(evidence.image_sha256, { exact: true }).first().waitFor();
    assert.equal(viewer.mutations.length, 0, 'Viewer must never mutate memory or execution');
    const viewerHandoff = viewer.page.getByRole('region', { name: 'Reviewed handoff', exact: true });
    await viewerHandoff.getByText('Warehouse rover A → Warehouse rover B', { exact: true }).waitFor();
    assert.equal(await viewerHandoff.getByRole('button').count(), 0, 'Viewer must have no handoff controls');
    await viewer.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await viewer.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Mobile layout must not overflow');
    assert.deepEqual(viewer.errors, []);
    await viewer.context.close();

    const operator = await startPage(browser, 'operator', { rejectFirstApproval: true });
    const handoffs = operator.page.getByRole('region', { name: 'Reviewed handoff', exact: true });
    await handoffs.getByLabel('Receiving body').selectOption('gazebo-rover-b');
    await handoffs.getByRole('button', { name: 'Pause source and review handoff', exact: true }).click();
    const review = handoffs.locator('.handoff-review');
    await review.getByRole('heading', { name: 'Completed steps (1)', exact: true }).waitFor();
    await review.getByRole('heading', { name: 'Remaining steps (2)', exact: true }).waitFor();
    await review.getByText('Immutable approval binding', { exact: true }).click();
    await review.getByText(proposal.digest, { exact: true }).waitFor();
    const approve = review.getByRole('button', { name: 'Approve reviewed handoff', exact: true });
    assert.equal(await approve.isDisabled(), true, 'Old source execution window must block approval');
    await operator.page.waitForTimeout(3300);
    assert.equal(await approve.isEnabled(), true);
    assert.equal(operator.mutations.length, 1, 'Proposing a handoff must not automatically approve it');
    await review.getByText(`Retained image · ${positive.id}`, { exact: true }).click();
    await review.getByRole('img').waitFor();
    await approve.click();
    await handoffs.getByRole('alert').filter({ hasText: 'Receiving body heartbeat is stale' }).waitFor();
    assert.equal(operator.mutations.length, 2);
    await approve.click();
    await handoffs.getByText(/Handoff approved\. Follow/).waitFor();
    await handoffs.getByText(/Context acknowledged/).waitFor();
    assert.equal(operator.mutations.length, 3);
    assert.deepEqual(operator.errors, []);
    await operator.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await operator.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await operator.context.close();

    const expired = await startPage(browser, 'operator', { expired: true });
    const expiredPanel = expired.page.getByRole('region', { name: 'Reviewed handoff', exact: true });
    await expiredPanel.getByRole('button', { name: 'Open handoff review', exact: true }).click();
    await expiredPanel.getByText(/This review expired/).waitFor();
    assert.equal(await expiredPanel.getByRole('button', { name: 'Approve reviewed handoff', exact: true }).isDisabled(), true);
    assert.equal(expired.mutations.length, 0);
    await expired.context.close();
    console.log('PASS: shared memory positives/negatives, original evidence/provenance, viewer read-only, immutable explicit handoff approval, source lease countdown, expiry, backend rejection, context acknowledgement and 390px layout');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
