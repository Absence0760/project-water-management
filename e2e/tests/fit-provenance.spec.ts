// Fit provenance and calibration exclusions (issue #4, assessor review): an
// applied fit is saved with a record of how it was made and validated, each
// run shows the record it ran with, a hand edit after Apply marks the record,
// and a stored exclusion leaves a trace in "What changed".
import type { Locator, Page } from '@playwright/test';
import { createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveChanges, saveSettings } from '../support/settings.ts';
import { whatChanged } from '../support/compare.ts';
import { ungroup } from '../support/format.ts';

/** The <dd> next to a <dt> in a definition list. */
const definition = (scope: Locator, term: string) => scope.getByRole('term').filter({ hasText: new RegExp(`^${term}$`) }).locator('xpath=following-sibling::dd[1]');

async function fitAndApply(page: Page, { seed, validate, bounds }: { seed: string; validate: boolean; bounds?: 'wide' | 'typical' }) {
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await fit.getByLabel('Seed').fill(seed);
	if (bounds) await fit.getByLabel(/^Bounds/).selectOption(bounds);
	await fit.getByLabel('Model runs per fit').fill('50');
	if (!validate) await fit.getByRole('checkbox', { name: /^Validate/ }).uncheck();
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();
	await expect(fit.getByText(new RegExp(`seed ${seed} ·`))).toBeVisible();
	await fit.getByRole('button', { name: 'Apply to form' }).click();
}

test('an applied fit is saved with its record, and the run shows which fit and validation produced its parameters', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Fit provenance');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=settings`);
	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await expect(fit.getByLabel('Seed')).toHaveValue('1');

	await fitAndApply(page, { seed: '7', validate: true, bounds: 'typical' });
	const record = page.getByRole('region', { name: /^Fit record of these parameters/ });
	await expect(definition(record, 'Seed')).toHaveText('7');
	await expect(definition(record, 'Bounds')).toHaveText('typical (Perrin et al. 80 %)');
	await expect(record.getByText('Parameters edited since fit')).toHaveCount(0);
	await saveSettings(page);

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('Fitted');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Fitted' })).toBeVisible();
	const prov = page.getByRole('region', { name: /^Where the parameters came from/ });
	await expect(prov).toContainText(/GR4J fit of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
	await expect(definition(prov, 'Seed')).toHaveText('7');
	await expect(definition(prov, 'Objective')).toHaveText('KGE′ (Kling–Gupta, 2012)');
	await expect(definition(prov, 'Bounds')).toHaveText('typical (Perrin et al. 80 %)');
	// The data-quality limits that decide which rain was suspect (engine ≥ 1.20.0, issue #66).
	await expect(prov.getByTestId('fit-rain-checks')).toContainText('zero-rain runs with 60+ wet-season days; low vs CHIRPS below 50 % of the whole-record median, 50 mm CHIRPS minimum (the defaults)');
	// Five starts of the full fit (CR-2) and the split-sample; 120 days hold no water years for the dry → wet test.
	await expect(definition(prov, 'Model runs')).toHaveText('50 per fit, 5 starts, 300 in all');
	// The in-sample score sits next to the validation scores.
	const scores = prov.getByRole('table');
	await expect(scores.getByRole('columnheader', { name: /^Calibration period \(in-sample\)/ })).toBeVisible();
	await expect(scores.getByRole('columnheader', { name: /^Split: other half/ })).toBeVisible();
	await expect(prov.getByText('Parameters edited since fit')).toHaveCount(0);
	// The run's own scores are in-sample: its parameters were fitted on these days (issue #45).
	const calibration = page.getByRole('region', { name: 'Calibration against observed flow' });
	await expect(calibration.getByText('Calibration period (in-sample).', { exact: true })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Run summary' }).getByText('calibration period (in-sample)', { exact: true })).toHaveCount(2);
});

test('editing a fitted parameter by hand marks the fit record as edited: in the form, once saved, on the run and in run comparison', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Fit edited');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=settings`);
	await fitAndApply(page, { seed: '3', validate: false });

	const record = page.getByRole('region', { name: /^Fit record of these parameters/ });
	await expect(record.getByText('Parameters edited since fit')).toHaveCount(0);
	await expect(record.getByText('This fit was not validated', { exact: false })).toBeVisible();
	await saveSettings(page);
	const fittedRun = await createRun(page.request, project.id, 'Fitted');

	const x1 = page.getByLabel(/^Production store capacity X1/);
	const fitted = ungroup(await x1.inputValue());
	await x1.fill(String(Math.round(fitted) === 1234 ? 1235 : 1234));
	await x1.press('Tab');
	await expect(record.getByText('Parameters edited since fit')).toBeVisible();
	await expect(record.getByText(/^Parameters edited since the fit: Production store capacity X1\./)).toBeVisible();

	await saveSettings(page);
	await page.reload();
	await expect(page.getByRole('region', { name: /^Fit record of these parameters/ }).getByText('Parameters edited since fit')).toBeVisible();

	const tunedRun = await createRun(page.request, project.id, 'Hand-tuned');
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByRole('heading', { level: 2, name: 'Hand-tuned' })).toBeVisible();
	const prov = page.getByRole('region', { name: /^Where the parameters came from/ });
	await expect(prov.getByText('Parameters edited since fit')).toBeVisible();
	// Hand-edited parameters: the run's scores are no longer in-sample (issue #45).
	await expect(
		page.getByRole('region', { name: 'Calibration against observed flow' }).getByText('Calibration period (parameters edited since the fit).', { exact: true })
	).toBeVisible();

	await page.goto(`/compare?a=${project.id}:${fittedRun}&b=${project.id}:${tunedRun}`);
	await expect(
		page.getByRole('table', { name: 'Calibration statistics for both runs, calibration period (run A in-sample, run B parameters edited since the fit)' })
	).toBeVisible();
	await expect(page.getByText('Fit record: parameters edited since the fit (x1)')).toBeVisible();
	const fits = page.getByRole('table', { name: 'Fit and validation for both runs' });
	await expect(fits.getByRole('row', { name: /^Parameters edited since fit/ })).toHaveText(/no\s*yes \(x1\)$/);
	await expect(fits.getByRole('row', { name: /^Split-sample: other half/ })).toContainText('not run');
});

