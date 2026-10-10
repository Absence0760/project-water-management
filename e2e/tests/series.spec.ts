import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, node, putModel, putSeries } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { answerConfirm } from '../support/confirm.ts';
import { addDataDialog, openAddData, uploadedNote } from '../support/addData.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

// Uploading on the Data tab is the header's Add data dialog (the page's one upload form).
async function upload(page: Page, kindLabel: string, file: string) {
	const form = await openAddData(page);
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
	await expect(uploadedNote(page)).toHaveText('Uploaded 92 days to “Rainfall — catchment”.');
	await expect(form).toBeHidden();

	// Uploading selects the new series and charts it, through the URL as picking its row does.
	await expect(page).toHaveURL(/[?&]series=/);
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
	await form.getByLabel(/^Name/).fill('Gauge W7');
	await form.getByRole('button', { name: 'Upload' }).click();
	await expect(uploadedNote(page)).toHaveText('Uploaded 92 days to “Gauge W7”.');
	const flowChart = page.getByRole('img', { name: /^Flow — observed gauge · Gauge W7: line chart/ });
	await expect(flowChart.locator('canvas')).toBeVisible();

	// Both are listed, and survive a reload.
	await page.reload();
	const table = page.getByRole('region', { name: 'Input time series' }).getByRole('table');
	await expect(table.getByRole('row')).toHaveCount(3);
	const flowRow = table.getByRole('row').filter({ hasText: 'Gauge W7' });
	await expect(flowRow).toContainText('Flow — observed gauge');
	await expect(flowRow).toContainText('2021-10-01');
	await expect(flowRow).toContainText('2021-12-31');

	// View re-draws a stored series.
	await table.getByRole('row').filter({ hasText: 'Rainfall — catchment' }).getByRole('button', { name: 'View', exact: true }).click();
	await expect(page.getByRole('img', { name: /^Rainfall — catchment: line chart/ }).locator('canvas')).toBeVisible();
});

