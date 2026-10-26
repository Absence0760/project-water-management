// The workspace's small-text floor on screen (issue #521 round 6, ui-playbook.md § 3 type scale): every tab's text,
// the app's frame included, is at least 12 px on a phone (0.85rem, 11.9 px, counts, as in round 5) and at least
// --font-xs (0.75rem, 10.5 px at the 14 px root) on a desktop. Small text takes app.css's --font-xs / --font-sm,
// which a phone lifts to 12 px; uiPatterns.test.ts refuses a literal size under them. The decided exceptions:
// text in an svg (charts and diagrams, sized in drawing units), visually hidden text, and the aria-hidden glyphs
// and count bubbles below. Synthetic data only.
import { seedManyAllocations } from '../support/allocations.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll, layoutSettled, smallText } from '../support/reflow.ts';

/** Every workspace tab (frontend/src/lib/workspace/tabs.ts ALL_TABS). */
const TABS = ['overview', 'network', 'map', 'crops', 'transfers', 'series', 'settings', 'calibration', 'runs', 'river', 'supply', 'dams', 'compare', 'scenarios', 'allocations', 'project', 'applications', 'history'];
/** The exceptions uiPatterns.test.ts lists: a menu's ▾, a delta's ▲▼, a sorted column's arrow, count bubbles on icon buttons. */
const GLYPHS = '[aria-hidden="true"]:is(.caret, .arrow, .dir, .count), .mfa-badge';

for (const { name, size, floor } of [
	{ name: 'a phone', size: { width: 390, height: 844 }, floor: 11.85 },
	{ name: 'a desktop', size: { width: 1440, height: 960 }, floor: 10.45 }
])
	test(`no text under the floor on any workspace tab on ${name}`, async ({ page, owner }) => {
		test.setTimeout(120_000);
		void owner;
		await page.setViewportSize(size);
		// Eight units with dams, three years of rain and flow, a run and registered volumes: every tab has content.
		const { id } = await seedManyAllocations(page.request, `Text floor ${size.width}`, { farms: 8 });
		for (const tab of TABS) {
			await page.goto(`/projects/${id}?tab=${tab}`);
			await expect(page.getByTestId('section-header').getByRole('heading', { level: 1 })).toBeVisible();
			await expect(page.locator(`#tab-${tab}`)).toHaveAttribute('aria-current', 'page');
			// The tab's chunk and its data have arrived: no loading state left in it.
			await expect(page.locator('.tab-body > *').first()).toBeVisible();
			await expect(page.locator('main .spinner')).toHaveCount(0);
			await layoutSettled(page);
			expect(await smallText(page, floor, page.locator('body'), GLYPHS), tab).toEqual([]);
			await expectNoSidewaysScroll(page);
		}
	});
