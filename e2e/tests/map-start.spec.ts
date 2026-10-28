// Start a model from the map (issue #326 C3; docs/design/start-from-map.md,
// docs/ui.md § Map), against the committed synthetic DEM the e2e API reads
// (DEM_URL, support/dem.ts). The golden path: an editor opens an empty
// project's Map, whose empty state leads with Delineate and Draw (D4), starts
// the model from the map, delineates the valley from its outlet (typed
// coordinates: no assertion reads the map's pixels), has two units'
// boundaries on the map (start-16, #523 C1: the units follow the user's
// boundaries), places a dam inside one, has the network proposed, reviews it
// with every value unticked (the dam part of its unit's composite dam, never
// a unit), ticks them, and applies: the model has the outflow gauge, the two
// units with their boundaries' areas and the rest of the catchment, the dam
// linked to its unit, and the sheet moves on to the data. Discard returns to
// the points; a viewer is offered none of it. Axe-scanned on the review,
// light and dark, and on a phone. A gauge inside the catchment becomes a
// gauge node in the order, and each proposed piece carries its number on the
// map and on its card (#326 C3's follow-up). The outlet gauge is placed as
// Delineate places a click (start-15): on a hillside's terrain channel beside
// the river it names the larger channel, and Use that channel puts it there.
// A dam marked off-channel is part of its unit's composite dam, with no
// shares proposed (#90: its shares are the user's to enter).
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject } from '../support/api.ts';
import { FIXTURE_DAM, FIXTURE_LOWER_UNIT, FIXTURE_MID_GAUGE, FIXTURE_OFF_CHANNEL, FIXTURE_OUTLET, FIXTURE_UPPER_UNIT } from '../support/dem.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openMap } from '../support/map.ts';

const startSheet = (page: Page) => page.getByRole('dialog', { name: 'Start the model from the map' });
/** A feature on a project's map, through the API (the units' boundaries as an upload or a drawing would leave them). */
async function postFeature(page: Page, projectId: string, data: Record<string, unknown>): Promise<string> {
	const r = await page.request.post(`${API_URL}/projects/${projectId}/map/features`, { data });
	expect(r.status()).toBe(201);
	return ((await r.json()) as { feature: { id: string } }).feature.id;
}
const area = (ring: [number, number][]) => ({ type: 'Polygon', coordinates: [ring] });
const bar = (page: Page) => page.getByTestId('map-draw-bar');

/** From the Start sheet's boundary step: Delineate → Enter coordinates → the outlet → Accept as the catchment boundary. */
async function delineateBoundary(page: Page) {
	await startSheet(page).getByTestId('start-delineate').click();
	await expect(bar(page)).toContainText('Delineating a catchment');
	await bar(page).getByTestId('map-enter-coordinates').click();
	const d = page.getByRole('dialog', { name: 'Delineate a catchment' });
	await d.getByLabel('Latitude').fill(String(FIXTURE_OUTLET[1]));
	await d.getByLabel('Longitude').fill(String(FIXTURE_OUTLET[0]));
	await d.getByTestId('delineate-submit').click();
	const review = page.getByRole('dialog', { name: 'The delineated catchment' });
	await review.getByTestId('delineate-accept-boundary').click();
	await expect(page.getByTestId('map-notice')).toContainText('Saved Catchment above the outlet (delineated)');
}

/** From the points step: Place a point → Enter coordinates → a dam just below the wall. */
async function placeDam(page: Page) {
	await startSheet(page).getByTestId('start-place').click();
	await expect(bar(page)).toContainText('Placing a point');
	await bar(page).getByTestId('map-enter-coordinates').click();
	const place = page.getByRole('dialog', { name: 'Place a point' });
	await place.getByLabel('Kind').selectOption('dam');
	await place.getByLabel(/^Name/).fill('Valley dam');
	await place.getByLabel('Latitude').fill(String(FIXTURE_DAM[1]));
	await place.getByLabel('Longitude').fill(String(FIXTURE_DAM[0]));
	await place.getByRole('button', { name: 'Place the point' }).click();
	await expect(page.getByTestId('map-notice')).toContainText('Placed dam “Valley dam” on the map.');
}

