// Per-day quality flags (calibration research CR-18/19/22, issue #66): a
// record's gauged range in Settings → Calibration record, the fit censoring
// days above the highest gauging, the data-quality panel beside the fit, and
// the fit record saying when the flag settings changed since.
import { seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('a gauged range needs its source, and saves with it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Quality flags form');
	await page.goto(`/projects/${project.id}?tab=settings`);
	const flags = page.getByRole('group', { name: /^Quality flags for Fit automatically/ });
	// Only a gauge record in the project: only its range is offered.
	await expect(flags.getByLabel(/^Logger record: highest gauging/)).toHaveCount(0);
	await flags.getByLabel(/^Gauge record: highest gauging/).fill('0.3');
	await expect(flags.getByRole('alert')).toHaveText('Gauge record gauged range: A gauged range needs its source.');
	await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();
	await flags.getByRole('textbox', { name: 'Source of the gauge record gauged range', exact: true }).fill('Synthetic rating table');
	await expect(flags.getByRole('alert')).toHaveCount(0);
	await flags.getByLabel('Suspect days').selectOption({ label: 'Score as recorded' });
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await page.reload();
	await expect(flags.getByLabel(/^Gauge record: highest gauging/)).toHaveValue('0.3');
	await expect(flags.getByRole('textbox', { name: 'Source of the gauge record gauged range', exact: true })).toHaveValue('Synthetic rating table');
	await expect(flags.getByLabel('Suspect days')).toHaveValue('include');
	await expect(flags.getByLabel('Days above the highest gauging')).toHaveValue('censor');
});

test('the fit censors days above the highest gauging, shows its data quality, and its record notices a flag change', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Quality flags fit');
	// The synthetic record peaks at 0.35 m³/s every 9th day: 14 of its 120 days are above 0.3.
	await updateSettings(page.request, project.id, {
		runoffModel: 'gr4j',
		qualityFlags: { ratings: { flow_observed_m3s: { gaugedMaxM3s: 0.3, gaugedMinM3s: null, source: 'Synthetic rating table' } } }
	});
	await page.goto(`/projects/${project.id}?tab=settings`);
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await fit.getByLabel('Model runs per fit').fill('50');
	await fit.getByLabel('Starts').fill('1');
	await fit.getByRole('checkbox', { name: /^Validate/ }).uncheck();
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();

	const panel = fit.getByTestId('fit-data-quality');
	await expect(panel.getByRole('heading', { name: /^Data quality of the scored record/ })).toContainText('120 of 120 observed days scored · 14 censored');
	await expect(panel).toContainText('Gauged range up to 0.300 m³/s (Synthetic rating table).');
	const byFlag = panel.getByRole('table', { name: 'Observed flow in the window, by quality flag' });
	await expect(byFlag.getByRole('row', { name: /^Above the highest gauging/ })).toContainText(/14\s*11\.7 %\s*censored at the highest gauging/);
	await expect(panel.getByRole('table', { name: 'Rain on the scored days' }).getByRole('row', { name: /^Catchment gauge reading/ })).toContainText('120');
	await expect(panel.getByRole('list', { name: 'What the record can’t support' })).toContainText('14 days read above the highest gauging (0.3 m³/s)');
	// The fit on all days sits beside the fit on the clean days.
	const scores = fit.getByRole('table', { name: /^Fit, and validation/ });
	await expect(scores.getByRole('columnheader', { name: /^Fitted, all days \(flags ignored\)/ })).toBeVisible();

	await fit.getByRole('button', { name: 'Apply to form' }).click();
	const record = page.getByRole('region', { name: /^Fit record of these parameters/ });
	await expect(record.getByTestId('fit-quality-flags')).toContainText('120 of 120 observed days scored · 14 censored');
	await expect(record.getByText('Quality flags changed since fit')).toHaveCount(0);
	// Leave the flood days out instead: the fit was made on other terms.
	await page.getByRole('group', { name: /^Quality flags for Fit automatically/ }).getByLabel('Days above the highest gauging').selectOption({ label: 'Leave out' });
	await expect(record.getByText('Quality flags changed since fit')).toBeVisible();
	await expect(record.getByText(/quality-flag settings .* have changed since the fit/)).toBeVisible();
});
