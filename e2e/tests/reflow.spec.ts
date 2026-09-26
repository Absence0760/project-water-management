// Reflow at 320 CSS px (WCAG 2.2 SC 1.4.10): a catchment tab never scrolls the
// page sideways. Genuinely wide content (a monthly table, the section menu)
// scrolls inside its own box instead. Issue #38.
import type { Page } from '@playwright/test';
import { createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const NARROW = { width: 320, height: 640 };

/**
 * The page's scroll width, plus every element that pokes past the viewport's
 * right edge without a scrolling (or clipping) ancestor to hold it, so a
 * failure names the culprit rather than just a number.
 */
async function sidewaysOverflow(page: Page) {
	return page.evaluate(() => {
		const root = document.documentElement;
		const edge = root.clientWidth;
		const held = (el: Element) => {
			for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
				const ox = getComputedStyle(p).overflowX;
				if (ox !== 'visible') return true;
			}
			return false;
		};
		const culprits = [...document.body.querySelectorAll('*')]
			.filter((el) => {
				const r = el.getBoundingClientRect();
				return r.width > 0 && r.right > edge + 0.5 && !held(el);
			})
			.map((el) => {
				const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
				return `${el.tagName.toLowerCase()}${cls} right=${Math.round(el.getBoundingClientRect().right)}`;
			});
		return { scrollWidth: root.scrollWidth, clientWidth: edge, culprits };
	});
}

async function expectNoSidewaysScroll(page: Page) {
	const o = await sidewaysOverflow(page);
	expect(o.culprits, `page is ${o.scrollWidth}px wide in a ${o.clientWidth}px viewport`).toEqual([]);
	expect(o.scrollWidth).toBeLessThanOrEqual(o.clientWidth);
}

test.describe('320 px reflow', () => {
	test.use({ viewport: NARROW });

	test('the Settings tab fits the screen, the feeds panel included', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Reflow settings');
		await putModel(page.request, project.id, sampleModel());
		await page.goto(`/projects/${project.id}?tab=settings`);
		await expect(page.getByLabel('A-pan evaporation, Sep, mm')).toBeVisible();
		await expectNoSidewaysScroll(page);
		await expect(page.getByRole('region', { name: 'Data feeds' })).toBeVisible();
		await expectNoSidewaysScroll(page);

		// The zero-rain period lists with a water-year row and a date-range row.
		const zeroRain = page.getByTestId('zero-rain-settings');
		await zeroRain.getByRole('button', { name: 'Add a water year' }).first().click();
		await zeroRain.getByRole('button', { name: 'Add a date range' }).first().click();
		await expect(zeroRain.getByRole('button', { name: /^Remove / })).toHaveCount(2);
		await expectNoSidewaysScroll(page);
	});

	for (const tab of ['overview', 'network', 'crops', 'transfers', 'series', 'runs']) {
		test(`the ${tab} tab fits the screen`, async ({ page, owner }) => {
			void owner;
			const project = await createProject(page.request, `Reflow ${tab}`);
			await putModel(page.request, project.id, sampleModel());
			await page.goto(`/projects/${project.id}?tab=${tab}`);
			await expect(page.locator(`#tab-${tab}`)).toHaveAttribute('aria-current', 'page');
			await expectNoSidewaysScroll(page);
		});
	}
});