test('an editor starts an empty model from the map: delineate, the units’ boundaries, place the dam, review the ticks, apply', async ({ page, owner }) => {
	void owner;
	// The whole flow in one test (each step needs the last): a delineation, a proposal routed on the DEM, five axe scans.
	test.setTimeout(90_000);
	const project = await createProject(page.request, 'Start from the map');
	await openMap(page, project.id);

	// D4: the empty map leads with delineating and drawing; upload is the other way.
	const empty = page.getByTestId('map-no-boundary');
	await expect(empty.getByTestId('map-empty-delineate')).toBeVisible();
	await expect(empty.getByTestId('map-draw-boundary')).toBeVisible();
	await expect(empty.getByRole('link', { name: 'upload it as a GeoJSON file' })).toBeVisible();
	await empty.getByTestId('map-empty-start').click();
	await expect(page).toHaveURL(/[?&]start=1(&|$)/);
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'boundary');

	// 1. The boundary, delineated: the sheet comes back at the points.
	await delineateBoundary(page);
	await expect(page).toHaveURL(/[?&]start=1(&|$)/);
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');
	await expect(startSheet(page).getByTestId('start-no-points')).toBeVisible();
	await expect(startSheet(page).getByTestId('start-outlet')).toHaveValue('');

	// 2. The units' boundaries (uploaded or drawn: here through the API, then a reload, which lands on the same step).
	const upper = await postFeature(page, project.id, { kind: 'other', name: 'Upper unit', geometry: area(FIXTURE_UPPER_UNIT) });
	await postFeature(page, project.id, { kind: 'other', name: 'Lower unit', geometry: area(FIXTURE_LOWER_UNIT) });
	await page.reload();
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');
	await expect(startSheet(page).getByLabel(/^Upper unit/)).toHaveValue('unit');
	// 3. The dam, placed inside the upper unit: part of its composite dam, never a unit of its own.
	await placeDam(page);
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');
	const damChoice = startSheet(page).getByLabel(/^Valley dam/);
	await expect(damChoice).toHaveValue('dam');
	await expect(damChoice.locator('option')).toHaveText(['Part of its unit’s composite dam', 'Another water user (no land)', 'Not in the model']);
	await expect(startSheet(page).getByTestId('start-count')).toHaveText('2 units, plus the rest of the catchment; 1 dam or pump as part of the unit around it.');
	await startSheet(page).getByTestId('start-propose').click();

	// 3. The proposal: nothing ticked until the editor ticks it; drawn dashed on the map meanwhile.
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'review');
	const review = page.getByTestId('start-review');
	await expect(review.getByTestId('start-catchment')).toHaveText(/^5[34]\d\.\d\d km²$/);
	const units = review.getByTestId('start-unit');
	await expect(units).toHaveCount(2);
	const unit = units.nth(0);
	await expect(unit.getByTestId('start-tick-area')).not.toBeChecked();
	await expect(unit.getByTestId('start-tick-drains')).not.toBeChecked();
	// The composite dam's shares are the user's to enter: no tick for them.
	await expect(unit.getByTestId('start-tick-dam')).toHaveCount(0);
	await expect(unit).toContainText('Drains into Lower unit');
	await expect(unit).toContainText(/Area 3\d\d\.\d\d km²: its boundary on the map \(the elevation model gives 3\d\d\.\d\d km² draining to its outflow\)/);
	await expect(unit.getByTestId('start-composite-dam')).toHaveText('Its composite dam: Valley dam. Its volume and the area draining to it are yours to enter on the unit; the register of dams is a reference only.');
	await expect(units.nth(1)).toContainText('Drains into Outflow gauge');
	await expect(review.getByTestId('start-tick-rest')).not.toBeChecked();
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expectNoViolations(page);
	}
	await page.emulateMedia({ colorScheme: 'light' });
	await page.setViewportSize({ width: 390, height: 844 });
	await startSheet(page).getByTestId('start-apply').scrollIntoViewIfNeeded();
	await expect(startSheet(page).getByTestId('start-apply')).toBeInViewport();
	await expectNoViolations(page);
	await page.setViewportSize({ width: 1440, height: 960 });
	// A reload lands on the same step (it is read from the server).
	await page.reload();
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'review');

	// A tick and a typed name survive closing the sheet and reopening it from the header.
	await unit.getByTestId('start-tick-area').check();
	await startSheet(page).getByRole('button', { name: 'Close', exact: true }).click();
	await page.getByTestId('section-header').getByTestId('map-start-open').click();
	await expect(page.getByTestId('start-review').getByTestId('start-unit').first().getByTestId('start-tick-area')).toBeChecked();
	await startSheet(page).getByTestId('start-tick-all').click();
	await expect(unit.getByTestId('start-tick-area')).toBeChecked();
	await expect(review.getByTestId('start-tick-rest-area')).toBeChecked();
	// The boundaries cover the catchment: nothing is left for the rest, which has no outline of its own.
	await expect(review.getByTestId('start-rest')).toContainText('Area 0.00 km²: the catchment less the units’ boundaries (no outline of its own)');
	// The valley's pan lies in the upper unit, but a boundary keeps its own area: no gross-or-effective choice (start-16).
	await expect(review.getByTestId('start-area-basis')).toHaveCount(0);
	await expect(review.getByTestId('start-warnings')).toContainText('Each unit keeps its boundary’s area (start-16): type a smaller one if you model them as non-contributing.');
	await expectNoViolations(page);
	await review.getByLabel('Outflow gauge’s name').fill('Valley weir');
	await startSheet(page).getByTestId('start-apply').click();
	const confirm = page.getByRole('alertdialog', { name: 'Apply the ticked values?' });
	await expect(confirm).toContainText('The empty model gets 4 hydrological units, with 3 areas (a unit’s is its boundary on the map) and 2 drains-into from the proposal.');
	await confirm.getByRole('button', { name: 'Apply' }).click();

	// 4. Data and the first run.
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'data');
	// The rain and the gauges are Data feeds, on the Data page (issue #586: it was on Settings); rain opens the boundary's proposal.
	await expect(startSheet(page).getByRole('link', { name: 'Rain from the boundary' })).toHaveAttribute('href', '?tab=series&rain=boundary#data-feeds');
	// Observed flow opens the DWS gauge's card, with the nearest gauging stations to the outlet proposed (#646 F4).
	await expect(startSheet(page).getByRole('link', { name: 'Observed flow' })).toHaveAttribute('href', '?tab=series&feed=dws#data-feeds');
	// Evaporation is a step of its own: with no A-pan the dams would lose nothing (round 4, persona-hydrologist).
	// Model settings' Demand holds the A-pan row; Calibration's Evaporation from the map proposes it (issue #586 split the two).
	await expect(startSheet(page).getByRole('link', { name: 'Evaporation', exact: true })).toHaveAttribute('href', '?tab=settings#set-demand');
	await expect(startSheet(page).getByRole('link', { name: 'Evaporation from the map', exact: true })).toHaveAttribute('href', '?tab=calibration#set-evaporation');
	await expect(startSheet(page).getByTestId('start-run')).toBeVisible();
	await expect(startSheet(page).getByRole('link', { name: 'Each unit’s composite dam' })).toHaveAttribute('href', '?tab=dams');
	await expect(page.getByTestId('map-notice')).toContainText('Started the model from the map.');

	// The evaporation link lands on Model settings' Demand group, where the A-pan row is, with its heading focused.
	await startSheet(page).getByRole('link', { name: 'Evaporation', exact: true }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Demand' })).toBeFocused();

	// The model: the weir, the two units with their boundaries' areas, and the rest.
	await page.goto(`/projects/${project.id}?tab=network`);
	for (const name of ['Valley weir', 'Upper unit', 'Lower unit', 'Rest of the catchment']) await expect(page.getByRole('main').getByText(name, { exact: true }).first()).toBeVisible();
	// The map: each unit's area is its boundary, from the map; the rest's is typed (it has no outline).
	await openMap(page, project.id);
	await expect(page.getByTestId('map-start-open')).toHaveCount(0);
	await expect(page.getByTestId('map-summary')).toContainText('2 of 3 unit areas from the map');
	const listed = await (await page.request.get(`${API_URL}/projects/${project.id}/map/features`)).json();
	const by = Object.fromEntries(listed.nodes.map((n: { name: string }) => [n.name, n]));
	expect(by['Upper unit']).toMatchObject({ areaSource: 'map', areaBasis: 'gross', areaFeatureId: upper });
	// The dam stands for the upper unit, part of its composite dam; nothing about the dam was filled in.
	const dam = listed.features.find((f: { name: string }) => f.name === 'Valley dam');
	expect(dam.nodeId).toBe(by['Upper unit'].id);
	const model = (await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json()) as { nodes: { name: string; damCapacityM3: number; pctRunoffToDam: number }[] };
	expect(model.nodes.find((n) => n.name === 'Upper unit')).toMatchObject({ damCapacityM3: 0, pctRunoffToDam: 0 });
});

