// Delineating a catchment from a point (issue #326 B-delineate, #342 map item
// 4; docs/design/delineation.md, docs/ui.md § Map), against the committed
// synthetic DEM the e2e API reads (DEM_URL, support/dem.ts). An editor
// starts Delineate from the header, gives the outlet's coordinates (the
// non-pointer path; no assertion reads the map's pixels), reviews the
// proposal's area, dataset and caveats, and accepts it as the catchment
// boundary. With a boundary already there, accepting as the boundary waits
// for the Replace tick (never silently), Reject leaves the map alone, and a
// point outside the DEM is refused with its reason. A viewer gets no
// Delineate. Axe-scanned on the review, light and dark.
//
// The operator's questions (2026-10-03): what are the two kinds of line, why
// do the channels go when the proposal shows, which line does the catchment
// follow, and how does the boundary reach the model? The bar and the Key name
// the terrain channels and the mapped rivers in words, the channels stay
// (dimmed) behind the proposal until it is decided, and after accepting a
// boundary the toast and its card offer Divide the model (Start from the map
// for an empty model).
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, seedRunnableProject } from '../support/api.ts';
import { FIXTURE_DAM, FIXTURE_JUNCTION, FIXTURE_JUNCTION_RIVER, FIXTURE_JUNCTION_TRIBUTARY, FIXTURE_MID_GAUGE, FIXTURE_OFF_CHANNEL, FIXTURE_OUTLET } from '../support/dem.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { boundaryGeoJson, loadRiverNetwork, openKey, openMap, showTab, uploadThroughSheet } from '../support/map.ts';

const sheet = (page: Page, name = 'Delineate a catchment') => page.getByRole('dialog', { name });
const review = (page: Page) => sheet(page, 'The delineated catchment');

/** Delineate → the draw bar → Enter coordinates → the sheet, filled and submitted. */
async function delineateAt(page: Page, [lon, lat]: [number, number], from: 'The catchment’s outlet' | 'Just below a dam wall' = 'The catchment’s outlet') {
	await page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true }).click();
	await expect(page.getByTestId('map-draw-bar')).toContainText('Delineating a catchment');
	await page.getByTestId('map-enter-coordinates').click();
	const s = sheet(page);
	await expect(s).toBeVisible();
	await expect(page).toHaveURL(/[?&]delineate=1(&|$)/);
	await s.getByRole('radio', { name: from }).check();
	await s.getByLabel('Latitude').fill(String(lat));
	await s.getByLabel('Longitude').fill(String(lon));
	await s.getByTestId('delineate-submit').click();
}

