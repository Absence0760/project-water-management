// Crops & demand (issue #17, option A · A3): a header with a one-line
// summary, a compact crop list largest planted area first (a row per crop:
// area, peak-need month, a factor sparkline; Edit opens its factors in a side
// sheet), the demand chart with its table behind Show table, and planted area
// per unit as stacked bars (a unit opens the farm drawer; Edit areas the
// planted-areas grid). From a wide page the list scrolls in its own column and
// the chart and bars fill the window beside it, however many crops and units
// there are. The full grids open from the Grids menu; nothing on the old tab
// is lost.
import type { Page } from '@playwright/test';
import { addMember, putModel, putSeries, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { openCropGrid, openCropSheet } from '../support/crops.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal, saveModelChanges } from '../support/network.ts';
import { answerConfirm } from '../support/confirm.ts';

async function savedFactor(page: Page, projectId: string, crop: string, month: number): Promise<number> {
	const res = await page.request.get(`${API_URL}/projects/${projectId}/model`);
	const m = (await res.json()) as { crops: { name: string; cropFactor: number[] }[] };
	return m.crops.find((c) => c.name === crop)!.cropFactor[month]!;
}

/** The seeded catchment plus a second crop (Vines, a factor above 1.0 in Jan) on Lower farm and a third farm with nothing planted. */
async function seed(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	const m = project.model;
	const vines = { id: crypto.randomUUID(), name: 'Vines', cropFactor: [0.3, 0.45, 0.6, 1.05, 0.6, 0.45, 0.3, 0, 0, 0, 0, 0.15] };
	m.crops.push(vines);
	m.cropAreas.push({ nodeId: m.nodes[2]!.id as string, cropId: vines.id, areaM2: 80_000 });
	m.nodes.push({ ...m.nodes[1]!, id: crypto.randomUUID(), name: 'Dry farm', sortOrder: 4 });
	await putModel(page.request, project.id, m);
	return project;
}

test('the header, crop list, demand chart and hydrological unit bars; Edit opens a crop’s factors in a sheet that saves', async ({ page, owner }) => {
	void owner;
	const project = await seed(page, 'Crops page');
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto(`/projects/${project.id}?tab=crops`);

	await expect(page.getByRole('heading', { level: 1, name: 'Crops & demand' })).toBeVisible();
	await expect(page.getByTestId('crops-summary')).toHaveText('2 crops · 40 ha irrigated on 2 farms · water year October to September');

	// A row per crop, largest area first: area, peak need (A-pan × factor), a sparkline with a name; the high-factor flag on Vines only.
	await expect(page.getByRole('heading', { name: 'Crops', exact: true })).toBeVisible();
	await expect(page.getByText('Largest planted area first')).toBeVisible();
	const rows = page.getByTestId('crop-row');
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toContainText('Orchard');
	await expect(rows.nth(1)).toContainText('Vines');
	const orchard = rows.filter({ hasText: 'Orchard' });
	await expect(orchard).toContainText('32 ha · peak need in Jan');
	await expect(orchard.getByRole('img', { name: /^Orchard: Crop factor by month, Oct–Sep\. max 0\.80 in Dec; Oct 0\.60, Nov 0\.70/ })).toBeVisible();
	await expect(orchard.getByRole('button', { name: /Factor above 1\.0/ })).toHaveCount(0);
	// The flag: an icon with its words as its name, shown on hover and focus; it opens the sheet with the full warning.
	const flag = rows.filter({ hasText: 'Vines' }).getByRole('button', { name: "Factor above 1.0 in Jan: check Vines isn't an FAO Kc" });
	await expect(flag).toBeVisible();
	await flag.focus();
	expect(await flag.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('"Factor above 1.0 in Jan"');
	expect(await flag.evaluate((el) => getComputedStyle(el, '::after').visibility)).toBe('visible');
	await flag.blur();
	// Each crop's colour: its own, the same in the list and the bars' key; no "Other" with two crops.
	await expect(page.getByTestId('crop-other')).toHaveCount(0);

	// The chart, above the fold, with its table one click away.
	const chart = page.getByRole('img', { name: /^Catchment irrigation demand by month, stacked by crop \(Orchard, Vines\)\. Peak in Jan/ });
	await expect(chart).toBeInViewport();
	await expect(page.getByTestId('crops-demand-summary')).toContainText('million m³ a year');
	await expect(page.locator('table.demand')).toBeHidden();
	await page.getByText('Show table', { exact: true }).click();
	await expect(page.locator('table.demand').getByRole('rowheader', { name: 'Catchment' })).toBeVisible();
	await page.getByText('Hide table', { exact: true }).click();

	// A bar per planted unit, largest first, parts in the list's order; the unplanted unit is named in the note.
	await expect(page.getByRole('img', { name: 'Lower farm: 20 ha, Orchard 12 ha and Vines 8 ha' })).toBeVisible();
	await expect(page.locator('ul.bars .farm')).toHaveText(['Upper farm', 'Lower farm']);
	await expect(page.getByTestId('crops-bar-key').locator('li')).toHaveText(['Orchard', 'Vines']);
	// A segment names its crop and area on hover.
	await expect(page.getByRole('img', { name: /^Lower farm: / }).locator('.seg').nth(1)).toHaveAttribute('title', 'Vines: 8 ha');
	await expect(page.getByText('Dry farm has no planted area, so its irrigation demand counts as zero.')).toBeVisible();
	// The page fills the window: the list and the results reach the bottom, nothing scrolls sideways.
	const layout = (await page.locator('.layout').boundingBox())!;
	expect(layout.y + layout.height).toBeGreaterThan(900);
	expect(layout.y + layout.height).toBeLessThanOrEqual(960);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
	await expectNoViolations(page);

	// Edit: the crop's name and 12 factors in a side sheet, linkable; it saves through its own save row.
	const sheet = await openCropSheet(page, 'Orchard');
	await expect(page).toHaveURL(/[?&]crop=/);
	await expect(sheet.getByRole('textbox', { name: 'Crop name' })).toHaveValue('Orchard');
	await expect(sheet.getByTestId('crop-planted-on')).toHaveText('Planted on Upper farm (20.00 ha) and Lower farm (12.00 ha).');
	await expectNoViolations(page);
	await sheet.getByLabel('Orchard crop factor, Jan').fill('0.9');
	await sheet.getByLabel('Orchard crop factor, Jan').press('Tab');
	await expect(sheet).toContainText('Unsaved changes to the model');
	await saveModelChanges(page);
	await expect(sheet).toContainText('No unsaved changes');
	expect(await savedFactor(page, project.id, 'Orchard', 3)).toBe(0.9);
	await closeModal(page);
	await expect(page).toHaveURL(/\?tab=crops$/);
	await expect(orchard.getByRole('img', { name: /^Orchard: Crop factor by month, Oct–Sep\. max 0\.90 in Jan; .* Jan 0\.90,/ })).toBeVisible();

	// The flag opens the crop's sheet too.
	await flag.click();
	await expect(page.getByRole('dialog', { name: 'Edit Vines' })).toBeVisible();
	await closeModal(page);

	// Back closes a sheet opened from the page.
	await openCropSheet(page, 'Vines');
	await page.goBack();
	await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Add crop opens the new crop’s sheet; Remove takes it and its areas away', async ({ page, owner }) => {
	void owner;
	const project = await seed(page, 'Crops page add');
	await page.goto(`/projects/${project.id}?tab=crops`);
	await page.getByRole('button', { name: '+ Add crop', exact: true }).click();
	const sheet = page.getByRole('dialog', { name: 'Edit Crop 3' });
	await expect(sheet.getByRole('textbox', { name: 'Crop name' })).toBeFocused();
	await sheet.getByRole('textbox', { name: 'Crop name' }).fill('Lucerne');
	await expect(page.getByRole('dialog', { name: 'Edit Lucerne' })).toBeVisible();
	await closeModal(page);
	await expect(page.getByTestId('crop-row')).toHaveCount(3);
	// Nothing planted: last in the list.
	await expect(page.getByTestId('crop-row').nth(2)).toContainText('Lucerne 0 ha · no crop factors yet');

	// Remove Vines (planted on a farm, so it asks first); the sheet closes with it.
	const vines = await openCropSheet(page, 'Vines');
	await vines.getByRole('button', { name: 'Remove Vines' }).click();
	await answerConfirm(page, true, 'Remove crop “Vines”?');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page).not.toHaveURL(/crop=/);
	await expect(page.getByTestId('crop-row')).toHaveCount(2);
	await expect(page.getByRole('img', { name: 'Lower farm: 12 ha, Orchard 12 ha' })).toBeVisible();
});

test('the Grids menu and Edit areas open the full grids over the page; a farm opens its drawer', async ({ page, owner }) => {
	void owner;
	const project = await seed(page, 'Crops page grids');
	await page.goto(`/projects/${project.id}?tab=crops`);

	// Crop factors: the full grid (reorder, every cell, the high-factor warning).
	const factors = await openCropGrid(page, 'crop-factors');
	await expect(page).toHaveURL(/\?tab=crops&grid=crop-factors$/);
	await expect(factors.getByLabel('Vines crop factor, Jan')).toHaveValue('1.05');
	await expect(factors.getByRole('status').filter({ hasText: 'A crop factor above 1.0' })).toContainText('Vines (Jan)');
	await expectNoViolations(page);
	await closeModal(page);

	// The menu holds the two crop grids only: the demand table is on the page, behind Show table (issue #174).
	const menu = page.locator('details.grids-menu');
	await menu.locator('summary').click();
	await expect(page.getByRole('group', { name: 'Open as a grid' }).getByRole('link')).toHaveText(['Crop factors', 'Planted areas']);
	// The menu closes on Escape, focus back on its button.
	await page.keyboard.press('Escape');
	await expect(page.getByRole('group', { name: 'Open as a grid' })).toBeHidden();
	await expect(menu.locator('summary')).toBeFocused();

	// Edit areas: the planted-areas grid; an edit there shows on the bars.
	await page.getByRole('link', { name: 'Edit areas' }).click();
	const areas = page.getByRole('dialog', { name: 'Planted areas' });
	await areas.getByLabel('Orchard on Dry farm, ha').fill('5');
	await areas.getByLabel('Orchard on Dry farm, ha').press('Tab');
	await closeModal(page);
	await expect(page.getByRole('img', { name: 'Dry farm: 5 ha, Orchard 5 ha' })).toBeVisible();
	await expect(page.getByText(/no planted area/)).toHaveCount(0);

	// A farm's name opens its drawer, with the same unsaved value.
	await page.getByRole('link', { name: 'Dry farm: planted areas' }).click();
	const drawer = page.getByRole('dialog', { name: 'Dry farm: planted areas' });
	await expect(drawer.getByLabel('Orchard on Dry farm, ha')).toHaveValue('5');
	await closeModal(page);
	await expect(page).toHaveURL(/\?tab=crops$/);
});

test('an old link to the Irrigation demand grid opens the page with its demand table shown', async ({ page, owner }) => {
	void owner;
	const project = await seed(page, 'Crops page demand link');
	// The grid modal showed it over any tab (grid=demand, issue #17) until it was removed as a repeat of the page (issue #174).
	await page.goto(`/projects/${project.id}?tab=network&grid=demand`);
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=crops#crop-demand-table$`));
	await expect(page.getByRole('heading', { level: 1, name: 'Crops & demand' })).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	const table = page.locator('table.demand');
	await expect(table.getByRole('rowheader', { name: 'Dry farm' })).toBeInViewport();
	await expect(table.getByRole('rowheader', { name: 'Catchment' })).toBeVisible();
	await expect(page.getByText('Hide table', { exact: true })).toBeVisible();
});

test('a viewer sees the list and bars, opens a crop’s factors read-only, and adds nothing', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seed(page, 'Crops page viewer');
	const viewer = await signIn('Crops page viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.goto(`/projects/${project.id}?tab=crops`);
	await expect(v.getByTestId('crop-row')).toHaveCount(2);
	await expect(v.getByRole('button', { name: 'View Vines' })).toBeVisible();
	await expect(v.getByRole('button', { name: '+ Add crop' })).toHaveCount(0);
	await expect(v.getByRole('link', { name: 'Areas table' })).toBeVisible();
	const sheet = await openCropSheet(v, 'Orchard');
	await expect(sheet).toHaveAccessibleName('Orchard: crop factors');
	await expect(sheet.getByLabel('Orchard crop factor, Oct')).not.toBeEditable();
	await expect(sheet.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
	await closeModal(v);
});

test('with no crops the header and an Add crop prompt show', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Crops page empty');
	await putModel(page.request, project.id, { ...project.model, crops: [], cropAreas: [] });
	await page.goto(`/projects/${project.id}?tab=crops`);
	await expect(page.getByTestId('crops-summary')).toHaveText('0 crops · nothing planted yet · water year October to September');
	await expect(page.getByRole('region', { name: 'No crops yet' }).getByRole('button', { name: 'Add crop', exact: true })).toBeVisible();
	await expect(page.locator('details.grids-menu')).toBeVisible();
});

test('with a daily A-pan series the demand chart says it shows the monthly means, which runs replace (issue #173)', async ({ page, owner }) => {
	void owner;
	const project = await seed(page, 'Crops page daily A-pan');
	await page.goto(`/projects/${project.id}?tab=crops`);
	const chart = page.getByRole('img', { name: /^Catchment irrigation demand by month/ });
	await expect(chart).toBeVisible();
	await expect(page.getByTestId('crops-demand-apan')).toHaveCount(0);

	await putSeries(page.request, project.id, { kind: 'evap_apan_mm', unit: 'mm', startDate: '2020-01-01', values: [5, 6, 7] });
	await page.reload();
	const note =
		'Shows the monthly A-pan means. Runs use the daily A-pan series (Data tab) on the days it has a value and these means only on the other days, so their demand differs.';
	await expect(page.getByTestId('crops-demand-apan')).toHaveText(note);
	// Screen readers hear it with the chart.
	await expect(chart).toHaveAccessibleName(/Show table holds the values\. Shows the monthly A-pan means\. .* so their demand differs\.$/);
	await expectNoViolations(page);

	// With no monthly means the preview shows no demand, but the alert says runs still take the daily series.
	await updateSettings(page.request, project.id, { apanMm: new Array(12).fill(0) });
	await page.reload();
	const alert = page.getByRole('region', { name: /^Irrigation demand by month/ }).locator('.alert');
	await expect(alert).toHaveText(
		"The monthly A-pan means aren't set, so this preview shows no demand. Runs use the daily A-pan series (Data tab) on the days it has a value. Enter the monthly A-pan values (Settings & calibration, Demand) for the other days."
	);
	await expect(alert.getByRole('link', { name: 'Enter the monthly A-pan values' })).toHaveAttribute('href', '?tab=settings');
	await expect(page.getByTestId('crops-demand-apan')).toHaveCount(0);
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the list, then the chart, then the bars in one column; the sheet fills the screen, no violations', async ({ page, owner }) => {
		void owner;
		const project = await seed(page, 'Crops page phone');
		await page.goto(`/projects/${project.id}?tab=crops`);
		const rows = page.getByTestId('crop-row');
		await expect(rows).toHaveCount(2);
		const [a, b] = [(await rows.nth(0).boundingBox())!, (await rows.nth(1).boundingBox())!];
		expect(b.y).toBeGreaterThan(a.y + a.height - 1);
		// Two crops fit: no Show all.
		await expect(page.getByRole('button', { name: /^Show all/ })).toHaveCount(0);
		const list = (await page.getByRole('region', { name: 'Crops', exact: true }).boundingBox())!;
		const chart = (await page.getByRole('img', { name: /^Catchment irrigation demand by month/ }).boundingBox())!;
		expect(chart.y).toBeGreaterThan(list.y + list.height - 1);
		const bar = page.getByRole('img', { name: /^Lower farm: / });
		expect((await bar.boundingBox())!.width).toBeGreaterThan(250);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		await expectNoViolations(page);

		const sheet = await openCropSheet(page, 'Orchard');
		const box = (await sheet.boundingBox())!;
		expect(box.x).toBe(0);
		expect(box.width).toBeGreaterThan(370);
		await expectNoViolations(page);
	});
});