test('a malformed CSV is rejected before upload', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series bad file');
	await page.goto(`/projects/${project.id}?tab=series`);
	const form = await openAddData(page);
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
	let form = await openAddData(page);
	const csv = (name: string, body: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(body) });

	await form.getByLabel('CSV file').setInputFiles(csv('first.csv', 'date,value\n2021-10-01,1\n2021-10-02,2\n2021-10-03,3\n'));
	await form.getByRole('button', { name: 'Upload' }).click();
	await expect(uploadedNote(page)).toHaveText('Uploaded 3 days to “Rainfall — catchment”.');
	form = await openAddData(page);

	// Same kind and name: append/update is the default. 10-03 is corrected,
	// 10-04 and 10-05 are new, and 10-02 (blank in the file) keeps its value.
	await expect(form.getByRole('radio', { name: /^Append \/ update/ })).toBeChecked();
	await form.getByLabel('CSV file').setInputFiles(csv('more.csv', 'date,value\n2021-10-02,\n2021-10-03,30\n2021-10-04,4\n2021-10-05,5\n'));
	const summary = form.getByRole('definition');
	await expect(summary.nth(4)).toHaveText('2'); // new days
	await expect(summary.nth(5)).toHaveText('1'); // changed
	await form.getByRole('button', { name: 'Upload and merge' }).click();
	// 10-03 is overwritten, so the form asks first.
	await form.getByRole('button', { name: 'Overwrite 1 day' }).click();
	await expect(uploadedNote(page)).toHaveText('Updated “Rainfall — catchment”: 2 new days, 1 changed. Data now runs to 2021-10-05.');

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
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Gauge W7', unit: 'm3/s', startDate: '2021-10-01', values: [0.5, 0.6, 0.7] });
	await page.goto(`/projects/${project.id}?tab=series`);
	const table = page.getByRole('region', { name: 'Input time series' }).getByRole('table');
	const rainRow = table.getByRole('row').filter({ hasText: 'Rainfall — catchment' });
	const flowRow = table.getByRole('row').filter({ hasText: 'Gauge W7' });

	await flowRow.getByRole('cell').first().click();
	await expect(page.getByRole('img', { name: /^Flow — observed gauge.*: line chart/ }).locator('canvas')).toBeVisible();
	await expect(flowRow.getByRole('button', { name: 'View', exact: true })).toHaveAttribute('aria-pressed', 'true');

	await rainRow.getByRole('rowheader').click();
	await expect(page.getByRole('img', { name: /^Rainfall — catchment: line chart/ }).locator('canvas')).toBeVisible();
	await expect(rainRow.getByRole('button', { name: 'View', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(flowRow.getByRole('button', { name: 'View', exact: true })).toHaveAttribute('aria-pressed', 'false');

	// A row's own control doesn't also select the row.
	await flowRow.getByRole('button', { name: /^Delete/ }).click();
	await answerConfirm(page, false);
	await expect(rainRow.getByRole('button', { name: 'View', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a US month/day CSV is read as month/day, and the summary says how dates were read', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series date order');
	await page.goto(`/projects/${project.id}?tab=series`);
	const form = await openAddData(page);
	await form.getByLabel('CSV file').setInputFiles({
		name: 'us.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('date,value\n03/04/2021,1\n03/13/2021,2\n')
	});
	const summary = form.getByRole('definition');
	await expect(form.getByText('month/day/year')).toBeVisible();
	await expect(summary.first()).toHaveText('2021-03-04 → 2021-03-13');
});

test("a series' CSV menu opens in full, even on the table's last row", async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'CSV menu');
	const days = Array.from({ length: 30 }, (_, i) => i);
	for (const kind of ['rain_catchment_mm', 'rain_chirps_mm', 'flow_observed_m3s', 'flow_logger_m3s']) {
		await putSeries(page.request, project.id, { kind, unit: kind.endsWith('mm') ? 'mm' : 'm³/s', startDate: '2021-10-01', values: days });
	}
	// A short window puts the last row near the bottom of the viewport, as in the report.
	await page.setViewportSize({ width: 1280, height: 620 });
	await page.goto(`/projects/${project.id}?tab=series`);
	const buttons = page.getByRole('button', { name: 'CSV', exact: true });
	await expect(buttons).toHaveCount(4);
	await buttons.last().scrollIntoViewIfNeeded();
	await buttons.last().click();
	const item = page.getByRole('button', { name: /\(CSV\)/ });
	await expect(item).toBeVisible();
	await expect(item).toBeInViewport({ ratio: 1 });
	// The table's scroll box doesn't grow a vertical scrollbar around the open menu.
	const wrap = page.locator('.table-wrap').filter({ has: page.locator('table.series') });
	expect(await wrap.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
	await page.keyboard.press('Escape');
	await expect(item).toBeHidden();
});

test('on a phone each series row is a card: every column and button fits without scrolling sideways', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series phone');
	await page.setViewportSize({ width: 390, height: 900 });

	// Empty: the hint points at Add data, and its button, right in the series panel, opens that dialog.
	await page.goto(`/projects/${project.id}?tab=series`);
	await expect(page.getByText('No time series yet.')).toContainText('with Add data.');
	await page.getByRole('region', { name: 'Input time series' }).getByRole('button', { name: 'Add a data file' }).click();
	await expect(addDataDialog(page)).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(addDataDialog(page)).toBeHidden();

	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: [1, 2, 3] });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Gauge W7', unit: 'm3/s', startDate: '2021-10-01', values: [0.5, 0.6, 0.7] });
	await page.reload();
	const table = page.getByRole('region', { name: 'Input time series' }).getByRole('table');
	const flowRow = table.getByRole('row').filter({ hasText: 'Gauge W7' });
	await expect(flowRow.getByRole('button', { name: 'View', exact: true })).toBeVisible();

	// Still a table to assistive tech: header cells and data cells keep their roles.
	await expect(table.getByRole('columnheader', { name: 'Coverage by year' })).toHaveCount(1);
	await expect(flowRow.getByRole('cell').first()).toContainText('2021-10-03'); // Data up to comes first (freshness first)
	await expect(flowRow.getByRole('cell').nth(1)).toContainText('2021-10-01');

	// Nothing is hidden behind a sideways scroll, in the table's box or the page.
	const wrap = page.locator('.table-wrap').filter({ has: page.locator('table.series') });
	expect(await wrap.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	await expect(wrap).not.toHaveAttribute('tabindex'); // no sideways-scroll tab stop (a11y/scrollRegions.ts)
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	const del = flowRow.getByRole('button', { name: /^Delete/ });
	await del.scrollIntoViewIfNeeded();
	for (const b of [flowRow.getByRole('button', { name: 'View', exact: true }), flowRow.getByRole('button', { name: 'Preview', exact: true }), del]) {
		await expect(b).toBeInViewport({ ratio: 1 });
	}
	// Each card shows its column labels.
	const label = await flowRow.getByRole('cell').first().evaluate((el) => getComputedStyle(el, '::before').content);
	expect(label).toContain('Data up to');
});

