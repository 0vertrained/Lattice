// axe-core WCAG 2.1 A/AA checks of the operator console in the light and dark themes, on a phone and a
// desktop: the sign-in page, every section, and an armed approval. The API is an isolated fixture;
// nothing here reaches a core or a body.
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
];
const audit = [
  { occurred_at: iso(-60000), actor: { operator: 'fixture-admin' }, event_type: 'round.approved', object_id: 'round-held-1', metadata: {} },
  { occurred_at: iso(-30000), actor: { service: 'lattice-core' }, event_type: 'mission.recovery_required', object_id: 'mission-dock', metadata: {} },
];
const devices = [
  { id: 'device-1', body_id: 'gazebo-rover', label: 'Warehouse simulator', created_at: iso(-86400000), expires_at: iso(86400000 * 29), revoked_at: null },
  { id: 'device-0', body_id: 'gazebo-rover', label: 'Old laptop', created_at: iso(-86400000 * 40), expires_at: iso(-86400000 * 10), revoked_at: iso(-86400000 * 12) },
];

async function open(browser, viewport, colorScheme) {
  const page = await browser.newPage({ viewport, colorScheme, reducedMotion: 'reduce' });
  await page.route('**/api/ready', (route) => route.fulfill({ status: 200, headers: { 'x-lattice-core-epoch': '3f9a1c2e-0000-4000-8000-000000000000' }, body: '' }));
  await page.route('**/api/v1/**', (route) => {
    const endpoint = new URL(route.request().url()).pathname.replace('/api/v1', '');
    const reply = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (route.request().method() !== 'GET') return reply({ code: 'fixture', message: 'This fixture accepts no changes.' }, 409);
    if (endpoint === '/auth/config') return reply({ mode: 'development', durable: true });
    if (endpoint === '/auth/me') return reply({ subject: 'fixture-admin', roles: ['admin'], mode: 'development' });
    if (endpoint === '/bodies') return reply(bodies());
    if (endpoint === '/missions') return reply(missions);
    if (endpoint === '/rounds') return reply(rounds);
    if (endpoint === '/audit') return reply(audit);
    if (endpoint === '/devices') return reply(devices);
    if (endpoint === '/navigation/map') return reply({ code: 'not_configured', message: 'No semantic navigation map is configured.' }, 404);
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
        const page = await open(browser, viewport, colorScheme);
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
        const abandon = page.getByRole('button', { name: 'Abandon held round', exact: true });
        await abandon.click();
        const confirm = page.getByRole('button', { name: 'Confirm abandon round', exact: true });
        await confirm.waitFor();
        assert.equal(await confirm.evaluate((element) => element === document.activeElement), true, 'Arming moves focus to the confirmation');
        await check(page, `${where} armed abandon`);
        await page.keyboard.press('Escape');
        await abandon.waitFor();
        assert.equal(await abandon.evaluate((element) => element === document.activeElement), true, 'Escape returns focus to the arm button');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${where} must not scroll sideways`);
        await page.close();
      }
    }
    assert.deepEqual(found, [], `axe found ${found.length} issue(s):\n${found.join('\n')}`);
    console.log('PASS: no axe WCAG 2.1 A/AA violations on the console sign-in, any section or an armed approval, light and dark, 390 and 1440 px; focus follows section moves and arming');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
