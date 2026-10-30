// Start from the map's data step as a to-do list (issue #646 item 2, the
// hydrologist's review F1–F4; docs/ui.md § Map, docs/design/start-from-map.md
// § The flow, step 4). A model is started from the map through the API, its
// units' boundaries *other* areas as Sub-catchments from clicks saves them
// (so this is F1's end-to-end check too: the per-unit proposals see them),
// against the committed synthetic DEM. Then, on the Map:
// - the data step lists each proposal with its status from what the project
//   holds (rain for each unit To do), and links observed flow to the DWS form;
// - closing the sheet keeps the list: the Getting started pill shows the same
//   items, and its link opens the sheet's data step again;
// - following the pill's Rain for each unit link and creating the feeds there
//   turns the item Done when the Map is opened again;
// - the units' rain reviewed together in the sheet: unticked until Tick all,
//   applied only after the confirm, and the item turns Done;
// - the points step makes units' boundaries (F13): Sub-catchments, one per
//   click, saves its piece and comes back to the sheet with it as a unit;
//   opened while the map is still loading, its Enter coordinates is folded
//   until clicked, and stays open once the map draws;
// - the A-pan row (issue #646 item 5) reads "A-pan not set" until the A-pan
//   is, and a unit boundary redrawn after the start shows in the Checks as an
//   area from an earlier outline, whose Use takes the area now (item 4, F6).
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { createProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { FIXTURE_DAM, FIXTURE_LOWER_UNIT, FIXTURE_UPPER_UNIT } from '../support/dem.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openMap } from '../support/map.ts';

const startSheet = (page: Page) => page.getByRole('dialog', { name: 'Start the model from the map' });
const area = (ring: [number, number][]) => ({ type: 'Polygon', coordinates: [ring] });
const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

/** The two units' rings joined along their shared edge: the catchment boundary around both. */
function unionRing(): [number, number][] {
	const east = FIXTURE_LOWER_UNIT[0]!;
	const west = FIXTURE_LOWER_UNIT[FIXTURE_LOWER_UNIT.length - 2]!;
	const i1 = FIXTURE_UPPER_UNIT.findIndex((p) => same(p, east));
	const i2 = FIXTURE_UPPER_UNIT.findIndex((p) => same(p, west));
	expect(i1).toBeGreaterThan(0);
	expect(i2).toBe(i1 + 1);
	return [...FIXTURE_UPPER_UNIT.slice(0, i1 + 1), ...FIXTURE_LOWER_UNIT.slice(1, -1), ...FIXTURE_UPPER_UNIT.slice(i2 + 1)];
}

async function post(request: APIRequestContext, path: string, data: unknown, status = 201) {
	const r = await request.post(`${API_URL}${path}`, { data });
	expect(r.status(), await r.text()).toBe(status);
	return r.json();
}

/** A project started from the map: the boundary, two units' boundaries as other areas, every value ticked and applied. */
async function startedProject(request: APIRequestContext, name: string): Promise<string> {
	const { id } = await createProject(request, name);
	await post(request, `/projects/${id}/map/features`, { kind: 'catchment_boundary', name: 'Valley', geometry: area(unionRing()) });
	const upper = (await post(request, `/projects/${id}/map/features`, { kind: 'other', name: 'Upper unit', geometry: area(FIXTURE_UPPER_UNIT) })).feature.id as string;
	const lower = (await post(request, `/projects/${id}/map/features`, { kind: 'other', name: 'Lower unit', geometry: area(FIXTURE_LOWER_UNIT) })).feature.id as string;
	const { proposal } = await post(request, `/projects/${id}/map/start`, {
		points: [
			{ featureId: upper, role: 'unit' },
			{ featureId: lower, role: 'unit' }
		]
	});
	const plan = proposal.plan as { outlet: { name: string }; rest: { name: string }; units: { key: string; name: string; areaM2: number | null; geometry: unknown; drainsIntoProposed: boolean }[] };
	await post(
		request,
		`/projects/${id}/map/start/${proposal.id}/apply`,
		{
			outletName: plan.outlet.name,
			units: plan.units.map((u) => ({ key: u.key, name: u.name, area: u.areaM2 !== null && !!u.geometry, drainsInto: u.drainsIntoProposed, runoffToDam: false })),
			rest: { include: false, name: plan.rest.name, area: false }
		},
		200
	);
	return id;
}

const pillStep = (page: Page, id: string) => page.getByTestId('map-setup').locator(`[data-step="${id}"]`);
const listItem = (page: Page, id: string) => startSheet(page).getByTestId('start-data-list').locator(`[data-item="${id}"]`);

test('the data step is a to-do list that stays after the sheet closes, and a followed link turns its item done', async ({ page, owner }) => {
	void owner;
	test.setTimeout(60_000);
	const id = await startedProject(page.request, 'Start data to-do');
	await openMap(page, id, '&start=1');
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'data');

	// Each item's status from what the project holds: the units have areas, nothing else is in yet.
	await expect(listItem(page, 'network')).toHaveAttribute('data-status', 'done');
	await expect(listItem(page, 'unit-rain')).toHaveAttribute('data-status', 'todo');
	await expect(listItem(page, 'unit-map')).toHaveAttribute('data-status', 'todo');
	await expect(listItem(page, 'run')).toHaveAttribute('data-status', 'todo');
	await expect(listItem(page, 'rain')).toHaveAttribute('data-next', 'true');
	await expect(startSheet(page).getByRole('link', { name: 'Observed flow' })).toHaveAttribute('href', '?tab=series&feed=dws#data-feeds');
	await expect(startSheet(page).getByRole('link', { name: 'MAP for each unit' })).toHaveAttribute('href', '?tab=settings#set-unit-map');
	await expect(startSheet(page).getByRole('link', { name: 'WR2012 check' })).toHaveAttribute('href', '?tab=calibration#set-wr2012');
	// F1: the units' boundaries are other areas, and the rain proposal sees both.
	await expect(startSheet(page).getByTestId('start-units-data')).toHaveAttribute('data-ready', 'true');
	await expect(startSheet(page).getByTestId('start-units-data-row')).toHaveCount(2);
	await expect(startSheet(page).getByTestId('start-units-tick-rain')).toHaveCount(2);
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expectNoViolations(page);
	}
	await page.emulateMedia({ colorScheme: 'light' });

	// Closed, the list stays: the Getting started pill holds the same items, and links back to the data step.
	await startSheet(page).getByRole('button', { name: 'Close', exact: true }).click();
	await expect(startSheet(page)).toHaveCount(0);
	await page.getByTestId('map-setup-pill').click();
	await expect(pillStep(page, 'unit-rain')).toHaveAttribute('data-status', 'todo');
	await expect(pillStep(page, 'run')).toHaveAttribute('data-status', 'todo');
	await expectNoViolations(page);
	await page.getByTestId('map-setup-start').click();
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'data');
	await startSheet(page).getByRole('button', { name: 'Close', exact: true }).click();

	// Follow Rain for each unit from the pill: Data feeds opens its proposal; create the feeds there.
	await page.getByTestId('map-setup-pill').click();
	await pillStep(page, 'unit-rain').getByTestId('map-setup-link-unit-rain').click();
	const panel = page.getByTestId('unit-rain');
	await expect(panel.getByTestId('unit-rain-row')).toHaveCount(2);
	await expect(panel.getByTestId('unit-rain-apply')).toHaveText('Create 2 feeds');
	await panel.getByTestId('unit-rain-apply').click();
	await expect(panel.getByTestId('unit-rain-done')).toHaveText(/^Created 2 feeds\./);

	// Back on the Map, the item is done.
	await openMap(page, id);
	await page.getByTestId('map-setup-pill').click();
	await expect(pillStep(page, 'unit-rain')).toHaveAttribute('data-status', 'done');
	await expect(pillStep(page, 'unit-rain').getByTestId('map-setup-link-unit-rain')).toHaveCount(0);
});