test('on a wide screen "What the model uses" spans the page with the kinds in columns; there is no second upload form', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series wide');
	await page.setViewportSize({ width: 1600, height: 1000 });
	await page.goto(`/projects/${project.id}?tab=series`);
	const series = (await page.getByRole('region', { name: 'Input time series' }).boundingBox())!;
	const usesRegion = page.getByRole('region', { name: 'What the model uses' });
	// The kinds are behind a disclosure (issue #174); the closing note shows without it.
	const terms = usesRegion.getByRole('term');
	await expect(terms.first()).toBeHidden();
	await expect(usesRegion.getByText(/^A run needs at least one rainfall series/)).toBeVisible();
	const more = usesRegion.getByText('Show what each kind of series is for', { exact: true });
	await more.click();
	await expect(usesRegion.getByText('Hide what each kind of series is for', { exact: true })).toBeVisible();
	await expect(terms.first()).toBeVisible();
	const uses = (await usesRegion.boundingBox())!;
	expect(Math.abs(uses.x - series.x)).toBeLessThan(2);
	expect(Math.abs(uses.width - series.width)).toBeLessThan(2);
	const first = (await terms.nth(0).boundingBox())!;
	const second = (await terms.nth(1).boundingBox())!;
	expect(Math.abs(first.y - second.y)).toBeLessThan(2);
	expect(second.x).toBeGreaterThan(first.x + first.width);
	// Uploading is the header's Add data only: no form on the page itself.
	await expect(page.getByLabel('CSV file')).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Upload CSV' })).toHaveCount(0);
});

test('a flow uploaded in l/s is converted to m³/s, the unit the model reads', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series in l/s');
	await page.goto(`/projects/${project.id}?tab=series`);
	const form = await upload(page, 'Flow — observed gauge', 'observed-flow-daily.csv');
	await form.getByLabel('Unit').selectOption('l/s');
	await expect(form.getByTestId('unit-converted')).toHaveText('Values in l/s are converted to m³/s when saved.');
	await form.getByRole('button', { name: 'Upload' }).click();
	await expect(uploadedNote(page)).toContainText('Uploaded 92 days');

	const list = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string; unit: string }[];
	expect(list[0]!.unit).toBe('m³/s');
	const values = (await (await page.request.get(`${API_URL}/projects/${project.id}/series/${list[0]!.id}`)).json()).values as (number | null)[];
	// The fixture's first reading, read as litres a second.
	const first = Number((await import('node:fs')).readFileSync(fixture('observed-flow-daily.csv'), 'utf8').split('\n')[1]!.split(',')[1]);
	expect(values[0]).toBeCloseTo(first / 1000, 9);
});

test('merging an l/s file into an m³/s series compares like with like and keeps the days the file leaves blank', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series l/s merge');
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: [1.2, 0.8, 0.6] });
	await page.goto(`/projects/${project.id}?tab=series`);
	const form = await openAddData(page);
	await form.getByLabel('Kind').selectOption({ label: 'Flow — observed gauge' });
	await form.getByLabel('Unit').selectOption('l/s');
	// 10-01 repeats the stored 1.2 m³/s, 10-02 is blank, 10-03 is corrected, 10-04 is new.
	await form
		.getByLabel('CSV file')
		.setInputFiles({ name: 'flow.csv', mimeType: 'text/csv', buffer: Buffer.from('date,value\n2021-10-01,1200\n2021-10-02,\n2021-10-03,650\n2021-10-04,500\n') });
	const summary = form.getByRole('definition');
	await expect(summary.nth(4)).toHaveText('1'); // new days
	await expect(summary.nth(5)).toHaveText('1'); // changed
	await expect(summary.nth(6)).toHaveText('1'); // unchanged
	await form.getByRole('button', { name: 'Upload and merge' }).click();
	await form.getByRole('button', { name: 'Overwrite 1 day' }).click();
	await expect(uploadedNote(page)).toContainText('1 new day, 1 changed');

	const list = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string }[];
	const values = (await (await page.request.get(`${API_URL}/projects/${project.id}/series/${list[0]!.id}`)).json()).values as number[];
	// 10-02 keeps its stored 0.8 m³/s (it came back 0.0008 when the merge was sent in l/s).
	expect(values.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1.2, 0.8, 0.65, 0.5]);
});

