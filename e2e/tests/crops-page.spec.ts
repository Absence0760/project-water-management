// Crops & demand as a page of pictures (issue #17, option A · A3): a header
// with a one-line summary, a card per crop (area, peak-need month, a factor
// sparkline; Edit opens its factors in a side sheet), the demand chart with
// its table behind Show table, and planted area per farm as stacked bars (a
// farm opens the farm drawer; Edit areas the planted-areas grid). The full
// grids open from the Grids menu; nothing on the old tab is lost.
import type { Page } from '@playwright/test';
import { addMember, putModel, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { openCropGrid, openCropSheet } from '../support/crops.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal, saveModelChanges } from '../support/network.ts';

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

test('the header, crop cards, demand chart and farm bars; Edit opens a crop’s factors in a sheet that saves', async ({ page, owner }) => {
	void owner;
	const project = await seed(page, 'Crops page');
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto(`/projects/${project.id}?tab=crops`);

	await expect(page.getByRole('heading', { level: 1, name: 'Crops & demand' })).toBeVisible();
	await expect(page.getByTestId('crops-summary')).toHaveText('2 crops · 40 ha irrigated on 2 farms · water year October to September');

	// A card per crop: area, peak need (A-pan × factor), a sparkline with a name; the high-factor hint on Vines only.
	const cards = page.getByTestId('crop-card');
	await expect(cards).toHaveCount(2);
	const orchard = cards.filter({ hasText: 'Orchard' });
	await expect(orchard).toContainText('32 ha · peak need in Jan');
	await expect(orchard.getByRole('img', { name: 'Orchard crop factor by month, October to September: 0.40 to 0.80, highest in Dec' })).toBeVisible();
	await expect(orchard).not.toContainText('Factor above 1.0');
	await expect(cards.filter({ hasText: 'Vines' })).toContainText('Factor above 1.0 in Jan');

	// The chart, above the fold, with its table one click away.
	const chart = page.getByRole('img', { name: /^Catchment irrigation demand by month, stacked by crop \(Orchard, Vines\)\. Peak in Jan/ });
	await expect(chart).toBeInViewport();
	await expect(page.getByTestId('crops-demand-summary')).toContainText('million m³ a year');
	await expect(page.locator('table.demand')).toBeHidden();
	await page.getByText('Show table', { exact: true }).click();
	await expect(page.locator('table.demand').getByRole('rowheader', { name: 'Catchment' })).toBeVisible();
	await page.getByText('Hide table', { exact: true }).click();

	// A bar per planted farm; the unplanted farm is named in the note.
	await expect(page.getByRole('img', { name: 'Lower farm: 20 ha, Orchard 12 ha and Vines 8 ha' })).toBeVisible();
	await expect(page.getByText('Dry farm has no planted area, so its irrigation demand counts as zero.')).toBeVisible();
	// The page fills the window: the lower row reaches the bottom, nothing scrolls sideways.
	const lower = (await page.locator('.lower').boundingBox())!;
	expect(lower.y + lower.height).toBeGreaterThan(900);
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
	await expect(orchard.getByRole('img', { name: /0\.40 to 0\.90, highest in Jan$/ })).toBeVisible();

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
	await expect(page.getByTestId('crop-card')).toHaveCount(3);
	await expect(page.getByTestId('crop-card').filter({ hasText: 'Lucerne' })).toContainText('0 ha · no crop factors yet');

	// Remove Vines (planted on a farm, so it asks first); the sheet closes with it.
	const vines = await openCropSheet(page, 'Vines');
	page.once('dialog', (d) => void d.accept());
	await vines.getByRole('button', { name: 'Remove Vines' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page).not.toHaveURL(/crop=/);
	await expect(page.getByTestId('crop-card')).toHaveCount(2);
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

	// Irrigation demand: the table and the chart, as the old tab showed them.
	const demand = await openCropGrid(page, 'demand');
	await expect(demand.locator('table.demand').getByRole('rowheader', { name: 'Dry farm' })).toBeVisible();
	await closeModal(page);

	// The menu closes on Escape, focus back on its button.
	const menu = page.locator('details.grids-menu');
	await menu.locator('summary').click();
	await expect(page.getByRole('group', { name: 'Open as a grid' })).toBeVisible();
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

test('a viewer sees the cards and bars, opens a crop’s factors read-only, and adds nothing', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seed(page, 'Crops page viewer');
	const viewer = await signIn('Crops page viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.goto(`/projects/${project.id}?tab=crops`);
	await expect(v.getByTestId('crop-card')).toHaveCount(2);
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

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('cards stack, bars stay readable, the sheet fills the screen, no violations', async ({ page, owner }) => {
		void owner;
		const project = await seed(page, 'Crops page phone');
		await page.goto(`/projects/${project.id}?tab=crops`);
		const cards = page.getByTestId('crop-card');
		await expect(cards).toHaveCount(2);
		const [a, b] = [(await cards.nth(0).boundingBox())!, (await cards.nth(1).boundingBox())!];
		expect(b.y).toBeGreaterThan(a.y + a.height - 1); // one column
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
