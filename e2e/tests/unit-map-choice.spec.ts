// A unit's "Source of the MAP" on its form (docs/ui.md § Network, docs/maps.md
// § MAP for each unit): a MAP grid or typed by hand. On the sample model with
// invented parcels and the committed synthetic grid (the e2e database keeps
// only that grid, since a real-looking one would become every spec's default,
// map-layers.spec.ts), so the WAAS 2007 MAP and the CCWR MAP are offered as not
// loaded and a unit's WAAS MAP is one seeded with the WAAS grid's source line:
// - Picking the grid writes the unit's MAP and its source line through MAP
//   for each unit's apply, with no question while the unit has no MAP: the
//   form shows it, the grid is chosen, and History has the change.
// - One grid for the whole project: with another unit on the WAAS 2007 MAP,
//   picking the grid asks to switch every unit; No writes nothing, Yes
//   switches both. A unit on another grid this grid can't cover holds the
//   grid, saying why.
// - Typed by hand keeps the MAP and asks for its source; another number typed
//   over a grid's MAP turns the choice to Typed by hand.
// - Unsaved model edits hold the grids, saying why.
// - A viewer sees the choice read-only.
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, seedRunnableProject, updateSettings } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { box } from '../support/map.ts';
import { loadSyntheticMapGrid } from '../support/mapGrid.ts';
import { openNodeForm, saveModelChanges } from '../support/network.ts';

/** A MAP the WAAS 2007 grid wrote: its source line, which the one-grid rule recognises. */
const WAAS_LINE = 'WAAS-SWCape-2007 1.1, area-weighted mean over the unit’s parcel, 4 cells';
const GRID_LINE = /^synthetic synthetic 1, area-weighted mean over the unit’s parcel, \d+ cells$/;

/** The sample model with rain for each unit and a parcel for each unit: Upper farm's inside the synthetic grid, Lower farm's inside it or outside. */
async function seed(request: APIRequestContext, name: string, lower: 'inside' | 'outside' = 'inside') {
	const project = await seedRunnableProject(request, name);
	await updateSettings(request, project.id, { unitRain: { mode: 'perUnit' } });
	const [, upper, lowerNode] = project.model.nodes as { id: string; name: string }[];
	for (const [n, geometry] of [
		[upper!, { type: 'Polygon', coordinates: [box(21.31, -33.69, 0.03)] }],
		[lowerNode!, { type: 'Polygon', coordinates: [lower === 'inside' ? box(21.36, -33.69, 0.02) : box(22.36, -33.69, 0.02)] }]
	] as const) {
		const res = await request.post(`${API_URL}/projects/${project.id}/map/features`, { data: { kind: 'farm_parcel', name: `${n.name} parcel`, nodeId: n.id, geometry } });
		expect(res.status(), await res.text()).toBe(201);
	}
	return project;
}

async function setUnitMap(request: APIRequestContext, projectId: string, name: string, mapMm: number | null, mapSource: string | null) {
	const model = await (await request.get(`${API_URL}/projects/${projectId}/model`)).json();
	for (const n of model.nodes) if (n.name === name) Object.assign(n, { mapMm, mapSource });
	expect((await request.put(`${API_URL}/projects/${projectId}/model`, { data: model })).status()).toBe(200);
}

async function unitMaps(request: APIRequestContext, projectId: string) {
	const model = await (await request.get(`${API_URL}/projects/${projectId}/model`)).json();
	return Object.fromEntries((model.nodes as { name: string; mapMm: number | null; mapSource: string | null }[]).filter((n) => n.name.endsWith('farm')).map((n) => [n.name, { mapMm: n.mapMm, mapSource: n.mapSource }]));
}

/** The unit's form on the Network tab, its grids read. */
async function unitForm(page: Page, projectId: string, unit: string) {
	await page.goto(`/projects/${projectId}?tab=network`);
	await openNodeForm(page);
	await page.getByLabel('Hydrological unit to edit').selectOption({ label: `${unit === 'Upper farm' ? 2 : 3}. ${unit} · hydrological unit` });
	const choice = page.getByTestId('unit-map-choice');
	await expect(choice).toHaveAttribute('data-ready', 'true');
	return choice;
}