test('the units’ rain reviewed together: unticked until Tick all, applied after the confirm, then done', async ({ page, owner }) => {
	void owner;
	test.setTimeout(60_000);
	const id = await startedProject(page.request, 'Start data tick all');
	await openMap(page, id, '&start=1');
	const review = startSheet(page).getByTestId('start-units-data');
	await expect(review).toHaveAttribute('data-ready', 'true');
	const ticks = review.getByTestId('start-units-tick-rain');
	await expect(ticks).toHaveCount(2);
	for (const t of await ticks.all()) await expect(t).not.toBeChecked();
	await expect(review.getByTestId('start-units-apply')).toBeDisabled();

	await review.getByTestId('start-units-tick-all').click();
	for (const t of await ticks.all()) await expect(t).toBeChecked();
	// A cancelled confirm applies nothing.
	await review.getByTestId('start-units-apply').click();
	await answerConfirm(page, false, '2 units get their own CHIRPS feeds (rnl)');
	await expect(listItem(page, 'unit-rain')).toHaveAttribute('data-status', 'todo');
	await review.getByTestId('start-units-apply').click();
	await answerConfirm(page, true);
	await expect(review.getByTestId('start-units-data-done')).toHaveText('Applied: 2 feeds created, 0 updated.');
	await expect(listItem(page, 'unit-rain')).toHaveAttribute('data-status', 'done');
	// Nothing left to take: each unit's feed reads its boundary's cells.
	await expect(review.getByTestId('start-units-tick-rain')).toHaveCount(0);
});

