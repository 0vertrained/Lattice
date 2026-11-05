// axe-core WCAG 2.1 A/AA checks of the operator console in the light and dark themes, on a phone and a
// desktop: the sign-in page, every section, an armed approval, a route review with the planner's
// search drawn, a continuation and a handoff behind their execution fences, and the audit ledger.
// It also checks that hidden sections stop polling. The API is an isolated fixture; nothing here
// reaches a core or a body.
const { chromium } = require('../../apps/control-center/node_modules/playwright');
const axe = require('../../apps/control-center/node_modules/axe-core');
const assert = require('node:assert/strict');

const base = process.env.LATTICE_UI_BASE_URL || 'http://localhost:5173/';
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const steps = [
  { title: 'Inspect the bay safety station', command: { type: 'inspect', location: 'inspection_bay' }, continue_on_missing_marker: false },
  { title: 'Check the loading dock for a safety marker', command: { type: 'inspect', location: 'loading_dock' }, continue_on_missing_marker: true },
  { title: 'Return to the charging station', command: { type: 'navigate', destination: 'charging_station', max_speed_mps: 0.3 }, continue_on_missing_marker: false },
];
const bodies = () => [
  { id: 'gazebo-rover', display_name: 'Warehouse rover', kind: 'rover', status: 'online', battery: 82, location: 'inspection_bay', pose: { x: 4.2, y: 2.1, yaw: 0.6 }, capabilities: ['navigate', 'inspect'], last_seen: iso(-300), adapter_version: 'fixture' },
  { id: 'mujoco-go1', display_name: 'Stair quadruped', kind: 'quadruped', status: 'online', battery: 24, location: 'stair_landing', pose: { x: 7.9, y: -1.3, yaw: -1.2 }, capabilities: ['navigate', 'stairs'], last_seen: iso(-800), adapter_version: 'fixture' },
  { id: 'spare-rover', display_name: 'Spare rover', kind: 'rover', status: 'offline', battery: 9, location: 'charging_station', pose: null, capabilities: ['navigate'], last_seen: iso(-60000), adapter_version: 'fixture' },
];
const missions = [
  { id: 'mission-dock', title: steps[1].title, command: steps[1].command, status: 'recovery_required', assigned_body_id: 'gazebo-rover', active_command_id: 'command-dock', progress_pct: 40, created_at: iso(-90000), updated_at: iso(-30000), status_detail: 'The core restarted while this command was running.', evidence: null },
  { id: 'mission-bay', title: steps[0].title, command: steps[0].command, status: 'succeeded', assigned_body_id: 'gazebo-rover', active_command_id: null, progress_pct: 100, created_at: iso(-200000), updated_at: iso(-95000), status_detail: null, evidence: null },
];
const rounds = [
  { id: 'round-held-1', digest: 'a'.repeat(64), steps, expires_at: iso(300000), status: 'recovery_required', current_step: 1, current_mission_id: 'mission-dock', mission_ids: ['mission-bay', 'mission-dock'], anomaly_count: 0, route_plan_id: null },
  { id: 'round-route-2', digest: 'b'.repeat(64), steps, expires_at: iso(300000), status: 'recovery_required', current_step: 1, current_mission_id: 'mission-dock', mission_ids: ['mission-dock'], anomaly_count: 0, route_plan_id: 'route-fixture', assigned_body_id: 'gazebo-rover' },
];
// Chained like the core's log: each hash covers the one before it. The last link is broken.
const audit = [
  { occurred_at: iso(-60000), actor: { operator: 'fixture-admin' }, event_type: 'round.approved', object_id: 'round-held-1', metadata: {}, position: 1, previous_hash: null, record_hash: '3f'.repeat(32), verified: true },
  { occurred_at: iso(-45000), actor: { body: 'gazebo-rover' }, event_type: 'route_condition.blocked', object_id: 'bay_to_transfer', metadata: {}, position: 2, previous_hash: '3f'.repeat(32), record_hash: '7b'.repeat(32), verified: true },
  { occurred_at: iso(-30000), actor: { service: 'lattice-core' }, event_type: 'mission.recovery_required', object_id: 'mission-dock', metadata: {}, position: 3, previous_hash: '00'.repeat(32), record_hash: 'c4'.repeat(32), verified: false },
];
// The warehouse map, and the planner's recorded search for a rover at the bay with a quadruped
// staged at the stair transfer.
const map = require('../../simulation/routes/warehouse-adaptive.json');
const search = [
  { reached_by: 'start', place_id: 'inspection_bay', body_id: 'gazebo-rover', segment_id: null, transfers: 0, distance_m: 0 },
  { reached_by: 'leg', place_id: 'west_bypass', body_id: 'gazebo-rover', segment_id: 'bay_to_west_bypass', transfers: 0, distance_m: 2.0223748416156684 },
  { reached_by: 'leg', place_id: 'stair_transfer', body_id: 'gazebo-rover', segment_id: 'bay_to_transfer', transfers: 0, distance_m: 4.6097722286464435 },
  { reached_by: 'leg', place_id: 'stair_transfer', body_id: 'gazebo-rover', segment_id: 'west_bypass_to_transfer', transfers: 0, distance_m: 7.1837700018412445 },
  { reached_by: 'transfer', place_id: 'stair_transfer', body_id: 'mujoco-go1', segment_id: null, transfers: 1, distance_m: 4.6097722286464435 },
  { reached_by: 'leg', place_id: 'upper_inspection', body_id: 'mujoco-go1', segment_id: 'stairs_to_upper', transfers: 1, distance_m: 8.112985039767116 },
];
const pose = (id) => map.places.find((place) => place.id === id).pose;
const leg = (segment_id, body_id, from, to, distance_m) => ({ segment_id, body_id, from, to, from_pose: pose(from), to_pose: pose(to), arrival_radius_m: 0.35, required_capabilities: ['navigate'], max_speed_mps: 0.30000001192092896, distance_m });
const plan = {
  planner_id: 'semantic-capability-dijkstra-v1', map_id: map.id, map_revision: map.revision, map_digest: 'd'.repeat(64),
  source_body_id: 'gazebo-rover', source_place_id: 'inspection_bay', destination_place_id: 'upper_inspection', destination_capability: 'inspect', destination_body_id: 'mujoco-go1',
  legs: [leg('bay_to_transfer', 'gazebo-rover', 'inspection_bay', 'stair_transfer', 4.6097722286464435), leg('stairs_to_upper', 'mujoco-go1', 'stair_transfer', 'upper_inspection', 3.503212811120672)],
  transfers: [{ place_id: 'stair_transfer', source_body_id: 'gazebo-rover', target_body_id: 'mujoco-go1', before_leg_index: 1, reason: 'gazebo-rover lacks [stairs] needed after stair_transfer.' }],
  distance_m: 8.112985039767116, explanation: ['Selected 2 route legs with 1 body transfers.'], assessments: [], search,
  alternatives: [{ segment_ids: ['bay_to_west_bypass', 'west_bypass_to_transfer', 'stairs_to_upper'], body_ids: ['gazebo-rover', 'gazebo-rover', 'mujoco-go1'], transfer_place_ids: ['stair_transfer'], destination_body_id: 'mujoco-go1', distance_m: 10.686982812961917 }],
};
const objective = { route: { source_body_id: 'gazebo-rover', source_place_id: 'inspection_bay', destination_place_id: 'upper_inspection', destination_capability: 'inspect' }, inspect_source: true, inspect_destination: true };
const proposal = { id: 'route-fixture', digest: 'e'.repeat(64), request: objective, plan, failure: null, steps, step_body_ids: ['gazebo-rover', 'gazebo-rover', 'mujoco-go1'], created_at: iso(-20000), expires_at: iso(600000), status: 'pending', round_id: null };
const replan = { id: 'replan-fixture', digest: 'f'.repeat(64), round_id: 'round-route-2', round_digest: 'b'.repeat(64), original_route_plan_id: 'route-fixture', original_objective: objective, source_body_id: 'gazebo-rover', source_place_id: 'inspection_bay', completed_steps: steps.slice(0, 1), remaining_steps: steps.slice(1), step_body_ids: ['gazebo-rover', 'mujoco-go1'], retained_mission_ids: ['mission-dock'], retained_observation_ids: [], plan, failure: null, conditions_revision: 0, blocked_segment_ids: [], created_at: iso(-5000), expires_at: iso(600000), not_before_at: iso(600000), status: 'pending', approved_at: null };
const handoff = { id: 'handoff-fixture', digest: '9'.repeat(64), round_id: 'round-route-2', source_body_id: 'gazebo-rover', target_body_id: 'mujoco-go1', created_at: iso(-5000), expires_at: iso(600000), not_before_at: iso(600000), status: 'pending', completed_steps: steps.slice(0, 1), remaining_steps: steps.slice(1), retained_observation_ids: [], context: { handoff_id: 'handoff-fixture', round_id: 'round-route-2', source_body_id: 'gazebo-rover', target_body_id: 'mujoco-go1', completed_steps: 1, observations: [], digest: '8'.repeat(64) }, source_mission_id: 'mission-dock', resumed_mission_id: null, approved_at: null, context_acknowledged_at: null };
const devices = [
  { id: 'device-1', body_id: 'gazebo-rover', label: 'Warehouse simulator', created_at: iso(-86400000), expires_at: iso(86400000 * 29), revoked_at: null },
  { id: 'device-0', body_id: 'gazebo-rover', label: 'Old laptop', created_at: iso(-86400000 * 40), expires_at: iso(-86400000 * 10), revoked_at: iso(-86400000 * 12) },
];