/**
 * A big synthetic catchment: 30 crops (areas falling off from 400 ha to under 5 ha, so the order is known) on 20 units,
 * each crop on one to four units. Names and numbers are invented.
 */
async function seedBig(page: Page, name: string) {
	const project = await seedRunnableProject(page.request, name);
	const m = project.model;
	const [gauge, unit] = [m.nodes[0]!, m.nodes[1]!];
	const units = Array.from({ length: 20 }, (_, u) => ({ ...unit, id: crypto.randomUUID(), name: `Unit ${u + 1}`, sortOrder: u + 2, downstreamNodeId: gauge.id }));
	m.nodes = [gauge, ...units];
	m.transfers = [];
	m.crops = Array.from({ length: 30 }, (_, i) => ({
		id: crypto.randomUUID(),
		name: `Crop ${String(i + 1).padStart(2, '0')}`,
		cropFactor: Array.from({ length: 12 }, (_, mo) => Math.round((0.3 + 0.5 * Math.abs(Math.sin((mo + i) / 3))) * 100) / 100)
	}));
	m.cropAreas = m.crops.flatMap((c, i) => {
		const k = 1 + (i % 4);
		const total = Math.round(4_000_000 / (i + 1) ** 1.3);
		return Array.from({ length: k }, (_, j) => ({ nodeId: units[(i * 3 + j * 7) % 20]!.id as string, cropId: c.id, areaM2: Math.round(total / k) }));
	});
	await putModel(page.request, project.id, m);
	return project;
}

