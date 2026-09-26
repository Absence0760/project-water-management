// The runoff model choice (issue #4 phase 3): GR4J is the default, legacy the
// b023 model still selectable in Settings. Run GR4J, read the runoff water
// balance, and compare it with the legacy run of the same catchment.
import { copyProject, createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { whatChanged } from '../support/compare.ts';

test('GR4J is the default; its parameters save, and a run reports the runoff balance', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'GR4J settings');
	await page.goto(`/projects/${project.id}?tab=settings`);

	const model = page.getByLabel('Runoff model', { exact: true });
	await expect(model).toHaveValue('gr4j');
	// Legacy shows its own parameters and none of GR4J's.
	await model.selectOption('legacy');
	await expect(page.getByLabel(/^Peak-flow coefficient a/)).toBeVisible();
	await expect(page.getByLabel(/^Production store capacity X1/)).toHaveCount(0);

	await model.selectOption('gr4j');
	await expect(page.getByLabel(/^Peak-flow coefficient a/)).toHaveCount(0);
	const x1 = page.getByLabel(/^Production store capacity X1/);
	await expect(x1).toHaveValue('350');
	await expect(page.getByLabel(/^Routing store capacity X3/)).toHaveValue('90');
	await expect(page.getByLabel(/^Unit hydrograph time base X4/)).toHaveValue('1.7');
	await expect(page.getByLabel('Pan coefficient, Oct')).toHaveValue('0.7');
	// X2 stays fixed at 0 until opted into.
	await expect(page.getByLabel(/^Groundwater exchange X2/)).toHaveCount(0);
	await page.getByLabel('Let the catchment gain or lose groundwater').check();
	await expect(page.getByLabel(/^Groundwater exchange X2/)).toHaveValue('0');
	await page.getByLabel('Let the catchment gain or lose groundwater').uncheck();

	await x1.fill('420');
	await page.getByLabel('Pan coefficient, Jan').fill('0.8');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

	await page.reload();
	await expect(model).toHaveValue('gr4j');
	await expect(x1).toHaveValue('420');
	await expect(page.getByLabel('Pan coefficient, Jan')).toHaveValue('0.8');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('GR4J');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'GR4J' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Runoff model' })).toBeVisible();
	const runoff = page.getByRole('region', { name: /^Runoff model: GR4J/ });
	await expect(runoff.getByText('X1 420 mm · X3 90 mm · X4 1.7 days')).toBeVisible();
	const balance = runoff.getByRole('table', { name: 'Where the rain went over the run' });
	for (const row of ['Rain', 'Actual evaporation', 'Natural flow', 'Change in storage']) {
		await expect(balance.getByRole('rowheader', { name: row, exact: true })).toBeVisible();
	}
	// Closed catchment: no exchange row.
	await expect(balance.getByRole('rowheader', { name: /Groundwater exchange/ })).toHaveCount(0);
	await expect(runoff.getByRole('img', { name: /^Model stores/ }).locator('canvas')).toBeVisible();
});

test('a legacy run has no runoff model panel', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Legacy runoff');
	await updateSettings(page.request, project.id, { runoffModel: 'legacy' });
	await createRun(page.request, project.id, 'Legacy');
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByRole('heading', { level: 2, name: 'Legacy' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Calibration' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Result sections' }).getByRole('link', { name: 'Runoff model' })).toHaveCount(0);
});

test('run comparison shows legacy against GR4J on a copy of the project', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Legacy baseline');
	await updateSettings(page.request, project.id, { runoffModel: 'legacy' });
	const legacyRun = await createRun(page.request, project.id, 'Legacy');
	const copy = await copyProject(page.request, project.id, 'GR4J copy');
	await updateSettings(page.request, copy, { runoffModel: 'gr4j', gr4j: { x1: 300, x2: 0, x3: 60, x4: 1.5, warmupDays: 365 } });
	const gr4jRun = await createRun(page.request, copy, 'GR4J');

	await page.goto(`/compare?a=${project.id}:${legacyRun}&b=${copy}:${gr4jRun}`);
	await expect(page.getByRole('heading', { name: 'Headline results' })).toBeVisible();
	await expect(whatChanged(page).getByText('Runoff model: legacy (b023 recession) → GR4J')).toBeVisible();
	await expect(whatChanged(page).getByText('GR4J production store X1: 350 mm → 300 mm')).toBeVisible();
	await expect(page.getByRole('rowheader', { name: 'Runoff coefficient (flow ÷ rain)' })).toBeVisible();
	await expect(page.getByRole('rowheader', { name: 'Kling–Gupta (KGE)' })).toBeVisible();
	// Neither run's parameters were fitted, so neither side is called in-sample (issue #45).
	await expect(page.getByRole('table', { name: 'Calibration statistics for both runs, calibration period (parameters not fitted)' })).toBeVisible();

	// The EWR test against the observed record, legacy and GR4J side by side (issue #4).
	const ewr = page.getByRole('region', { name: 'EWR test against observed flow' });
	await expect(ewr.getByRole('rowheader', { name: 'Frequency bias (1 ideal)' })).toBeVisible();
	await expect(ewr.getByRole('row', { name: /^Observed days compared/ }).getByRole('cell').nth(1)).toHaveText('120');
	for (const side of ['A: Legacy', 'B: GR4J']) {
		const table = ewr.getByRole('region', { name: side });
		await expect(table.getByRole('table', { name: 'Observed days by EWR result, model against observed' })).toBeVisible();
		await expect(table.getByRole('table', { name: `${side}: by month` }).getByRole('rowheader')).toHaveCount(12);
	}
});

test('GR4J without A-pan evaporation: Settings warns, and a run is refused with the reason', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'No A-pan');
	await updateSettings(page.request, project.id, { apanMm: new Array(12).fill(0) });
	await page.goto(`/projects/${project.id}?tab=settings`);
	await expect(page.getByLabel('Runoff model', { exact: true })).toHaveValue('gr4j');
	await expect(page.getByRole('status').filter({ hasText: /GR4J needs A-pan evaporation/ })).toBeVisible();

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('No evaporation');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('alert')).toContainText('GR4J needs potential evaporation');

	// Positive control: with A-pan the warning goes and the run goes through.
	await updateSettings(page.request, project.id, { apanMm: new Array(12).fill(150) });
	await page.goto(`/projects/${project.id}?tab=settings`);
	await expect(page.getByLabel('Runoff model', { exact: true })).toHaveValue('gr4j');
	await expect(page.getByRole('status').filter({ hasText: /GR4J needs A-pan evaporation/ })).toHaveCount(0);
	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('With evaporation');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'With evaporation' })).toBeVisible();
});
