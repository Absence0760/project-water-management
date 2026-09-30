// The shared "On this page" menu (common/SectionNav.svelte, docs/ui.md § On this page): on a laptop or
// wider its links flow across at most two rows (groups may break across them; as whole blocks, Runs &
// results took three rows at 1280 px), and what doesn't fit goes into a More menu at the end of the bar.
// It is on Settings & calibration, Runs & results, River & reserve, Units & supply and Data. Synthetic data.
import type { Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openRiver, seedRiverProject } from '../support/river.ts';
import { openSupply, seedSupplyProject } from '../support/supply.ts';

const SETTINGS_LINKS = [
	'Demand',
	'Flow calibration',
	'Rain gaps',
	'Calibration record',
	'Fit automatically',
	'WR2012 check',
	'Flow share',
	'EWR',
	'Reserve rules',
	'Drought restrictions',
	'Simulation period',
	'Data quality',
	'Outcome matrix',
	'Seasonal outlook',
	'Evidence',
	// Automatic runs, Data feeds, API keys and Scheduled reports behind one link.
	'Automation & access'
];
const moreButton = (menu: Locator) => menu.getByRole('button', { name: /^More sections/ });

/** How many rows the bar's links (and More) take: their distinct tops. */
async function barRows(menu: Locator): Promise<number> {
	const boxes = await Promise.all([...(await menu.getByRole('link').all()), ...(await moreButton(menu).all())].map((l) => l.boundingBox()));
	return new Set(boxes.map((b) => Math.round(b!.y))).size;
}

/**
 * Issue #162: a wider gap between groups with no name on the bar read as a spacing bug. Either each group's
 * name sits just before its first link, on its row, or there are no names and every gap on a row is the same.
 */
async function expectNamedGroups(menu: Locator, names: string[]): Promise<void> {
	await expect(menu.locator('.groups .grp-h')).toHaveText(names);
	const pairs = await menu.locator('.groups .grp-h').evaluateAll((els) =>
		els.map((el) => {
			const n = el.getBoundingClientRect();
			const l = el.nextElementSibling!.getBoundingClientRect();
			return { dy: Math.abs(n.top - l.top), gap: l.left - n.right };
		})
	);
	for (const p of pairs) {
		expect(p.dy).toBeLessThan(1);
		expect(p.gap).toBeGreaterThanOrEqual(0);
		expect(p.gap).toBeLessThan(12);
	}
}
async function expectEvenGaps(menu: Locator): Promise<void> {
	await expect(menu.locator('.groups .grp-h')).toHaveCount(0);
	const boxes = await menu.locator('.groups a.pill').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), left: r.left, right: r.right })));
	const gaps = boxes.slice(1).flatMap((b, i) => (b.top === boxes[i]!.top ? [b.left - boxes[i]!.right] : []));
	expect(gaps.length).toBeGreaterThan(0);
	expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1);
}

/** The menu's height: two rows of 30 px links and their gaps come to about 78 px; three to 112. */
const TWO_ROWS = 90;

test('Settings: at 1440 and 1280 px every link is on the bar, in at most two rows', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Menu rows settings');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${project.id}?tab=settings`);
	const menu = page.getByRole('navigation', { name: 'Settings sections' });
	await expect(menu.getByRole('link')).toHaveText(SETTINGS_LINKS);
	for (const width of [1440, 1280]) {
		await page.setViewportSize({ width, height: 900 });
		await expect(moreButton(menu)).toHaveCount(0);
		await expect(menu.getByRole('link')).toHaveText(SETTINGS_LINKS);
		expect(await barRows(menu)).toBeLessThanOrEqual(2);
		expect((await menu.boundingBox())!.height).toBeLessThan(TWO_ROWS);
		// Its group names would push links into More at 1280 px, so it has none and spaces its links evenly.
		await expectEvenGaps(menu);
	}
});

