// The crop grids (in the grid modal, full screen on a phone) and Transfers at
// phone width: each table row becomes a card with visible field labels, so
// every field is on screen without scrolling the table sideways (the sticky
// name column used to leave room for one month).
import type { Locator, Page } from '@playwright/test';
import { createProject, putModel, sampleModel, updateSettings } from '../support/api.ts';
import { openCropGrid } from '../support/crops.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal } from '../support/network.ts';

const PHONE = { width: 390, height: 844 };

/** The element sits fully inside the viewport's width. */
async function expectOnScreen(el: Locator, page: Page) {
	const box = await el.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

/** Neither the page nor any table box scrolls sideways. */
async function expectNoSidewaysScroll(page: Page) {
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
	const wraps = page.locator('.table-wrap');
	for (let i = 0; i < (await wraps.count()); i++) {
		const [sw, cw] = await wraps.nth(i).evaluate((el) => [el.scrollWidth, el.clientWidth]);
		// The read-only demand preview may still scroll; the edit tables may not.
		const demand = await wraps.nth(i).locator('table.demand').count();
		if (!demand) expect(sw).toBeLessThanOrEqual(cw);
	}
}

test.describe('phone', () => {
	test.use({ viewport: PHONE });

	test('crop factors and planted areas are cards with every field on screen', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Phone crops');
		await putModel(page.request, project.id, sampleModel());
		await page.goto(`/projects/${project.id}?tab=crops`);
		const factors = await openCropGrid(page, 'crop-factors');

		// Every month of the crop, and the last one especially, is on screen.
		for (const m of ['Oct', 'Jan', 'Sep']) await expectOnScreen(factors.getByLabel(`Orchard crop factor, ${m}`), page);
		// No mean factor (issue #174): an unweighted average the workbook doesn't have.
		await expect(factors.getByText(/^Mean/)).toHaveCount(0);
		await expectOnScreen(factors.getByRole('button', { name: 'Remove Orchard' }), page);
		await expectNoSidewaysScroll(page);
		await closeModal(page);

		// Planted areas: each farm's crops, with the farm total labelled.
		const areas = await openCropGrid(page, 'planted-areas');
		await expectOnScreen(areas.getByLabel('Orchard on Lower farm, ha'), page);
		await expect(areas.getByRole('cell', { name: 'Total 20.00 ha' })).toBeVisible();
		await expect(areas.getByRole('cell', { name: 'All crops 32.00 ha' })).toBeVisible();

		await expectNoSidewaysScroll(page);
	});

	test('the stacked demand chart sits above the demand table (behind Show table) and fits the screen', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Phone demand chart');
		await putModel(page.request, project.id, sampleModel());
		await updateSettings(page.request, project.id, { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
		await page.goto(`/projects/${project.id}?tab=crops`);

		// Orchard on 32 ha: Jan is the peak, 320 000 m² × 0.8 × 230 mm / 1000 / 31 days.
		const chart = page.getByRole('img', { name: /^Catchment irrigation demand by month, stacked by crop \(Orchard\)\. Peak in Jan at 1 899 m³\/day\./ });
		await expect(chart).toBeVisible();
		await expectOnScreen(chart, page);
		// The table stays the data source, below the chart, one click away.
		await page.getByText('Show table', { exact: true }).click();
		const table = page.locator('table.demand');
		await expect(table).toBeVisible();
		expect((await chart.boundingBox())!.y).toBeLessThan((await table.boundingBox())!.y);
		await expectNoSidewaysScroll(page);
	});

	test('a transfer rule is a card with its fields labelled and on screen', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Phone transfers');
		await putModel(page.request, project.id, sampleModel());
		await page.goto(`/projects/${project.id}?tab=transfers`);
		await expect(page.getByLabel('Source of transfer 1')).toBeVisible();

		await expect(page.getByRole('rowheader', { name: 'Transfer 1' })).toBeVisible();
		for (const label of [
			'Source of transfer 1',
			'Destination of transfer 1',
			'Daily cap of transfer 1, m³',
			'Minimum source storage for transfer 1, %',
			'transfer 1 enabled'
		])
			await expectOnScreen(page.getByLabel(label, { exact: true }), page);
		// A rate per month (engine 1.14.0), six to a row, each field on screen and tap-sized.
		for (const m of ['Oct', 'Mar', 'Apr', 'Sep']) await expectOnScreen(page.getByLabel(`Max rate of transfer 1 in ${m}, m³/s`, { exact: true }), page);
		const box = await page.getByLabel('Max rate of transfer 1 in Sep, m³/s', { exact: true }).boundingBox();
		expect(box!.height).toBeGreaterThanOrEqual(44);
		const oct = (await page.getByLabel('Max rate of transfer 1 in Oct, m³/s', { exact: true }).boundingBox())!;
		const apr = (await page.getByLabel('Max rate of transfer 1 in Apr, m³/s', { exact: true }).boundingBox())!;
		expect(apr.y).toBeGreaterThan(oct.y + oct.height - 1);

		// A river off-take's fields (engine 1.14.0) stay on screen, its switches tap-sized.
		await page.getByLabel('Where transfer 1 takes its water', { exact: true }).selectOption('river');
		for (const label of ['Hands-off flow for transfer 1, m³/day', 'Conveyance losses of transfer 1, %', 'How much transfer 1 takes'])
			await expectOnScreen(page.getByLabel(label, { exact: true }), page);
		const ewr = (await page.locator('.offtake .check').first().boundingBox())!;
		expect(ewr.height).toBeGreaterThanOrEqual(44);
		await page.getByLabel('Where transfer 1 takes its water', { exact: true }).selectOption('dam');

		// The visible "Enabled" text is part of the toggle's tap target.
		const enabled = page.getByLabel('transfer 1 enabled');
		await expect(enabled).toBeChecked();
		await page.locator('.on-toggle').getByText('Enabled').click();
		await expect(enabled).not.toBeChecked();

		await expectNoSidewaysScroll(page);
	});
});

test('on a desktop the crop and transfer tables keep their column headers', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const project = await createProject(page.request, 'Desktop tables');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=crops&grid=crop-factors`);
	const factors = page.getByRole('dialog', { name: 'Crop factors' });
	await expect(factors.getByRole('columnheader', { name: 'Sep', exact: true }).first()).toBeVisible();
	await page.goto(`/projects/${project.id}?tab=transfers`);
	await expect(page.getByRole('columnheader', { name: /^Takes from/ })).toBeVisible();
	await expect(page.getByRole('columnheader', { name: /^Max rate by month/ })).toBeVisible();
	await expect(page.getByRole('rowheader', { name: '1', exact: true })).toBeVisible();
});