test('Discard returns to the points and changes nothing; with no units the catchment becomes one', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Start discard');
	await openMap(page, project.id, '&start=1');
	await delineateBoundary(page);
	await startSheet(page).getByTestId('start-propose').click();
	await expect(page.getByTestId('start-review').getByTestId('start-unit')).toHaveCount(0);
	const rest = page.getByTestId('start-review').getByTestId('start-rest');
	await expect(rest).toBeVisible();
	// The whole catchment is the rest, with the valley's pan in it (195): its ticked area asks which, gross until changed.
	await rest.getByTestId('start-tick-rest').check();
	await rest.getByTestId('start-tick-rest-area').check();
	await expect(rest.getByTestId('start-rest-area-basis').getByRole('radio', { name: /^Gross, 5[34]\d\.\d\d km² \(what drains into pans included\)$/ })).toBeChecked();
	await startSheet(page).getByTestId('start-discard').click();
	await page.getByRole('alertdialog', { name: 'Discard the proposed model?' }).getByRole('button', { name: 'Discard' }).click();
	await expect(page.getByTestId('map-notice')).toHaveText(/Discarded the proposed model; nothing in the model changed\./);
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');
	await startSheet(page).getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByTestId('section-header').getByTestId('map-start-open')).toHaveText('Start from the map');
	// A tool started from the header, then cancelled, never brings the sheet back.
	await page.getByTestId('map-tools').getByRole('button', { name: 'Place a point', exact: true }).click();
	await bar(page).getByRole('button', { name: 'Cancel' }).click();
	await page.getByTestId('map-tools').getByRole('button', { name: 'Place a point', exact: true }).click();
	await bar(page).getByTestId('map-enter-coordinates').click();
	const place = page.getByRole('dialog', { name: 'Place a point' });
	await place.getByLabel('Latitude').fill(String(FIXTURE_DAM[1]));
	await place.getByLabel('Longitude').fill(String(FIXTURE_DAM[0]));
	await place.getByRole('button', { name: 'Place the point' }).click();
	await expect(page.getByTestId('map-notice')).toContainText('Placed gauge');
	await expect(page).not.toHaveURL(/start=/);
	await expect(startSheet(page)).toHaveCount(0);
});