test('Runs & results: at 1440 and 1280 px every link is on the bar, in at most two rows (three before)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Menu rows runs');
	await createRun(page.request, project.id, 'Baseline');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${project.id}?tab=runs`);
	const menu = page.getByRole('navigation', { name: 'Result sections' });
	await expect(menu.getByRole('link', { name: 'Outputs', exact: true })).toBeVisible();
	for (const width of [1440, 1280]) {
		await page.setViewportSize({ width, height: 900 });
		await expect(moreButton(menu)).toHaveCount(0);
		await expect(menu.getByRole('link', { name: 'Outputs', exact: true })).toBeVisible();
		expect(await barRows(menu)).toBeLessThanOrEqual(2);
		expect((await menu.boundingBox())!.height).toBeLessThan(TWO_ROWS);
		// Its group names would push links into More (they did in CI's fonts), so it has none and spaces its links evenly.
		await expectEvenGaps(menu);
	}
});

/** Settings & calibration at 1024 px, where its eighteen links don't fit in two rows. */
async function narrowSettings(page: Page, name: string) {
	const project = await createProject(page.request, name);
	await page.setViewportSize({ width: 1024, height: 768 });
	await page.goto(`/projects/${project.id}?tab=settings`);
	const menu = page.getByRole('navigation', { name: 'Settings sections' });
	await expect(moreButton(menu)).toBeVisible();
	return menu;
}

test('a narrower window moves the last links into More, which works from the keyboard and jumps like the bar', async ({ page, owner }) => {
	void owner;
	const menu = await narrowSettings(page, 'Menu more');
	const more = moreButton(menu);
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	expect(await barRows(menu)).toBeLessThanOrEqual(2);
	expect((await menu.boundingBox())!.height).toBeLessThan(TWO_ROWS);

	// The bar keeps the first links in page order; More holds the rest, in order, grouped as on the bar.
	const onBar = await menu.getByRole('link').allTextContents();
	expect(onBar.length).toBeGreaterThan(0);
	expect(onBar).toEqual(SETTINGS_LINKS.slice(0, onBar.length));

	// Keyboard: Enter opens it, Tab goes into its links, Escape closes it with focus back on the button.
	await more.focus();
	await page.keyboard.press('Enter');
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await expect(menu.getByRole('link')).toHaveText(SETTINGS_LINKS);
	await expect(menu.getByRole('list', { name: 'Automation & access' }).last().getByRole('link').last()).toHaveText('Automation & access');
	await page.keyboard.press('Tab');
	await expect(menu.getByRole('link', { name: SETTINGS_LINKS[onBar.length], exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(more).toBeFocused();
	await expect(menu.getByRole('link')).toHaveText(onBar);

	// Following a link in More jumps to its section below the menu, closes it, and More then says it holds the section read.
	await more.click();
	await menu.getByRole('link', { name: 'Automation & access' }).click();
	await expect(page).toHaveURL(/#set-auto$/);
	await expect(page.getByRole('heading', { level: 2, name: 'Automatic runs' })).toBeInViewport();
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	// Past the form too (the menu used to sit inside it and scrolled away at Data feeds): the group's panels below it
	// still count as the group's link being read.
	await page.getByRole('heading', { level: 2, name: 'Scheduled reports' }).scrollIntoViewIfNeeded();
	await expect(menu).toBeInViewport();
	await expect(more).toHaveAccessibleName('More sections, including the one being read');

	// A click outside closes it too.
	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await page.getByRole('heading', { level: 2, name: 'Scheduled reports' }).click();
	await expect(more).toHaveAttribute('aria-expanded', 'false');
});

test('the open More menu passes axe; wider, More goes; on a phone the strip has every link', async ({ page, owner }) => {
	void owner;
	const menu = await narrowSettings(page, 'Menu more a11y');
	const more = moreButton(menu);
	// The page with More closed, then the open menu itself. Open, the panel lies over
	// whatever the page has under it, and axe's target-size rule counts a control it
	// half covers as a small target: in DejaVu Sans the Soil-water store help button
	// sat 6 px under the last link. That is the page's layout under a transient
	// overlay (as a control under the sticky header is, a11y.ts), not the menu's.
	await expectNoViolations(page);
	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await expectNoViolations(page, { include: 'nav[aria-label="Settings sections"]' });

	// Wide again: everything back on the bar, no More.
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(more).toHaveCount(0);
	await expect(menu.getByRole('link')).toHaveText(SETTINGS_LINKS);

	// Phone: one sideways strip with every link, no More, and no sideways scroll of the page.
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(more).toHaveCount(0);
	await expect(menu.getByRole('link')).toHaveText(SETTINGS_LINKS);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await expectNoViolations(page);
});

test('River & reserve has the menu: every panel, a jump that lands below it, and a loaded link that lands', async ({ page, owner }) => {
	void owner;
	const id = await seedRiverProject(page.request, 'Menu river');
	await createRun(page.request, id, 'Baseline');
	await page.setViewportSize({ width: 1440, height: 960 });
	await openRiver(page, id);
	const menu = page.getByRole('navigation', { name: 'River sections' });
	await expect(menu.getByRole('link')).toHaveText(['Flow vs reserve', 'Days below, by year', 'EWR by month', 'Uncertainty', 'Outcome matrix', 'Seasonal outlook', 'Water account']);
	await expect(menu.getByRole('list', { name: 'How sure, and what if' }).getByRole('link')).toHaveText(['Uncertainty', 'Outcome matrix', 'Seasonal outlook']);
	// Its group names would take it to a second row at 1440, so it has none and spaces its links evenly (issue #162).
	await expectEvenGaps(menu);
	await expect(menu.getByRole('link', { name: 'Flow vs reserve' })).toHaveAttribute('aria-current', 'location');
	// One row at 1440, so the first screen loses little.
	expect(await barRows(menu)).toBe(1);

	await menu.getByRole('link', { name: 'Water account' }).click();
	await expect(page).toHaveURL(/#res-water-account$/);
	const account = page.locator('#res-water-account');
	await expect(account).toBeInViewport();
	await expect(menu).toBeInViewport();
	await expect(menu.getByRole('link', { name: 'Water account' })).toHaveAttribute('aria-current', 'location');
	const menuBox = (await menu.boundingBox())!;
	expect((await account.boundingBox())!.y).toBeGreaterThanOrEqual(menuBox.y + menuBox.height - 1);

	// A fresh load (a goto that only changes the fragment would stay on the page).
	await page.goto(`/projects/${id}?tab=overview`);
	await page.goto(`/projects/${id}?tab=river#res-outlook`);
	await expect(page.getByRole('heading', { name: 'Seasonal outlook' })).toBeInViewport();
	await expect(menu.getByRole('link', { name: 'Seasonal outlook' })).toHaveAttribute('aria-current', 'location');
});

