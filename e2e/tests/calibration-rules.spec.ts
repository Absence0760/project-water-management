// Automated calibration under pre-declared rules (issue #153): the rules are
// saved before any fit is seen, the run uses only the saved rules, and the
// fit it keeps is applied and saved with how the rules chose it.
import { addMember, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('the saved rules pick the fit: a rule change needs saving first, and the kept fit is stored with its rules', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Calibration rules');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=settings`);

	const rules = page.getByTestId('calibration-rules');
	await expect(rules.getByTestId('rules-status')).toContainText('Revision 1 · draft, not signed off by the hydrologist');
	await expect(rules.getByTestId('rules-fits')).toContainText('2 fits, each with the split-sample and dry → wet tests (at most 8).');

	const auto = page.getByRole('region', { name: /^Automated calibration/ });
	await expect(auto.getByText('These rules are drafts until the hydrologist signs them off')).toBeVisible();
	// The search is part of the rules, not chosen at run time: a smaller one is a rule change, saved first.
	await expect(auto.getByLabel('Model runs per fit')).toHaveCount(0);
	await rules.getByLabel('Model runs per fit').fill('50');
	await rules.getByLabel('Starts per fit').fill('1');
	await expect(auto.getByTestId('auto-rules-unsaved')).toBeVisible();
	await expect(auto.getByRole('button', { name: 'Run the calibration rules' })).toBeDisabled();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await expect(rules.getByTestId('rules-status')).toContainText('Revision 2');
	await expect(auto.getByTestId('auto-rules')).toContainText('seed 1, 1 start per fit, 50 model runs per optimisation');
	await auto.getByRole('button', { name: 'Run the calibration rules' }).click();

	// 120 days of record: no dry → wet test, so the default rules keep nothing, and say why for each fit.
	const fits = auto.getByRole('table', { name: 'Fits the rules tried' });
	await expect(fits.getByRole('row')).toHaveCount(3);
	await expect(fits.getByRole('cell', { name: 'Not kept', exact: true })).toHaveCount(2);
	await expect(fits.getByText(/the record doesn’t allow the dry → wet test/).first()).toBeVisible();
	await expect(auto.getByText(/No fit passed the rules, so none is kept/)).toBeVisible();
	await expect(auto.getByRole('button', { name: 'Apply the kept fit to form' })).toHaveCount(0);

	// Select by the split-sample test instead: the run waits until the change is saved.
	await rules.getByLabel('on the held-out test').selectOption({ label: 'split-sample test (other half)' });
	await expect(auto.getByTestId('auto-rules-unsaved')).toBeVisible();
	await expect(auto.getByRole('button', { name: 'Run the calibration rules' })).toBeDisabled();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	await expect(rules.getByTestId('rules-status')).toContainText('Revision 3');
	await expect(auto.getByTestId('auto-rules')).toContainText('Revision 3');

	await auto.getByRole('button', { name: 'Run the calibration rules' }).click();
	await expect(fits.getByRole('cell', { name: 'Kept', exact: true })).toHaveCount(1);
	// An unsaved rule edit after the run holds Apply back too.
	await rules.getByLabel('Seed').fill('2');
	await expect(auto.getByRole('button', { name: 'Apply the kept fit to form' })).toBeDisabled();
	await rules.getByLabel('Seed').fill('1');
	await auto.getByRole('button', { name: 'Apply the kept fit to form' }).click();
	await expect(page.getByText('Unsaved settings')).toBeVisible();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

	await page.reload();
	const prov = page.getByRole('region', { name: /^Fit record of these parameters/ });
	await expect(prov.getByTestId('fit-auto-badge')).toHaveText('Automated');
	await expect(prov.getByTestId('fit-auto')).toContainText('calibration rules revision 3 (draft, not signed off): kept');
	await expect(prov.getByText(/Automated calibration picked this fit under draft rules/)).toBeVisible();
});

test('a sign-off is recorded with the rules, and a viewer can read the rules but not change them', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Calibration rules sign-off');
	await updateSettings(page.request, project.id, { runoffModel: 'gr4j' });
	await page.goto(`/projects/${project.id}?tab=settings`);
	const rules = page.getByTestId('calibration-rules');
	await rules.getByLabel('Signed off by').fill('A. Hydrologist');
	await rules.getByLabel('On', { exact: true }).fill('2026-09-29');
	await rules.getByRole('button', { name: 'Record the sign-off' }).click();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
	// Signing off changes no rule: the revision stays.
	await expect(rules.getByTestId('rules-status')).toHaveText(/Signed off\s*Revision 1 · signed off by A. Hydrologist on 2026-09-29/);

	const viewer = await signIn('Rules viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=settings`);
	const seen = viewer.page.getByTestId('calibration-rules');
	await expect(seen.getByTestId('rules-status')).toContainText('signed off by A. Hydrologist');
	await expect(seen.getByLabel('on the held-out test')).toBeDisabled();
	await expect(seen.getByTestId('rules-sign-off')).toHaveCount(0);
});
