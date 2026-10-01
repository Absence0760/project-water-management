// Automatic calibration in the browser (issue #4 phase 5): fit GR4J to the
// observed record in a Web Worker, read the fit and its validation, apply the
// result to the form and save it. A fit never saves anything by itself.
import { addMember, putSeries, seedRunnableProject, syntheticFlow, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { ungroup } from '../support/format.ts';

test('fitting GR4J fills the form, and only Save stores it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Auto-calibration');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=settings`);

	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await expect(fit.getByLabel('Objective')).toHaveValue('kgePrime');
	await fit.getByLabel('Model runs per fit').fill('60');
	// 5 starts of the whole record by default (CR-2), then the two validation fits.
	await expect(fit.getByLabel('Starts')).toHaveValue('5');
	await expect(fit.getByText('420 runs in all.')).toBeVisible();
	await fit.getByLabel('Starts').fill('3');
	await expect(fit.getByText('300 runs in all.')).toBeVisible();
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();

	const scores = fit.getByRole('table', { name: /^Fit, and validation/ });
	await expect(scores).toBeVisible();
	// Every start is listed with its seed, and exactly one is kept.
	const starts = fit.getByRole('table', { name: /^Starts: separate searches/ });
	await expect(starts.getByRole('rowheader')).toHaveCount(3);
	await expect(starts.getByRole('rowheader', { name: /\(kept\)$/ })).toHaveCount(1);
	await expect(starts.getByRole('row', { name: /^1/ }).getByRole('cell').first()).toHaveText('1');
	for (const col of ['Current parameters', 'Fitted', 'Split: fitted half', 'Split: other half']) {
		await expect(scores.getByRole('columnheader', { name: new RegExp(`^${col}`) })).toBeVisible();
	}
	await expect(scores.getByRole('rowheader', { name: /^KGE′/ })).toBeVisible();
	// The benchmarks table ends with how to read it (issue #174: once, in the table, not as a note at the panel's end).
	const bench = fit.getByTestId('fit-benchmarks');
	await expect(bench.getByRole('rowheader', { name: 'Mean flow every day' })).toBeVisible();
	await expect(bench.getByTestId('fit-benchmarks-note')).toHaveText(
		'Judge the fit by the validation columns: they score days the parameters never saw. The model should clearly beat the mean flow every day, and in a strongly seasonal catchment the day-of-year climatology too.'
	);
	// CR-5 (engine 1.61.0): the split test's benchmarks come from its fitted half, as a forecast without the other half's flows would.
	await expect(bench.getByTestId('fit-benchmarks-source')).toHaveText(
		'On a validation column both benchmarks are built from that test’s calibration period and applied to the validation days, as a forecast made without the validation flows would be.'
	);
	await expect(fit.getByText(/KGE of the mean flow is/)).toHaveCount(0);
	// 120 days of record: no water years to test wet-year behaviour on, and the page says so.
	await expect(fit.getByText(/too few to fit on dry years and test on wet ones/)).toBeVisible();

	const params = fit.getByRole('table', { name: 'Parameters', exact: true });
	const fitted = await params.getByRole('row', { name: /^Production store capacity X1/ }).getByRole('cell').nth(1).textContent();
	await fit.getByRole('button', { name: 'Apply to form' }).click();
	const x1 = page.getByLabel(/^Production store capacity X1/);
	await expect(x1).not.toHaveValue('350');
	expect(ungroup(await x1.inputValue())).toBeCloseTo(ungroup(fitted!), -1);
	// Applied, not saved.
	await expect(page.getByText('Unsaved settings')).toBeVisible();
	const applied = await x1.inputValue();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await page.reload();
	await expect(x1).toHaveValue(applied);
});

test('turning groundwater exchange on offers X2 without resetting the other ticks', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Auto-calibration ticks');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=settings`);
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	// Only a gauge record: nothing else to validate against, so no choice is offered.
	await expect(fit.getByLabel('Also validate against')).toHaveCount(0);
	const x4 = fit.getByRole('checkbox', { name: /^Unit hydrograph time base X4/ });
	await x4.uncheck();
	await expect(fit.getByRole('checkbox', { name: /^Groundwater exchange X2/ })).toHaveCount(0);
	await page.getByLabel('Let the catchment gain or lose groundwater').check();
	await expect(fit.getByRole('checkbox', { name: /^Groundwater exchange X2/ })).not.toBeChecked();
	await expect(x4).not.toBeChecked();
	await expect(fit.getByRole('checkbox', { name: /^Production store capacity X1/ })).toBeChecked();
});

test('a fit can be cancelled, leaving the form untouched', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Auto-calibration cancel');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=settings`);
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await fit.getByLabel('Model runs per fit').fill('10000');
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();
	await expect(fit.getByRole('progressbar', { name: 'Calibration progress' })).toBeVisible();
	await fit.getByRole('button', { name: 'Cancel' }).click();
	await expect(fit.getByRole('button', { name: 'Fit automatically', exact: true })).toBeEnabled();
	await expect(fit.getByRole('progressbar')).toHaveCount(0);
	await expect(page.getByLabel(/^Production store capacity X1/)).toHaveValue('350');
	await expect(page.getByText('Unsaved settings')).toBeHidden();
});

test('a viewer can fit but not apply', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Auto-calibration viewer');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	const viewer = await signIn('Fit viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=settings`);
	const fit = viewer.page.getByRole('region', { name: /^Fit automatically/ });
	await fit.getByLabel('Model runs per fit').fill('50');
	await fit.getByRole('checkbox', { name: /^Validate/ }).uncheck();
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();
	await expect(fit.getByRole('table', { name: 'Parameters', exact: true })).toBeVisible();
	await expect(fit.getByRole('button', { name: 'Apply to form' })).toHaveCount(0);
});

test('with a gauge and a logger record, the fit can be validated against the other one', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Auto-calibration two records');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j', calibrationFlowKind: 'flow_observed_m3s' });
	// Synthetic second instrument: 70 % of the gauge, over the same 120 days.
	const logger = syntheticFlow(120).map((q) => Math.round(q * 0.7 * 1000) / 1000);
	await putSeries(page.request, project.id, { kind: 'flow_logger_m3s', unit: 'm³/s', startDate: '2021-10-01', values: logger });
	await page.goto(`/projects/${project.id}?tab=settings`);

	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	const record = fit.getByLabel('Also validate against');
	await expect(record).toHaveValue('');
	// The fit uses the gauge, so only the logger is offered.
	await expect(record.getByRole('option')).toHaveText(['No other record', 'Logger flow']);
	await record.selectOption({ label: 'Logger flow' });
	await fit.getByLabel('Model runs per fit').fill('50');
	await fit.getByRole('checkbox', { name: /^Validate/ }).uncheck();
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();

	const scores = fit.getByRole('table', { name: /^Fit, and validation/ });
	const col = scores.getByRole('columnheader', { name: /^Independent record: Logger flow/ });
	await expect(col).toBeVisible();
	await expect(col).toContainText('2021-10-01 – 2022-01-28');
	// Every logger day was also fitted to (on the gauge), and the note says what that means.
	await expect(fit.getByText(/120 of the 120 days scored against the logger record were also fitted to/)).toBeVisible();
});
