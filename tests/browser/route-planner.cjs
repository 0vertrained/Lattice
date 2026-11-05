const assert = require('node:assert/strict');
const { chromium } = require('../../apps/control-center/node_modules/playwright');

// Contract and interaction fixtures only. No requests reach a live core or robot.
const base = process.env.LATTICE_UI_BASE_URL || 'http://localhost:5173/';
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const clone = (value) => structuredClone(value);
const map = {
  id: 'fixture_warehouse', revision: 1, frame_id: 'map',
  places: [
    { id: 'bay', label: 'Inspection bay · ground floor', pose: { x: 0, y: 0, z: 0 }, arrival_radius_m: 0.6, transfer_allowed: false },
    { id: 'landing', label: 'Transfer landing · ground floor', pose: { x: 3, y: 0, z: 0 }, arrival_radius_m: 0.6, transfer_allowed: true },
    { id: 'upper', label: 'Upper station · first floor', pose: { x: 6, y: 3, z: 1.2 }, arrival_radius_m: 0.6, transfer_allowed: false },
  ],
  segments: [
    { id: 'ground', from: 'bay', to: 'landing', required_capabilities: ['navigate'], max_speed_mps: 0.3, enabled: true },
    { id: 'stairs', from: 'landing', to: 'upper', required_capabilities: ['navigate', 'stairs'], max_speed_mps: 0.2, enabled: true },
  ],
};
const bodies = [
  { id: 'rover', display_name: 'Warehouse rover', kind: 'rover', status: 'online', battery: 95, location: 'bay', pose: { x: 0, y: 0, yaw: 0 }, capabilities: ['navigate', 'inspect'], last_seen: iso(), adapter_version: 'browser-fixture' },
  { id: 'quadruped', display_name: 'Stair quadruped', kind: 'quadruped', status: 'online', battery: 91, location: 'landing', pose: { x: 3, y: 0, z: 0.3, yaw: 0 }, capabilities: ['navigate', 'inspect', 'stairs'], last_seen: iso(), adapter_version: 'browser-fixture' },
  { id: 'unstaged', display_name: 'Unstaged quadruped', kind: 'quadruped', status: 'online', battery: 90, location: 'unknown', pose: null, capabilities: ['navigate', 'stairs'], last_seen: iso(-60000), adapter_version: 'browser-fixture' },
];
const request = {
  route: { source_body_id: 'rover', source_place_id: 'bay', destination_place_id: 'upper', destination_capability: 'inspect' },
  inspect_source: true, inspect_destination: true,
};
const assessments = [
  { body_id: 'rover', place_id: 'bay', eligible: true, reasons: [], capability_gaps: [{ segment_id: 'stairs', missing_capabilities: ['stairs'] }] },
  { body_id: 'quadruped', place_id: 'landing', eligible: true, reasons: [], capability_gaps: [] },
  { body_id: 'unstaged', place_id: null, eligible: false, reasons: ['Heartbeat is stale.', 'Body is not localized at a permitted transfer point.'], capability_gaps: [] },
];
const plan = {
  planner_id: 'capability-route-v1', map_id: map.id, map_revision: 1, map_digest: 'a'.repeat(64),
  ...request.route, destination_body_id: 'quadruped', distance_m: 7.4,
  legs: map.segments.map((segment, index) => ({
    segment_id: segment.id, body_id: index ? 'quadruped' : 'rover', from: segment.from, to: segment.to,
    from_pose: map.places[index].pose, to_pose: map.places[index + 1].pose,
    arrival_radius_m: 0.6, required_capabilities: segment.required_capabilities, max_speed_mps: segment.max_speed_mps, distance_m: index ? 4.4 : 3,
  })),
  transfers: [{ place_id: 'landing', source_body_id: 'rover', target_body_id: 'quadruped', before_leg_index: 1, reason: 'The rover lacks stairs. The staged quadruped can continue the upper-floor route.' }],
  explanation: ['The source covers the ground-floor segment before a reviewed transfer to a body with stairs capability.'],
  assessments,
  search: [
    { reached_by: 'start', place_id: 'bay', body_id: 'rover', segment_id: null, transfers: 0, distance_m: 0 },
    { reached_by: 'leg', place_id: 'landing', body_id: 'rover', segment_id: 'ground', transfers: 0, distance_m: 3 },
    { reached_by: 'transfer', place_id: 'landing', body_id: 'quadruped', segment_id: null, transfers: 1, distance_m: 3 },
    { reached_by: 'leg', place_id: 'upper', body_id: 'quadruped', segment_id: 'stairs', transfers: 1, distance_m: 7.4 },
  ],
};
const traverse = (index) => ({
  type: 'traverse_route', traversal: {
    map_id: map.id, map_revision: 1, map_digest: plan.map_digest, segment_id: map.segments[index].id,
    from: { id: map.places[index].id, pose: map.places[index].pose, arrival_radius_m: 0.6 },
    to: { id: map.places[index + 1].id, pose: map.places[index + 1].pose, arrival_radius_m: 0.6 },
    required_capabilities: map.segments[index].required_capabilities, max_speed_mps: map.segments[index].max_speed_mps,
  },
});
const steps = [
  { title: 'Inspect the ground-floor bay', command: { type: 'inspect', location: 'bay' }, continue_on_missing_marker: false },
  { title: 'Traverse ground-floor route', command: traverse(0), continue_on_missing_marker: false },
  { title: 'Traverse stairs to upper station', command: traverse(1), continue_on_missing_marker: false },
  { title: 'Inspect the upper-floor station', command: { type: 'inspect', location: 'upper' }, continue_on_missing_marker: false },
];
const proposal = {
  id: 'route-browser', digest: 'b'.repeat(64), request, plan, failure: null, steps,
  step_body_ids: ['rover', 'rover', 'quadruped', 'quadruped'],
  created_at: iso(), expires_at: iso(300000), status: 'pending', round_id: null,
};
const round = {
  id: 'round-route-browser', digest: 'c'.repeat(64), steps, expires_at: iso(300000), status: 'active',
  current_step: 2, current_mission_id: 'mission-ground', assigned_body_id: 'rover',
  mission_ids: ['mission-inspect', 'mission-ground'], anomaly_count: 0, route_plan_id: proposal.id,
};
const mission = {
  id: 'mission-ground', title: steps[1].title, command: traverse(0), status: 'succeeded',
  assigned_body_id: 'rover', active_command_id: null, progress_pct: 100,
  created_at: iso(-60000), updated_at: iso(), status_detail: null, evidence: null,
};
const transfer = {
  round_id: round.id, route_plan_id: proposal.id, current_step: 2, required: true,
  source_body_id: 'rover', recommended_target_body_id: 'quadruped', transfer_place_id: 'landing',
  reason: plan.transfers[0].reason, ready: true, blocking_reasons: [], map_digest: plan.map_digest,
};
const handoff = {
  id: 'handoff-route-browser', digest: 'd'.repeat(64), round_id: round.id,
  source_body_id: 'rover', target_body_id: 'quadruped', created_at: iso(), expires_at: iso(300000),
  not_before_at: iso(-1000), status: 'pending', completed_steps: steps.slice(0, 2), remaining_steps: steps.slice(2),
  retained_observation_ids: [], context: {
    handoff_id: 'handoff-route-browser', round_id: round.id, source_body_id: 'rover', target_body_id: 'quadruped',
    completed_steps: 2, observations: [], digest: 'e'.repeat(64),
  },
  source_mission_id: mission.id, resumed_mission_id: null, approved_at: null, context_acknowledged_at: null,
};

