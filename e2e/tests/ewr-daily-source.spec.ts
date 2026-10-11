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
/** The TAB flows the first test reads from drm-synthetic.tab (Oct 0.4704, Feb 0.0579 m³/s), as Settings saves them. */
const TAB_M3S = [0.4704, 0.4, 0.3, 0.2, 0.0579, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4];

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

test('a .tab file sets the TAB flows (shown converted before use), and the run says which EWR it used', async ({ page, owner }) => {
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
	// A new source scales by area (the client's hydrologist, issue #90 B2), which a .tab can't give: the MAR ratio is a pick.
	await expect(daily.getByLabel('Scale the tables by')).toHaveValue('area');
	await expect(daily.getByTestId('ewr-scale-factor')).toHaveText('Scale factor: enter the table’s catchment area.');
	await expect(daily.getByTestId('ewr-scaled-pending')).toBeVisible();
	await daily.getByLabel('Scale the tables by').selectOption('mar');
	await expect(daily.getByTestId('ewr-scale-factor')).toContainText('49.8 Mm³/a');
	await saveSettings(page);

	// The run judges the outlet by the TAB file, and says so.
	await createRun(page.request, id, 'TAB file');
	await page.goto(`/projects/${id}?tab=runs`);
	await expect(page.getByTestId('outlet-ewr-source').first()).toContainText(/^EWR: the DRM TAB file × [\d.]+ \(natural MAR [\d.]+ ÷ 49\.8 Mm³\/a\)$/);
});

// The scaled tables (issue #90 B1 gap a): each value × s, in Settings as soon as s is known (the area ratio needs no
// run) and with the run, from its own settings snapshot and s. The units are 12 + 8 = 20 km²; the table's 40 km², so s = 0.5.
test('the TAB flows scaled to the model show in Settings and with the run that read them', async ({ page, owner }) => {
	void owner;
	const id = await seed(page.request, 'Daily EWR, scaled tables');
	await updateSettings(page.request, id, {
		ewrDailySource: { method: 'tab', scaling: 'area', tableMarMm3: null, tableAreaKm2: 40, tabM3s: TAB_M3S, naturalPctM3s: null, reservePctM3s: null }
	});
	await page.goto(`/projects/${id}?tab=settings`);
	const daily = page.getByRole('group', { name: /^The daily EWR at the outlet/ });
	await expect(daily.getByTestId('ewr-scale-factor')).toHaveText('Scale factor s = 20 km² ÷ 40 km² = 0.5.');
	const scaled = daily.getByTestId('ewr-scaled').getByRole('table', { name: /^TAB flows scaled to the model/ });
	await expect(scaled).toContainText('× s = 0.5');
	// Oct 0.4704 × 0.5, Feb 0.0579 × 0.5.
	await expect(scaled.getByRole('row', { name: /^m³\/s/ }).getByRole('cell')).toHaveText(['0.235', '0.200', '0.150', '0.100', '0.029', '0.050', '0.075', '0.100', '0.125', '0.150', '0.175', '0.200']);

	await createRun(page.request, id, 'Scaled TAB');
	await page.goto(`/projects/${id}?tab=runs`);
	await expect(page.getByTestId('outlet-ewr-source').first()).toHaveText('EWR: the DRM TAB file × 0.5 (area 20 ÷ 40 km²)');
	const runScaled = page.getByTestId('run-ewr-scaled');
	await runScaled.getByText(/^The daily EWR’s tables as this run read them/).click();
	await expect(runScaled.getByRole('row', { name: /^m³\/s/ }).getByRole('cell').first()).toHaveText('0.235');
	await expectNoViolations(page);
});

// The .rul half, on its own: one test with both halves made five page loads and three whole-page scans of Settings
// (~3,000 elements), 17–19 s on CI and over the 30 s budget on a loaded runner. This starts from the TAB file the
// first test saves, set through the API.
test('a .rul under the TAB file fills the percentile tables and keeps the TAB file; a .tab under the tables offers its MAR only; the tables are kept for switching back', async ({ page, owner }) => {
	void owner;
	const id = await seed(page.request, 'Daily EWR, percentile tables from DRM files');
	await updateSettings(page.request, id, {
		ewrDailySource: { method: 'tab', scaling: 'mar', tableMarMm3: 49.8, tableAreaKm2: null, tabM3s: TAB_M3S, naturalPctM3s: null, reservePctM3s: null }
	});
	await page.goto(`/projects/${id}?tab=settings`);
	const daily = page.getByRole('group', { name: /^The daily EWR at the outlet/ });
	const loadFile = daily.getByLabel('Load a DRM file (.rul / .tab)');
	const preview = daily.getByTestId('ewr-tab-preview');

	// A .rul loaded under the TAB file fills the percentile tables but keeps the TAB file, and says so.
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

test('Compare runs names each run’s daily EWR on the water-year bars when a pragmatic baseline meets a DRM what-if', async ({ page, owner }) => {
	void owner;
	const id = await seed(page.request, 'Compare daily EWR sources');
	const baseline = await createRun(page.request, id, 'Pragmatic');
	await updateSettings(page.request, id, {
		ewrDailySource: { method: 'tab', scaling: 'mar', tableMarMm3: 49.8, tableAreaKm2: null, tabM3s: [0.47, 0.27, 0.1, 0.05, 0.06, 0.08, 0.22, 0.97, 1.85, 2.09, 1.57, 1.16], naturalPctM3s: null, reservePctM3s: null }
	});
	const whatIf = await createRun(page.request, id, 'TAB file');
	await page.goto(`/projects/${id}?tab=compare&a=${id}:${baseline}&b=${id}:${whatIf}`);
	const years = page.getByRole('region', { name: /^Days below .*, each year$/ });
	// The bars count each run's own daily EWR: the caption and the legend name both, never "the pragmatic EWR" for the two.
	await expect(years.getByText(/^Days in each water year/)).toHaveText(
		/^Days in each water year \(Oct–Sep\) when the simulated outflow was below each run’s daily EWR at the outlet \(Baseline: the pragmatic EWR; What-if 1: the daily EWR from the DRM TAB file\)\./
	);
	await expect(years.getByTestId('reserve-years-daily')).toHaveText([' (the pragmatic EWR)', ' (the daily EWR from the DRM TAB file)']);
	await expectNoViolations(page);

	// River & reserve and the printed report draw the TAB run's EWR line by its source, and the caption counts days below it.
	await page.goto(`/projects/${id}?tab=river&run=${whatIf}`);
	const flow = page.getByRole('region', { name: /^Flow vs/ });
	await expect(flow.getByText('EWR from the DRM TAB file (scaled)').first()).toBeVisible();
	await expect(flow.getByText(/below the daily EWR line \(from the DRM TAB file\)/)).toBeVisible();
	await expect(flow.getByText(/pragmatic EWR/)).toHaveCount(0);
	await page.goto(`/projects/${id}/report?run=${whatIf}`);
	await expect(page.getByText('Days the outflow dips below the daily EWR line (from the DRM TAB file) count as EWR not met.')).toBeVisible();
	await expect(page.getByText('EWR from the DRM TAB file (scaled)').first()).toBeAttached();
});