test('picking the grid gives the unit its MAP and source line, saved as one change, and the named grids not loaded say so', async ({ page, owner }) => {
	void owner;
	await loadSyntheticMapGrid();
	const { id } = await seed(page.request, 'Unit MAP choice pick');
	const choice = await unitForm(page, id, 'Upper farm');
	await expect(page.getByRole('group', { name: 'Source of the MAP', exact: true })).toHaveAttribute('data-testid', 'unit-map-choice');
	// The named grids first, offered but not loaded here; then the loaded test grid, with this unit's MAP; then Typed by hand, chosen.
	await expect(choice.getByRole('radio')).toHaveCount(4);
	await expect(choice.getByRole('radio', { name: 'WAAS 2007 MAP' })).toBeDisabled();
	await expect(choice.getByRole('radio', { name: 'WAAS 2007 MAP' })).toHaveAccessibleDescription('Not loaded on this server.');
	await expect(choice.getByRole('radio', { name: 'CCWR MAP' })).toBeDisabled();
	const grid = choice.getByRole('radio', { name: /^synthetic \d{3} mm$/ });
	await expect(grid).toBeEnabled();
	await expect(choice.getByRole('radio', { name: 'Typed by hand' })).toBeChecked();
	const mm = (await grid.locator('xpath=..').textContent())!.match(/(\d{3}) mm/)![1]!;
	await expectNoViolations(page, { include: '[data-testid="unit-map-choice"]' });

	// No MAP yet, so nothing to ask: picked, saved straight away.
	await grid.check();
	await expect(choice.getByTestId('unit-map-choice-notice')).toHaveText(`Upper farm’s MAP is now ${mm} mm from synthetic, saved as one model change (History).`);
	await expect(grid).toBeChecked();
	await expect(page.getByTestId('unit-map').getByLabel('MAP (mm)')).toHaveValue(mm);
	await expect(choice.getByTestId('unit-map-source-line')).toHaveText(GRID_LINE);
	await expect(page.getByLabel('Source of the MAP')).toHaveCount(0);
	expect((await unitMaps(page.request, id))['Upper farm']).toEqual({ mapMm: Number(mm), mapSource: expect.stringMatching(GRID_LINE) });
	const history = await page.request.get(`${API_URL}/projects/${id}/history`);
	expect(JSON.stringify(await history.json()).match(/MAP of “Upper farm” from the MAP grid synthetic synthetic 1/g)).toHaveLength(1);
});

test('picking a grid while another unit is on the WAAS 2007 MAP asks to switch every unit: No writes nothing, Yes switches both', async ({ page, owner }) => {
	void owner;
	await loadSyntheticMapGrid();
	const { id } = await seed(page.request, 'Unit MAP choice switch');
	await setUnitMap(page.request, id, 'Lower farm', 700, WAAS_LINE);
	await setUnitMap(page.request, id, 'Upper farm', 800, 'DWAF map');

	// Lower farm reads as on the WAAS 2007 MAP, from its source line.
	let choice = await unitForm(page, id, 'Lower farm');
	await expect(choice.getByRole('radio', { name: 'WAAS 2007 MAP' })).toBeChecked();
	await expect(choice.getByTestId('unit-map-source-line')).toHaveText(WAAS_LINE);

	choice = await unitForm(page, id, 'Upper farm');
	await expect(choice.getByRole('radio', { name: 'Typed by hand' })).toBeChecked();
	await expect(page.getByLabel('Source of the MAP')).toHaveValue('DWAF map');
	const grid = choice.getByRole('radio', { name: /^synthetic \d{3} mm$/ });
	await grid.check();
	await answerConfirm(page, false, '1 unit uses WAAS 2007 MAP now: Lower farm.');
	// No: nothing written, the choice as it was.
	await expect(choice.getByRole('radio', { name: 'Typed by hand' })).toBeChecked();
	await expect(grid).not.toBeChecked();
	expect(await unitMaps(page.request, id)).toEqual({ 'Upper farm': { mapMm: 800, mapSource: 'DWAF map' }, 'Lower farm': { mapMm: 700, mapSource: WAAS_LINE } });

	await grid.check();
	await answerConfirm(page, true, /Switch every unit to synthetic\?[\s\S]*It and Upper farm get their MAP from synthetic[\s\S]*Upper farm’s typed 800 mm \(“DWAF map”\) is replaced/);
	await expect(choice.getByTestId('unit-map-choice-notice')).toHaveText('Upper farm and 1 other unit now have their MAP from synthetic, saved as one model change (History).');
	await expect(grid).toBeChecked();
	const after = await unitMaps(page.request, id);
	expect(after['Upper farm']!.mapSource).toMatch(GRID_LINE);
	expect(after['Lower farm']!.mapSource).toMatch(GRID_LINE);
});

