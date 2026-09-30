// Automated calibration under pre-declared rules, run by the server (issue
// #153): the rules are saved before any fit is seen, the server fits them one
// background job per fit (run here by the job tick), and applying the kept
// fit is the server's too, saved with a record of how the rules chose it.
import { addMember, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';

test('the saved rules pick the fit on the server: a rule change needs saving first, and the kept fit is applied with its rules', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Calibration rules');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=settings`);

	const rules = page.getByTestId('calibration-rules');
	await expect(rules.getByTestId('rules-status')).toContainText('Revision 1 · draft, not signed off by the hydrologist');
	await expect(rules.getByTestId('rules-fits')).toContainText('2 fits, each with the split-sample and dry → wet tests (at most 8).');

	const auto = page.getByRole('region', { name: /^Automated calibration/ });
	await expect(auto.getByText('These rules are drafts until the hydrologist signs them off')).toBeVisible();
	// The search is part of the rules: a smaller one is a rule change, saved first.
	await rules.getByLabel('Model runs per fit').fill('50');
	await rules.getByLabel('Starts per fit').fill('1');
	await rules.getByLabel('After a kept fit is applied, run the model and the uncertainty ensemble around it').uncheck();
	await expect(auto.getByTestId('auto-rules-unsaved')).toBeVisible();
	await expect(auto.getByRole('button', { name: 'Run the calibration rules' })).toBeDisabled();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await expect(rules.getByTestId('rules-status')).toContainText('Revision 2');
	await expect(auto.getByTestId('auto-rules')).toContainText('seed 1, 1 start per fit, 50 model runs per optimisation');

	await auto.getByRole('button', { name: 'Run the calibration rules' }).click();
	await expect(auto.getByRole('status').filter({ hasText: /^Fitting 1 of 2 on the server/ })).toBeVisible();
	await runJobsTick({ projects: [project.id], schedule: false });

	// 120 days of record: no dry → wet test, so the default rules keep nothing, and say why for each fit.
	const fits = auto.getByRole('table', { name: 'Fits the rules tried' });
	await expect(fits.getByRole('row')).toHaveCount(3);
	await expect(fits.getByRole('cell', { name: 'Not kept', exact: true })).toHaveCount(2);
	await expect(fits.getByText(/the record doesn’t allow the dry → wet test/).first()).toBeVisible();
	await expect(auto.getByText(/No fit passed the rules, so none is kept/)).toBeVisible();
	await expect(auto.getByRole('button', { name: 'Apply and save the kept fit' })).toHaveCount(0);

	// Keep by the split-sample test instead: saved first, then run again.
	await rules.getByLabel('on the held-out test').selectOption({ label: 'split-sample test (other half)' });
	await expect(auto.getByRole('button', { name: 'Run the calibration rules' })).toBeDisabled();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await expect(auto.getByTestId('auto-rules')).toContainText('Revision 3');
	await auto.getByRole('button', { name: 'Run the calibration rules' }).click();
	await expect(auto.getByRole('status').filter({ hasText: /^Fitting 1 of 2 on the server/ })).toBeVisible();
	await runJobsTick({ projects: [project.id], schedule: false });
	await expect(fits.getByRole('cell', { name: 'Kept', exact: true })).toHaveCount(1);

	// An unsaved edit holds Apply back (applying saves at once).
	const applyButton = auto.getByRole('button', { name: 'Apply and save the kept fit' });
	await rules.getByLabel('Seed').fill('2');
	await expect(applyButton).toBeDisabled();
	await expect(auto.getByTestId('auto-apply-hint')).toHaveText('Save the calibration rules first.');
	await rules.getByLabel('Seed').fill('1');
	await expect(applyButton).toBeEnabled();
	await applyButton.click();
	await expect(auto.getByTestId('auto-applied')).toContainText(', with a run');
	// Saved by the server: nothing unsaved in the form.
	await expect(page.getByText('Unsaved settings')).toBeHidden();

	await page.reload();
	const prov = page.getByRole('region', { name: /^Fit record of these parameters/ });
	await expect(prov.getByTestId('fit-auto-badge')).toHaveText('Automated');
	await expect(prov.getByTestId('fit-auto')).toContainText('calibration rules revision 3 (draft, not signed off): kept');
	await expect(prov.getByText(/Automated calibration picked this fit under draft rules/)).toBeVisible();
});

test('a sign-off is a typed signature the server dates, and a viewer can read the rules but not change them', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Calibration rules sign-off');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=settings`);
	const rules = page.getByTestId('calibration-rules');
	const sign = rules.getByRole('button', { name: 'Sign off these rules' });
	await expect(sign).toBeDisabled();
	await rules.getByLabel('Your name, as a signature').fill('A. Hydrologist');
	await sign.click();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	// Signing off changes no rule: the revision stays; the date is the server's.
	const today = new Date().toISOString().slice(0, 10);
	await expect(rules.getByTestId('rules-status')).toHaveText(new RegExp(`Signed off\\s*Revision 1 · signed off by A\\. Hydrologist on ${today}`));

	const viewer = await signIn('Rules viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=settings`);
	const seen = viewer.page.getByTestId('calibration-rules');
	await expect(seen.getByTestId('rules-status')).toContainText('signed off by A. Hydrologist');
	await expect(seen.getByLabel('on the held-out test')).toBeDisabled();
	await expect(seen.getByTestId('rules-sign-off')).toHaveCount(0);
	await expect(viewer.page.getByRole('region', { name: /^Automated calibration/ }).getByRole('button', { name: 'Run the calibration rules' })).toHaveCount(0);
});
