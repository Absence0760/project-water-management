// The daily EWR at the outlet from Desktop Reserve Model files (engine 1.77.0,
// issue #455, docs/ui.md § The daily EWR at the outlet): upload a .tab and a
// .rul on Settings, see the converted values, save, run, and read which EWR
// the run used; and fill a Reserve rule table from the same files. The file
// load sits above the tables (and at the top of each rule table), and a file
// never changes the daily EWR's method on its own. The files are synthetic
// (e2e/fixtures/drm-synthetic.*, the app's own example files).
import type { APIRequestContext } from '@playwright/test';
import { createProject, createRun, putModel, putSeries, sampleModel, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveChanges, saveSettings } from '../support/settings.ts';
import { answerConfirm } from '../support/confirm.ts';

const RUL = new URL('../fixtures/drm-synthetic.rul', import.meta.url).pathname;
const TAB = new URL('../fixtures/drm-synthetic.tab', import.meta.url).pathname;

async function seed(request: APIRequestContext, name: string): Promise<string> {
	const project = await createProject(request, name);
	await putModel(request, project.id, sampleModel());
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	const days = 1096;
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(days) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(days) });
	return project.id;
}

test('a .tab file sets the TAB flows (shown converted before use), a .rul the percentile tables, and the run says which EWR it used', async ({ page, owner }) => {
	void owner;
	const id = await seed(page.request, 'Daily EWR from DRM files');
	await page.goto(`/projects/${id}?tab=settings`);
	const daily = page.getByRole('group', { name: /^The daily EWR at the outlet/ });
	await expect(daily.getByLabel('Daily EWR from')).toHaveValue('pragmatic');

	await daily.getByLabel('Daily EWR from').selectOption('tab');
	// The TAB flows and the table MAR are missing: Save is blocked and says why.
	await expect(daily.getByRole('alert')).toContainText('Daily EWR at the outlet: Enter the TAB file’s 12 monthly total flows');
	await expect(saveChanges(page)).toBeDisabled();
	// The file load sits above the TAB flows, with the shared Expected format.
	const loadFile = daily.getByLabel('Load a DRM file (.rul / .tab)');
	await expect(loadFile).toBeAttached();
	const loadBox = (await daily.getByText('Load a DRM file (.rul / .tab)').boundingBox())!;
	const tableBox = (await daily.getByRole('table', { name: /^TAB flows/ }).boundingBox())!;
	expect(loadBox.y + loadBox.height).toBeLessThan(tableBox.y);
	await daily.getByTestId('format-help').getByText('Expected format').click();
	await expect(daily.getByRole('link', { name: 'Example .tab', exact: true })).toHaveAttribute('download', 'drm-example.tab');
	await expect(daily.getByRole('link', { name: 'Example CSV (percentile table, m³/s)' })).toHaveAttribute('download', 'ewr-example.csv');

	// The .tab's last column, Mm³ a month, converted to m³/s (October: 1.26 Mm³ over 31 days; February over 28).
	await loadFile.setInputFiles(TAB);
	const preview = daily.getByTestId('ewr-tab-preview');
	await expect(preview.getByRole('row', { name: /^Mm³/ })).toContainText('1.26');
	await expect(preview.getByRole('row', { name: /^m³\/s/ })).toContainText('0.4704');
	await expect(preview.getByRole('row', { name: /^m³\/s/ })).toContainText('0.0579');
	await expectNoViolations(page);
	// Cancel uses nothing; load it again and use it.
	await preview.getByRole('button', { name: 'Cancel' }).click();
	await expect(preview).toBeHidden();
	await expect(daily.getByLabel('TAB flow, Oct, m³/s')).toHaveValue('');
	await loadFile.setInputFiles(TAB);
	await preview.getByRole('button', { name: 'Use these values' }).click();
	await expect(daily.getByLabel('TAB flow, Oct, m³/s')).toHaveValue(/^0\.470/);
	await expect(daily.getByLabel('Table MAR (Mm³/a)')).toHaveValue('49.8');
	await expect(daily.getByTestId('ewr-scale-factor')).toContainText('49.8 Mm³/a');
	await saveSettings(page);

	// The run judges the outlet by the TAB file, and says so.
	await createRun(page.request, id, 'TAB file');
	await page.goto(`/projects/${id}?tab=runs`);
	await expect(page.getByTestId('outlet-ewr-source').first()).toContainText(/^EWR: the DRM TAB file × [\d.]+ \(natural MAR [\d.]+ ÷ 49\.8 Mm³\/a\)$/);

	// A .rul loaded under the TAB file fills the percentile tables but keeps the TAB file, and says so.
	await page.goto(`/projects/${id}?tab=settings`);
	await expect(daily.getByLabel('Daily EWR from')).toHaveValue('tab');
	await loadFile.setInputFiles(RUL);
	const fileResult = daily.getByRole('status', { name: 'File result' });
	await expect(fileResult).toHaveText(
		'Read drm-synthetic.rul (DRM rule curves, m³/s): filled the two percentile tables (the total Reserve and the natural duration curve). The daily EWR still comes from the DRM TAB file; the tables are used only once you pick them.'
	);
	await expect(daily.getByLabel('Daily EWR from')).toHaveValue('tab');
	await expect(daily.getByLabel('TAB flow, Oct, m³/s')).toHaveValue(/^0\.470/);
	// One click switches, on the person's say.
	await daily.getByRole('button', { name: 'Use the percentile tables' }).click();
	await expect(daily.getByLabel('Daily EWR from')).toHaveValue('percentile');
	await expect(daily.getByRole('button', { name: 'Use the percentile tables' })).toBeHidden();
	await expect(fileResult).toHaveText('The daily EWR now comes from the DRM percentile tables.');
	await expect(daily.getByLabel('Natural flow percentile table, Oct, 10 %, m³/s')).toHaveValue('1.305');
	await expect(daily.getByLabel('Total Reserve flow percentile table, Oct, 99 %, m³/s')).toHaveValue('0.011');
	await expect(page.getByTestId('pragmatic-unused')).toBeVisible();
	await expectNoViolations(page);
	// A .tab under the percentile tables offers its MAR only, and changes nothing else.
	await daily.getByLabel('Table MAR (Mm³/a)').fill('10');
	await loadFile.setInputFiles(TAB);
	await preview.getByRole('button', { name: 'Use its MAR only' }).click();
	await expect(fileResult).toHaveText("Used drm-synthetic.tab's MAR, 49.8 Mm³/a, as the table MAR.");
	await expect(daily.getByLabel('Table MAR (Mm³/a)')).toHaveValue('49.8');
	await expect(daily.getByLabel('Daily EWR from')).toHaveValue('percentile');
	await expect(daily.getByLabel('Natural flow percentile table, Oct, 10 %, m³/s')).toHaveValue('1.305');
	await saveSettings(page);
	await page.reload();
	await expect(daily.getByLabel('Daily EWR from')).toHaveValue('percentile');
	await expect(daily.getByLabel('Natural flow percentile table, Oct, 10 %, m³/s')).toHaveValue('1.305');

	// Back to the pragmatic EWR: the tables are kept for switching back.
	await daily.getByLabel('Daily EWR from').selectOption('pragmatic');
	await expect(page.getByTestId('pragmatic-unused')).toBeHidden();
	await saveSettings(page);
	await page.reload();
	await daily.getByLabel('Daily EWR from').selectOption('percentile');
	await expect(daily.getByLabel('Natural flow percentile table, Oct, 10 %, m³/s')).toHaveValue('1.305');

	// A phone: the grids scroll in their own boxes, the page doesn't scroll sideways.
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);
});

