// Each unit's MAP from the MAP grid (issue #482; docs/ui.md § Settings &
// calibration, docs/maps.md § MAP for each unit). On the sample model with
// invented parcels linked to both units, and the committed synthetic grid:
// - Settings → Rain for each unit → MAP from the grid proposes each unit's
//   area-weighted MAP from the one grid that covers both, marked synthetic;
//   Use asks first, then writes both units' MAP and source as one model
//   change, says so, and leaves nothing to use; the unit's form holds the MAP
//   and a source naming the grid and the method, and History has one entry.
//   The panel passes axe; a cancelled Use writes nothing.
// - A unit outside the grid is listed with why, never filled; a unit holding
//   another grid's MAP is named and holds Use.
// - Unsaved model edits hold Use, saying why; saved, Use works again.
// - A viewer has no panel (the proposal is an editor's).
import type { APIRequestContext } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, seedRunnableProject, updateSettings } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box } from '../support/map.ts';
import { loadSyntheticMapGrid } from '../support/mapGrid.ts';
import { closeModal, openNodeForm, saveModelChanges } from '../support/network.ts';
import { openSettings } from '../support/settings.ts';

/** The sample model with rain for each unit on and a parcel for each unit: inside the synthetic grid (region Z), or Lower farm's outside it. */
async function seed(request: APIRequestContext, name: string, lowerOutside = false) {
	const project = await seedRunnableProject(request, name);
	await updateSettings(request, project.id, { unitRain: { mode: 'perUnit' } });
	const [, upper, lower] = project.model.nodes as { id: string; name: string }[];
	for (const [n, geometry] of [
		[upper!, { type: 'Polygon', coordinates: [box(21.31, -33.69, 0.03)] }],
		[lower!, { type: 'Polygon', coordinates: [box(lowerOutside ? 22.36 : 21.36, -33.69, 0.02)] }]
	] as const) {
		const res = await request.post(`${API_URL}/projects/${project.id}/map/features`, { data: { kind: 'farm_parcel', name: `${n.name} parcel`, nodeId: n.id, geometry } });
		expect(res.status(), await res.text()).toBe(201);
	}
	return project;
}

test('an editor uses each unit’s MAP from the grid, written to the units with its source and one History entry', async ({ page, owner }) => {
	void owner;
	await loadSyntheticMapGrid();
	const { id } = await seed(page.request, 'Unit MAP from the grid');
	await openSettings(page, id);
	const panel = page.getByTestId('unit-map-proposal');
	await expect(panel.getByTestId('unit-map-body')).toHaveAttribute('data-ready', 'true');
	await expect(panel.getByRole('heading', { name: 'MAP from the grid' })).toBeVisible();
	await expect(panel.getByTestId('unit-map-synthetic')).toContainText('Synthetic test data.');
	await expect(panel.getByTestId('unit-map-coverage')).toHaveText('synthetic (0.01° cells) covers all 2 units with a parcel on the map.');

	const rows = panel.getByTestId('unit-map-rows').locator('tbody tr');
	await expect(rows).toHaveCount(2);
	await expect(rows.getByRole('rowheader')).toHaveText(['Upper farm', 'Lower farm']);
	// Unit, proposed MAP (whole mm), cells, what the form holds now (nothing yet).
	await expect(rows.first()).toHaveText(/^Upper farm\s*\d{3}\s*\d+\s*None$/);
	const upperMm = (await rows.first().locator('td').first().textContent())!.trim();
	await expect(panel.getByTestId('unit-map-source')).toContainText('Invented MAP grid for tests and demos');
	await expectNoViolations(page, { include: '[data-testid="unit-map-proposal"]' });

	// Cancelled: nothing written.
	await panel.getByRole('button', { name: 'Use for 2 units' }).click();
	await answerConfirm(page, false);
	await expect(rows.first().locator('td').last()).toHaveText('None');
	await expect(panel.getByTestId('unit-map-notice')).toHaveText('');

	await panel.getByRole('button', { name: 'Use for 2 units' }).click();
	await answerConfirm(page, true, '2 units get their MAP and source from synthetic synthetic 1');
	await expect(panel.getByTestId('unit-map-notice')).toHaveText('2 units now have their MAP from synthetic synthetic 1, saved as one model change (History). Run the model to see its effect.');
	await expect(panel.getByTestId('unit-map-notice')).toBeFocused();
	await expect(panel.getByTestId('unit-map-same')).toHaveText('Every unit listed holds this MAP from this grid.');
	await expect(panel.getByRole('button', { name: /^Use for/ })).toHaveCount(0);
	await expect(rows.first().locator('td').last()).toHaveText(`${upperMm} mm, the same`);
	// The switch's own count follows the model.
	await expect(page.getByTestId('unit-rain-coverage')).toContainText('2 of 2 units with land have a MAP.');

	// The unit's form holds it, with the grid and the method as its source.
	await rows.first().getByRole('link', { name: 'Upper farm' }).click();
	await expect(page).toHaveURL(/[?&]tab=network&edit=/);
	const form = await openNodeForm(page, 'Upper farm');
	await expect(form.getByLabel(/^MAP/)).toHaveValue(upperMm);
	await expect(form.getByLabel('Source of the MAP')).toHaveValue(/^synthetic synthetic 1, area-weighted mean over the unit’s parcel, \d+ cells$/);

	// One History entry for both units.
	const history = await page.request.get(`${API_URL}/projects/${id}/history`);
	expect(JSON.stringify(await history.json()).match(/MAP of 2 units from the MAP grid synthetic synthetic 1/g)).toHaveLength(1);
});

