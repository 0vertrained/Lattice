// axe-core WCAG 2.1 A/AA checks of the public tour in the light and dark themes, on a phone and a desktop.
// Covers the story opening, the stories line, the menu, and every chapter of every recorded story.
const { chromium } = require('../../apps/control-center/node_modules/playwright');
const axe = require('../../apps/control-center/node_modules/axe-core');
const assert = require('node:assert/strict');
(async () => {
  const base = process.env.LATTICE_VISITOR_URL || 'http://localhost:5173/';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const found = [];
  const stories = [
    ['Blocked aisle', 'Adaptive route chapters', ['A new route condition', 'Reviewed continuity', 'Measured continuation', 'Evidence and limits']],
    ['Rover to quadruped', 'Capability route chapters', ['Capability decision', 'Measured traversal', 'Camera continuity', 'Approval and limits']],
    ['Two-rover handoff', 'Two-rover chapters', ['Shared objective', 'Two-rover replay', 'Shared memory', 'Handoff proof']],
    ['Core restart', 'Walkthrough chapters', ['Briefing', 'Recorded mission', 'Camera evidence', 'Restart recovery', 'Architecture']],
  ];
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
        const page = await browser.newPage({ viewport, colorScheme, reducedMotion: 'reduce' });
        await page.goto(base, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { level: 1 }).waitFor();
        await check(page, `${where} opening`);
        if (viewport.width < 760) {
          await page.getByRole('button', { name: 'Menu', exact: true }).click();
          await page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Stories' }).waitFor();
          await check(page, `${where} menu`);
          await page.keyboard.press('Escape');
        }
        for (const [story, nav, chapters] of stories) {
          await page.getByRole('navigation', { name: 'Recorded stories' }).getByRole('button', { name: story, exact: true }).click();
          for (const chapter of chapters) {
            await page.getByRole('navigation', { name: nav, exact: true }).getByRole('button', { name: chapter, exact: true }).click();
            await page.getByRole('heading', { name: chapter, exact: true }).waitFor();
            await check(page, `${where} ${story}: ${chapter}`);
          }
        }
        // The restart ladder with a held round, the state with the most colour on screen.
        await page.getByRole('navigation', { name: 'Recorded stories' }).getByRole('button', { name: 'Core restart', exact: true }).click();
        await page.getByRole('navigation', { name: 'Walkthrough chapters', exact: true }).getByRole('button', { name: 'Restart recovery', exact: true }).click();
        await page.getByRole('button', { name: /^Review/ }).click();
        await check(page, `${where} restart ladder under review`);
        await page.close();
      }
    }
    assert.deepEqual(found, [], `axe found ${found.length} issue(s):\n${found.join('\n')}`);
    console.log('PASS: no axe WCAG 2.1 A/AA violations in the opening, menu or any chapter of the four stories, light and dark, 390 and 1440 px');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
