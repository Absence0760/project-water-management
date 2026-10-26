// Settings → Flow generation → Split the EWR between units by (settings.ewrSplit, issue #553 round 4;
// docs/ui.md § Model settings, docs/model.md §2.5b). On the sample model (synthetic):
// the flow share by default; the state line says the choice only matters under Per unit, and
// follows the method; choosing each unit's natural MAR saves, joins the panel's summary
// and changes the Flow share line, and a reload keeps it.
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openSettings, saveSettings } from '../support/settings.ts';

test('the EWR split: the flow share by default, each unit’s natural MAR when chosen, and a line saying when it matters', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'EWR split');
	await openSettings(page, project.id);
	const share = page.locator('#set-share');
	const field = share.getByTestId('ewr-split');
	const select = field.getByRole('combobox', { name: 'Split the EWR between units by' });
	const state = field.getByTestId('ewr-split-state');
	await expect(select).toHaveValue('flowShare');
	await expect(field).toHaveAttribute('data-unit-rain', 'off');
	await expect(state).toHaveText('Fragmentation: GR4J runs once on the catchment rain, so both give the flow share. The choice matters only under Per unit.');

	// Per unit (unsaved is enough: the line reads the form).
	await share.getByRole('group', { name: /^How natural flow is made/ }).getByRole('radio', { name: 'Per unit' }).check();
	await expect(field).toHaveAttribute('data-unit-rain', 'on');
	await expect(state).toHaveText('Per unit: the flow share splits the EWR, though each unit makes its own runoff.');
	await select.selectOption('naturalMar');
	await expect(state).toHaveText('Per unit: each unit’s EWR share is its own GR4J runoff’s share, not its flow share.');
	await expect(share.getByTestId('share-hint')).toContainText('the EWR is split by each unit’s natural MAR (below); the flow share now splits only the land cover’s low-flow threshold');
	await saveSettings(page);

	await page.reload();
	await expect(select).toHaveValue('naturalMar');
	await expect(share.getByTestId('summary-share')).toHaveText('Per unit · no unit on a rainfall station · the EWR split by each unit’s natural MAR');
	await expectNoViolations(page, { include: '#set-share' });

	// Back to Fragmentation, saved through the API: the choice is kept, and the line says it gives the flow share.
	await updateSettings(page.request, project.id, { unitRain: null });
	await page.reload();
	await expect(select).toHaveValue('naturalMar');
	await expect(field).toHaveAttribute('data-unit-rain', 'off');
	await expect(share.getByTestId('summary-share')).toHaveText('Fragmentation · flow share: by catchment area · the EWR split by natural MAR (the flow share under Fragmentation)');
});