test('a viewer is offered no start, and a link to it does nothing', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Start viewer');
	const viewer = await signIn('Start viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=map&start=1`);
	await expect(viewer.page.locator('.map-page[data-ready]')).toBeVisible();
	await expect(viewer.page).not.toHaveURL(/start=/);
	await expect(viewer.page.getByRole('dialog')).toHaveCount(0);
	await expect(viewer.page.getByTestId('map-empty-start')).toHaveCount(0);
	await expect(viewer.page.getByTestId('map-empty-delineate')).toHaveCount(0);
});

test('a gauge inside the catchment becomes a gauge node; each piece has its number on the map and on its card', async ({ page, owner }) => {
	void owner;
	test.setTimeout(60_000);
	// Picking the gauge frames the map on it; without reduced motion that is a 600 ms flight, and the hover below would
	// aim at a badge still moving under the pointer (CI, #391). The animation isn't what this test checks.
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const project = await createProject(page.request, 'Start with a gauge');
	const post = async (data: Record<string, unknown>) => {
		const r = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, { data });
		expect(r.status()).toBe(201);
		return ((await r.json()) as { feature: { id: string } }).feature.id;
	};
	const weir = await post({ kind: 'gauge', name: 'Valley weir', lon: FIXTURE_OUTLET[0], lat: FIXTURE_OUTLET[1] });
	await post({ kind: 'other', name: 'Upper unit', geometry: area(FIXTURE_UPPER_UNIT) });
	await post({ kind: 'dam', name: 'Valley dam', lon: FIXTURE_DAM[0], lat: FIXTURE_DAM[1] });
	await post({ kind: 'gauge', name: 'Mid weir', lon: FIXTURE_MID_GAUGE[0], lat: FIXTURE_MID_GAUGE[1] });
	await openMap(page, project.id, '&start=1');
	// No boundary: the outlet is a gauge.
	await startSheet(page).getByTestId('start-skip-boundary').click();
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');
	await startSheet(page).getByTestId('start-outlet').selectOption(weir);
	// A gauge other than the outlet is a gauge node by default, and offers nothing else but leaving it out.
	const mid = startSheet(page).getByLabel(/^Mid weir/);
	await expect(mid).toHaveValue('gauge');
	await expect(mid.locator('option')).toHaveText(['A gauge in the network (no land)', 'Not in the model']);
	await expect(startSheet(page).getByTestId('start-count')).toHaveText('1 unit, 1 gauge, plus the rest of the catchment; 1 dam or pump as part of the unit around it.');
	await startSheet(page).getByTestId('start-propose').click();

	// The review: the upper unit (1) drains into the gauge (2), which measures the land above it and owns none.
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'review');
	const units = page.getByTestId('start-review').getByTestId('start-unit');
	await expect(units).toHaveCount(2);
	await expect(units.nth(0).getByTestId('piece-badge')).toHaveText('Piece 1: 1');
	await expect(units.nth(0)).toContainText('Drains into Mid weir');
	await expect(units.nth(1).getByTestId('piece-badge')).toHaveText('Piece 2: 2');
	await expect(units.nth(1)).toContainText(/It measures 4\d\d\.\d\d km² of the catchment above it/);
	await expect(units.nth(1).getByTestId('start-tick-area')).toHaveCount(0);
	// Beside a unit's boundary the rest has no outline of its own, so no piece on the map.
	await expect(page.getByTestId('start-review').getByTestId('start-rest').getByTestId('piece-badge')).toHaveCount(0);
	await expectNoViolations(page);

	// On the map (when it can draw): a number per piece, and a card with the focus lights its piece.
	const mapBox = page.getByTestId('catchment-map').locator('xpath=..');
	// The map draws in CI's browser (map-draw.spec.ts asserts the same), so the pieces are checked, never skipped.
	await expect(mapBox).toHaveAttribute('data-status', 'ready');
	{
		const badges = page.locator('.piece-badge');
		await expect(badges).toHaveText(['1', '2']);
		await units.nth(0).getByRole('textbox').focus();
		await expect(page.locator('.piece-badge[data-lit="true"]')).toHaveText('1');
		// With the sheet closed, a number under the pointer names its piece; a click opens its card.
		await startSheet(page).getByRole('button', { name: 'Close', exact: true }).click();
		await expect(page.locator('.piece-badge[data-lit="true"]')).toHaveCount(0);
		// Closed, the page says in words what the pieces are; the gauge's own marker stays clickable beside its number.
		await expect(page.getByTestId('map-pieces-pending')).toContainText('numbered as its card in the sheet');
		await page.getByRole('button', { name: 'Gauge: Mid weir' }).click();
		await expect(page).toHaveURL(/[?&]feature=/);
		await expect(page).not.toHaveURL(/[?&]start=1/);
		await badges.filter({ hasText: '2' }).hover();
		await expect(page.getByTestId('map-piece-name')).toContainText('Proposed piece 2');
		await expect(page.getByTestId('map-piece-name')).toContainText('Mid weir');
		await badges.filter({ hasText: '2' }).click();
		await expect(page).toHaveURL(/[?&]start=1(&|$)/);
		await expect(units.nth(1).getByRole('textbox')).toBeFocused();
	}

	await startSheet(page).getByTestId('start-tick-all').click();
	await startSheet(page).getByTestId('start-apply').click();
	await page.getByRole('alertdialog', { name: 'Apply the ticked values?' }).getByRole('button', { name: 'Apply' }).click();
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'data');
	// The model: the gauge is a gauge node between the upper unit and the outflow.
	const model = (await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json()) as { nodes: { id: string; name: string; kind: string; downstreamNodeId: string | null }[] };
	const by = Object.fromEntries(model.nodes.map((n) => [n.name, n]));
	expect(by['Mid weir']).toMatchObject({ kind: 'gauge', downstreamNodeId: by['Valley weir']!.id });
	expect(by['Upper unit']).toMatchObject({ kind: 'farm', downstreamNodeId: by['Mid weir']!.id });
	expect(by['Valley dam']).toBeUndefined();
});

