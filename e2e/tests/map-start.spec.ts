// Start a model from the map (issue #326 C3; docs/design/start-from-map.md,
// docs/ui.md § Map), against the committed synthetic DEM the e2e API reads
// (DEM_URL, support/dem.ts). The golden path: an editor opens an empty
// project's Map, whose empty state leads with Delineate and Draw (D4), starts
// the model from the map, delineates the valley from its outlet (typed
// coordinates: no assertion reads the map's pixels), places the dam, has the
// network proposed, reviews it with every value unticked, ticks them, and
// applies: the model has the outflow gauge, the dam's unit and the rest of
// the catchment, with their areas from the map, and the sheet moves on to
// the data. Discard returns to the points; a viewer is offered none of it.
// Axe-scanned on the review, light and dark, and on a phone. A gauge inside
// the catchment becomes a gauge node in the order, and each proposed piece
// carries its number on the map and on its card (#326 C3's follow-up).
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject } from '../support/api.ts';
import { FIXTURE_DAM, FIXTURE_MID_GAUGE, FIXTURE_OUTLET } from '../support/dem.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openMap } from '../support/map.ts';

const startSheet = (page: Page) => page.getByRole('dialog', { name: 'Start the model from the map' });
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

test('an editor starts an empty model from the map: delineate, place the dam, review the ticks, apply', async ({ page, owner }) => {
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

	// 2. The dam, placed: listed as a unit with a dam.
	await placeDam(page);
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');
	await expect(startSheet(page).getByLabel(/^Valley dam/)).toHaveValue('dam');
	await expect(startSheet(page).getByTestId('start-count')).toHaveText('1 unit, plus the rest of the catchment.');
	await startSheet(page).getByTestId('start-propose').click();

	// 3. The proposal: nothing ticked until the editor ticks it; drawn dashed on the map meanwhile.
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'review');
	const review = page.getByTestId('start-review');
	await expect(review.getByTestId('start-catchment')).toHaveText(/^5[34]\d\.\d\d km²$/);
	const unit = review.getByTestId('start-unit');
	await expect(unit).toHaveCount(1);
	await expect(unit.getByTestId('start-tick-area')).not.toBeChecked();
	await expect(unit.getByTestId('start-tick-drains')).not.toBeChecked();
	await expect(unit.getByTestId('start-tick-dam')).not.toBeChecked();
	await expect(unit).toContainText('Drains into Outflow gauge');
	await expect(unit).toContainText(/Area 3[2-5]\d\.\d\d km²/);
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
	await expect(page.getByTestId('start-review').getByTestId('start-unit').getByTestId('start-tick-area')).toBeChecked();
	await startSheet(page).getByTestId('start-tick-all').click();
	await expect(unit.getByTestId('start-tick-area')).toBeChecked();
	await expect(unit.getByTestId('start-tick-dam')).toBeChecked();
	await expect(review.getByTestId('start-tick-rest-area')).toBeChecked();
	await review.getByLabel('Outflow gauge’s name').fill('Valley weir');
	await startSheet(page).getByTestId('start-apply').click();
	const confirm = page.getByRole('alertdialog', { name: 'Apply the ticked values?' });
	await expect(confirm).toContainText('The empty model gets 3 nodes, with 2 areas');
	await confirm.getByRole('button', { name: 'Apply' }).click();

	// 4. Data and the first run.
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'data');
	await expect(startSheet(page).getByRole('link', { name: 'Rain from the boundary' })).toBeVisible();
	// Evaporation is a step of its own: with no A-pan the dams would lose nothing (round 4, persona-hydrologist).
	await expect(startSheet(page).getByRole('link', { name: 'Evaporation' })).toHaveAttribute('href', '?tab=settings#set-demand');
	await expect(startSheet(page).getByTestId('start-run')).toBeVisible();
	await expect(page.getByTestId('map-notice')).toContainText('Started the model from the map.');

	// The evaporation link lands on Settings' Demand group, where the A-pan row is, with its heading focused.
	await startSheet(page).getByRole('link', { name: 'Evaporation' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Demand' })).toBeFocused();

	// The model: the weir, the dam's unit draining into it with its area from the map, and the rest.
	await page.goto(`/projects/${project.id}?tab=network`);
	for (const name of ['Valley weir', 'Valley dam', 'Rest of the catchment']) await expect(page.getByRole('main').getByText(name, { exact: true }).first()).toBeVisible();
	// The map: the dam's unit has its parcel, from the map.
	await openMap(page, project.id);
	await expect(page.getByTestId('map-start-open')).toHaveCount(0);
	await expect(page.getByTestId('map-feature-list').getByRole('button', { name: /^Valley dam/ }).first()).toBeVisible();
	await expect(page.getByTestId('map-summary')).toContainText('2 of 2 unit areas from the map');
});

