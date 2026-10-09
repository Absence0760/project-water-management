// The runoff model (issue #16): GR4J is the only one since engine 1.0.0
// removed the legacy b023 model, so Settings has no model to pick and a new run
// is GR4J. A run of the legacy model stored before then still opens, read-only
// and badged "Workbook comparison": it can't be nominated, published or signed
// off, and compares against a GR4J run. The API can't make such a run any more,
// so those tests plant one in the database (support/db.ts plantLegacyRun).
import type { Page } from '@playwright/test';
import { createRun, seedRunnableProject, updateSettings } from '../support/api.ts';
import { plantLegacyRun } from '../support/db.ts';
import { expect, test } from '../support/fixtures.ts';
import { saveSettings } from '../support/settings.ts';
import { whatChanged } from '../support/compare.ts';

const sections = (page: Page) => page.getByRole('navigation', { name: 'Result sections' });

test('GR4J is the only runoff model: no picker, its parameters save, and a run reports the runoff balance', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'GR4J settings');
	await page.goto(`/projects/${project.id}?tab=settings`);

	const flow = page.getByRole('region', { name: 'Flow calibration', exact: true });
	await expect(flow.getByTestId('runoff-model')).toHaveText('GR4J (Perrin et al. 2003)');
	await expect(flow).toContainText('The legacy b023 workbook model was removed in engine 1.0.0');
	// Nothing to choose, and none of the legacy model's parameters.
	await expect(page.getByLabel('Runoff model', { exact: true })).toHaveCount(0);
	await expect(page.getByLabel(/^Peak-flow coefficient a/)).toHaveCount(0);
	await expect(page.getByRole('group', { name: /^Summer months/ })).toHaveCount(0);
	await expect(page.getByText('Advanced: winter switch, recession and base flow')).toHaveCount(0);

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
	await saveSettings(page);

	await page.reload();
	await expect(x1).toHaveValue('420');
	await expect(page.getByLabel('Pan coefficient, Jan')).toHaveValue('0.8');

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('GR4J');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'GR4J' })).toBeVisible();
	// A new run is GR4J: no legacy badge anywhere.
	await expect(page.getByText('Workbook comparison', { exact: true })).toHaveCount(0);
	await expect(sections(page).getByRole('link', { name: 'Runoff model' })).toBeVisible();
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

test('an old legacy run opens read-only with a clear badge, and can’t be nominated, published or signed off', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Legacy runoff');
	const legacy = await createRun(page.request, project.id, 'Old legacy');
	await plantLegacyRun(legacy);

	await page.goto(`/projects/${project.id}?tab=runs&run=${legacy}`);
	await expect(page.getByRole('heading', { level: 2, name: 'Old legacy' })).toBeVisible();
	// Badged in the list and the header.
	const row = page.getByRole('region', { name: 'Runs', exact: true }).getByRole('listitem').filter({ has: page.getByRole('button', { name: /^Old legacy/ }) });
	await expect(row.getByText('Workbook comparison', { exact: true })).toBeVisible();
	await expect(row.getByText('Workbook comparison', { exact: true })).toHaveAttribute('title', /removed in engine 1\.0\.0.*can’t be re-run/);
	await expect(page.locator('.badge').filter({ hasText: 'Workbook comparison' })).toBeVisible();
	// No stores to show; the calibration still reads.
	await expect(sections(page).getByRole('link', { name: 'Calibration' })).toBeVisible();
	await expect(sections(page).getByRole('link', { name: 'Runoff model' })).toHaveCount(0);

	// It can't be nominated as evidence, nor published.
	const evidence = page.getByRole('region', { name: 'Evidence', exact: true });
	await expect(evidence.getByText('A run of the legacy runoff model (removed in engine 1.0.0) is workbook comparison only, so it can’t be nominated as evidence.')).toBeVisible();
	await expect(evidence.getByRole('button', { name: /^Nominate/ })).toHaveCount(0);
	const publication = page.getByRole('region', { name: /^Publication/ });
	await expect(publication).toContainText('so it can’t be published. Engine 1.0.0 removed that model: run the project again (a new run uses GR4J) and publish that run.');
	await expect(publication.getByRole('button', { name: 'Publish this run' })).toHaveCount(0);

	// Its report says what it is and offers no sign-off.
	await page.goto(`/projects/${project.id}/report?run=${legacy}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(page.getByText(/^Legacy runoff model \(b023 workbook, removed in engine 1\.0\.0\): it does not conserve water/).first()).toBeVisible();
	const signoff = page.locator('#rep-signoff');
	await expect(signoff).toContainText(/cannot be signed off/);
	await expect(signoff.getByRole('button', { name: 'Sign off this run…' })).toHaveCount(0);

	// Positive control: the project's next run is GR4J, unbadged, and can be nominated and signed.
	const fresh = await createRun(page.request, project.id, 'Fresh GR4J');
	await page.goto(`/projects/${project.id}/report?run=${fresh}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	await expect(page.locator('#rep-signoff').getByRole('button', { name: 'Sign off this run…' })).toBeVisible();
	await page.goto(`/projects/${project.id}?tab=runs&run=${fresh}`);
	await expect(page.getByRole('heading', { level: 2, name: 'Fresh GR4J' })).toBeVisible();
	await expect(page.locator('.badge').filter({ hasText: 'Workbook comparison' })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Evidence', exact: true }).getByRole('button', { name: 'Nominate as evidence' })).toBeVisible();
});

test('run comparison shows an old legacy run against a GR4J run', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Legacy baseline');
	const legacyRun = await createRun(page.request, project.id, 'Legacy');
	await plantLegacyRun(legacyRun);
	await updateSettings(page.request, project.id, { gr4j: { x1: 300, x2: 0, x3: 60, x4: 1.5, warmupDays: 365 } });
	const gr4jRun = await createRun(page.request, project.id, 'GR4J');

	await page.goto(`/compare?a=${project.id}:${legacyRun}&b=${project.id}:${gr4jRun}`);
	await expect(page.getByRole('heading', { name: 'Headline results' })).toBeVisible();
	await expect(whatChanged(page).getByText('Runoff model: legacy (b023 recession) → GR4J')).toBeVisible();
	await expect(whatChanged(page).getByText('GR4J production store X1: 350 mm → 300 mm')).toBeVisible();
	await expect(page.getByRole('status').filter({ hasText: /^Run A uses the legacy runoff model \(b023 workbook, removed in engine 1\.0\.0\)/ })).toBeVisible();
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
	await expect(page.getByTestId('runoff-model')).toHaveText('GR4J (Perrin et al. 2003)');
	await expect(page.getByRole('status').filter({ hasText: /GR4J needs A-pan evaporation/ })).toBeVisible();

	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('No evaporation');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('alert')).toContainText('GR4J needs potential evaporation');

	// Positive control: with A-pan the warning goes and the run goes through.
	await updateSettings(page.request, project.id, { apanMm: new Array(12).fill(150) });
	await page.goto(`/projects/${project.id}?tab=settings`);
	await expect(page.getByTestId('runoff-model')).toHaveText('GR4J (Perrin et al. 2003)');
	await expect(page.getByRole('status').filter({ hasText: /GR4J needs A-pan evaporation/ })).toHaveCount(0);
	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByLabel(/^Run label/).fill('With evaporation');
	await page.getByRole('button', { name: 'Run model' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'With evaporation' })).toBeVisible();
});
