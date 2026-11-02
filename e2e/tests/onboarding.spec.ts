// Fast catchment onboarding (WP-4.10; docs/ui.md § Project list, § Summary
// and § Map, docs/maps.md § Start from the map), against the committed
// synthetic DEM the e2e API reads (DEM_URL, support/dem.ts). The golden path:
// a new user's New project starts guided by default and opens the new
// project's Map on the Start sheet; the catchment is delineated from its
// outlet, the units' boundaries go on the map, the network is proposed,
// ticked and applied, and the to-do list carries on past the network: the
// cultivated area links to the first unit's planted areas, the EWR and the
// calibration are items of their own, and once rain, flow and the A-pan are
// in, Run the model leads to a run, after which the calibration asks for a
// fit to the outlet's observed flow. The other way in: an empty model opens
// on the Summary, whose guided card opens the same sheet. Axe-scanned at
// desktop and phone width.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { putSeries, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { FIXTURE_LOWER_UNIT, FIXTURE_OUTLET, FIXTURE_UPPER_UNIT } from '../support/dem.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openMap } from '../support/map.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';

const DESKTOP = { width: 1440, height: 960 };
const PHONE = { width: 390, height: 844 };
const startSheet = (page: Page) => page.getByRole('dialog', { name: 'Start the model from the map' });
const listItem = (page: Page, id: string) => startSheet(page).getByTestId('start-data-list').locator(`[data-item="${id}"]`);
const area = (ring: [number, number][]) => ({ type: 'Polygon', coordinates: [ring] });
const projectIdOf = (page: Page) => new URL(page.url()).pathname.split('/').pop()!;

/** Axe at desktop and phone width, with no sideways scroll on the phone; back to the desktop after. */
async function scanBothWidths(page: Page) {
	await expectNoViolations(page);
	await resizeTo(page, PHONE);
	await expectNoViolations(page);
	await expectNoSidewaysScroll(page);
	await resizeTo(page, DESKTOP);
}

/** The New project dialog, filled in: its How to start choice left at the default unless `how` is given. */
async function newProject(page: Page, name: string, how?: 'Guided, from the map' | 'An empty model') {
	await page.goto('/');
	await page.getByRole('button', { name: 'New project' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'New project' });
	await dialog.getByLabel('Name').fill(name);
	if (how) await dialog.getByRole('radio', { name: how }).check();
	return dialog;
}