// Issue #54 item 3: an upload that would overwrite stored days asks first.
const csvFile = (name: string, body: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(body) });
async function storedValues(page: Page, projectId: string): Promise<(number | null)[]> {
	const list = (await (await page.request.get(`${API_URL}/projects/${projectId}/series`)).json()).series as { id: string }[];
	return (await (await page.request.get(`${API_URL}/projects/${projectId}/series/${list[0]!.id}`)).json()).values;
}

test('a merge that changes stored days says which and how many before it overwrites them; Back sends nothing', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Overwrite confirm');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: [1, 2, 3, 4] });
	await page.goto(`/projects/${project.id}?tab=series`);
	let form = await openAddData(page);

	// Positive control: a file that only adds days uploads straight away.
	await form.getByLabel('CSV file').setInputFiles(csvFile('new.csv', 'date,value\n2021-10-04,4\n2021-10-05,5\n'));
	await form.getByRole('button', { name: 'Upload and merge' }).click();
	await expect(uploadedNote(page)).toHaveText('Updated “Rainfall — catchment”: 1 new day, 0 changed. Data now runs to 2021-10-05.');
	await expect(form).toBeHidden();
	form = await openAddData(page);

	// 10-02 and 10-04 change, 10-03 is the same.
	await form.getByLabel('CSV file').setInputFiles(csvFile('fix.csv', 'date,value\n2021-10-02,20\n2021-10-03,3\n2021-10-04,40\n'));
	await form.getByRole('button', { name: 'Upload and merge' }).click();
	const confirm = form.getByTestId('overwrite-confirm');
	await expect(confirm.getByText('This changes 2 days already stored in “Rainfall — catchment”, between 2021-10-02 and 2021-10-04.')).toBeFocused();
	await expect(confirm).toContainText('you can put them back from the History tab');
	await expect(form.getByRole('button', { name: 'Upload and merge' })).toHaveCount(0);
	await confirm.getByText('Show the changes').click();
	const rows = confirm.getByRole('row');
	await expect(rows).toHaveCount(3);
	await expect(rows.nth(0)).toHaveText(/Date\s*Stored \(mm\)\s*From the file \(mm\)/);
	await expect(rows.nth(1)).toHaveText(/2021-10-02\s*2\.00\s*20\.00/);
	await expect(rows.nth(2)).toHaveText(/2021-10-04\s*4\.00\s*40\.00/);
	await expectNoViolations(page);

	await form.getByRole('button', { name: 'Back' }).click();
	await expect(confirm).toHaveCount(0);
	await expect(form.getByRole('button', { name: 'Upload and merge' })).toBeEnabled();
	expect(await storedValues(page, project.id)).toEqual([1, 2, 3, 4, 5]);

	// Switching to Replace takes the question back: it asks again, about the replace.
	await form.getByRole('button', { name: 'Upload and merge' }).click();
	await expect(form.getByRole('button', { name: 'Overwrite 2 days' })).toBeVisible();
	await form.getByRole('radio', { name: /^Replace the whole series/ }).check();
	await expect(form.getByTestId('overwrite-confirm')).toHaveCount(0);
	await form.getByRole('radio', { name: /^Append \/ update/ }).check();

	await form.getByRole('button', { name: 'Upload and merge' }).click();
	await form.getByRole('button', { name: 'Overwrite 2 days' }).click();
	await expect(uploadedNote(page)).toHaveText('Updated “Rainfall — catchment”: 0 new days, 2 changed. Data now runs to 2021-10-05.');
	expect(await storedValues(page, project.id)).toEqual([1, 20, 3, 40, 5]);
});

test('replacing a series asks first, counting every stored day it drops', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Replace confirm');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: [1, null, 3] });
	await page.goto(`/projects/${project.id}?tab=series`);
	const form = await openAddData(page);
	await form.getByLabel('CSV file').setInputFiles(csvFile('all.csv', 'date,value\n2021-11-01,7\n'));
	await form.getByRole('radio', { name: /^Replace the whole series/ }).check();
	await form.getByRole('button', { name: 'Upload and replace' }).click();
	const confirm = form.getByTestId('overwrite-confirm');
	await expect(confirm).toContainText('This replaces all 2 days stored in “Rainfall — catchment” (2021-10-01 → 2021-10-03) with the file.');
	await expect(confirm.getByText('Show the changes')).toHaveCount(0);
	await form.getByRole('button', { name: 'Replace 2 days' }).click();
	await expect(uploadedNote(page)).toHaveText('Uploaded 1 day to “Rainfall — catchment”.');
	expect(await storedValues(page, project.id)).toEqual([7]);
});