/** A project with one gauge on the map at `at`, the Start sheet open at the points with it as the outlet. */
async function startAtGauge(page: Page, name: string, at: [number, number]): Promise<void> {
	const project = await createProject(page.request, name);
	const r = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, { data: { kind: 'gauge', name: 'Weir', lon: at[0], lat: at[1] } });
	expect(r.status()).toBe(201);
	const weir = ((await r.json()) as { feature: { id: string } }).feature.id;
	await openMap(page, project.id, '&start=1');
	await startSheet(page).getByTestId('start-skip-boundary').click();
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');
	await startSheet(page).getByTestId('start-outlet').selectOption(weir);
}

test('an outlet gauge on a small terrain channel beside the river: the larger channel is named, and Use that channel puts the outlet on it', async ({ page, owner }) => {
	void owner;
	test.setTimeout(60_000);
	// Three cells off the river, as a displaced river line puts a gauge: on the hillside's small terrain channel there.
	await startAtGauge(page, 'Start beside the river', FIXTURE_OFF_CHANNEL);
	await startSheet(page).getByTestId('start-propose').click();
	const review = page.getByTestId('start-review');
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'review');
	await expect(review.getByTestId('start-warnings')).toContainText(/A much larger terrain channel runs \d+ m west of the outlet \(Weir\)/);
	await expect(review.getByTestId('start-outlet-placement')).toHaveText(/^The outlet: On the nearest terrain channel, \d+ m from the point\.$/);
	await expect(review.getByTestId('start-catchment')).toHaveText(/^\d\.\d\d km²$/);
	await expectNoViolations(page);
	await review.getByTestId('start-outlet-use-larger').click();
	// Proposed again with the outlet on the river: the valley above the mid gauge, hundreds of km².
	await expect(review.getByTestId('start-outlet-placement')).toHaveText(/^The outlet: On the larger channel, as you chose, \d+ m from the point\.$/);
	await expect(review.getByTestId('start-catchment')).toHaveText(/^[34]\d\d\.\d\d km²$/);
	await expect(review.getByTestId('start-outlet-use-larger')).toHaveCount(0);
});