test('an editor delineates the valley from its outlet, reviews it and accepts it as the catchment boundary', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Delineate golden path');
	await openMap(page, project.id);
	await delineateAt(page, FIXTURE_OUTLET);

	const r = review(page);
	await expect(r).toBeVisible();
	// The synthetic valley is about 547 km² (backend/src/delineation/fixture.ts).
	await expect(r.getByTestId('delineate-fact-area')).toHaveText(/^5[34]\d\.\d\d km²$/);
	// The valley's pan (fixture.ts PAN): what drains into it is reported beside the area, with the effective area (delineate-9).
	await expect(r.getByTestId('delineate-fact-into-pans')).toHaveText(/^\d\.\d\d km² \(\d+ %\) drains into a pan; the largest holds [\d\s]+ mm over its \d\.\d\d km²\. Non-contributing in WR2012’s sense; still inside the area and outline$/);
	await expect(r.getByTestId('delineate-fact-effective-area')).toHaveText(/^5[34]\d\.\d\d km², if the pans contribute nothing$/);
	// The focused Delineate button went with the form: the sheet's title has the focus.
	await expect(r.getByRole('heading', { name: 'The delineated catchment' })).toBeFocused();
	await r.getByText('How it was made').click();
	await expect(r.getByTestId('delineate-fact-dataset')).toContainText('Synthetic DEM');
	await expect(r.getByTestId('delineate-fact-method')).toContainText('[delineate-12]');
	await expect(r.getByTestId('delineate-fact-pans')).toContainText('Non-contributing (pans)');
	await expect(r.getByRole('heading', { name: 'Before you accept it' })).toBeVisible();
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expectNoViolations(page);
	}
	await page.emulateMedia({ colorScheme: 'light' });
	// A phone: the decision buttons in reach, and no violations.
	await page.setViewportSize({ width: 390, height: 844 });
	await r.getByTestId('delineate-reject').scrollIntoViewIfNeeded();
	await expect(r.getByTestId('delineate-reject')).toBeInViewport();
	await expectNoViolations(page);
	await page.setViewportSize({ width: 1440, height: 960 });
	// A reload keeps the sheet (the param is judged once the state is in).
	await page.reload();
	await expect(review(page)).toBeVisible();
	await expect(page).toHaveURL(/[?&]delineate=1(&|$)/);

	await r.getByTestId('delineate-accept-boundary').click();
	await expect(page.getByTestId('map-notice')).toContainText('Saved Catchment above the outlet (delineated), 5');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page).not.toHaveURL(/delineate=/);
	await expect(page).toHaveURL(/[?&]feature=/);
	await expect(page.getByTestId('map-feature-card').getByRole('heading', { name: 'Catchment above the outlet (delineated)' })).toBeVisible();
	await expect(page.getByTestId('map-summary')).toContainText('1 feature');
	await expect(page.getByTestId('map-delineation-pending')).toHaveCount(0);
	// What it is, and the next step: a boundary on the map, not the model yet; the model has nodes, so Divide the model.
	await expect(page.getByTestId('map-notice')).toContainText('on the map as the catchment boundary. It isn’t in the model yet.');
	await expect(page.getByTestId('map-notice-next')).toHaveText('Divide the model');
	await expect(page.getByTestId('map-notice-next')).toHaveAttribute('href', /[?&]divide=1(&|$)/);
	const next = page.getByTestId('map-boundary-next');
	await expect(next).toContainText('This boundary is on the map, not in the model yet. Divide the model splits it into each unit’s area at your dams, abstraction points and gauges, for you to tick.');
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expectNoViolations(page);
	}
	await page.emulateMedia({ colorScheme: 'light' });
	await next.getByTestId('map-boundary-next-open').click();
	await expect(page.getByRole('dialog', { name: 'Divide the model from the map' })).toBeVisible();
	await expect(page).toHaveURL(/[?&]divide=1(&|$)/);
	// Back closes the sheet and leaves the boundary's card with its next step.
	await page.goBack();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByTestId('map-boundary-next')).toBeVisible();
});

/** A small square round `[lon, lat]` uploaded as an "other" area: Show everything then frames a view the channels draw in. */
const squareAround = ([lon, lat]: [number, number], d = 0.03) =>
	JSON.stringify({
		type: 'FeatureCollection',
		features: [
			{
				type: 'Feature',
				properties: { name: 'View square' },
				geometry: {
					type: 'Polygon',
					coordinates: [
						[
							[lon - d, lat - d],
							[lon + d, lat - d],
							[lon + d, lat + d],
							[lon - d, lat + d],
							[lon - d, lat - d]
						]
					]
				}
			}
		]
	});

