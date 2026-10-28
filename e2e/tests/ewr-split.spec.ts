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
	// An older web build may still send the retired choices (the EWR split, #615; the flow-share method and Hi/Lo split,
	// #616): the patch saves, the keys dropped.
	await updateSettings(page.request, project.id, { ewrSplit: 'naturalMar', flowShareMethod: 'manual', hiLoSplit: { hi: 0.7, lo: 0.3 } });
	await openSettings(page, project.id);
	const share = page.locator('#set-share');
	// No choice left to make.
	await expect(share.getByRole('combobox', { name: /Split the EWR/ })).toHaveCount(0);
	const hint = share.getByTestId('ewr-split-hint');
	await expect(hint).toHaveText(
		'Each unit’s share is its natural MAR: its own GR4J runoff over the run’s complete water years ÷ the units’ total, from the runs on each unit’s own rain above. It splits the EWR, the land cover’s low-flow threshold and the priority users’ demand between the units. The run’s summary lists each unit’s share, and the hydrological unit table’s In use column the latest run’s.'
	);
	// Under Fragmentation the Per unit setup is on show, for the shares only.
	await expect(share.getByTestId('flowgen-share-setup')).toBeVisible();
	await expect(share.getByTestId('unit-rain-settings')).toBeVisible();
	// The sample model's units have no rain of their own: they run on the catchment rain, so their share follows their area.
	const rule4 = share.getByTestId('ewr-split-catchment-rain');
	await expect(rule4).toContainText('no rain of');
	await expect(rule4).toContainText('share follows');
	await expect(share.getByTestId('summary-share')).toContainText('flow and EWR by each unit’s natural MAR');
	await expectNoViolations(page, { include: '#set-share' });

	// Per unit says the same of the share, from the units' own runoff.
	await share.getByRole('group', { name: /^How natural flow is made/ }).getByRole('radio', { name: 'Per unit' }).check();
	await expect(hint).toHaveText(
		'Each unit’s share is its natural MAR: its own GR4J runoff over the run’s complete water years ÷ the units’ total. It splits the EWR, the land cover’s low-flow threshold and the priority users’ demand between the units. The run’s summary lists each unit’s share, and the hydrological unit table’s In use column the latest run’s.'
	);
	await expect(share.getByTestId('flowgen-share-setup')).toHaveCount(0);
	await saveSettings(page);
	// Nothing stores the retired keys.
	const stored = (await (await page.request.get(`${API_URL}/projects/${project.id}`)).json()) as { project: { settings: Record<string, unknown> } };
	for (const k of ['ewrSplit', 'flowShareMethod', 'hiLoSplit']) expect(k in stored.project.settings, k).toBe(false);

	// Run readiness names the same units.
	await page.goto(`/projects/${project.id}?tab=runs`);
	await expect(page.getByTestId('run-catchment-rain')).toContainText('share follows');
});