test('a new project starts guided, from its map: delineate, the units, the proposal, then the to-do list to a run and its calibration', async ({ page, owner }) => {
	void owner;
	// One flow, each step needing the last: a delineation, a routed proposal, a run and six axe scans.
	test.setTimeout(150_000);
	await resizeTo(page, DESKTOP);
	const dialog = await newProject(page, 'Guided valley');
	const guided = dialog.getByRole('radio', { name: 'Guided, from the map' });
	await expect(guided).toBeChecked();
	await expect(guided).toHaveAccessibleDescription(/a to-do list takes you through the data to a first calibrated run/);
	await expect(dialog.getByRole('radio', { name: 'An empty model' })).not.toBeChecked();
	await scanBothWidths(page);
	await dialog.getByRole('button', { name: 'Create project' }).click();

	// The new project opens on its Map, on the Start sheet's first step.
	await expect(page).toHaveURL(/\/projects\/[^/?]+\?tab=map&start=1$/);
	await expect(page.locator('.map-page[data-ready]')).toBeVisible();
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'boundary');
	// The server has an elevation model: Delineate is offered, and no note says it is off.
	await expect(startSheet(page).getByTestId('start-delineate')).toBeVisible();
	await expect(startSheet(page).getByTestId('start-no-dem')).toHaveCount(0);
	const id = projectIdOf(page);

	// 1. The boundary, delineated from the outlet (typed coordinates: no assertion reads the map's pixels).
	await startSheet(page).getByTestId('start-delineate').click();
	const bar = page.getByTestId('map-draw-bar');
	await expect(bar).toContainText('Delineating a catchment');
	await bar.getByTestId('map-enter-coordinates').click();
	const d = page.getByRole('dialog', { name: 'Delineate a catchment' });
	await d.getByLabel('Latitude').fill(String(FIXTURE_OUTLET[1]));
	await d.getByLabel('Longitude').fill(String(FIXTURE_OUTLET[0]));
	await d.getByTestId('delineate-submit').click();
	await page.getByRole('dialog', { name: 'The delineated catchment' }).getByTestId('delineate-accept-boundary').click();
	await expect(page.getByTestId('map-notice')).toContainText('Saved Catchment above the outlet (delineated)');
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');

	// 2. The units' boundaries (drawn or uploaded: here through the API, then a reload, which lands on the same step).
	for (const [name, ring] of [
		['Upper unit', FIXTURE_UPPER_UNIT],
		['Lower unit', FIXTURE_LOWER_UNIT]
	] as const) {
		const r = await page.request.post(`${API_URL}/projects/${id}/map/features`, { data: { kind: 'other', name, geometry: area([...ring]) } });
		expect(r.status(), await r.text()).toBe(201);
	}
	await page.reload();
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');
	await startSheet(page).getByTestId('start-propose').click();

	// 3. The proposal, every value ticked, applied.
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'review');
	await expect(page.getByTestId('start-review').getByTestId('start-unit')).toHaveCount(2);
	await startSheet(page).getByTestId('start-tick-all').click();
	await startSheet(page).getByTestId('start-apply').click();
	await answerConfirm(page, true, 'The empty model gets 4 hydrological units');

	// 4. The data to-do list, past the network: the planted areas of the first unit, the EWR, the run and its calibration.
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'data');
	const model = (await (await page.request.get(`${API_URL}/projects/${id}/model`)).json()) as { nodes: { id: string; name: string; kind: string }[] };
	const upper = model.nodes.find((n) => n.name === 'Upper unit')!;
	await expect(startSheet(page).getByRole('link', { name: 'Cultivated area' })).toHaveAttribute('href', `?tab=crops&farm=${upper.id}`);
	await expect(listItem(page, 'crops')).toContainText('Crops → Upper unit’s planted areas');
	await expect(listItem(page, 'ewr')).toHaveAttribute('data-status', 'todo');
	await expect(startSheet(page).getByRole('link', { name: 'The EWR' })).toHaveAttribute('href', '?tab=settings#set-ewr');
	await expect(listItem(page, 'run')).toHaveAttribute('data-status', 'todo');
	await expect(listItem(page, 'calibrate')).toHaveAttribute('data-status', 'todo');
	await expect(listItem(page, 'calibrate')).toContainText('Needs an observed flow record at the outlet first');
	await expect(listItem(page, 'calibrate')).toContainText('(optional)');
	await scanBothWidths(page);

	// The data a run reads (accepted on their own pages, here through the API): the A-pan, the EWR, rain and observed flow.
	await updateSettings(page.request, id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	await putSeries(page.request, id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(120) });
	await putSeries(page.request, id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(120) });
	await openMap(page, id, '&start=1');
	await expect(listItem(page, 'ewr')).toHaveAttribute('data-status', 'done');
	await expect(listItem(page, 'flow')).toHaveAttribute('data-status', 'done');
	// With a record to fit to, the calibration is no longer optional.
	await expect(listItem(page, 'calibrate')).toContainText('Fit the parameters fits them to the outlet’s observed flow');
	await expect(listItem(page, 'calibrate')).not.toContainText('(optional)');

	// Run the model from its item: Runs & results, one run.
	await startSheet(page).getByTestId('start-run').click();
	await expect(page).toHaveURL(/[?&]tab=runs(&|$)/);
	await page.getByRole('button', { name: 'Run model', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Runs', exact: true }).getByRole('button').first()).toHaveAttribute('aria-current', 'true');

	// Back on the Map: the run is done, and the calibration is what is left of a first calibrated run.
	await openMap(page, id, '&start=1');
	await expect(listItem(page, 'run')).toHaveAttribute('data-status', 'done');
	await expect(listItem(page, 'calibrate')).toHaveAttribute('data-status', 'todo');
	await startSheet(page).getByRole('link', { name: 'Calibrate, and run with the fit' }).click();
	await expect(page).toHaveURL(/[?&]tab=calibration#set-fit$/);
	await expect(page.getByRole('heading', { name: 'Fit the parameters' })).toBeVisible();
});

test('an empty model opens on the Summary, whose guided card opens the Map’s Start sheet', async ({ page, owner }) => {
	void owner;
	test.setTimeout(60_000);
	await resizeTo(page, DESKTOP);
	const dialog = await newProject(page, 'Typed valley', 'An empty model');
	await dialog.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(/\/projects\/[^/?]+$/);
	const card = page.getByTestId('summary-guided-start');
	await expect(card.getByRole('heading', { name: 'Set the catchment up from its map' })).toBeVisible();
	await expect(card.getByRole('link', { name: 'Or type the network in' })).toHaveAttribute('href', '?tab=network');
	await scanBothWidths(page);

	await card.getByTestId('summary-guided-open').click();
	await expect(page).toHaveURL(/[?&]tab=map&start=1$/);
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'boundary');
});