async function open(browser, viewport, colorScheme, polled = []) {
  const page = await browser.newPage({ viewport, colorScheme, reducedMotion: 'reduce' });
  await page.route('**/api/ready', (route) => route.fulfill({ status: 200, headers: { 'x-lattice-core-epoch': '3f9a1c2e-0000-4000-8000-000000000000' }, body: '' }));
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    const endpoint = url.pathname.replace('/api/v1', '');
    polled.push(endpoint);
    const reply = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (route.request().method() !== 'GET') return reply({ code: 'fixture', message: 'This fixture accepts no changes.' }, 409);
    if (endpoint === '/auth/config') return reply({ mode: 'development', durable: true });
    if (endpoint === '/auth/me') return reply({ subject: 'fixture-admin', roles: ['admin'], mode: 'development' });
    if (endpoint === '/bodies') return reply(bodies());
    if (endpoint === '/missions') return reply(missions);
    if (endpoint === '/rounds') return reply(rounds);
    if (endpoint === '/audit') return reply(url.searchParams.has('limit') ? audit.slice(-Number(url.searchParams.get('limit'))) : audit);
    if (endpoint === '/devices') return reply(devices);
    if (endpoint === '/navigation/map') return reply(map);
    if (endpoint === '/navigation/conditions') return reply({ map_id: map.id, map_digest: 'd'.repeat(64), revision: 0, conditions: [], blocked_segment_ids: [] });
    if (endpoint === '/navigation/plans') return reply([proposal]);
    if (endpoint === '/replans') return reply([replan]);
    if (endpoint === '/handoffs') return reply([handoff]);
    if (endpoint.endsWith('/transfer-options')) return reply({ round_id: 'round-route-2', route_plan_id: 'route-fixture', current_step: 1, required: false, source_body_id: 'gazebo-rover', recommended_target_body_id: null, transfer_place_id: null, reason: 'The next step stays with the rover.', ready: false, blocking_reasons: [], map_digest: 'd'.repeat(64) });
    if (endpoint === '/observations/last-seen') return reply({ code: 'not_found', message: 'No observation matches.' }, 404);
    return reply([]);
  });
  await page.goto(new URL('operator.html', base).href);
  await page.getByLabel('Development API key').waitFor();
  return page;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const found = [];
  const check = async (page, where) => {
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() =>
      window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }),
    );
    for (const violation of result.violations)
      found.push(`${where}: ${violation.id} (${violation.impact}) ${violation.nodes.map((node) => node.target.join(' ')).slice(0, 4).join(', ')}`);
  };
  try {
    for (const colorScheme of ['light', 'dark']) {
      for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
        const where = `${colorScheme} ${viewport.width}px`;
        const polled = [];
        const page = await open(browser, viewport, colorScheme, polled);
        await check(page, `${where} sign-in`);
        await page.getByLabel('Development API key').fill('console-accessibility-fixture-'.repeat(2));
        await page.getByRole('button', { name: 'Connect to local core', exact: true }).click();
        const rail = page.getByRole('navigation', { name: 'Console sections' });
        for (const section of ['Fleet', 'Rounds', 'Missions', 'Routes', 'Continuity', 'Audit', 'Devices']) {
          await rail.getByRole('link', { name: new RegExp(`^${section}`) }).click();
          await page.getByRole('heading', { level: 1, name: section, exact: true }).waitFor();
          // Focus follows the operator's move to the section's heading.
          assert.equal(await page.evaluate(() => document.activeElement?.textContent), section);
          await page.waitForTimeout(400);
          await check(page, `${where} ${section}`);
        }
        await rail.getByRole('link', { name: /^Rounds/ }).click();
        const abandon = page.getByRole('button', { name: 'Abandon held round', exact: true }).first();
        await abandon.click();
        const confirm = page.getByRole('button', { name: 'Confirm abandon round', exact: true });
        await confirm.waitFor();
        assert.equal(await confirm.evaluate((element) => element === document.activeElement), true, 'Arming moves focus to the confirmation');
        await check(page, `${where} armed abandon`);
        await page.keyboard.press('Escape');
        await abandon.waitFor();
        assert.equal(await abandon.evaluate((element) => element === document.activeElement), true, 'Escape returns focus to the arm button');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${where} must not scroll sideways`);

        // A route review draws the planner's search; a continuation waits behind its fence.
        await rail.getByRole('link', { name: /^Routes/ }).click();
        await page.getByRole('button', { name: 'View route plan', exact: true }).click();
        await page.getByRole('region', { name: 'Routes the planner compared', exact: true }).waitFor();
        await page.getByText('How the planner searched', { exact: true }).click();
        await page.getByRole('button', { name: 'View continuity review', exact: true }).click();
        await page.locator('.replan-review .fence').waitFor();
        assert.equal(await page.getByRole('button', { name: 'Approve reviewed continuation', exact: true }).isDisabled(), true, 'The fence keeps approval closed');
        await check(page, `${where} route and continuation reviews`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${where} route reviews must not scroll sideways`);
        await rail.getByRole('link', { name: /^Continuity/ }).click();
        await page.getByRole('button', { name: 'Open handoff review', exact: true }).click();
        await page.locator('.handoff-review .fence').waitFor();
        await check(page, `${where} handoff review`);
        await rail.getByRole('link', { name: /^Audit/ }).click();
        await page.getByText('1 not verified', { exact: true }).waitFor();
        await check(page, `${where} audit ledger`);

        // Opened sections stay mounted while hidden; only the shell keeps polling.
        await rail.getByRole('link', { name: /^Fleet/ }).click();
        await page.waitForTimeout(500);
        polled.length = 0;
        await page.waitForTimeout(5500);
        const hiddenPolls = [...new Set(polled)].filter((endpoint) => !['/bodies', '/missions', '/rounds'].includes(endpoint));
        assert.deepEqual(hiddenPolls, [], `${where}: hidden sections must not poll`);
        await page.close();
      }
    }
    assert.deepEqual(found, [], `axe found ${found.length} issue(s):\n${found.join('\n')}`);
    console.log('PASS: no axe WCAG 2.1 A/AA violations on the console sign-in, every section, an armed approval, route and continuation reviews with the search and fence timer, a handoff review and the audit ledger, light and dark, 390 and 1440 px; focus follows section moves and arming; hidden sections stop polling');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