test('a unit outside the grid is listed and left alone, and a unit holding another grid’s MAP holds Use', async ({ page, owner }) => {
	void owner;
	await loadSyntheticMapGrid();
	const project = await seed(page.request, 'Unit MAP outside', true);
	await openSettings(page, project.id);
	const panel = page.getByTestId('unit-map-proposal');
	await expect(panel.getByTestId('unit-map-body')).toHaveAttribute('data-ready', 'true');
	await expect(panel.getByTestId('unit-map-coverage')).toHaveText(
		'synthetic (0.01° cells) covers 1 of the 2 units with a parcel on the map; the rest keep what they have.'
	);
	await expect(panel.getByTestId('unit-map-rows').locator('tbody tr').getByRole('rowheader')).toHaveText(['Upper farm']);
	await expect(panel.getByTestId('unit-map-uncovered')).toHaveText(/Not covered by this grid, so left as they are:\s*Lower farm: the grid has no value inside the unit’s parcel\./);
	await expect(panel.getByRole('button', { name: 'Use for 1 unit' })).toBeEnabled();

	// Lower farm gets a MAP from another grid (its source in this panel's form): Use would mix two grids, so it waits.
	const model = await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json();
	for (const n of model.nodes) if (n.name === 'Lower farm') Object.assign(n, { mapMm: 700, mapSource: 'another-grid 1, area-weighted mean over the unit’s parcel, 4 cells' });
	expect((await page.request.put(`${API_URL}/projects/${project.id}/model`, { data: model })).status()).toBe(200);
	await page.reload();
	await expect(panel.getByTestId('unit-map-body')).toHaveAttribute('data-ready', 'true');
	await expect(panel.getByTestId('unit-map-other-grid')).toContainText('Lower farm has a MAP from another grid');
	await expect(panel.getByRole('button', { name: 'Use for 1 unit' })).toBeDisabled();
	await expectNoViolations(page, { include: '[data-testid="unit-map-proposal"]' });
});

test('unsaved model edits hold Use, saying why, and once saved it works again', async ({ page, owner }) => {
	void owner;
	await loadSyntheticMapGrid();
	const { id } = await seed(page.request, 'Unit MAP unsaved model');
	await openSettings(page, id);
	const panel = page.getByTestId('unit-map-proposal');
	await expect(panel.getByTestId('unit-map-body')).toHaveAttribute('data-ready', 'true');
	const use = panel.getByRole('button', { name: 'Use for 2 units' });
	await expect(use).toBeEnabled();

	// An unsaved edit to a unit's form (not its MAP), then back to Settings within the workspace.
	await panel.getByTestId('unit-map-rows').getByRole('link', { name: 'Upper farm' }).click();
	await expect(page).toHaveURL(/[?&]tab=network&edit=/);
	const form = await openNodeForm(page, 'Upper farm');
	await form.getByLabel('Return flow (% of supply)').fill('5');
	await form.getByLabel('Return flow (% of supply)').press('Tab');
	await closeModal(page);
	await page.getByRole('link', { name: 'Settings & calibration', exact: true }).click();
	await expect(panel.getByTestId('unit-map-body')).toHaveAttribute('data-ready', 'true');

	// Use waits: it saves straight to the model, which would drop the unsaved edit.
	await expect(use).toBeDisabled();
	await expect(use).toHaveAccessibleDescription('Save or discard your model changes first: MAPs used here are saved straight away.');

	// Saved, Use works again, and the edit is kept.
	expect((await saveModelChanges(page)).status()).toBe(200);
	await expect(use).toBeEnabled();
	await use.click();
	await answerConfirm(page, true, '2 units get their MAP and source from synthetic synthetic 1');
	await expect(panel.getByTestId('unit-map-notice')).toContainText('2 units now have their MAP from synthetic synthetic 1');
	// The saved edit survived the apply's reload, beside the new MAP.
	await panel.getByTestId('unit-map-rows').getByRole('link', { name: 'Upper farm' }).click();
	await expect(page).toHaveURL(/[?&]tab=network&edit=/);
	const after = await openNodeForm(page, 'Upper farm');
	await expect(after.getByLabel('Return flow (% of supply)')).toHaveValue('5');
	await expect(after.getByLabel('Source of the MAP')).toHaveValue(/^synthetic synthetic 1, area-weighted mean over the unit’s parcel/);
});

test('a viewer has no MAP from the grid panel', async ({ page, owner, signIn }) => {
	void owner;
	await loadSyntheticMapGrid();
	const { id } = await seed(page.request, 'Unit MAP viewer');
	const viewer = await signIn('Unit MAP viewer');
	await addMember(page.request, id, viewer.user.email, 'viewer');
	await openSettings(viewer.page, id);
	await expect(viewer.page.getByTestId('unit-rain-settings')).toBeVisible();
	await expect(viewer.page.getByTestId('unit-map-proposal')).toHaveCount(0);
});