test('the points step makes units’ boundaries: Sub-catchments, one per click, comes back to the sheet with its piece as a unit', async ({ page, owner }) => {
	void owner;
	test.setTimeout(60_000);
	const { id } = await createProject(page.request, 'Start points to boundaries');
	await post(page.request, `/projects/${id}/map/features`, { kind: 'catchment_boundary', name: 'Valley', geometry: area(unionRing()) });
	await openMap(page, id, '&start=1');
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');
	await expect(startSheet(page).getByTestId('start-draw-unit')).toBeVisible();
	await startSheet(page).getByTestId('start-subcatchments').click();
	const bar = page.getByTestId('map-click-bar');
	await expect(bar).toBeVisible();
	await bar.getByText('Enter coordinates').click();
	await bar.getByTestId('map-click-lat').fill(String(FIXTURE_DAM[1]));
	await bar.getByTestId('map-click-lon').fill(String(FIXTURE_DAM[0]));
	await bar.getByTestId('map-click-add').click();
	await expect(bar.getByTestId('map-click-piece')).toHaveCount(1);
	await bar.getByTestId('map-click-save').click();
	await expect(page.getByTestId('map-notice')).toContainText('on the map as areas: each is a unit’s boundary in the Start sheet.');
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');
	await expect(startSheet(page).getByTestId('start-points').locator('select[id*="-role-"]')).toHaveCount(1);
	await expect(startSheet(page).getByTestId('start-points').locator('select[id*="-role-"]').first()).toHaveValue('unit');
});

