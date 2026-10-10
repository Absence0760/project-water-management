// The crop grids (in the grid modal, full screen on a phone) and Transfers at
// phone width: each table row becomes a card with visible field labels, so
// every field is on screen without scrolling the table sideways (the sticky
// name column used to leave room for one month).
import type { Locator, Page } from '@playwright/test';
import { createProject, putModel, sampleModel, updateSettings } from '../support/api.ts';
import { openCropGrid } from '../support/crops.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal, openNodeForm } from '../support/network.ts';

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

		// Orchard on 32 ha: Jan is the peak, 320 000 m² × 0.8 × 230 mm / 1000 / 31 days = 1 899 m³/day at the crop,
		// abstracted at the units' 80 % efficiency: 1 899 / 0.8.
		const chart = page.getByRole('img', { name: /^Catchment irrigation demand by month, stacked by crop \(Orchard\)\. Peak in Jan at 2 374 m³\/day\./ });
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
		await expect(page.getByLabel('From, transfer 1', { exact: true })).toBeVisible();

		await expect(page.getByRole('heading', { level: 3, name: 'Transfer 1', exact: true })).toBeVisible();
		for (const label of [
			'From, transfer 1',
			'To, transfer 1',
			'Daily cap of transfer 1, m³',
			'Min source storage of transfer 1, %',
			'Enabled, transfer 1'
		])
			await expectOnScreen(page.getByLabel(label, { exact: true }), page);
		// A rate per month (engine 1.14.0), four to a row, each field on screen and tap-sized.
		for (const m of ['Oct', 'Mar', 'Apr', 'Sep']) await expectOnScreen(page.getByLabel(`Max rate of transfer 1 in ${m}, m³/s`, { exact: true }), page);
		const box = await page.getByLabel('Max rate of transfer 1 in Sep, m³/s', { exact: true }).boundingBox();
		expect(box!.height).toBeGreaterThanOrEqual(44);
		const oct = (await page.getByLabel('Max rate of transfer 1 in Oct, m³/s', { exact: true }).boundingBox())!;
		const apr = (await page.getByLabel('Max rate of transfer 1 in Apr, m³/s', { exact: true }).boundingBox())!;
		expect(apr.y).toBeGreaterThan(oct.y + oct.height - 1);

		// A river off-take's fields (engine 1.14.0) stay on screen, its switches tap-sized.
		await page.getByLabel('Takes from, transfer 1', { exact: true }).selectOption('river');
		for (const label of ['Hands-off flow for transfer 1, m³/day', 'Losses on the way of transfer 1, %', 'Takes, transfer 1'])
			await expectOnScreen(page.getByLabel(label, { exact: true }), page);
		const ewr = (await page.getByTestId('transfer-rule').locator('.check').first().boundingBox())!;
		expect(ewr.height).toBeGreaterThanOrEqual(44);
		await page.getByLabel('Takes from, transfer 1', { exact: true }).selectOption('dam');

		// The switch's visible word ("Enabled", which its name starts with) is part of its tap target; switched off, the heading says so.
		const enabled = page.getByLabel('Enabled, transfer 1');
		await expect(enabled).toBeChecked();
		const sw = page.getByTestId('transfer-rule').locator('.switch');
		const swBox = (await sw.boundingBox())!;
		const inputBox = (await enabled.boundingBox())!;
		expect(inputBox.width).toBeGreaterThanOrEqual(swBox.width - 1);
		expect(inputBox.height).toBeGreaterThanOrEqual(44);
		await sw.click({ position: { x: swBox.width - 4, y: swBox.height / 2 } });
		await expect(enabled).not.toBeChecked();
		await expect(page.getByTestId('transfer-rule').locator('.switch')).toHaveText('Enabled');
		await expect(page.getByRole('heading', { level: 3, name: 'Transfer 1 off', exact: true })).toBeVisible();

		await expectNoSidewaysScroll(page);
	});
});

test('on a desktop the crop table keeps its column headers and a transfer card its field labels', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const project = await createProject(page.request, 'Desktop tables');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=crops&grid=crop-factors`);
	const factors = page.getByRole('dialog', { name: 'Crop factors' });
	await expect(factors.getByRole('columnheader', { name: 'Sep', exact: true }).first()).toBeVisible();
	await page.goto(`/projects/${project.id}?tab=transfers`);
	const rule = page.getByTestId('transfer-rule');
	await expect(rule.getByText('Max rate by month', { exact: true })).toBeVisible();
	// Wide, the dividers mark the Limits and Source groups and each field names itself, so their titles go.
	await expect(rule.getByText('Limits', { exact: true })).toBeHidden();
	await expect(rule.getByText('Daily cap, m³', { exact: true })).toBeVisible();
	await expect(rule.getByText('Priority, lower first', { exact: true })).toBeVisible();
	await expect(rule.getByText('Takes from', { exact: true })).toBeVisible();
	await expect(rule.getByRole('heading', { level: 3, name: 'Transfer 1', exact: true })).toBeVisible();
});

test.describe('phone node form', () => {
	test.use({ viewport: PHONE });

	test('the form’s section links keep their width in their scrolling row, none over the next', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Phone section links');
		await putModel(page.request, project.id, sampleModel());
		await page.goto(`/projects/${project.id}?tab=network`);
		await openNodeForm(page, 'Upper farm');
		// The section menu (common/SectionNav): on a phone one strip with every link, scrolling sideways.
		const links = page.getByTestId('node-sheet-jump').getByRole('link');
		expect(await links.count()).toBeGreaterThan(2);
		const boxes = await links.evaluateAll((els) => els.map((el) => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, clipped: el.scrollWidth > el.clientWidth + 0.5 })));
		for (const [i, b] of boxes.entries()) {
			expect(b.clipped, `link ${i + 1}'s text fits`).toBe(false);
			if (i) expect(b.left, `link ${i + 1} starts after link ${i}`).toBeGreaterThanOrEqual(boxes[i - 1]!.right);
		}
	});

	test('the node list comes before the card, and every row shows its Edit without a hover', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Phone node list');
		await putModel(page.request, project.id, sampleModel());
		await page.goto(`/projects/${project.id}?tab=network`);
		const list = page.getByRole('list', { name: 'All hydrological units' });
		await list.getByRole('button', { name: /^Upper farm/ }).click();
		const listBox = (await list.boundingBox())!;
		expect((await page.getByTestId('node-card').boundingBox())!.y).toBeGreaterThanOrEqual(listBox.y + listBox.height);
		const edit = list.getByRole('button', { name: 'Edit Lower farm' });
		await expect(edit).toBeVisible();
		expect((await edit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		await edit.click();
		await expect(page.getByRole('dialog', { name: 'Edit Lower farm' })).toBeVisible();
		await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
	});
});
