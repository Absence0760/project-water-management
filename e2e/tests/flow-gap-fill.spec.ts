import { createProject, putSeries, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

// Issue #66: a series' source and given unit (107_series_source.sql), and gap
// filling of the observed flow records (engine ≥ 1.23.0, docs/model.md
// §2.10i). Synthetic records only.

test('a flow record uploaded in l/s says so, and an editor records where it came from', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Series source');
	await page.goto(`/projects/${project.id}?tab=series`);
	const form = page.getByRole('region', { name: 'Upload CSV' });
	await form.getByLabel('Kind').selectOption({ label: 'Flow — observed gauge' });
	await form.getByLabel('Unit').selectOption('l/s');
	await form.getByLabel('Source').fill('DWS X1H001');
	const rows = ['date,flow', ...Array.from({ length: 10 }, (_, i) => `2021-10-${String(i + 1).padStart(2, '0')},${1000 + i * 10}`)];
	await form.getByLabel('CSV file').setInputFiles({ name: 'weir.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
	await form.getByRole('button', { name: 'Upload' }).click();
	await expect(form.getByRole('status')).toContainText('Uploaded 10 days');

	const row = page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Flow — observed gauge' });
	await expect(row.getByTestId('series-source')).toHaveText('DWS X1H001 · given in l/s (× 0.001 to m³/s)');
	// The charted series: its given unit, and the source an editor records on change.
	await row.getByRole('button', { name: 'View', exact: true }).click();
	const origin = page.getByTestId('series-origin');
	await expect(origin.getByTestId('series-given-unit')).toHaveText('Uploaded in l/s, converted to m³/s (× 0.001)');
	const source = origin.getByRole('textbox', { name: 'Source' });
	await expect(source).toHaveValue('DWS X1H001');
	await source.fill('DWS X1H001 (daily means)');
	await source.press('Enter');
	await expect(row.getByTestId('series-source')).toHaveText('DWS X1H001 (daily means) · given in l/s (× 0.001 to m³/s)');
	await page.reload();
	await expect(page.getByTestId('series-origin').getByRole('textbox', { name: 'Source' })).toHaveValue('DWS X1H001 (daily means)');
});

test('the Data tab shades the gap days a run fills, and Settings turns the filling on', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Flow gaps');
	// A recession with a 3-day gap and a 20-day gap.
	const values: (number | null)[] = Array.from({ length: 60 }, (_, i) => 10 * Math.pow(0.97, i));
	for (let i = 10; i < 13; i++) values[i] = null;
	for (let i = 30; i < 50; i++) values[i] = null;
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', name: 'Weir', unit: 'm3/s', startDate: '2021-10-01', values });
	await updateSettings(page.request, project.id, {
		flowGapFill: { flow_observed_m3s: { interpolateMaxDays: 5, donor: null, donorMaxDays: 60, donorMinOverlapDays: 365 } }
	});

	await page.goto(`/projects/${project.id}?tab=series`);
	await page.getByRole('row', { name: /Weir/ }).getByRole('button', { name: 'View', exact: true }).click();
	await expect(page.locator('figure.chart')).toHaveAttribute('data-shaded', '1');
	await expect(
		page.getByText('Shaded: 3 days interpolated across gaps of up to 5 days, in a run only (Settings → Flow gaps); the stored record is unchanged. 1 gap (20 days) stay open.')
	).toBeVisible();

	// Settings: the record's spec as saved, and switching it off clears the shading.
	await page.getByRole('link', { name: 'Settings & calibration', exact: true }).click();
	const gauge = page.getByTestId('gap-fill-flow_observed_m3s');
	const fill = gauge.getByRole('checkbox', { name: 'Fill gaps in a run' });
	await expect(fill).toBeChecked();
	await expect(gauge.getByLabel('Interpolate gaps up to (days)')).toHaveValue('5');
	// One control for scoring filled days: the quality flags' infilled treatment, which says so here.
	await expect(page.getByTestId('gap-fill-scoring')).toContainText('Infilled days');
	await expect(page.getByLabel('Infilled days')).toHaveValue('exclude');
	await fill.uncheck();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await page.goto(`/projects/${project.id}?tab=series`);
	await page.getByRole('row', { name: /Weir/ }).getByRole('button', { name: 'View', exact: true }).click();
	await expect(page.locator('figure.chart canvas')).toBeVisible();
	await expect(page.locator('figure.chart')).not.toHaveAttribute('data-shaded');
});