test('Discard returns to the points and changes nothing; with no units the catchment becomes one', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Start discard');
	await openMap(page, project.id, '&start=1');
	await delineateBoundary(page);
	await startSheet(page).getByTestId('start-propose').click();
	await expect(page.getByTestId('start-review').getByTestId('start-unit')).toHaveCount(0);
	await expect(page.getByTestId('start-review').getByTestId('start-rest')).toBeVisible();
	await startSheet(page).getByTestId('start-discard').click();
	await page.getByRole('alertdialog', { name: 'Discard the proposed model?' }).getByRole('button', { name: 'Discard' }).click();
	await expect(page.getByTestId('map-notice')).toHaveText(/Discarded the proposed model; nothing in the model changed\./);
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'points');
	await startSheet(page).getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByTestId('section-header').getByTestId('map-start-open')).toHaveText('Start from the map');
	// A tool started from the header, then cancelled, never brings the sheet back.
	await page.getByTestId('section-header').getByRole('button', { name: 'Place a point' }).click();
	await bar(page).getByRole('button', { name: 'Cancel' }).click();
	await page.getByTestId('section-header').getByRole('button', { name: 'Place a point' }).click();
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
	const project = await createProject(page.request, 'Start with a gauge');
	const post = async (data: Record<string, unknown>) => {
		const r = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, { data });
		expect(r.status()).toBe(201);
		return ((await r.json()) as { feature: { id: string } }).feature.id;
	};
	const weir = await post({ kind: 'gauge', name: 'Valley weir', lon: FIXTURE_OUTLET[0], lat: FIXTURE_OUTLET[1] });
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
	await expect(startSheet(page).getByTestId('start-count')).toHaveText('1 unit and 1 gauge, plus the rest of the catchment.');
	await startSheet(page).getByTestId('start-propose').click();

	// The review: the dam (1) drains into the gauge (2), which measures the land above it and owns none.
	await expect(page.getByTestId('start-sheet')).toHaveAttribute('data-step', 'review');
	const units = page.getByTestId('start-review').getByTestId('start-unit');
	await expect(units).toHaveCount(2);
	await expect(units.nth(0).getByTestId('piece-badge')).toHaveText('Piece 1: 1');
	await expect(units.nth(0)).toContainText('Drains into Mid weir');
	await expect(units.nth(1).getByTestId('piece-badge')).toHaveText('Piece 2: 2');
	await expect(units.nth(1)).toContainText(/It measures 4\d\d\.\d\d km² of the catchment above it/);
	await expect(units.nth(1).getByTestId('start-tick-area')).toHaveCount(0);
	await expect(page.getByTestId('start-review').getByTestId('start-rest').getByTestId('piece-badge')).toHaveText('Piece R: R');
	await expectNoViolations(page);

	// On the map (when it can draw): a number per piece, and a card with the focus lights its piece.
	const mapBox = page.getByTestId('catchment-map').locator('xpath=..');
	// The map draws in CI's browser (map-draw.spec.ts asserts the same), so the pieces are checked, never skipped.
	await expect(mapBox).toHaveAttribute('data-status', 'ready');
	{
		const badges = page.locator('.piece-badge');
		await expect(badges).toHaveText(['1', '2', 'R']);
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
	// The model: the gauge is a gauge node between the dam and the outflow.
	const model = (await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json()) as { nodes: { id: string; name: string; kind: string; downstreamNodeId: string | null }[] };
	const by = Object.fromEntries(model.nodes.map((n) => [n.name, n]));
	expect(by['Mid weir']).toMatchObject({ kind: 'gauge', downstreamNodeId: by['Valley weir']!.id });
	expect(by['Valley dam']).toMatchObject({ kind: 'farm', downstreamNodeId: by['Mid weir']!.id });
});
