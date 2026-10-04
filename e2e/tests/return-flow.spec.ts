// A unit's irrigation return flow (engine 1.71.0, docs/model.md §2.7): the
// share of the water supplied that returns to the river the same day, at most
// the losses (100 % − efficiency), the efficiency being its crops' irrigation
// systems blended (engine 1.72.0). The node table heads the column as a share
// of the water supplied and shows the efficiency read-only; a return flow
// above the losses is flagged, not refused (the crops' systems, set elsewhere,
// move the losses), and a run caps it (run.test.ts). Synthetic data only.
import { createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { closeModal, openNodeForm, openNodeTable, saveModelChanges } from '../support/network.ts';

test('the return flow is a share of the water supplied; above the losses it is flagged and runs cap it', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Return flow');
	// The sample's Orchard on drip (its SABI preset key): the units' 80 % no longer counts, drip's 90 % does.
	const model = sampleModel();
	model.crops[0]!.irrigationSystemId = 'drip';
	// Upper farm starts at 5 %, so ending on all of drip's losses (10 %) is a change to save.
	model.nodes.find((n) => n.name === 'Upper farm')!.returnFlowFraction = 0.05;
	await putModel(page.request, project.id, model);
	await page.goto(`/projects/${project.id}?tab=network`);
	const grid = await openNodeTable(page);
	await expect(grid.getByRole('columnheader', { name: /^Return flow/ })).toContainText('% of supply');

	// Every planting is on a system, so the efficiency is text (an output), not an input.
	const efficiency = grid.getByRole('status', { name: /^Irrigation efficiency of Upper farm, %/ });
	await expect(efficiency).toHaveText('90 %');
	const returnFlow = grid.getByLabel('Irrigation return flow at Upper farm, % of the water supplied');
	await returnFlow.fill('20');
	await returnFlow.press('Tab');
	// 20 % of the supply can't return when only 10 % of it is lost: flagged, not refused (its crops' systems,
	// set elsewhere, move the losses), and a run caps it at the losses.
	const cell = grid.locator('td', { has: page.getByLabel('Irrigation return flow at Upper farm, % of the water supplied') });
	await expect(cell).toHaveAttribute('title', /^Only 10 % of the water supplied is lost at its 90 % irrigation efficiency/);
	await expect(grid.getByRole('listitem').filter({ hasText: 'return flow' })).toHaveCount(0);

	// All of the losses is the most it fits: 10 % at 90 % is no longer flagged, and saves.
	await returnFlow.fill('10');
	await returnFlow.press('Tab');
	await expect(cell).not.toHaveAttribute('title', /Only/);
	expect((await saveModelChanges(page)).status()).toBe(200);
	await page.reload();
	const again = await openNodeTable(page);
	await expect(again.getByLabel('Irrigation return flow at Upper farm, % of the water supplied')).toHaveValue('10');
	await expect(again.getByRole('status', { name: /^Irrigation efficiency of Upper farm, %/ })).toHaveText('90 %');
	await closeModal(page);

	// Above the losses in the unit form: the warning says what a run will return.
	const form = await openNodeForm(page, 'Upper farm');
	await form.getByLabel('Return flow (% of supply)').fill('25');
	await form.getByLabel('Return flow (% of supply)').press('Tab');
	await expect(form.getByTestId('return-flow-over')).toHaveText(
		"Only 10 % of the water supplied is lost at its 90 % irrigation efficiency (its crops' systems), so runs return 10 %, not 25 %. Lower it to match, or check its crops' systems."
	);
});
