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
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, seedRunnableProject } from '../support/api.ts';
import { FIXTURE_DAM, FIXTURE_JUNCTION, FIXTURE_JUNCTION_RIVER, FIXTURE_JUNCTION_TRIBUTARY, FIXTURE_OFF_CHANNEL, FIXTURE_OUTLET } from '../support/dem.ts';
import { expect, test } from '../support/fixtures.ts';
import { boundaryGeoJson, loadRiverNetwork, openMap, uploadThroughSheet } from '../support/map.ts';

const header = (page: Page) => page.getByTestId('section-header');
const sheet = (page: Page, name = 'Delineate a catchment') => page.getByRole('dialog', { name });
const review = (page: Page) => sheet(page, 'The delineated catchment');

/** Delineate → the draw bar → Enter coordinates → the sheet, filled and submitted. */
async function delineateAt(page: Page, [lon, lat]: [number, number], from: 'The catchment’s outlet' | 'Just below a dam wall' = 'The catchment’s outlet') {
	await header(page).getByRole('button', { name: 'Delineate' }).click();
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
	// The focused Delineate button went with the form: the sheet's title has the focus.
	await expect(r.getByRole('heading', { name: 'The delineated catchment' })).toBeFocused();
	await r.getByText('How it was made').click();
	await expect(r.getByTestId('delineate-fact-dataset')).toContainText('Synthetic DEM');
	await expect(r.getByTestId('delineate-fact-method')).toContainText('[delineate-3]');
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
	await expect(header(page).getByRole('button', { name: 'Delineate' })).toBeFocused();

	// From the outlet: accepting as the boundary waits for the tick.
	await delineateAt(page, FIXTURE_OUTLET);
	const r = review(page);
	const accept = r.getByTestId('delineate-accept-boundary');
	await expect(accept).toBeDisabled();
	// With it waiting, Delineate → Enter coordinates asks for a new point, and Back to the proposal returns to it.
	await r.getByRole('button', { name: 'Close', exact: true }).click();
	await header(page).getByRole('button', { name: 'Delineate' }).click();
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
	await expect(page.getByTestId('map-feature-list').getByRole('button', { name: /^Catchment above the outlet/ })).toBeVisible();
	await expect(page.getByTestId('map-feature-list').getByRole('button', { name: /^Synthetic catchment/ })).toHaveCount(0);
});

test('leaving Delineate for Place a point or Draw a shape leaves the delineating behind', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Delineate modes');
	await openMap(page, project.id);
	const bar = page.getByTestId('map-draw-bar');
	await header(page).getByRole('button', { name: 'Delineate' }).click();
	await expect(bar).toContainText('Delineating a catchment');
	await expect(header(page).getByRole('button', { name: 'Delineate' })).toHaveAttribute('aria-pressed', 'true');
	await header(page).getByRole('button', { name: 'Place a point' }).click();
	await expect(bar).toContainText('Placing a point');
	await expect(header(page).getByRole('button', { name: 'Place a point' })).toHaveAttribute('aria-pressed', 'true');
	await expect(header(page).getByRole('button', { name: 'Delineate' })).toHaveAttribute('aria-pressed', 'false');
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
	await expect(offer).toContainText(/^A much larger channel runs \d+ m west of your point: about [\d ,]+ km² drains through it here/);
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
	await expect(header(viewer.page).getByRole('button', { name: 'Delineate' })).toHaveCount(0);
	// A link to the sheet does nothing for a viewer: the param goes.
	await viewer.page.goto(`/projects/${project.id}?tab=map&delineate=1`);
	await expect(viewer.page.locator('.map-page[data-ready]')).toBeVisible();
	await expect(viewer.page).not.toHaveURL(/delineate=/);
	await expect(viewer.page.getByRole('dialog')).toHaveCount(0);
});