test('while delineating, the bar and the Key say which line is which; the channels stay, dimmed, behind the proposal and go once it is decided', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	// The River network layer on (its key entry and the bar's line show while the layer is; no reach is loaded near
	// the valley, since river datasets are global to the e2e database and a reach there moves other specs' clicks).
	const project = await seedRunnableProject(page.request, 'Delineate lines');
	await openMap(page, project.id, '&layers=rivers');
	await uploadThroughSheet(page, 'other', 'square.geojson', squareAround([FIXTURE_MID_GAUGE[0], -33.515]));
	await expect(page.locator('.map-wrap[data-status="ready"]')).toBeVisible();
	await page.getByTestId('map-show-everything').click();
	const body = page.locator('.map-body');
	await expect(body).not.toHaveAttribute('data-channels');

	await page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true }).click();
	const bar = page.getByTestId('map-draw-bar');
	// What to click and what the result follows, in two sentences.
	await expect(bar.getByTestId('map-draw-how')).toHaveText(
		'Click a terrain channel at the catchment’s outlet, or just below a dam wall. The catchment follows the terrain: all the land that drains to that point.'
	);
	const lines = bar.getByTestId('map-delineation-lines');
	await expect(lines.getByRole('listitem')).toHaveText([
		'Terrain channels: where your click goes; the outline follows these',
		'River network: mapped rivers, for reference only; they can sit off the terrain channels'
	]);
	await expect(body).toHaveAttribute('data-channels', 'on');
	await expect(body).not.toHaveAttribute('data-channel-tiles', '0');
	// The Key names both lines in the same words.
	await openKey(page);
	const key = page.getByTestId('map-key');
	await expect(key.locator('[data-key-item="terrain channels"]')).toHaveText('terrain channels: where your click goes; the outline follows these');
	await expect(key.locator('[data-key-item="river network"]')).toHaveText('river network: mapped rivers, for reference only; they can sit off the terrain channels');
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expectNoViolations(page);
	}
	await page.emulateMedia({ colorScheme: 'light' });
	// A phone: the bar's lines wrap under its how-to, nothing scrolls sideways.
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(lines).toBeVisible();
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);
	await page.setViewportSize({ width: 1440, height: 960 });

	// The proposal: the click step ends, the channels stay behind it, dimmed, and the Key still names them.
	await bar.getByTestId('map-enter-coordinates').click();
	const s = sheet(page);
	await s.getByLabel('Latitude').fill(String(FIXTURE_OUTLET[1]));
	await s.getByLabel('Longitude').fill(String(FIXTURE_OUTLET[0]));
	await s.getByTestId('delineate-submit').click();
	await expect(review(page)).toBeVisible();
	await expect(page.getByTestId('map-draw-bar')).toHaveCount(0);
	await expect(body).toHaveAttribute('data-channels', 'dim');
	await expect(review(page)).toContainText('its outline follows the terrain channels, drawn dimmed behind it');
	await review(page).getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByTestId('map-delineation-pending')).toContainText('drawn dashed on the map over the terrain channels it follows, waiting for your decision.');
	await expect(body).toHaveAttribute('data-channels', 'dim');
	// Back from the phone, the Key's tab fell back to the list: open it again.
	await openKey(page);
	await expect(key.locator('[data-key-item="terrain channels"]')).toBeVisible();

	// Rejected: the channels go with it, and the Key drops them.
	await page.getByTestId('map-delineation-pending').getByRole('link', { name: 'Review it' }).click();
	await review(page).getByTestId('delineate-reject').click();
	await expect(page.getByTestId('map-notice')).toHaveText(/Rejected the delineated catchment/);
	await expect(body).not.toHaveAttribute('data-channels');
	await expect(key.locator('[data-key-item="terrain channels"]')).toHaveCount(0);
	await expect(key.locator('[data-key-item="river network"]')).toHaveText('river network');
});

