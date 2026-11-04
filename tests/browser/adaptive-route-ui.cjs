const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('../../apps/control-center/node_modules/playwright');

// Isolated UI fixtures only: invented conditions and detours never reach a core or public assets.
const base = process.env.LATTICE_UI_BASE_URL || 'http://localhost:5173/';
const sourceRun = JSON.parse(fs.readFileSync(path.join(__dirname, '../../apps/control-center/public/demo/capability-route.json')));
const clone = (value) => structuredClone(value);
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const rover = 'gazebo-rover', quad = 'mujoco-go1';
const map = clone(sourceRun.map);
map.id = 'browser_adaptive_map';
map.places.push({ id: 'east_passage', label: 'East passage', pose: { x: 2.5, y: 2.5, z: 0 }, arrival_radius_m: 0.5, transfer_allowed: false });
map.segments.push(
  { id: 'bay_to_east', from: 'inspection_bay', to: 'east_passage', required_capabilities: ['navigate'], max_speed_mps: 0.3, enabled: true },
  { id: 'east_to_transfer', from: 'east_passage', to: 'stair_transfer', required_capabilities: ['navigate'], max_speed_mps: 0.3, enabled: true },
);
const digest = 'a'.repeat(64);
const bodies = [
  { id: rover, display_name: 'Warehouse rover', kind: 'rover', status: 'online', battery: 90, location: 'inspection_bay', pose: { x: 0, y: 2.5, z: 0, yaw: 0 }, capabilities: ['navigate', 'inspect'], last_seen: iso(), adapter_version: 'browser-fixture' },
  { id: quad, display_name: 'Staged Go1', kind: 'quadruped', status: 'online', battery: 90, location: 'stair_transfer', pose: { x: 1, y: -2, z: 0, yaw: 0 }, capabilities: ['navigate', 'inspect', 'stairs'], last_seen: iso(), adapter_version: 'browser-fixture' },
];
const sensorReport = {
  id: 'condition-sensor', event_id: 'sensor-fixture-event', revision: 1, map_digest: digest,
  segment_id: 'bay_to_transfer', status: 'blocked', reason: 'Laser returns block the current ground-floor corridor.',
  observed_at: iso(), received_at: iso(), actor: { body: rover }, body_id: rover, command_id: 'command-held', expected_revision: null,
  evidence: { sensor: 'laser_scan', frame_id: 'map', distance_m: 0.52, blocked_samples: 17, scan_sha256: 'f'.repeat(64), observer_pose: bodies[0].pose },
};
const conditionSnapshot = { map_id: map.id, map_digest: digest, revision: 1, conditions: [sensorReport], blocked_segment_ids: ['bay_to_transfer'] };
const oldSteps = clone(sourceRun.steps);
const round = { id: 'round-adaptive-fixture', digest: 'b'.repeat(64), status: 'recovery_required', steps: oldSteps, current_step: 1, current_mission_id: 'mission-held', assigned_body_id: rover, route_plan_id: 'route-original', expires_at: iso(300000), mission_ids: ['mission-bay', 'mission-held'], anomaly_count: 0 };
const objective = { route: { source_body_id: rover, source_place_id: 'inspection_bay', destination_place_id: 'upper_inspection', destination_capability: 'inspect' }, inspect_source: true, inspect_destination: true };
const plan = clone(sourceRun.plan);
plan.map_id = map.id; plan.map_digest = digest;
plan.legs = ['bay_to_east', 'east_to_transfer', 'stairs_to_upper'].map((id) => {
  const segment = map.segments.find((item) => item.id === id);
  const from = map.places.find((item) => item.id === segment.from), to = map.places.find((item) => item.id === segment.to);
  return { segment_id: id, body_id: id === 'stairs_to_upper' ? quad : rover, from: from.id, to: to.id, from_pose: from.pose, to_pose: to.pose, arrival_radius_m: to.arrival_radius_m, required_capabilities: segment.required_capabilities, max_speed_mps: segment.max_speed_mps, distance_m: 3 };
});
plan.transfers[0].before_leg_index = 2;
plan.explanation = ['Excluded blocked segment bay_to_transfer at condition revision 1.', 'Continue from the known inspection bay through the east passage, preserving the completed inspection.'];
const traversal = (leg) => ({ type: 'traverse_route', traversal: { map_id: map.id, map_revision: map.revision, map_digest: digest, segment_id: leg.segment_id, from: { id: leg.from, pose: leg.from_pose, arrival_radius_m: 0.5 }, to: { id: leg.to, pose: leg.to_pose, arrival_radius_m: leg.arrival_radius_m }, required_capabilities: leg.required_capabilities, max_speed_mps: leg.max_speed_mps } });
const remaining = plan.legs.map((leg) => ({ title: `Continue via ${leg.to.replaceAll('_', ' ')}`, command: traversal(leg), continue_on_missing_marker: false }));
remaining.push(clone(oldSteps[3]));
const replan = { id: 'replan-fixture', digest: 'c'.repeat(64), round_id: round.id, round_digest: round.digest, original_route_plan_id: round.route_plan_id, original_objective: objective, source_body_id: rover, source_place_id: 'inspection_bay', completed_steps: oldSteps.slice(0, 1), remaining_steps: remaining, step_body_ids: [rover, rover, quad, quad], retained_mission_ids: round.mission_ids, retained_observation_ids: ['observation-bay'], plan, failure: null, conditions_revision: 1, blocked_segment_ids: ['bay_to_transfer'], created_at: iso(), expires_at: iso(300000), not_before_at: iso(-1000), status: 'pending', approved_at: null };
const originalProposal = { id: 'initial-review', digest: 'd'.repeat(64), request: objective, plan: clone(plan), failure: null, steps: oldSteps, step_body_ids: [rover, rover, quad, quad], created_at: iso(), expires_at: iso(300000), status: 'pending', round_id: null, adaptive: { conditions_revision: 1, blocked_segment_ids: ['bay_to_transfer'], step_offset: 0, parent_plan_id: null } };
const jpeg = fs.readFileSync(path.join(__dirname, '../../apps/control-center/public/demo/capability-observation-1.jpg'));
const evidence = { model_id: 'fixture-marker', captured_at_ms: Date.now(), frame_sha256: 'e'.repeat(64), image_sha256: createHash('sha256').update(jpeg).digest('hex'), image_base64: jpeg.toString('base64'), confidence_domain: 'browser fixture only', detections: [] };

