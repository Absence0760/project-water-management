import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { createProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function upload(page: Page, kindLabel: string, file: string) {
	const form = page.getByRole('region', { name: 'Upload CSV' });
	await form.getByLabel('Kind').selectOption({ label: kindLabel });
	await form.getByLabel('CSV file').setInputFiles(fixture(file));
	return form;
}

test('upload daily rainfall and observed flow CSVs and chart them', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series upload');
	await page.goto(`/projects/${project.id}?tab=series`);
	await expect(page.getByText('No time series yet.')).toBeVisible();

	// Rainfall: ISO dates, 92 days, no gaps.
	let form = await upload(page, 'Rainfall — catchment', 'rainfall-daily.csv');
	await expect(form.getByLabel('Unit')).toHaveValue('mm');
	const summary = form.getByRole('definition');
	await expect(summary.nth(0)).toHaveText('2021-10-01 → 2021-12-31');
	await expect(summary.nth(1)).toHaveText('92');
	await expect(summary.nth(3)).toHaveText('0');
	await form.getByRole('button', { name: 'Upload' }).click();
	await expect(form.getByRole('status')).toHaveText('Uploaded 92 days to “Rainfall — catchment”.');

	// Uploading selects the new series and charts it.
	const rainChart = page.getByRole('img', { name: /^Rainfall — catchment: line chart/ });
	await expect(rainChart).toBeVisible();
	await expect(rainChart.locator('canvas')).toBeVisible();
	await expect(page.getByRole('figure')).toContainText('Rainfall — catchment');

	// Observed flow: DD/MM/YYYY dates with one missing day (a gap).
	form = await upload(page, 'Flow — observed gauge', 'observed-flow-daily.csv');
	await expect(form.getByLabel('Unit')).toHaveValue('m³/s');
	await expect(summary.nth(1)).toHaveText('92');
	await expect(summary.nth(2)).toHaveText('91');
	await expect(summary.nth(3)).toHaveText('1');
	await form.getByLabel(/^Name/).fill('Gauge G1');
	await form.getByRole('button', { name: 'Upload' }).click();
	await expect(form.getByRole('status')).toHaveText('Uploaded 92 days to “Gauge G1”.');
	const flowChart = page.getByRole('img', { name: /^Flow — observed gauge · Gauge G1: line chart/ });
	await expect(flowChart.locator('canvas')).toBeVisible();

	// Both are listed, and survive a reload.
	await page.reload();
	const table = page.getByRole('region', { name: 'Input time series' }).getByRole('table');
	await expect(table.getByRole('row')).toHaveCount(3);
	const flowRow = table.getByRole('row').filter({ hasText: 'Gauge G1' });
	await expect(flowRow).toContainText('Flow — observed gauge');
	await expect(flowRow).toContainText('2021-10-01');
	await expect(flowRow).toContainText('2021-12-31');

	// View re-draws a stored series.
	await table.getByRole('row').filter({ hasText: 'Rainfall — catchment' }).getByRole('button', { name: 'View' }).click();
	await expect(page.getByRole('img', { name: /^Rainfall — catchment: line chart/ }).locator('canvas')).toBeVisible();
});

test('a malformed CSV is rejected before upload', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series bad file');
	await page.goto(`/projects/${project.id}?tab=series`);
	const form = page.getByRole('region', { name: 'Upload CSV' });
	await form.getByLabel('CSV file').setInputFiles({
		name: 'broken.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('date,value\n2021-10-01,1.5\n2021-10-02,lots\n')
	});
	await expect(form.getByRole('alert')).toHaveText('broken.csv: Line 3: "lots" is not a number');
	await expect(form.getByRole('button', { name: 'Upload' })).toBeDisabled();
});
