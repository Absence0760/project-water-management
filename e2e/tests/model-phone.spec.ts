// Crops & demand and Transfers at phone width: each table row becomes a card
// with visible field labels, so every field is on screen without scrolling the
// table sideways (the sticky name column used to leave room for one month).
import type { Locator, Page } from '@playwright/test';
import { createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

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
		await expect(page.getByRole('heading', { name: 'Planted areas' })).toBeVisible();

		// Every month of the crop, and the last one especially, is on screen.
		for (const m of ['Oct', 'Jan', 'Sep']) await expectOnScreen(page.getByLabel(`Orchard crop factor, ${m}`), page);
		await expect(page.getByRole('cell', { name: /^Mean 0\.62$/ })).toBeVisible();
		await expectOnScreen(page.getByRole('button', { name: 'Remove Orchard' }), page);

		// Planted areas: each farm's crops, with the farm total labelled.
		await expectOnScreen(page.getByLabel('Orchard on Lower farm, ha'), page);
		await expect(page.getByRole('cell', { name: 'Total 20.00 ha' })).toBeVisible();
		await expect(page.getByRole('cell', { name: 'All crops 32.00 ha' })).toBeVisible();

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
			'Max rate of transfer 1, m³/s',
			'Daily cap of transfer 1, m³',
			'Minimum source storage for transfer 1, %',
			'transfer 1 enabled'
		])
			await expectOnScreen(page.getByLabel(label, { exact: true }), page);
		const months = page.getByRole('group', { name: /^Months transfer 1 runs/ });
		await expectOnScreen(months.getByRole('checkbox', { name: /September$/ }), page);
		// The month toggles are tap-sized on a phone.
		const box = await months.locator('label').first().boundingBox();
		expect(box!.height).toBeGreaterThanOrEqual(44);

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
	await page.goto(`/projects/${project.id}?tab=crops`);
	await expect(page.getByRole('columnheader', { name: 'Sep', exact: true }).first()).toBeVisible();
	await expect(page.getByText('Mean', { exact: true }).first()).toBeVisible();
	await page.goto(`/projects/${project.id}?tab=transfers`);
	await expect(page.getByRole('columnheader', { name: /^Min storage/ })).toBeVisible();
	await expect(page.getByRole('rowheader', { name: '1', exact: true })).toBeVisible();
});