test('a calibration exclusion needs a reason, and shows in What changed and on the run', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Exclusions');
	const before = await createRun(page.request, project.id, 'Before');
	await page.goto(`/projects/${project.id}?tab=settings`);

	const excl = page.getByRole('group', { name: /^Calibration exclusions/ });
	await expect(excl.getByText('None: every observed day in the calibration window is scored.')).toBeVisible();
	await excl.getByRole('button', { name: 'Exclude a water year' }).click();
	// No reason yet: saving is blocked.
	await expect(excl.getByRole('alert')).toHaveText('Exclusion 1: needs a reason.');
	await expect(saveChanges(page)).toBeDisabled();
	await excl.getByLabel(/^Water year/).fill('2021');
	await excl.getByLabel(/^Water year/).press('Tab');
	await expect(excl.getByText('WY 2021/22: 2021-10-01 – 2022-09-30')).toBeVisible();
	await excl.getByLabel('Reason').fill('Rain gauge moved');
	await expect(excl.getByRole('alert')).toHaveCount(0);
	await saveSettings(page);
	await page.reload();
	await expect(page.getByRole('group', { name: /^Calibration exclusions/ }).getByLabel('Reason')).toHaveValue('Rain gauge moved');

	const after = await createRun(page.request, project.id, 'After');
	await page.goto(`/compare?a=${project.id}:${before}&b=${project.id}:${after}`);
	await expect(whatChanged(page).getByText('Calibration exclusion WY 2021/22 added: “Rain gauge moved”')).toBeVisible();

	await page.goto(`/projects/${project.id}?tab=runs&run=${after}`);
	await expect(page.getByRole('heading', { level: 2, name: 'After' })).toBeVisible();
	// The whole 120-day record falls in the excluded water year.
	await expect(page.getByRole('region', { name: 'Calibration against observed flow' })).toContainText(
		'Every observed day inside the calibration window falls in a calibration exclusion (2021-10-01 – 2022-09-30: Rain gauge moved)'
	);
	await expect(page.getByRole('region', { name: /^Where the parameters came from/ })).toContainText(
		'This run’s calibration statistics leave out WY 2021/22 (Rain gauge moved).'
	);
});
