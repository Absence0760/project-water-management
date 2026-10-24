// Low-flow periods (issue #557, docs/model.md §2.10h, ui.md § Settings): a
// date range in which only a record's low flows are valid. Added under the
// calibration exclusions; inside it a reading above the threshold is left
// out, the run's quality strip shows those days, and comparing runs lists the
// period. Synthetic records only.
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { whatChanged } from '../support/compare.ts';
import { expect, test } from '../support/fixtures.ts';
import { anySaveBar, saveChanges, saveSettings } from '../support/settings.ts';

test('a low-flow period needs a reason and a source, leaves its high readings out and shows them on the hydrograph', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Low flows only');
	const before = await createRun(page.request, project.id, 'Before');
	await page.goto(`/projects/${project.id}?tab=settings`);

	const group = page.getByRole('group', { name: /^Low flows only/ });
	await expect(group.getByText('None: every reading in the calibration window is scored at any flow.')).toBeVisible();
	// Adding a row and removing it again leaves nothing to save.
	await group.getByRole('button', { name: 'Use only low flows in a date range' }).click();
	await group.getByRole('button', { name: 'Remove low-flow period 1' }).click();
	await expect(anySaveBar(page)).toHaveCount(0);
	await group.getByRole('button', { name: 'Use only low flows in a date range' }).click();
	// No reason yet: saving is blocked.
	await expect(group.getByRole('alert')).toHaveText('Low-flow period 1: needs a reason.');
	await expect(saveChanges(page)).toBeDisabled();
	await expect(group.getByLabel('Record')).toHaveValue('flow_observed_m3s');
	await group.getByLabel('From', { exact: true }).fill('2021-10-01');
	await group.getByLabel('From', { exact: true }).press('Tab');
	await group.getByLabel('To', { exact: true }).fill('2021-12-31');
	await group.getByLabel('To', { exact: true }).press('Tab');
	await group.getByLabel(/^Valid up to/).fill('0.3');
	await group.getByLabel(/^Valid up to/).press('Tab');
	await group.getByLabel('Reason').fill('Logger over-reads floods');
	await expect(group.getByRole('alert')).toHaveText('Low-flow period 1: needs a source.');
	await group.getByLabel('Source').fill('Client site visit');
	await expect(group.getByRole('alert')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="low-flow-periods"]' });
	await saveSettings(page);
	await page.reload();
	await expect(page.getByRole('group', { name: /^Low flows only/ }).getByLabel('Reason')).toHaveValue('Logger over-reads floods');
	await expect(page.getByTestId('summary-record')).toContainText('low flows only in 1 period');

	// The synthetic record peaks at 0.35 m³/s every 9th day: 11 of those peaks fall in Oct–Dec 2021.
	const after = await createRun(page.request, project.id, 'After');
	await page.goto(`/projects/${project.id}?tab=runs&run=${after}`);
	const hydro = page.locator('#res-hydrograph figure').first();
	await expect(hydro).toHaveAttribute('data-ready', 'true');
	await expect(hydro).toHaveAttribute('data-lanes', '1');
	await expect(hydro.locator('.lane-key').getByRole('listitem')).toHaveText(['Above a low-flow period’s threshold: 11 days; left out of Fit automatically and the run’s statistics']);

	await page.goto(`/compare?a=${project.id}:${before}&b=${project.id}:${after}`);
	await expect(whatChanged(page).getByText('Low flows only: added gauge record 2021-10-01 – 2021-12-31 at or below 0.3 m³/s')).toBeVisible();
});