test('the Add data dialog asks before it overwrites stored days too', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Overwrite confirm dialog');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: [1, 2] });
	await page.goto(`/projects/${project.id}`);
	await page.getByRole('button', { name: 'Add data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Add data' });
	await dialog.getByLabel('CSV file').setInputFiles(csvFile('rain.csv', 'date,value\n2021-10-02,9\n2021-10-03,3\n'));
	await dialog.getByRole('button', { name: 'Upload and merge' }).click();
	await expect(dialog.getByTestId('overwrite-confirm')).toContainText('This changes 1 day already stored in “Rainfall — catchment”, between 2021-10-02 and 2021-10-02.');
	await dialog.getByRole('button', { name: 'Overwrite 1 day' }).click();
	await expect(dialog).toBeHidden();
	expect(await storedValues(page, project.id)).toEqual([1, 9, 3]);
});

// Issue #40 part c: a CHIRPS series says which product and version it holds.
test('a CHIRPS upload is asked its product and version, and the series row shows and changes it', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'CHIRPS version');
	await page.goto(`/projects/${project.id}?tab=series`);
	const form = await upload(page, 'Rainfall — CHIRPS', 'rainfall-daily.csv');
	const version = form.getByLabel('CHIRPS product and version');
	await expect(version).toHaveValue('');
	await expect(version).toHaveAccessibleDescription(/A b023 workbook’s CHIRPS column is usually v2\.0; the CHIRPS data feed writes v3\.0/);
	await version.selectOption({ label: 'CHIRPS v2.0' });
	await form.getByRole('button', { name: 'Upload' }).click();
	await expect(uploadedNote(page)).toContainText('Uploaded 92 days');

	// The product is the charted series' Series details (issue #464), labelled; the upload charts what it uploaded.
	const row = page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Rainfall — CHIRPS' });
	await expect(row.getByRole('combobox')).toHaveCount(0);
	await row.getByRole('button', { name: 'View', exact: true }).click();
	const label = page.getByRole('group', { name: 'Series details' }).getByRole('combobox', { name: 'Product' });
	await expect(label).toHaveValue('CHIRPS/2.0');
	// Relabelling keeps the values; the server has the new label.
	await label.selectOption({ label: 'CHIRPS sat v3.0' });
	await expect
		.poll(async () => ((await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { product: string | null }[])[0]!.product)
		.toBe('CHIRPS sat');
	await page.reload();
	await expect(label).toHaveValue('CHIRPS sat/3.0');
	// Other kinds are never asked.
	await upload(page, 'Rainfall — catchment', 'rainfall-daily.csv');
	await expect(form.getByLabel('CHIRPS product and version')).toHaveCount(0);
});