test('an empty model: Delineate from the Getting started pill, accept the boundary, and Start from the map is the next step', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Delineate empty model');
	await openMap(page, project.id);
	await page.getByTestId('map-setup-pill').click();
	await page.getByTestId('map-setup-delineate').click();
	await expect(page.getByTestId('map-draw-bar')).toContainText('Delineating a catchment');
	await page.getByTestId('map-enter-coordinates').click();
	const s = sheet(page);
	await s.getByLabel('Latitude').fill(String(FIXTURE_OUTLET[1]));
	await s.getByLabel('Longitude').fill(String(FIXTURE_OUTLET[0]));
	await s.getByTestId('delineate-submit').click();
	await review(page).getByTestId('delineate-accept-boundary').click();
	await expect(page.getByTestId('map-notice')).toContainText('It isn’t in the model yet.');
	await expect(page.getByTestId('map-boundary-next')).toContainText('Start from the map proposes the model’s units from it');
	await page.getByTestId('map-notice-next').click();
	await expect(page.getByRole('dialog', { name: 'Start the model from the map' })).toBeVisible();
	await expect(page).toHaveURL(/[?&]start=1(&|$)/);
});

test('a boundary is replaced only with the tick; Reject changes nothing; a point outside the DEM is refused', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Delineate replace');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());

	// Outside the DEM: refused in the sheet with the reason, nothing proposed.
	await delineateAt(page, [25, -30]);
	await expect(sheet(page).getByTestId('delineate-error')).toContainText('outside the elevation model');
	await sheet(page).getByRole('button', { name: 'Close', exact: true }).click();
	await page.getByTestId('map-draw-bar').getByRole('button', { name: 'Cancel' }).click();

	// From the dam wall, then Reject.
	await delineateAt(page, FIXTURE_DAM, 'Just below a dam wall');
	await expect(review(page).getByTestId('delineate-fact-area')).toHaveText(/^3[2-5]\d\.\d\d km²$/);
	await review(page).getByTestId('delineate-reject').click();
	await expect(page.getByTestId('map-notice')).toHaveText(/Rejected the delineated catchment; nothing on the map changed\./);
	await expect(page.getByTestId('map-summary')).toContainText('1 feature');
	// The sheet's opener (the draw bar) is gone: focus comes back to Delineate, not to <body> (WCAG 2.4.3).
	await expect(page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true })).toBeFocused();

	// From the outlet: accepting as the boundary waits for the tick.
	await delineateAt(page, FIXTURE_OUTLET);
	const r = review(page);
	const accept = r.getByTestId('delineate-accept-boundary');
	await expect(accept).toBeDisabled();
	// With it waiting, Delineate → Enter coordinates asks for a new point, and Back to the proposal returns to it.
	await r.getByRole('button', { name: 'Close', exact: true }).click();
	await page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true }).click();
	await page.getByTestId('map-enter-coordinates').click();
	await expect(sheet(page).getByTestId('delineate-form')).toBeVisible();
	await sheet(page).getByTestId('delineate-back').click();
	await expect(review(page).getByTestId('delineate-accept-boundary')).toBeVisible();
	await review(page).getByRole('button', { name: 'Close', exact: true }).click();
	await page.getByTestId('map-draw-bar').getByRole('button', { name: 'Cancel' }).click();
	// Closed, the proposal waits on the page, and Review it reopens it.
	await expect(page.getByTestId('map-delineation-pending')).toContainText('waiting for your decision');
	await page.getByTestId('map-delineation-pending').getByRole('link', { name: 'Review it' }).click();
	await expect(review(page)).toBeVisible();
	await review(page).getByTestId('delineate-replace').check();
	await review(page).getByTestId('delineate-accept-boundary').click();
	await expect(page.getByTestId('map-notice')).toContainText('Saved Catchment above the outlet (delineated)');
	await expect(page.getByTestId('map-summary')).toContainText('1 feature');
	await showTab(page, 'features');
	await expect(page.getByTestId('map-feature-list').getByRole('button', { name: /^Catchment above the outlet/ })).toBeVisible();
	await expect(page.getByTestId('map-feature-list').getByRole('button', { name: /^Synthetic catchment/ })).toHaveCount(0);
});