async function startPage(browser, role, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const page = await context.newPage();
  const state = { conditions: clone(conditionSnapshot), rounds: [clone(round)], replans: options.saved ? [clone(replan)] : [], plans: [clone(originalProposal)], mutations: [], errors: [], approvalAttempts: 0 };
  if (options.expired) state.replans[0].expires_at = iso(-1000);
  if (options.fenced) state.replans[0].not_before_at = iso(6000);
  if (options.blocked) { state.replans[0].plan = null; state.replans[0].source_place_id = null; state.replans[0].status = 'blocked'; state.replans[0].remaining_steps = []; state.replans[0].step_body_ids = []; state.replans[0].failure = { code: 'source_unavailable', message: 'The held source is outside every known semantic place.', assessments: plan.assessments }; }
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(), url = new URL(req.url()), endpoint = url.pathname.replace('/api/v1', '');
    const reply = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (req.method() !== 'GET') {
      const payload = req.postDataJSON(); state.mutations.push({ endpoint, body: payload });
      if (endpoint === '/navigation/conditions') {
        assert.equal(payload.map_digest, digest);
        assert.ok(/^operator-[a-z0-9-]+$/.test(payload.event_id));
        assert.ok(Math.abs(Date.now() - Date.parse(payload.observed_at)) < 5000);
        assert.ok(!('command_id' in payload) && !('evidence' in payload), 'An operator cannot fabricate body sensor evidence');
        if (payload.status === 'clear') assert.equal(payload.expected_revision, state.conditions.revision);
        if (options.rejectReport) {
          state.conditions.revision += 1;
          state.conditions.conditions.unshift({ ...clone(sensorReport), id: 'condition-raced', revision: state.conditions.revision });
          return reply({ code: 'conflict', message: 'A newer body observation arrived. Review the current condition revision.' }, 409);
        }
        const condition = { ...payload, id: `operator-report-${state.mutations.length}`, revision: ++state.conditions.revision, actor: { operator: 'fixture-operator' }, received_at: iso(), body_id: null, command_id: null, evidence: null };
        state.conditions.conditions.unshift(condition);
        state.conditions.blocked_segment_ids = payload.status === 'clear' ? [] : [payload.segment_id];
        return reply(condition, 201);
      }
      if (endpoint === `/rounds/${round.id}/replan-proposal`) {
        assert.deepEqual(payload, { digest: round.digest });
        state.replans = [{ ...clone(replan), conditions_revision: state.conditions.revision, blocked_segment_ids: clone(state.conditions.blocked_segment_ids) }];
        return reply(state.replans[0], 201);
      }
      if (endpoint === `/replans/${replan.id}/approve`) {
        assert.deepEqual(payload, { digest: replan.digest });
        state.approvalAttempts += 1;
        if (options.rejectApproval && state.approvalAttempts === 1) return reply({ code: 'conflict', message: 'A fresh source heartbeat after the stop fence is required.' }, 409);
        state.replans[0].status = 'approved'; state.replans[0].approved_at = iso();
        state.rounds[0] = { ...state.rounds[0], status: 'active', digest: '9'.repeat(64), steps: [...state.replans[0].completed_steps, ...state.replans[0].remaining_steps] };
        return reply(state.rounds[0]);
      }
      return reply({ code: 'fixture_mutation_rejected', message: 'Unexpected mutation in adaptive UI fixture.' }, 409);
    }
    if (endpoint === '/auth/config') return reply({ mode: 'development', durable: true });
    if (endpoint === '/auth/me') return reply({ subject: `fixture-${role}`, roles: [role], mode: 'development' });
    if (endpoint === '/bodies') return reply(bodies);
    if (endpoint === '/missions' || endpoint === '/audit' || endpoint === '/observations' || endpoint === '/handoffs') return reply([]);
    if (endpoint === '/rounds') return reply(state.rounds);
    if (endpoint === '/replans') return reply(state.replans);
    if (endpoint === '/navigation/map') return reply(map);
    if (endpoint === '/navigation/plans') return reply(state.plans);
    if (endpoint === '/navigation/conditions') return reply(state.conditions);
    if (endpoint.endsWith('/transfer-options')) return reply({ round_id: round.id, route_plan_id: round.route_plan_id, current_step: 1, required: false, source_body_id: rover, recommended_target_body_id: null, transfer_place_id: null, reason: 'A route condition holds this objective; no body transfer is due yet.', ready: false, blocking_reasons: [], map_digest: digest });
    if (endpoint === '/observations/observation-bay/evidence') return reply(evidence);
    if (endpoint === '/observations/last-seen') return reply({ subject_key: 'fixture', last_seen: null, later_negative: null, queried_at: iso(), explanation: 'No selected fixture subject.' });
    return reply({ code: 'unknown_fixture_endpoint', message: endpoint }, 404);
  });
  await page.goto(new URL('operator.html#routes', base).href);
  await page.getByLabel('Development API key').fill('isolated-adaptive-fixture-key-'.repeat(3));
  await page.getByRole('button', { name: 'Connect to local core', exact: true }).click();
  const conditions = page.getByRole('region', { name: 'Route conditions', exact: true });
  const continuity = page.getByRole('region', { name: 'Continue a held objective', exact: true });
  await conditions.getByText('Condition revision 1', { exact: true }).waitFor();
  await continuity.waitFor();
  return { page, context, state, conditions, continuity };
}
async function finish(test) { assert.deepEqual(test.state.errors, []); await test.context.close(); }
async function openReview(test) { await test.continuity.getByRole('button', { name: 'View continuity review', exact: true }).click(); await test.continuity.locator('.replan-review').waitFor(); }

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  try {
    const viewer = await startPage(browser, 'viewer', { saved: true });
    assert.equal(await viewer.conditions.getByRole('button').count(), 0);
    await viewer.conditions.getByText(/Laser scan · nearest reported obstacle 0.52 m · 17 blocked samples/).first().waitFor();
    await viewer.conditions.getByText('Condition provenance', { exact: true }).first().click();
    await viewer.conditions.getByText(sensorReport.evidence.scan_sha256, { exact: true }).first().waitFor();
    await openReview(viewer);
    assert.equal(await viewer.continuity.getByRole('button', { name: 'Approve reviewed continuation', exact: true }).count(), 0);
    assert.equal(viewer.state.mutations.length, 0, 'Read-only conditions and replans never issue commands or reviews');
    await finish(viewer);

    const operator = await startPage(browser, 'operator');
    await operator.continuity.getByRole('button', { name: 'Prepare updated route review', exact: true }).click();
    await operator.continuity.getByRole('heading', { name: 'Review the remaining route', exact: true }).waitFor();
    assert.equal(operator.state.mutations.length, 1, 'Preparing a continuity review never approves it');
    const review = operator.continuity.locator('.replan-review');
    await review.getByText('Original objective:', { exact: true }).waitFor();
    assert.equal(await review.locator('.route-assignments').first().locator('li').count(), 1, 'Completed prefix stays separate');
    assert.equal(await review.locator('.route-assignments').nth(1).locator('li').count(), 4, 'New suffix shows the detour and future transfer');
    await review.getByText('Retained evidence and mission history', { exact: true }).click();
    await review.getByText('Retained image · observation-bay', { exact: true }).click();
    await review.getByRole('img', { name: 'Retained camera evidence from observation observation-bay', exact: true }).waitFor();
    await operator.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await operator.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await operator.continuity.screenshot({ path: '/tmp/lattice-adaptive-review-mobile.png' });
    await review.getByRole('button', { name: 'Approve reviewed continuation', exact: true }).click();
    await operator.continuity.getByText(/The updated route was approved for the same objective/).waitFor();
    assert.deepEqual(operator.state.mutations.map((item) => item.endpoint), [`/rounds/${round.id}/replan-proposal`, `/replans/${replan.id}/approve`]);
    assert.equal(operator.state.rounds[0].id, round.id);
    assert.deepEqual(operator.state.rounds[0].steps[0], oldSteps[0], 'Approval preserves completed work');
    await finish(operator);

    const changed = await startPage(browser, 'operator', { saved: true });
    await openReview(changed);
    changed.state.conditions.revision = 2;
    await changed.continuity.getByText(/Route conditions changed or are unavailable/).waitFor();
    assert.equal(await changed.continuity.getByRole('button', { name: 'Approve reviewed continuation', exact: true }).isDisabled(), true);
    const planner = changed.page.getByRole('region', { name: 'Capability route planner', exact: true });
    await planner.getByRole('button', { name: 'View route plan', exact: true }).click();
    await planner.getByText(/Route conditions changed or their current snapshot is unavailable/).waitFor();
    assert.equal(await planner.getByRole('button', { name: 'Approve reviewed route', exact: true }).isDisabled(), true, 'Initial plans also bind condition revision');
    assert.equal(changed.state.mutations.length, 0);
    await finish(changed);

    const clear = await startPage(browser, 'operator');
    await clear.conditions.getByRole('button', { name: 'Review clear report', exact: true }).click();
    await clear.conditions.getByLabel('Reason for this report').fill('Operator checked the corridor from a safe position.');
    clear.state.conditions.revision = 2;
    clear.state.conditions.conditions.unshift({ ...clone(sensorReport), id: 'condition-newer', revision: 2 });
    await clear.conditions.getByText(/The condition snapshot changed after this clear review/).waitFor();
    assert.equal(await clear.conditions.getByRole('button', { name: 'Confirm clear report', exact: true }).isDisabled(), true, 'New sensor observation invalidates old clear intent');
    assert.equal(clear.state.mutations.length, 0);
    await clear.conditions.getByRole('button', { name: 'Review current condition before clearing', exact: true }).click();
    assert.equal(await clear.conditions.getByLabel('Reason for this report').inputValue(), '');
    await clear.conditions.getByLabel('Reason for this report').fill('Operator repeated the corridor check after the new report.');
    await clear.conditions.getByRole('button', { name: 'Confirm clear report', exact: true }).click();
    await clear.conditions.getByText(/Clear report recorded\. Held execution still needs its own review/).waitFor();
    assert.equal(clear.state.mutations.length, 1, 'Clear cannot auto-resume or auto-replan');
    assert.equal(clear.state.mutations[0].body.expected_revision, 2);
    assert.equal(clear.state.rounds[0].status, 'recovery_required');
    await clear.conditions.getByLabel('Route segment').selectOption('bay_to_east');
    await clear.conditions.getByLabel('Reason for this report').fill('Operator reports debris blocking the alternate corridor.');
    await clear.conditions.getByRole('button', { name: 'Record blocked condition', exact: true }).click();
    await clear.conditions.getByText(/Blocked condition recorded/).waitFor();
    assert.equal(clear.state.mutations.length, 2);
    assert.equal(clear.state.mutations[1].body.status, 'blocked');
    await clear.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await clear.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await clear.conditions.screenshot({ path: '/tmp/lattice-adaptive-conditions-mobile.png' });
    await finish(clear);

    const racedClear = await startPage(browser, 'operator', { rejectReport: true });
    await racedClear.conditions.getByRole('button', { name: 'Review clear report', exact: true }).click();
    await racedClear.conditions.getByLabel('Reason for this report').fill('Operator inspected the route before this clear request.');
    await racedClear.conditions.getByRole('button', { name: 'Confirm clear report', exact: true }).click();
    await racedClear.conditions.getByRole('alert').filter({ hasText: 'A newer body observation arrived' }).waitFor();
    await racedClear.conditions.getByText(/The condition snapshot changed after this clear review/).waitFor();
    assert.equal(await racedClear.conditions.getByRole('button', { name: 'Confirm clear report', exact: true }).isDisabled(), true);
    assert.equal(racedClear.state.mutations.length, 1, 'A server-side clear conflict must not retry against the new revision');
    await finish(racedClear);

    const expired = await startPage(browser, 'operator', { saved: true, expired: true });
    await openReview(expired);
    await expired.continuity.getByText(/This updated review expired/).waitFor();
    assert.equal(await expired.continuity.getByRole('button', { name: 'Approve reviewed continuation', exact: true }).isDisabled(), true);
    assert.equal(expired.state.mutations.length, 0);
    await finish(expired);

    const blocked = await startPage(browser, 'operator', { saved: true, blocked: true });
    await openReview(blocked);
    await blocked.continuity.getByText('The held source is outside every known semantic place.', { exact: true }).waitFor();
    assert.equal(await blocked.continuity.getByRole('button', { name: 'Approve reviewed continuation', exact: true }).count(), 0);
    assert.equal(blocked.state.mutations.length, 0);
    await finish(blocked);

    const fenced = await startPage(browser, 'operator', { saved: true, fenced: true, rejectApproval: true });
    await openReview(fenced);
    const approve = fenced.continuity.getByRole('button', { name: 'Approve reviewed continuation', exact: true });
    assert.equal(await approve.isDisabled(), true, 'Source fence blocks approval');
    await fenced.page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent === 'Approve reviewed continuation' && !button.disabled));
    await approve.click();
    await fenced.continuity.getByRole('alert').filter({ hasText: 'fresh source heartbeat after the stop fence' }).waitFor();
    assert.equal(fenced.state.mutations.length, 1, 'Readiness rejection must not retry automatically');
    fenced.state.replans[0].status = 'invalidated';
    await fenced.continuity.getByText(/This continuity review is now invalidated/).waitFor();
    assert.equal(await approve.isDisabled(), true);
    await finish(fenced);

    const roundChanged = await startPage(browser, 'operator', { saved: true });
    await openReview(roundChanged);
    roundChanged.state.rounds[0].digest = '8'.repeat(64);
    await roundChanged.continuity.getByText(/The held objective changed after this review/).waitFor();
    assert.equal(await roundChanged.continuity.getByRole('button', { name: 'Approve reviewed continuation', exact: true }).isDisabled(), true);
    assert.equal(roundChanged.state.mutations.length, 0);
    await finish(roundChanged);
    console.log('PASS: read-only sensor provenance, explicit condition reporting, compare-and-clear revision freeze, no auto-resume/replan, preserved completed prefix and evidence, new detour assignments, exact digest approval, source fence/readiness rejection, condition/round revision invalidation, expiry, ungrounded-source refusal and 390px layout');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
