import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { createProject, putSeries } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
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

test('a later file appends to an existing series without erasing stored days', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series append');
	await page.goto(`/projects/${project.id}?tab=series`);
	const form = page.getByRole('region', { name: 'Upload CSV' });
	const csv = (name: string, body: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(body) });

	await form.getByLabel('CSV file').setInputFiles(csv('first.csv', 'date,value\n2021-10-01,1\n2021-10-02,2\n2021-10-03,3\n'));
	await form.getByRole('button', { name: 'Upload' }).click();
	await expect(form.getByRole('status')).toHaveText('Uploaded 3 days to “Rainfall — catchment”.');

	// Same kind and name: append/update is the default. 10-03 is corrected,
	// 10-04 and 10-05 are new, and 10-02 (blank in the file) keeps its value.
	await expect(form.getByRole('radio', { name: /^Append \/ update/ })).toBeChecked();
	await form.getByLabel('CSV file').setInputFiles(csv('more.csv', 'date,value\n2021-10-02,\n2021-10-03,30\n2021-10-04,4\n2021-10-05,5\n'));
	const summary = form.getByRole('definition');
	await expect(summary.nth(4)).toHaveText('2'); // new days
	await expect(summary.nth(5)).toHaveText('1'); // changed
	await form.getByRole('button', { name: 'Upload and merge' }).click();
	await expect(form.getByRole('status')).toHaveText('Updated “Rainfall — catchment”: 2 new days, 1 changed. Data now runs to 2021-10-05.');

	const row = page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Rainfall — catchment' });
	await expect(row).toContainText('2021-10-05');
	const stored = await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json();
	const s = await (await page.request.get(`${API_URL}/projects/${project.id}/series/${stored.series[0].id}`)).json();
	expect(s.values).toEqual([1, 2, 30, 4, 5]);
});

test('clicking anywhere on a series row shows it in the chart; its buttons keep their own meaning', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series row click');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: [1, 2, 3] });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Gauge G1', unit: 'm3/s', startDate: '2021-10-01', values: [0.5, 0.6, 0.7] });
	await page.goto(`/projects/${project.id}?tab=series`);
	const table = page.getByRole('region', { name: 'Input time series' }).getByRole('table');
	const rainRow = table.getByRole('row').filter({ hasText: 'Rainfall — catchment' });
	const flowRow = table.getByRole('row').filter({ hasText: 'Gauge G1' });

	await flowRow.getByRole('cell').first().click();
	await expect(page.getByRole('img', { name: /^Flow — observed gauge.*: line chart/ }).locator('canvas')).toBeVisible();
	await expect(flowRow.getByRole('button', { name: 'View' })).toHaveAttribute('aria-pressed', 'true');

	await rainRow.getByRole('rowheader').click();
	await expect(page.getByRole('img', { name: /^Rainfall — catchment: line chart/ }).locator('canvas')).toBeVisible();
	await expect(rainRow.getByRole('button', { name: 'View' })).toHaveAttribute('aria-pressed', 'true');
	await expect(flowRow.getByRole('button', { name: 'View' })).toHaveAttribute('aria-pressed', 'false');

	// A row's own control doesn't also select the row.
	page.once('dialog', (d) => void d.dismiss());
	await flowRow.getByRole('button', { name: /^Delete/ }).click();
	await expect(rainRow.getByRole('button', { name: 'View' })).toHaveAttribute('aria-pressed', 'true');
});

test('a US month/day CSV is read as month/day, and the summary says how dates were read', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series date order');
	await page.goto(`/projects/${project.id}?tab=series`);
	const form = page.getByRole('region', { name: 'Upload CSV' });
	await form.getByLabel('CSV file').setInputFiles({
		name: 'us.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('date,value\n03/04/2021,1\n03/13/2021,2\n')
	});
	const summary = form.getByRole('definition');
	await expect(form.getByText('month/day/year')).toBeVisible();
	await expect(summary.first()).toHaveText('2021-03-04 → 2021-03-13');
});
