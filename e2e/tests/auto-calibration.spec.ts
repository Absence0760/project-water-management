// Automatic calibration in the browser (issue #4 phase 5): fit GR4J to the
// observed record in a Web Worker, read the fit and its validation, apply the
// result to the form and save it. A fit never saves anything by itself.
import { addMember, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('fitting GR4J fills the form, and only Save stores it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Auto-calibration');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=settings`);

	const fit = page.getByRole('region', { name: /^Fit automatically/ });
	await expect(fit.getByLabel('Objective')).toHaveValue('kgePrime');
	await fit.getByLabel('Model runs per fit').fill('60');
	await expect(fit.getByText('180 runs in all.')).toBeVisible();
	await fit.getByRole('button', { name: 'Fit automatically', exact: true }).click();

	const scores = fit.getByRole('table', { name: /^Fit, and validation/ });
	await expect(scores).toBeVisible();
	for (const col of ['Current parameters', 'Fitted', 'Split: fitted half', 'Split: other half']) {
		await expect(scores.getByRole('columnheader', { name: new RegExp(`^${col}`) })).toBeVisible();
	}
	await expect(scores.getByRole('rowheader', { name: /^KGE′/ })).toBeVisible();
	// 120 days of record: no water years to test wet-year behaviour on, and the page says so.
	await expect(fit.getByText(/too few to fit on dry years and test on wet ones/)).toBeVisible();

	const params = fit.getByRole('table', { name: 'Parameters', exact: true });
	const fitted = await params.getByRole('row', { name: /^Production store capacity X1/ }).getByRole('cell').nth(1).textContent();
	await fit.getByRole('button', { name: 'Apply to form' }).click();
	const x1 = page.getByLabel(/^Production store capacity X1/);
	await expect(x1).not.toHaveValue('350');
	expect(Number((await x1.inputValue()).replace(/,/g, ''))).toBeCloseTo(Number(fitted!.replace(/,/g, '')), -1);
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