test('a Reserve rule table is filled from a .rul (grids, unit, REC, source) and a .tab (natural MAR); a bad file names its line', async ({ page, owner }) => {
	void owner;
	const id = await seed(page.request, 'Rule table from DRM files');
	await page.goto(`/projects/${id}?tab=settings`);
	const section = page.getByRole('region', { name: /^Reserve rule tables/ });
	await section.getByRole('button', { name: 'Add a rule table' }).click();
	const table = section.getByRole('group', { name: 'Rule table at Outlet (Outflow gauge)' });
	// The file load opens the table, above its fields, with the shared Expected format.
	const load = table.getByLabel('Load a DRM file (.rul / .tab) or a CSV');
	const status = table.getByRole('status', { name: 'File result', exact: true });
	const loadBox = (await table.getByText('Load a DRM file (.rul / .tab) or a CSV').boundingBox())!;
	const siteBox = (await table.getByLabel('EWR site').boundingBox())!;
	expect(loadBox.y + loadBox.height).toBeLessThan(siteBox.y);
	await table.getByTestId('format-help').getByText('Expected format').click();
	await expect(table.getByRole('link', { name: 'Example .rul (m³/s)' })).toHaveAttribute('download', 'drm-example.rul');
	await expect(table.getByRole('link', { name: 'Example CSV (low-flow table)' })).toHaveAttribute('download', 'ewr-low-flow-example.csv');

	await load.setInputFiles({ name: 'broken.rul', mimeType: 'text/plain', buffer: Buffer.from('Data are given in m^3/s mean monthly flow\r\nMonth  % Points\r\n  10%  20%\r\nOct  1  x\r\n') });
	await expect(status).toHaveText('broken.rul: line 4: the Oct row of the total Reserve block needs 2 numbers; it has one that isn’t a number.');

	await load.setInputFiles(RUL);
	await expect(status).toContainText('Read drm-synthetic.rul (DRM rule curves, m³/s): the total Reserve as the EWR, the low flows, the natural duration curve and the REC, C.');
	await expect(table.getByLabel('Unit')).toHaveValue('m3s');
	await expect(table.getByLabel('Recommended ecological category (REC)')).toHaveValue('C');
	await expect(table.getByLabel('Source', { exact: true })).toHaveValue('Desktop Reserve Model rule curves (drm-synthetic.rul, generated 01/01/2026)');
	await expect(table.getByLabel('EWR (total flow), Oct, 10 %, m³/s')).toHaveValue('0.6');
	await expect(table.getByLabel('Low flows (maintenance to drought), May, 10 %, m³/s')).toHaveValue('0.867');

	await load.setInputFiles(TAB);
	await expect(status).toContainText('Read drm-synthetic.tab (DRM summary): the natural MAR, 49.8 Mm³/a and the REC, C.');
	await expect(table.getByLabel('Natural MAR in the determination (Mm³/a)')).toHaveValue('49.8');
	await expectNoViolations(page);
	await saveSettings(page);

	// Loading the .rul again over the filled grids asks first; declining keeps them.
	await table.getByLabel('EWR (total flow), Oct, 10 %, m³/s').fill('0.7');
	await load.setInputFiles(RUL);
	await answerConfirm(page, false, 'Replace the rule table at Outlet (Outflow gauge) with drm-synthetic.rul?');
	await expect(table.getByLabel('EWR (total flow), Oct, 10 %, m³/s')).toHaveValue('0.7');
});