test.describe('a big catchment', () => {
	test('the chart and the hydrological unit bars stay on the first screen; the list scrolls in itself; named crops never share a colour', async ({ page, owner }) => {
		void owner;
		const project = await seedBig(page, 'Crops page big');
		await page.setViewportSize({ width: 1440, height: 960 });
		await page.goto(`/projects/${project.id}?tab=crops`);
		await expect(page.getByTestId('crops-summary')).toContainText('30 crops · ');

		// The chart and the planted-area card, key included, are inside the window without scrolling the page.
		const chart = page.getByRole('img', { name: /^Catchment irrigation demand by month, stacked by crop \(Crop 01, .*Crop 09, Other \(21 crops\)\)/ });
		await expect(chart).toBeInViewport({ ratio: 1 });
		const card = (await page.getByRole('region', { name: 'Planted area by hydrological unit' }).boundingBox())!;
		expect(card.y + card.height).toBeLessThanOrEqual(960);
		const key = page.getByTestId('crops-bar-key');
		await expect(key).toBeInViewport({ ratio: 1 });
		await expect(key.locator('li').last()).toHaveText('Other');
		expect(await page.evaluate(() => window.scrollY)).toBe(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);

		// The list and the bars scroll inside their own boxes.
		const scrolls = (sel: string) => page.locator(sel).evaluate((el) => el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY === 'auto');
		expect(await scrolls('.crop-list')).toBe(true);
		expect(await scrolls('ul.bars')).toBe(true);
		const list = (await page.getByRole('region', { name: 'Crops', exact: true }).boundingBox())!;
		expect(list.y + list.height).toBeLessThanOrEqual(960);
		// Units largest first.
		const ha = (await page.locator('ul.bars .total').allTextContents()).map((t) => Number(t.replace(/[^\d.]/g, '')));
		expect(ha).toEqual([...ha].sort((a, b) => b - a));

		// Crops largest first: nine with a colour each, then "Other" naming the rest, whose rows say so.
		const rows = page.getByTestId('crop-row');
		await expect(rows).toHaveCount(30);
		await expect(rows.first()).toContainText('Crop 01');
		await expect(page.getByTestId('crop-other')).toContainText('Other: Crop 10, Crop 11, Crop 12');
		await expect(page.getByTestId('crop-other')).toContainText('21 smaller crops share one colour');
		await expect(rows.nth(9)).toContainText('Crop 10');
		await expect(rows.nth(9)).toContainText('in Other');
		await expect(rows.nth(8)).not.toContainText('in Other');
		const named = await page.locator('[data-testid="crop-row"] .key:not(.hatch)').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
		expect(named).toHaveLength(9);
		expect(new Set(named).size).toBe(9);
		const other = await page.getByTestId('crop-other').locator('.key').evaluate((e) => getComputedStyle(e).backgroundColor);
		expect(named).not.toContain(other);
		// The same colours in the unit bars' key, in the same order.
		const keyColours = await key.locator('.key').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
		expect(keyColours).toEqual([...named, other]);
		await expectNoViolations(page);
	});

	test('below the two-column width: a capped list with Show all, then the chart and the bars', async ({ page, owner }) => {
		void owner;
		const project = await seedBig(page, 'Crops page big narrow');
		await page.setViewportSize({ width: 1024, height: 800 });
		await page.goto(`/projects/${project.id}?tab=crops`);
		const list = page.locator('.crop-list');
		const capped = (await list.boundingBox())!.height;
		expect(capped).toBeLessThan(400);
		const more = page.getByRole('button', { name: 'Show all 30 crops' });
		await expect(more).toHaveAttribute('aria-expanded', 'false');
		await more.click();
		const fewer = page.getByRole('button', { name: 'Show fewer' });
		await expect(fewer).toHaveAttribute('aria-expanded', 'true');
		expect((await list.boundingBox())!.height).toBeGreaterThan(capped * 3);
		await fewer.click();
		await expect(more).toBeVisible();
		const chart = (await page.getByRole('img', { name: /^Catchment irrigation demand by month/ }).boundingBox())!;
		expect(chart.y).toBeGreaterThan((await list.boundingBox())!.y + capped - 1);
		await expect(page.getByTestId('crops-bar-key')).toBeVisible();
	});

	test.describe('phone', () => {
		test.use({ viewport: { width: 390, height: 844 } });

		test('one column, no sideways scroll, the key under the bars, no violations', async ({ page, owner }) => {
			void owner;
			const project = await seedBig(page, 'Crops page big phone');
			await page.goto(`/projects/${project.id}?tab=crops`);
			await expect(page.getByRole('button', { name: 'Show all 30 crops' })).toBeVisible();
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
			const key = page.getByTestId('crops-bar-key');
			await key.scrollIntoViewIfNeeded();
			await expect(key).toBeInViewport({ ratio: 1 });
			await expectNoViolations(page);
		});
	});
});