test('Sub-catchments opened while the map is still loading: Enter coordinates is folded, one click opens it, and it stays open once the map draws', async ({ page, owner }) => {
	// The panel used to open the typed coordinates whenever it mounted before the map had drawn, as if the map
	// had failed, and keep them open after it drew: a click on Enter coordinates then shut them (CI runs
	// 40803033108 and 41068074039 timed out on the test above filling a hidden Latitude). The map library's
	// chunk is held back until the form is open, so the panel mounts while the map is loading, every time.
	void owner;
	test.setTimeout(60_000);
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	await page.route('**/_app/immutable/chunks/*.js', async (route) => {
		const res = await route.fetch();
		const body = await res.text();
		if (body.includes('maplibre')) await held;
		await route.fulfill({ response: res, body });
	});
	const { id } = await createProject(page.request, 'Start points while the map loads');
	await post(page.request, `/projects/${id}/map/features`, { kind: 'catchment_boundary', name: 'Valley', geometry: area(unionRing()) });
	await openMap(page, id, '&start=1');
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');
	await startSheet(page).getByTestId('start-subcatchments').click();
	const bar = page.getByTestId('map-click-bar');
	await expect(bar).toBeVisible();
	await expect(page.locator('.map-wrap')).toHaveAttribute('data-status', 'loading');
	await expect(bar.getByTestId('map-click-how')).toContainText('Click a terrain channel for each outlet');
	await expect(bar.getByTestId('map-click-lat')).toBeHidden();
	await bar.getByText('Enter coordinates').click();
	await expect(bar.getByTestId('map-click-lat')).toBeVisible();
	release();
	await expect(page.locator('.map-wrap')).toHaveAttribute('data-status', 'ready');
	await expect(bar.getByTestId('map-click-lat')).toBeVisible();
	await bar.getByTestId('map-click-lat').fill(String(FIXTURE_DAM[1]));
	await bar.getByTestId('map-click-lon').fill(String(FIXTURE_DAM[0]));
	await bar.getByTestId('map-click-add').click();
	await expect(bar.getByTestId('map-click-piece')).toHaveCount(1);
});

test('the A-pan row says it isn’t set until it is, and a redrawn unit boundary offers its area now in the Checks', async ({ page, owner }) => {
	void owner;
	test.setTimeout(60_000);
	const id = await startedProject(page.request, 'Start data stale');
	await openMap(page, id, '&start=1');
	await expect(listItem(page, 'evaporation')).toHaveAttribute('data-status', 'todo');
	await expect(listItem(page, 'evaporation')).toContainText('A-pan not set: crop demand and dam evaporation are zero.');
	const r = await page.request.patch(`${API_URL}/projects/${id}`, { data: { settings: { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] } } });
	expect(r.status(), await r.text()).toBe(200);
	await openMap(page, id, '&start=1');
	await expect(listItem(page, 'evaporation')).toHaveAttribute('data-status', 'done');
	await expect(listItem(page, 'evaporation')).toContainText('The monthly A-pan is set.');

	// Redraw the upper unit's boundary smaller: the model keeps the area Start took, and the Checks say so.
	const map = await (await page.request.get(`${API_URL}/projects/${id}/map/features`)).json();
	const upper = map.features.find((f: { name: string }) => f.name === 'Upper unit');
	const unit = map.nodes.find((n: { areaFeatureId: string | null }) => n.areaFeatureId === upper.id);
	const xs = FIXTURE_UPPER_UNIT.map((p) => p[0]);
	const ys = FIXTURE_UPPER_UNIT.map((p) => p[1]);
	const [cx, cy] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
	const d = (Math.max(...xs) - Math.min(...xs)) / 6;
	const smaller = area([
		[cx - d, cy - d],
		[cx + d, cy - d],
		[cx + d, cy + d],
		[cx - d, cy + d],
		[cx - d, cy - d]
	]);
	const patched = await page.request.patch(`${API_URL}/projects/${id}/map/features/${upper.id}`, { data: { geometry: smaller } });
	expect(patched.status(), await patched.text()).toBe(200);
	const nowKm2 = (await patched.json()).feature.areaM2 / 1e6;

	await openMap(page, id, '&checks=1');
	const check = page.getByTestId('map-checks').locator(`[data-check="earlier-outline:${unit.id}"]`);
	await expect(check).toContainText(`${unit.name}'s area is from an earlier outline of Upper unit:`);
	await expectNoViolations(page);
	await check.getByTestId('map-check-use').click();
	await answerConfirm(page, true, `Set ${unit.name}’s area from the map?`);
	await expect(check).toHaveCount(0);
	const after = await (await page.request.get(`${API_URL}/projects/${id}/map/features`)).json();
	expect(after.nodes.find((n: { id: string }) => n.id === unit.id).areaKm2).toBeCloseTo(nowKm2, 9);
});
