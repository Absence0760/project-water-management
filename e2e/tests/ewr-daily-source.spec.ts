// The daily EWR at the outlet from Desktop Reserve Model files (engine 1.77.0,
// issue #455, docs/ui.md § The daily EWR at the outlet): upload a .tab and a
// .rul on Settings, see the converted values, save, run, and read which EWR
// the run used; and fill a Reserve rule table from the same files. The files
// are synthetic (e2e/fixtures/drm-synthetic.*, the app's own example files).
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
	await daily.getByText('Which files can I load into the daily EWR, and what do they fill?').click();
	await expect(daily.getByRole('link', { name: '.tab', exact: true })).toHaveAttribute('download', 'drm-example.tab');

	// The .tab's last column, Mm³ a month, converted to m³/s (October: 1.26 Mm³ over 31 days; February over 28).
	await daily.getByLabel('Load a DRM file (.tab or .rul)').setInputFiles(TAB);
	const preview = daily.getByTestId('ewr-tab-preview');
	await expect(preview.getByRole('row', { name: /^Mm³/ })).toContainText('1.26');
	await expect(preview.getByRole('row', { name: /^m³\/s/ })).toContainText('0.4704');
	await expect(preview.getByRole('row', { name: /^m³\/s/ })).toContainText('0.0579');
	await expectNoViolations(page);
	// Cancel uses nothing; load it again and use it.
	await preview.getByRole('button', { name: 'Cancel' }).click();
	await expect(preview).toBeHidden();
	await expect(daily.getByLabel('TAB flow, Oct, m³/s')).toHaveValue('');
	await daily.getByLabel('Load a DRM file (.tab or .rul)').setInputFiles(TAB);
	await preview.getByRole('button', { name: 'Use these values' }).click();
	await expect(daily.getByLabel('TAB flow, Oct, m³/s')).toHaveValue(/^0\.470/);
	await expect(daily.getByLabel('Table MAR (Mm³/a)')).toHaveValue('49.8');
	await expect(daily.getByTestId('ewr-scale-factor')).toContainText('49.8 Mm³/a');
	await saveSettings(page);

	// The run judges the outlet by the TAB file, and says so.
	await createRun(page.request, id, 'TAB file');
	await page.goto(`/projects/${id}?tab=runs`);
	await expect(page.getByTestId('outlet-ewr-source').first()).toContainText(/^EWR: the DRM TAB file × [\d.]+ \(natural MAR [\d.]+ ÷ 49\.8 Mm³\/a\)$/);

	// The percentile tables from the .rul: the natural duration curve and the total Reserve, m³/s.
	await page.goto(`/projects/${id}?tab=settings`);
	await daily.getByLabel('Daily EWR from').selectOption('percentile');
	await daily.getByLabel('Load a DRM file (.tab or .rul)').setInputFiles(RUL);
	await expect(daily.getByRole('status', { name: 'File result' })).toContainText('Read drm-synthetic.rul (DRM rule curves, m³/s)');
	await expect(daily.getByLabel('Natural flow percentile table, Oct, 10 %, m³/s')).toHaveValue('1.305');
	await expect(daily.getByLabel('Total Reserve flow percentile table, Oct, 99 %, m³/s')).toHaveValue('0.011');
	await expect(page.getByTestId('pragmatic-unused')).toBeVisible();
	await expectNoViolations(page);
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
	const load = table.getByLabel('Load a file (.rul, .tab or CSV)');
	const status = table.getByRole('status', { name: 'Paste result', exact: true });

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
