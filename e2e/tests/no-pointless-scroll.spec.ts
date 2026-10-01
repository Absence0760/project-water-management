// No pointless page scroll (issue #17 "Viewport-height layout"; docs/design/ui-playbook.md § 2): a page keeps
// only a 1rem gutter below its content, plus room for the model save bar while that shows. The page used to
// reserve 5rem (the workspace 4rem) below everything, so any page whose content came within 56–70 px of the
// window's foot scrolled for nothing. Synthetic data only.
import type { Page } from '@playwright/test';
import { createProject, createRun, seedRunnableProject, showAllSections } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { rulesCard } from '../support/transfers.ts';

/** The page's gutter below its content (app.css `.page`, 1rem at the 14 px root). */
const GUTTER = 14;

const TABS = [
	'overview', 'network', 'map', 'crops', 'transfers', 'series', 'settings', 'runs', 'river',
	'supply', 'dams', 'compare', 'scenarios', 'allocations', 'project', 'applications', 'history'
];

/** How far the page scrolls, and how far its content (the `.page` box less its bottom padding) reaches past the window. */
const measure = (page: Page) =>
	page.evaluate(() => {
		const main = document.querySelector('.page') as HTMLElement;
		const r = main.getBoundingClientRect();
		const contentBottom = r.bottom + scrollY - parseFloat(getComputedStyle(main).paddingBottom);
		return { scroll: document.documentElement.scrollHeight - innerHeight, content: contentBottom - innerHeight };
	});

/** The page scrolls no further than its content plus the gutter: nothing but a gutter's worth of blank below. */
async function expectNoReservedRoom(page: Page, what: string) {
	await expect(page.locator('h1').first(), what).toBeVisible();
	await expect
		.poll(async () => {
			const m = await measure(page);
			return m.scroll - Math.max(0, Math.ceil(m.content) + GUTTER);
		}, { message: `${what}: the page scrolls past its content and a 1rem gutter` })
		.toBeLessThanOrEqual(0);
}

test('pages whose content fits the window do not scroll', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const small = await seedRunnableProject(page.request, 'Short pages');
	await createRun(page.request, small.id, 'Baseline');
	const empty = await createProject(page.request, 'Short pages empty');
	// The empty project's Data tab ended 53 px above the window's foot and scrolled 3 px under the old padding.
	// /account is not here: with the two-step sign-in and delete-account cards (#282, #112) its content is taller
	// than 960 px, so it scrolls for a reason; the gutter test below still holds it to a 1rem gutter at three sizes.
	for (const url of ['/', '/teams', `/projects/${empty.id}?tab=series`, `/projects/${empty.id}?tab=overview`, `/projects/${small.id}?tab=compare`]) {
		await page.goto(url);
		await expect(page.locator('h1').first()).toBeVisible();
		await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight), { message: url }).toBe(0);
	}
});

test('every workspace tab and app page keeps only a gutter below its content, wide and on a phone', async ({ page, owner }) => {
	void owner;
	test.setTimeout(180_000);
	const project = await seedRunnableProject(page.request, 'Gutter only');
	await createRun(page.request, project.id, 'Baseline');
	// Every section an owner sees is checked: a new tab fails here until it joins TABS. Shown all first, since
	// History, Allocations and Applications start hidden (DEFAULT_HIDDEN_TABS) and still open from their links.
	await showAllSections(page.request);
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto(`/projects/${project.id}`);
	await expect(page.getByRole('navigation', { name: 'Project sections' }).getByRole('link')).toHaveCount(TABS.length);
	for (const [width, height] of [
		[1440, 960],
		[1280, 800],
		[390, 844]
	] as const) {
		await page.setViewportSize({ width, height });
		for (const url of ['/', '/teams', '/account', '/help', ...TABS.map((t) => `/projects/${project.id}?tab=${t}`)]) {
			await page.goto(url);
			await expectNoReservedRoom(page, `${url.replace(project.id, '<id>')} at ${width}×${height}`);
		}
	}
});

test('with unsaved model edits the save bar never covers the last row, on a short page or a long one', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Save bar clearance');
	await page.goto(`/projects/${project.id}?tab=transfers`);
	await page.getByTestId('section-header').getByRole('button', { name: '+ Add transfer', exact: true }).click();
	const bar = page.getByRole('region', { name: 'Unsaved model changes' });
	await expect(bar).toBeVisible();
	const barTop = async () => (await bar.boundingBox())!.y;

	// Transfers with two rules is short: its rules card ends above the bar, and the page still doesn't scroll.
	await expect.poll(async () => {
		const rules = (await rulesCard(page).boundingBox())!;
		return rules.y + rules.height - (await barTop());
	}).toBeLessThanOrEqual(0);
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);

	// Settings is long: scrolled to the end, its content ends above the bar (the page's room below is the bar's height).
	await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Settings & calibration', exact: true }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Settings & calibration' })).toBeVisible();
	await expect(bar).toBeVisible();
	await expect
		.poll(async () => {
			await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
			const contentBottom = await page.evaluate(() => {
				const main = document.querySelector('.page') as HTMLElement;
				return main.getBoundingClientRect().bottom - parseFloat(getComputedStyle(main).paddingBottom);
			});
			return contentBottom - (await barTop());
		})
		.toBeLessThanOrEqual(0);
});