test('leaving Delineate for Place a point or Draw a shape leaves the delineating behind', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Delineate modes');
	await openMap(page, project.id);
	const bar = page.getByTestId('map-draw-bar');
	await page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true }).click();
	await expect(bar).toContainText('Delineating a catchment');
	await expect(page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await page.getByTestId('map-tools').getByRole('button', { name: 'Place a point', exact: true }).click();
	await expect(bar).toContainText('Placing a point');
	await expect(page.getByTestId('map-tools').getByRole('button', { name: 'Place a point', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true })).toHaveAttribute('aria-pressed', 'false');
	await bar.getByTestId('map-enter-coordinates').click();
	await expect(page.getByRole('dialog', { name: 'Place a point' })).toBeVisible();
});

test('a point beside a much larger channel is not delineated quietly: the sheet names the channel, and Use that channel delineates it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Delineate larger channel');
	await openMap(page, project.id);
	await delineateAt(page, FIXTURE_OFF_CHANNEL);
	const offer = sheet(page).getByTestId('delineate-larger');
	await expect(offer).toBeVisible();
	await expect(offer).toContainText(/^A much larger channel runs \d+ m west of your point: [\d\s,]+ km² drains through it/);
	await expect(sheet(page).getByTestId('delineate-error')).toHaveCount(0);
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expectNoViolations(page);
	}
	await page.emulateMedia({ colorScheme: 'light' });
	// Keep my point: the small catchment it snapped to.
	await offer.getByTestId('delineate-keep-point').click();
	await expect(review(page)).toBeVisible();
	await expect(review(page).getByTestId('delineate-fact-area')).toHaveText(/^\d\.\d\d km²$/);
	// Delineate again at the same point and use the channel instead: the valley above the mid gauge, hundreds of km².
	await review(page).getByRole('button', { name: 'Delineate another point' }).click();
	await sheet(page).getByTestId('delineate-submit').click();
	await sheet(page).getByTestId('delineate-use-larger').click();
	await expect(review(page)).toBeVisible();
	await expect(review(page).getByTestId('delineate-fact-area')).toHaveText(/^[34]\d\d\.\d\d km²$/);
});

test('a point at a confluence asks which river, and delineates the one picked', async ({ page, owner }) => {
	void owner;
	// A river reach along the valley and a small tributary ending at the point: two rivers within 200 m.
	await loadRiverNetwork('e2e-confluence', [
		{ id: 99100001, upstreamKm2: 400, order: 4, line: FIXTURE_JUNCTION_RIVER },
		{ id: 99100002, upstreamKm2: 3, order: 1, line: FIXTURE_JUNCTION_TRIBUTARY }
	]);
	const project = await seedRunnableProject(page.request, 'Delineate confluence');
	await openMap(page, project.id);
	await delineateAt(page, FIXTURE_JUNCTION);
	const box = sheet(page).getByTestId('delineate-confluence');
	await expect(box).toBeVisible();
	await expect(box.getByTestId('delineate-choice')).toHaveText(['The river along the point, 400 km²', 'The river above the junction, 3.00 km²']);
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expectNoViolations(page);
	}
	await page.emulateMedia({ colorScheme: 'light' });
	// The river: the valley above the junction, hundreds of km², matched to the reach.
	await box.getByTestId('delineate-choice').first().click();
	await expect(review(page)).toBeVisible();
	await expect(review(page).getByTestId('delineate-fact-area')).toHaveText(/^[34]\d\d\.\d\d km²$/);
});

test('a viewer gets no Delineate', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Delineate viewer');
	const viewer = await signIn('Delineate viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await openMap(viewer.page, project.id);
	await expect(viewer.page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true })).toHaveCount(0);
	// A link to the sheet does nothing for a viewer: the param goes.
	await viewer.page.goto(`/projects/${project.id}?tab=map&delineate=1`);
	await expect(viewer.page.locator('.map-page[data-ready]')).toBeVisible();
	await expect(viewer.page).not.toHaveURL(/delineate=/);
	await expect(viewer.page.getByRole('dialog')).toHaveCount(0);
});