// An automatic station's hourly record, added up into manual-gauge days (issue #40 (b) amendment 5). Synthetic.
test('an hourly file is added up into 08:00 days, or midnight days, and the series records which', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Hourly rain');
	await page.goto(`/projects/${project.id}?tab=series`);
	const form = await openAddData(page);
	await form.getByLabel('Kind').selectOption({ label: 'Rainfall — alternative catchment gauge' });
	// 2 mm an hour from 21:00 on the 5th to 04:00 on the 6th (stamps close their hour): a storm straddling midnight.
	const rows = ['timestamp,rain_mm'];
	for (let h = 0; h < 72; h++) {
		const iso = new Date(Date.UTC(2020, 2, 4, 9 + h)).toISOString();
		const stamp = `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
		rows.push(`${stamp},${stamp >= '2020-03-05 21:00' && stamp <= '2020-03-06 04:00' ? 2 : 0}`);
	}
	await form.getByLabel('CSV file').setInputFiles({ name: 'station.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
	const boundary = form.getByTestId('day-boundary');
	await expect(boundary.getByRole('radio', { name: /^08:00 to 08:00/ })).toBeChecked();
	await expect(form.getByTestId('sub-daily-summary')).toHaveText('72 readings, 24 a day, 08:00–08:00');
	// Midnight splits the storm over two days, with two partial days at the ends; back to 08:00 for the upload.
	await boundary.getByRole('radio', { name: /^midnight to midnight/ }).check();
	await expect(form.getByTestId('sub-daily-summary')).toContainText('2 days have fewer readings');
	await boundary.getByRole('radio', { name: /^08:00 to 08:00/ }).check();
	await form.getByLabel('Product').fill('SASSCAL AWS');
	await form.getByLabel('Version').fill('1');
	await form.getByRole('button', { name: 'Upload' }).click();
	await expect(uploadedNote(page)).toHaveText('Uploaded 3 days to “Rainfall — alternative catchment gauge”.');

	const row = page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Rainfall — alternative catchment gauge' });
	await expect(row.getByTestId('series-day-boundary')).toHaveText('08:00–08:00 days, added up from sub-daily readings');
	await row.getByRole('button', { name: 'View', exact: true }).click();
	await expect(page.getByRole('group', { name: 'Series details' }).getByTestId('series-provenance')).toHaveText('SASSCAL AWS v1');
	// No rain-source period names it yet, so no run reads it.
	await expect(row).toContainText('Not used: no rain-source period names it');
	const stored = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string; dayBoundary: string }[];
	expect(stored[0]!.dayBoundary).toBe('08:00');
	const s = await (await page.request.get(`${API_URL}/projects/${project.id}/series/${stored[0]!.id}`)).json();
	expect(s.startDate).toBe('2020-03-04');
	expect(s.values).toEqual([0, 16, 0]);
});

// Issue #45: a daily A-pan record is its own kind, guessed from the file name,
// and Settings then says A-pan comes from it (the monthly means before it).
test('a daily A-pan file uploads as its own kind, and Settings says evaporation now comes from it', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Daily A-pan');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const source = page.getByTestId('apan-source');
	await expect(source).toHaveAttribute('data-daily', 'false');
	await expect(source).toHaveText('A-pan comes from these monthly means on every day. A daily A-pan record can be added on the Data tab.');

	await page.goto(`/projects/${project.id}?tab=series`);
	const form = await openAddData(page);
	await form.getByLabel('CSV file').setInputFiles(fixture('apan-daily.csv'));
	await expect(form.getByLabel('Kind')).toHaveValue('evap_apan_mm');
	await expect(form.getByLabel('Unit')).toHaveValue('mm');
	await form.getByRole('button', { name: 'Upload' }).click();
	await expect(uploadedNote(page)).toHaveText('Uploaded 30 days to “Evaporation — A-pan, daily”.');
	const row = page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Evaporation — A-pan, daily' });
	await expect(row).toContainText('Daily evaporation');

	await page.goto(`/projects/${project.id}?tab=settings`);
	await expect(source).toHaveAttribute('data-daily', 'true');
	await expect(source).toContainText('A-pan comes from the daily A-pan series (Data tab) on the days it has a value');
});

// Issue #45: a DWS hydrology export loads as it is. The synthetic fixture is the
// one the feed's and the import's unit tests read (packages/engine/fixtures).
test('a DWS export loads with its missing-data codes and -999 as gaps, and the summary says why', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series DWS export');
	await page.goto(`/projects/${project.id}?tab=series`);
	const form = await openAddData(page);
	await form.getByLabel('Kind').selectOption({ label: 'Flow — observed gauge' });
	await form.getByLabel('CSV file').setInputFiles(fileURLToPath(new URL('../../packages/engine/fixtures/dws-daily-export.txt', import.meta.url)));
	const summary = form.getByRole('definition');
	await expect(summary.nth(0)).toHaveText('2021-01-01 → 2021-01-11');
	await expect(summary.nth(1)).toHaveText('11');
	await expect(summary.nth(2)).toHaveText('7');
	await expect(summary.nth(3)).toHaveText('4');
	await expect(form.getByTestId('dws-summary')).toHaveText(
		'10 rows, Daily avg flow rate in cubic metres/sec 99999.999. 3 read as gaps: 2 rows with a missing-data quality code (170, 255); 1 negative value (a placeholder such as -999).'
	);
	await expect(form.getByTestId('dws-quality')).toHaveText('1 × 6, 2 × 1, 60 × 1, 170 × 1, 255 × 1');
	await form.getByLabel(/^Name/).fill('Weir X0H000');
	await form.getByRole('button', { name: 'Upload' }).click();
	await expect(uploadedNote(page)).toHaveText('Uploaded 11 days to “Weir X0H000”.');

	const list = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string }[];
	const stored = (await (await page.request.get(`${API_URL}/projects/${project.id}/series/${list[0]!.id}`)).json()) as { startDate: string; values: (number | null)[] };
	expect(stored.startDate).toBe('2021-01-01');
	expect(stored.values).toEqual([0.412, 0.398, 1.897, null, null, null, 12.5, 0.371, null, 0.355, 0.349]);
});

test('a semicolon file with decimal commas loads; one that mixes decimal points in is refused with the reason', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series semicolons');
	await page.goto(`/projects/${project.id}?tab=series`);
	const form = await openAddData(page);
	await form.getByLabel('CSV file').setInputFiles({ name: 'mixed.csv', mimeType: 'text/csv', buffer: Buffer.from('datum;reën\n2021-10-01;12,5\n2021-10-02;3.25\n') });
	await expect(form.getByRole('alert')).toHaveText(
		'mixed.csv: the file mixes decimal points ("3.25", line 3) and decimal commas ("12,5", line 2); use one throughout'
	);
	await form.getByLabel('CSV file').setInputFiles({ name: 'rain.csv', mimeType: 'text/csv', buffer: Buffer.from('datum;reën\n2021-10-01;12,5\n2021-10-02;"1 234,5"\n2021-10-03;0\n') });
	const summary = form.getByRole('definition');
	await expect(summary.nth(0)).toHaveText('2021-10-01 → 2021-10-03');
	await expect(summary.nth(2)).toHaveText('3');
	await form.getByRole('button', { name: 'Upload' }).click();
	await expect(uploadedNote(page)).toContainText('Uploaded 3 days');
	const list = (await (await page.request.get(`${API_URL}/projects/${project.id}/series`)).json()).series as { id: string }[];
	const stored = (await (await page.request.get(`${API_URL}/projects/${project.id}/series/${list[0]!.id}`)).json()) as { values: (number | null)[] };
	expect(stored.values).toEqual([12.5, 1234.5, 0]);
});

test('the Series details controls that save on change say Saved, and a failed save reverts the control and says why beside it', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series save on change');
	const outlet = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const weir = node('Middle weir', 'gauge', outlet.id, 2, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const farm = node('Lower farm', 'farm', outlet.id, 3, { areaKm2: 8 });
	await putModel(page.request, project.id, { nodes: [outlet, weir, farm], crops: [], cropAreas: [], transfers: [] });
	await putSeries(page.request, project.id, { kind: 'rain_chirps_mm', name: 'Grid', unit: 'mm', startDate: '2021-10-01', values: [1, 2, 3] });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Weir', unit: 'm³/s', startDate: '2021-10-01', values: [0.5, 0.6, 0.7] });

	let fail = true;
	await page.route(/\/series\/[^/?]+$/, (route) =>
		route.request().method() === 'PATCH' && fail
			? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal error' }) })
			: route.fallback()
	);
	await page.goto(`/projects/${project.id}?tab=series`);
	const region = page.getByRole('region', { name: 'Input time series' });
	const chirps = region.getByRole('row').filter({ hasText: 'Rainfall — CHIRPS' });
	const flow = region.getByRole('row').filter({ hasText: 'Flow — observed gauge' });
	const details = page.getByRole('group', { name: 'Series details' });

	// A failed relabel: the select shows the stored label again, and the reason sits beside it.
	await chirps.getByRole('button', { name: 'View', exact: true }).click();
	const label = details.getByRole('combobox', { name: 'Product' });
	await label.selectOption({ label: 'CHIRPS v2.0' });
	await expect(label).toHaveValue('');
	await expect(label).toHaveAttribute('aria-invalid', 'true');
	await expect(label).toHaveAccessibleDescription(/^Not saved:/);
	fail = false;
	await label.selectOption({ label: 'CHIRPS v2.0' });
	await expect(label).toHaveAccessibleDescription('Saved');
	await expect(label).toHaveValue('CHIRPS/2.0');
	await expect(label).not.toHaveAttribute('aria-invalid', 'true');

	// A failed move: back at the outlet, and said beside it; a flow record has no Product.
	fail = true;
	await flow.getByRole('button', { name: 'View', exact: true }).click();
	await expect(details.getByRole('combobox', { name: 'Product' })).toHaveCount(0);
	const site = details.getByRole('combobox', { name: 'Measured at' });
	await site.selectOption({ label: 'Gauge Middle weir' });
	await expect(site).toHaveAccessibleDescription(/^Not saved:/);
	await expect(site).toHaveValue('');

	// A failed source edit: the input shows the stored (empty) source again.
	const source = details.getByRole('textbox', { name: 'Source' });
	await source.fill('DWS X1H001');
	await source.press('Tab');
	await expect(source).toHaveValue('');
	await expect(source).toHaveAttribute('aria-invalid', 'true');

	// Saves that go through say so beside the control.
	fail = false;
	await source.fill('DWS X1H001');
	await source.press('Tab');
	await expect(source).not.toHaveAttribute('aria-invalid', 'true');
	await expect(source).toHaveAccessibleDescription('Saved');
	await expectNoViolations(page);
});

// Issue #464: one labelled Series details row under the chart; the table row keeps only a read-only "At gauge X".
test('the Series details row labels the charted series’ product, where measured, source and upload unit, and a viewer reads them', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Series details');
	const outlet = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const weir = node('Middle weir', 'gauge', outlet.id, 2, { areaKm2: 0, pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	await putModel(page.request, project.id, { nodes: [outlet, weir], crops: [], cropAreas: [], transfers: [] });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Weir', unit: 'm³/s', startDate: '2021-10-01', values: [0.5, 0.6, 0.7] });
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', name: 'Station', unit: 'mm', startDate: '2021-10-01', values: [1, 2, 3] });

	await page.goto(`/projects/${project.id}?tab=series`);
	const region = page.getByRole('region', { name: 'Input time series' });
	const flow = region.getByRole('row').filter({ hasText: 'Flow — observed gauge' });
	// The rows hold no controls of their own but the row's actions: no selects, no text boxes.
	await expect(region.getByRole('table').getByRole('combobox')).toHaveCount(0);
	await expect(region.getByRole('table').getByRole('textbox')).toHaveCount(0);
	await expect(flow.getByTestId('series-site')).toHaveCount(0);

	await flow.getByRole('button', { name: 'View', exact: true }).click();
	const details = page.getByRole('group', { name: 'Series details' });
	await expect(details.getByRole('term')).toHaveText(['Measured at', 'Source', 'Upload unit']);
	// The upload records the unit it was given in (here m³/s, no conversion).
	await expect(details.getByTestId('series-given-unit')).toHaveText('m³/s');
	const site = details.getByRole('combobox', { name: 'Measured at' });
	await expect(site.getByRole('option')).toHaveText(['The outlet', 'Gauge Middle weir']);
	await site.selectOption({ label: 'Gauge Middle weir' });
	await expect(site).toHaveAccessibleDescription('Saved');
	await expect(flow.getByTestId('series-site')).toHaveText('At gauge Middle weir');
	const source = details.getByRole('textbox', { name: 'Source' });
	await source.fill('DWS X1H001');
	await source.press('Tab');
	await expect(source).toHaveAccessibleDescription('Saved');

	// Rain has no Measured at; its details say only the source and unit.
	await region.getByRole('row').filter({ hasText: 'Rainfall — catchment' }).getByRole('button', { name: 'View', exact: true }).click();
	await expect(details.getByRole('term')).toHaveText(['Source', 'Upload unit']);
	await expectNoViolations(page);

	// A viewer reads the same details as words, with the same labels.
	const viewer = await signIn('Series details viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.goto(`/projects/${project.id}?tab=series`);
	const vFlow = v.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Flow — observed gauge' });
	await expect(vFlow.getByTestId('series-site')).toHaveText('At gauge Middle weir');
	await vFlow.getByRole('button', { name: 'View', exact: true }).click();
	const vDetails = v.getByRole('group', { name: 'Series details' });
	await expect(vDetails.getByRole('term')).toHaveText(['Measured at', 'Source', 'Upload unit']);
	await expect(vDetails.getByRole('definition')).toHaveText(['Gauge Middle weir', 'DWS X1H001', 'm³/s']);
	await expect(vDetails.getByRole('combobox')).toHaveCount(0);
	await expect(vDetails.getByRole('textbox')).toHaveCount(0);
	await expectNoViolations(v);
});

test('a series row’s role explains itself through a tip the keyboard reaches, not a hover title', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series role tip');
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', name: 'Station A', unit: 'mm', startDate: '2021-10-01', values: [1, 2, 3] });
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', name: 'Station B', unit: 'mm', startDate: '2021-10-01', values: [1, 2, 3] });
	await page.goto(`/projects/${project.id}?tab=series`);
	const row = page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Station B' });
	await expect(row.getByTestId('series-role')).toHaveText('Not used (another series of this kind is)');
	await expect(row.getByTestId('series-role')).not.toHaveAttribute('title');
	const tip = row.getByRole('button', { name: 'About Catchment rainfall' });
	await tip.focus();
	await page.keyboard.press('Enter');
	await expect(tip).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator(`[id="${await tip.getAttribute('aria-controls')}"]`)).toContainText('Daily catchment-average rainfall');
});