test('a unit on the WAAS 2007 MAP that the grid can’t cover holds the grid, saying which to type by hand', async ({ page, owner }) => {
	void owner;
	await loadSyntheticMapGrid();
	const { id } = await seed(page.request, 'Unit MAP choice blocked', 'outside');
	await setUnitMap(page.request, id, 'Lower farm', 700, WAAS_LINE);
	const choice = await unitForm(page, id, 'Upper farm');
	const grid = choice.getByRole('radio', { name: /^synthetic \d{3} mm$/ });
	await expect(grid).toBeDisabled();
	await expect(grid).toHaveAccessibleDescription(
		'It would mix two grids: Lower farm (WAAS 2007 MAP) has a MAP from another grid that this one doesn’t cover. Type its MAP by hand, or clear it, on its form first.'
	);
	await expectNoViolations(page, { include: '[data-testid="unit-map-choice"]' });
});

test('Typed by hand keeps the MAP and asks for its source, and another number over a grid’s MAP turns to Typed by hand', async ({ page, owner }) => {
	void owner;
	await loadSyntheticMapGrid();
	const { id } = await seed(page.request, 'Unit MAP choice typed');
	const choice = await unitForm(page, id, 'Upper farm');
	const grid = choice.getByRole('radio', { name: /^synthetic \d{3} mm$/ });
	await grid.check();
	await expect(choice.getByTestId('unit-map-source-line')).toHaveText(GRID_LINE);
	const mm = await page.getByTestId('unit-map').getByLabel('MAP (mm)').inputValue();

	// Typed by hand: the number stays, the grid's line goes, and the source is asked for.
	await choice.getByRole('radio', { name: 'Typed by hand' }).check();
	const source = page.getByLabel('Source of the MAP');
	await expect(source).toHaveValue('');
	await expect(source).toHaveAttribute('aria-invalid', 'true');
	await expect(page.getByTestId('unit-map').getByLabel('MAP (mm)')).toHaveValue(mm);
	// The model has an unsaved edit now, so the grid waits, saying why.
	await expect(grid).toBeDisabled();
	await expect(grid).toHaveAccessibleDescription('Save or discard your model changes first: a grid’s MAP is saved straight away.');
	await source.fill('a catchment study, 1990–2020');
	expect((await saveModelChanges(page)).status()).toBe(200);
	expect((await unitMaps(page.request, id))['Upper farm']).toEqual({ mapMm: Number(mm), mapSource: 'a catchment study, 1990–2020' });

	// Back on the grid, then another number typed over it: Typed by hand, the source asked for.
	await expect(grid).toBeEnabled();
	await grid.check();
	await answerConfirm(page, true, 'Replace the typed MAP?');
	await expect(grid).toBeChecked();
	const map = page.getByTestId('unit-map').getByLabel('MAP (mm)');
	await map.fill('901');
	await map.blur();
	await expect(choice.getByRole('radio', { name: 'Typed by hand' })).toBeChecked();
	await expect(page.getByLabel('Source of the MAP')).toHaveValue('');
	await expect(page.getByLabel('Source of the MAP')).toHaveAttribute('aria-invalid', 'true');
});

test('a viewer sees which source a unit’s MAP has, read-only', async ({ page, owner, signIn }) => {
	void owner;
	await loadSyntheticMapGrid();
	const { id } = await seed(page.request, 'Unit MAP choice viewer');
	await setUnitMap(page.request, id, 'Upper farm', 700, WAAS_LINE);
	const viewer = await signIn('Unit MAP choice viewer');
	await addMember(page.request, id, viewer.user.email, 'viewer');
	const choice = await unitForm(viewer.page, id, 'Upper farm');
	await expect(choice.getByRole('radio', { name: 'WAAS 2007 MAP' })).toBeChecked();
	await expect(choice.getByRole('radio', { name: 'WAAS 2007 MAP' })).toBeDisabled();
	await expect(choice.getByRole('radio', { name: 'CCWR MAP' })).toBeDisabled();
	await expect(choice.getByRole('radio', { name: 'Typed by hand' })).toBeDisabled();
	await expect(choice.getByTestId('unit-map-source-line')).toHaveText(WAAS_LINE);
});
