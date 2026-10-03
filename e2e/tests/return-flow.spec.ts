// A unit's irrigation return flow (engine 1.71.0, docs/model.md §2.7): the
// share of the water supplied that returns to the river the same day, at most
// the losses (100 % − efficiency). The node table heads the column as a share
// of the water supplied, refuses more than the losses before a save (the API
// and the database refuse it too, model/validate.test.ts,
// migration-197.db.test.ts), and saves the most there is. Synthetic data only.
import { createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openNodeTable, saveModelChanges } from '../support/network.ts';

test('the return flow is a share of the water supplied, refused above the losses, saved at them', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Return flow');
	await putModel(page.request, project.id, sampleModel());
	await page.goto(`/projects/${project.id}?tab=network`);
	const grid = await openNodeTable(page);
	await expect(grid.getByRole('columnheader', { name: /^Return flow/ })).toContainText('% of supply');

	const efficiency = grid.getByLabel('Irrigation efficiency of Upper farm, %');
	const returnFlow = grid.getByLabel('Irrigation return flow at Upper farm, % of the water supplied');
	await efficiency.fill('90');
	await returnFlow.fill('20');
	await returnFlow.press('Tab');
	// 20 % of the supply can't return when only 10 % of it is lost.
	const problem = grid.getByRole('listitem').filter({ hasText: 'the return flow' });
	await expect(problem).toHaveText('"Upper farm": the return flow (20% of the water supplied) is more than the losses at 90% irrigation efficiency: at most 10% can return.');
	await expect(grid.getByRole('button', { name: 'Save changes' })).toBeDisabled();

	// All of the losses is the most: 10 % at 90 % saves.
	await returnFlow.fill('10');
	await returnFlow.press('Tab');
	await expect(problem).toHaveCount(0);
	expect((await saveModelChanges(page)).status()).toBe(200);
	await page.reload();
	const again = await openNodeTable(page);
	await expect(again.getByLabel('Irrigation return flow at Upper farm, % of the water supplied')).toHaveValue('10');
	await expect(again.getByLabel('Irrigation efficiency of Upper farm, %')).toHaveValue('90');
});
