// How the EWR is split between the units (issue #615; docs/ui.md § Model settings, docs/model.md §2.5b): one way only,
// by each unit's natural MAR, under both flow generation methods, so there is no choice to make. On the sample model
// (synthetic): Model settings → Model selection for flow generation says so under both methods, shows the Per unit
// setup the shares come from under Fragmentation, and names the units that have no rain of their own (their share
// follows their area); Run readiness names them too; a patch with the retired ewrSplit saves without it.
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openSettings, saveSettings } from '../support/settings.ts';

test('the EWR is split by each unit’s natural MAR under both methods, and the units on the catchment rain are named', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'EWR split');
	// An older web build may still send the retired choice: the patch saves, the key dropped.
	await updateSettings(page.request, project.id, { ewrSplit: 'naturalMar' });
	await openSettings(page, project.id);
	const share = page.locator('#set-share');
	// No choice left to make.
	await expect(share.getByRole('combobox', { name: /Split the EWR/ })).toHaveCount(0);
	const hint = share.getByTestId('ewr-split-hint');
	await expect(hint).toHaveText(
		'The EWR is split between the units by each unit’s natural MAR: its own GR4J runoff over the run’s complete water years ÷ the units’ total, from the runs on each unit’s own rain above. The run’s summary lists each unit’s share.'
	);
	// Under Fragmentation the Per unit setup is on show, for the shares only.
	await expect(share.getByTestId('flowgen-share-setup')).toBeVisible();
	await expect(share.getByTestId('unit-rain-settings')).toBeVisible();
	// The sample model's units have no rain of their own: they run on the catchment rain, so their share follows their area.
	const rule4 = share.getByTestId('ewr-split-catchment-rain');
	await expect(rule4).toContainText('no rain of');
	await expect(rule4).toContainText('share follows');
	await expect(share.getByTestId('summary-share')).toContainText('EWR by each unit’s natural MAR');
	await expectNoViolations(page, { include: '#set-share' });

	// Per unit says the same of the EWR, from the units' own runoff.
	await share.getByRole('group', { name: /^How natural flow is made/ }).getByRole('radio', { name: 'Per unit' }).check();
	await expect(hint).toHaveText('The EWR is split between the units by each unit’s natural MAR: its own GR4J runoff over the run’s complete water years ÷ the units’ total. The run’s summary lists each unit’s share.');
	await expect(share.getByTestId('flowgen-share-setup')).toHaveCount(0);
	await saveSettings(page);
	// Nothing stores the retired key.
	const stored = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()) as { project: { settings: Record<string, unknown> } };
	expect('ewrSplit' in stored.project.settings).toBe(false);

	// Run readiness names the same units.
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByTestId('run-catchment-rain')).toContainText('share follows');
});