test('Hydrological units has the menu: the hydrological unit detail and each table, with a jump below it', async ({ page, owner }) => {
	void owner;
	const project = await seedSupplyProject(page.request, 'Menu supply', 6);
	await createRun(page.request, project.id, 'Baseline');
	await page.setViewportSize({ width: 1440, height: 960 });
	await openSupply(page, project.id);
	const menu = page.getByRole('navigation', { name: 'Hydrological units sections' });
	await expect(menu.getByRole('link')).toHaveText(['Hydrological unit detail', 'Hydrological unit results', 'Curtailment', 'Assurance of supply']);
	expect(await barRows(menu)).toBe(1);
	await expectNamedGroups(menu, ['Each hydrological unit', 'Tables for this run']);

	await menu.getByRole('link', { name: 'Assurance of supply' }).click();
	await expect(page).toHaveURL(/#res-assurance$/);
	await expect(page.locator('#res-assurance')).toBeInViewport();
	await expect(menu).toBeInViewport();
	await expect(menu.getByRole('link', { name: 'Assurance of supply' })).toHaveAttribute('aria-current', 'location');

	await page.setViewportSize({ width: 390, height: 844 });
	await menu.getByRole('link', { name: 'Curtailment' }).click();
	await expect(page.locator('#res-curtailment')).toBeInViewport();
	await expect(menu.getByRole('link', { name: 'Curtailment' })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('Data has the menu: only the panels drawn, a jump that lands below it, and a loaded #data- link that lands', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Menu data');
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto(`/projects/${project.id}?tab=series`);
	const menu = page.getByRole('navigation', { name: 'Data sections' });
	// Rain and observed flow, no logger or CHIRPS: no agreement table and no double mass.
	await expect(menu.getByRole('link')).toHaveText(['Series', 'Chart', 'Data checks', 'What the model uses']);
	await expectNamedGroups(menu, ['Series', 'Checks', 'Adding data']);

	await menu.getByRole('link', { name: 'What the model uses' }).click();
	await expect(page).toHaveURL(/#data-uses$/);
	await expect(page.getByRole('heading', { level: 2, name: 'What the model uses' })).toBeInViewport();
	await expect(menu).toBeInViewport();

	// A fresh load (a goto that only changes the fragment would stay on the page).
	await page.goto(`/projects/${project.id}?tab=overview`);
	await page.goto(`/projects/${project.id}?tab=series#data-checks`);
	const checks = page.getByRole('heading', { level: 2, name: 'Data checks' });
	await expect(checks).toBeInViewport();
	await expect(checks).toBeFocused();
	const menuBox = (await menu.boundingBox())!;
	expect((await checks.boundingBox())!.y).toBeGreaterThanOrEqual(menuBox.y + menuBox.height);
});