test('a long dam marked off-channel is part of its unit’s composite dam: never a unit, no shares proposed, linked on apply (194, start-16)', async ({ page, owner }) => {
	void owner;
	test.setTimeout(60_000);
	const project = await createProject(page.request, 'Start with an off-channel dam');
	const projectId = project.id;
	const weir = await postFeature(page, projectId, { kind: 'gauge', name: 'Weir', lon: FIXTURE_OUTLET[0], lat: FIXTURE_OUTLET[1] });
	await postFeature(page, projectId, { kind: 'other', name: 'Lower unit', geometry: area(FIXTURE_LOWER_UNIT) });
	// Three cells wide and 20 long, the river its west column all the way, inside the lower unit's boundary.
	const ring = [
		[20.7421875, -33.4474849],
		[20.7463074, -33.4474849],
		[20.7463074, -33.4703991],
		[20.7421875, -33.4703991],
		[20.7421875, -33.4474849]
	];
	const damId = await postFeature(page, projectId, { kind: 'dam', name: 'Long dam', geometry: { type: 'Polygon', coordinates: [ring] } });
	expect((await page.request.patch(`${API_URL}/projects/${projectId}/map/features/${damId}`, { data: { damPosition: 'off_channel' } })).status()).toBe(200);
	await openMap(page, projectId, '&start=1');
	await startSheet(page).getByTestId('start-skip-boundary').click();
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');
	await startSheet(page).getByTestId('start-outlet').selectOption(weir);
	await expect(startSheet(page).getByLabel(/^Long dam/)).toHaveValue('dam');
	await startSheet(page).getByTestId('start-propose').click();

	const review = page.getByTestId('start-review');
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'review');
	// One unit, the lower one, which holds the outlet: the dam is part of it, and offers no shares.
	const unit = review.getByTestId('start-unit');
	await expect(unit).toHaveCount(1);
	await expect(unit).toContainText('Lower unit');
	await expect(unit.getByTestId('start-composite-dam')).toContainText('Its composite dam: Long dam.');
	await expect(unit.getByTestId('start-tick-upstream')).toHaveCount(0);
	await expect(unit.getByTestId('start-tick-dam')).toHaveCount(0);
	await expect(unit.getByTestId('start-placement')).toHaveText('Its boundary’s outflow: the most-drained cell inside it above the outlet, where its order is read from.');
	await expectNoViolations(page);
	await startSheet(page).getByTestId('start-tick-all').click();
	await startSheet(page).getByTestId('start-apply').click();
	await page.getByRole('alertdialog', { name: 'Apply the ticked values?' }).getByRole('button', { name: 'Apply' }).click();
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'data');

	const listed = await (await page.request.get(`${API_URL}/projects/${projectId}/map/features`)).json();
	const lower = listed.nodes.find((n: { name: string }) => n.name === 'Lower unit');
	expect(listed.features.find((f: { id: string }) => f.id === damId).nodeId).toBe(lower.id);
	const model = (await (await page.request.get(`${API_URL}/projects/${projectId}/model`)).json()) as { nodes: { name: string; pctUpstreamToDam: number; pctRunoffToDam: number }[] };
	// The shares stay a new unit's defaults, for the user to enter: nothing proposed from the dam's siting.
	expect(model.nodes.find((n) => n.name === 'Lower unit')).toMatchObject({ pctUpstreamToDam: 1, pctRunoffToDam: 0 });
});