async function startPage(browser, role, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  const state = { map: clone(map), plans: options.saved ? [clone(proposal)] : [], rounds: options.active ? [clone(round)] : [], handoffs: [], transfer: clone(transfer), mutations: [], reads: [], errors: [] };
  state.planningStarted = new Promise((resolve) => { state.onPlanningStarted = resolve; });
  if (options.held) state.rounds[0].status = 'recovery_required';
  if (options.expired) state.plans[0].expires_at = iso(-1000);
  if (options.unstaged) {
    state.transfer.ready = false;
    state.transfer.blocking_reasons = ['Planned receiving body is not at the transfer point.'];
  }
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const endpoint = new URL(req.url()).pathname.replace('/api/v1', '');
    const reply = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (req.method() !== 'GET') {
      state.mutations.push({ endpoint, body: req.postDataJSON() });
      if (endpoint === '/navigation/plans') {
        assert.deepEqual(req.postDataJSON(), request);
        await new Promise((resolve) => { state.releasePlan = resolve; state.onPlanningStarted(); });
        const result = clone(proposal);
        if (options.blocked) {
          result.plan = null; result.status = 'blocked'; result.steps = []; result.step_body_ids = [];
          result.failure = { code: 'transfer_unavailable', message: 'No ready body with stairs capability is staged at the required transfer point.', assessments };
        }
        state.plans = [result];
        return reply(result, 201);
      }
      if (endpoint === `/navigation/plans/${proposal.id}/approve`) {
        assert.deepEqual(req.postDataJSON(), { digest: proposal.digest });
        if (options.rejectApproval) return reply({ code: 'conflict', message: 'The planned receiving body heartbeat is stale. Prepare a fresh route.' }, 409);
        state.plans[0].status = 'approved'; state.plans[0].round_id = round.id; state.rounds = [clone(round)];
        return reply(round);
      }
      if (endpoint === `/rounds/${round.id}/handoff-proposal`) {
        assert.deepEqual(req.postDataJSON(), { target_body_id: 'quadruped' });
        state.handoffs = [clone(handoff)];
        return reply(handoff, 201);
      }
      if (endpoint === `/rounds/${round.id}/abandon`) {
        assert.deepEqual(req.postDataJSON(), { digest: round.digest });
        state.rounds[0].status = 'cancelled';
        return reply(state.rounds[0]);
      }
      return reply({ code: 'fixture_mutation_rejected', message: 'Unexpected browser-fixture mutation.' }, 409);
    }
    state.reads.push(endpoint);
    if (endpoint === '/auth/config') return reply({ mode: 'development', durable: true });
    if (endpoint === '/auth/me') return reply({ subject: `fixture-${role}`, roles: [role], mode: 'development' });
    if (endpoint === '/bodies') return reply(options.absent ? bodies.filter((body) => body.id !== 'quadruped') : bodies);
    if (endpoint === '/missions') return reply(options.active ? [mission] : []);
    if (endpoint === '/audit' || endpoint === '/observations') return reply([]);
    if (endpoint === '/rounds') return reply(state.rounds);
    if (endpoint === '/handoffs') return reply(state.handoffs);
    if (endpoint === '/navigation/map') return options.unconfigured ? reply({ code: 'conflict', message: 'No semantic map is configured.' }, 422) : reply(state.map);
    if (endpoint === '/navigation/plans') return reply(state.plans);
    if (endpoint === `/rounds/${round.id}/transfer-options`) return reply(state.transfer);
    if (endpoint === '/observations/last-seen') return reply({ subject_key: 'fixture', last_seen: null, later_negative: null, queried_at: iso(), explanation: 'No fixture observation.' });
    return reply({ code: 'unknown_fixture_endpoint', message: endpoint }, 404);
  });
  await page.goto(new URL('operator.html#routes', base).href);
  await page.getByLabel('Development API key').fill('isolated-browser-fixture-key-'.repeat(3));
  await page.getByRole('button', { name: 'Connect to local core', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Capability route planner', exact: true });
  await panel.waitFor();
  await panel.getByText(options.unconfigured ? /Route planning is unavailable/ : /revision 1, map frame/).waitFor();
  return { page, panel, context, state };
}

/** Opens a console section from the rail and waits for its heading. */
async function openSection(page, name) {
  await page.getByRole('navigation', { name: 'Console sections' }).getByRole('link', { name: new RegExp(`^${name}`) }).click();
  await page.getByRole('heading', { level: 1, name, exact: true }).waitFor();
}
async function prepareRoute(test) {
  await test.panel.getByLabel('Starting body').selectOption('rover');
  await test.panel.getByLabel('Starting place').selectOption('bay');
  await test.panel.getByLabel('Destination').selectOption('upper');
  await test.panel.getByRole('button', { name: 'Prepare route review', exact: true }).click();
  await test.state.planningStarted;
  await test.panel.getByRole('button', { name: 'Planning route…', exact: true }).waitFor();
  assert.equal(await test.panel.getByLabel('Starting body').isDisabled(), true, 'Request fields freeze while planning');
  test.state.releasePlan();
  await test.panel.locator('.route-review').waitFor();
}
async function finish(test) {
  assert.deepEqual(test.state.errors, []);
  await test.context.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  try {
    const viewer = await startPage(browser, 'viewer', { saved: true, active: true, held: true });
    assert.equal(await viewer.panel.getByRole('combobox').count(), 0);
    await viewer.panel.getByRole('button', { name: 'View route plan', exact: true }).click();
    assert.equal(await viewer.panel.getByRole('button', { name: 'Approve reviewed route', exact: true }).count(), 0);
    await viewer.panel.getByText(/Missing stairs for/).waitFor();
    await viewer.panel.getByText('Heartbeat is stale.', { exact: true }).waitFor();
    await openSection(viewer.page, 'Continuity');
    await viewer.page.getByRole('heading', { name: 'Recommended capability transfer', exact: true }).waitFor();
    assert.equal(await viewer.page.getByRole('button', { name: 'Pause source and review handoff', exact: true }).count(), 0);
    await openSection(viewer.page, 'Rounds');
    await viewer.page.getByRole('region', { name: 'Inspection round', exact: true }).getByText('Recovery required').first().waitFor();
    assert.equal(await viewer.page.getByRole('button', { name: 'Abandon held round', exact: true }).count(), 0);
    assert.equal(viewer.state.mutations.length, 0, 'Viewing recommendation must never pause or approve');
    await finish(viewer);

    const operator = await startPage(browser, 'operator');
    const prepare = operator.panel.getByRole('button', { name: 'Prepare route review', exact: true });
    assert.equal(await prepare.isDisabled(), true, 'Source and places require explicit selection');
    await prepareRoute(operator);
    assert.equal(operator.state.mutations.length, 1, 'Preparation never approves automatically');
    await operator.panel.getByText(/elevation not reported/).waitFor();
    await operator.panel.getByText(/finishing with Stair quadruped/).waitFor();
    const ranking = operator.panel.getByRole('region', { name: 'Routes the planner compared', exact: true });
    assert.equal(await ranking.locator('tbody tr').count(), 1, 'Only the selected route when the search ranked no alternative');
    await ranking.getByText(/reached no other route/).waitFor();
    await operator.panel.getByText('How the planner searched', { exact: true }).click();
    assert.deepEqual(await operator.panel.locator('.route-search-steps li').allTextContents(), [
      'Starts at Inspection bay · ground floor with Warehouse rover. 0.00 m',
      'Inspection bay · ground floor to Transfer landing · ground floor with Warehouse rover. 3.00 m',
      'Stair quadruped could take over at Transfer landing · ground floor. 3.00 m, 1 body change',
      'Transfer landing · ground floor to Upper station · first floor with Stair quadruped. 7.40 m, 1 body change Reaches the destination.',
    ]);
    await operator.panel.getByText('Review binding and provenance', { exact: true }).click();
    await operator.panel.getByText(proposal.digest, { exact: true }).waitFor();
    await operator.page.screenshot({ path: '/tmp/lattice-route-planner-desktop.png', fullPage: true });
    await operator.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await operator.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, '390px route review must not overflow');
    await operator.panel.screenshot({ path: '/tmp/lattice-route-planner-mobile.png' });
    await operator.panel.getByLabel('Starting body').selectOption('quadruped');
    assert.equal(await operator.panel.locator('.route-review').count(), 0, 'Changing source clears the active review');
    assert.equal(await operator.panel.getByLabel('Starting place').inputValue(), '', 'Changing source clears its old place');
    await operator.panel.getByRole('button', { name: 'View route plan', exact: true }).click();
    await operator.panel.getByText(/starting with Warehouse rover/).waitFor();
    await operator.panel.getByRole('button', { name: 'Approve reviewed route', exact: true }).click();
    await operator.panel.getByText(/The source runs the 4 reviewed steps in order up to the first change of body/).waitFor();
    assert.equal(operator.state.mutations.length, 1, 'Arming an approval sends nothing');
    await operator.panel.getByRole('button', { name: 'Confirm route approval', exact: true }).click();
    await operator.panel.getByText(/Route approved as round/).waitFor();
    assert.deepEqual(operator.state.mutations.map((entry) => entry.endpoint), ['/navigation/plans', `/navigation/plans/${proposal.id}/approve`]);
    await finish(operator);

    const changed = await startPage(browser, 'operator', { saved: true });
    await changed.panel.getByRole('button', { name: 'View route plan', exact: true }).click();
    changed.state.map.revision = 2;
    await changed.panel.getByText(/The configured map revision changed/).waitFor({ timeout: 14000 });
    assert.equal(await changed.panel.getByRole('button', { name: 'Approve reviewed route', exact: true }).isDisabled(), true);
    assert.equal(changed.state.mutations.length, 0);
    await finish(changed);

    const expired = await startPage(browser, 'operator', { saved: true, expired: true });
    await expired.panel.getByRole('button', { name: 'View route plan', exact: true }).click();
    await expired.panel.getByText(/This route review expired/).waitFor();
    assert.equal(await expired.panel.getByRole('button', { name: 'Approve reviewed route', exact: true }).isDisabled(), true);
    assert.equal(expired.state.mutations.length, 0);
    await finish(expired);

    const blocked = await startPage(browser, 'operator', { blocked: true });
    await prepareRoute(blocked);
    await blocked.panel.getByText('Route cannot be approved', { exact: true }).waitFor();
    await blocked.panel.getByText(/No ready body with stairs capability/).waitFor();
    assert.equal(await blocked.panel.getByRole('button', { name: 'Approve reviewed route', exact: true }).count(), 0);
    assert.equal(blocked.state.mutations.length, 1);
    await finish(blocked);

    const rejected = await startPage(browser, 'operator', { saved: true, rejectApproval: true });
    await rejected.panel.getByRole('button', { name: 'View route plan', exact: true }).click();
    await rejected.panel.getByRole('button', { name: 'Approve reviewed route', exact: true }).click();
    await rejected.panel.getByRole('button', { name: 'Confirm route approval', exact: true }).click();
    await rejected.panel.getByRole('alert').filter({ hasText: 'planned receiving body heartbeat is stale' }).waitFor();
    assert.equal(rejected.state.mutations.length, 1, 'Rejected approval cannot automatically retry');
    rejected.state.plans[0].status = 'invalidated';
    await rejected.panel.getByText(/This review is now invalidated/).waitFor();
    assert.equal(await rejected.panel.getByRole('button', { name: 'Approve reviewed route', exact: true }).isDisabled(), true);
    await finish(rejected);

    for (const absent of [false, true]) {
      const unavailable = await startPage(browser, 'operator', { active: true, unstaged: true, absent });
      await openSection(unavailable.page, 'Continuity');
      const handoffs = unavailable.page.getByRole('region', { name: 'Reviewed handoff', exact: true });
      await handoffs.getByText('Planned receiving body is not at the transfer point.', { exact: true }).waitFor();
      assert.equal(await handoffs.getByRole('button', { name: 'Pause source and review handoff', exact: true }).isDisabled(), true);
      assert.equal(unavailable.state.mutations.length, 0, 'Unstaged/absent targets cannot prepare a transfer');
      await finish(unavailable);
    }

    const ready = await startPage(browser, 'operator', { active: true });
    await openSection(ready.page, 'Continuity');
    const handoffs = ready.page.getByRole('region', { name: 'Reviewed handoff', exact: true });
    await handoffs.getByRole('heading', { name: 'Recommended capability transfer', exact: true }).waitFor();
    assert.equal(await handoffs.getByLabel('Receiving body').inputValue(), 'quadruped');
    assert.deepEqual(await handoffs.getByLabel('Receiving body').locator('option').evaluateAll((items) => items.map((item) => item.value)), ['', 'quadruped']);
    assert.equal(ready.state.mutations.length, 0);
    await handoffs.getByRole('button', { name: 'Pause source and review handoff', exact: true }).click();
    await handoffs.getByRole('button', { name: 'Approve reviewed handoff', exact: true }).waitFor();
    assert.equal(ready.state.mutations.length, 1, 'Explicit preparation does not approve the transfer');
    await ready.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await ready.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await finish(ready);

    const held = await startPage(browser, 'operator', { active: true, held: true });
    await openSection(held.page, 'Rounds');
    const roundPanel = held.page.getByRole('region', { name: 'Inspection round', exact: true });
    await roundPanel.getByRole('button', { name: 'Abandon held round', exact: true }).click();
    await roundPanel.getByText(/abandoning does not authorize new motion/).waitFor();
    assert.equal(held.state.mutations.length, 0, 'Opening abandon review must not retire execution');
    await roundPanel.getByRole('button', { name: 'Keep held round', exact: true }).click();
    assert.equal(held.state.mutations.length, 0);
    await roundPanel.getByRole('button', { name: 'Abandon held round', exact: true }).click();
    await roundPanel.getByRole('button', { name: 'Confirm abandon round', exact: true }).click();
    await roundPanel.getByText(/Held round abandoned\. Its evidence is retained/).waitFor();
    assert.deepEqual(held.state.mutations, [{ endpoint: `/rounds/${round.id}/abandon`, body: { digest: round.digest } }], 'Abandon uses exact reviewed digest and never auto-replans');
    await finish(held);

    const unconfigured = await startPage(browser, 'operator', { unconfigured: true });
    assert.equal(await unconfigured.panel.getByRole('combobox').count(), 0);
    assert.equal(unconfigured.state.mutations.length, 0);
    await finish(unconfigured);
    console.log('PASS: explicit route source and immutable review, typed traversal, viewer read-only, exact digest approval, map changes, expiry, stale/invalidated review, capability rejections, readonly transfer recommendation, absent/unstaged target blocks, explicit handoff preparation, the recorded planner search and ranking, armed and confirmed approval, confirmed abandonment without auto-replan, optional map and 390px layout');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
