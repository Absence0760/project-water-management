// The Map's search (issue #523 C5, #90 Q23; docs/maps.md § Search, docs/ui.md
// § Map), against the committed synthetic datasets (no real place): the
// gazetteer (Kwartsvallei sits at the synthetic DEM's outlet), the gauging
// stations, the register of dams and the quaternaries. Find then start: an
// editor with an empty project finds the valley by name, picks it from the
// list (with the places' credit), the map moves there, and Start the model
// from the map → Delineate with Enter at the crosshair places its point exactly
// there, and Delineate… delineates the valley from it. A viewer searches codes: one match
// moves the map at once, a quaternary is framed whole, Escape closes a
// list; nothing found says what to try. Axe-scanned with the list open.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject } from '../support/api.ts';
import { loadSyntheticDamRegister } from '../support/damRegister.ts';
import { FIXTURE_OUTLET } from '../support/dem.ts';
import { expect, test } from '../support/fixtures.ts';
import { loadSyntheticGazetteer, loadSyntheticQuaternaries, loadSyntheticStations, openMap } from '../support/map.ts';

const search = (page: Page) => page.getByTestId('map-search');
const mapReady = (page: Page) => expect(page.locator('.map-wrap[data-status="ready"]')).toBeVisible();

/** The map's settled view (west, south, east, north), from its `data-view`. */
async function view(page: Page): Promise<[number, number, number, number]> {
	return (await page.locator('.map-wrap').getAttribute('data-view'))!.split(',').map(Number) as [number, number, number, number];
}
/** The view's centre is within `tol` degrees of [lon, lat]. */
async function expectCentredOn(page: Page, [lon, lat]: [number, number], tol = 0.002) {
	await expect
		.poll(async () => {
			const [w, s, e, n] = await view(page);
			return Math.max(Math.abs((w + e) / 2 - lon), Math.abs((s + n) / 2 - lat));
		})
		.toBeLessThan(tol);
}

async function find(page: Page, q: string) {
	await search(page).getByRole('searchbox', { name: 'Find a place on the map' }).fill(q);
	await search(page).getByRole('button', { name: 'Find' }).click();
}

test.beforeAll(async () => {
	await loadSyntheticGazetteer();
	await loadSyntheticStations();
	await loadSyntheticDamRegister();
	await loadSyntheticQuaternaries();
});

test('an editor finds the valley by name, the map moves there, and Start from the map delineates from that point', async ({ page, owner }) => {
	void owner;
	test.setTimeout(60_000);
	// The pick frames the map; without reduced motion that is a 600 ms flight, and the view is read once it settles.
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const project = await createProject(page.request, 'Find then start');
	await openMap(page, project.id);
	await mapReady(page);

	await find(page, 'kwartsvallei');
	const hits = search(page).getByTestId('map-search-hit');
	await expect(hits).toHaveCount(3);
	await expect(search(page).getByTestId('map-search-status')).toHaveText('3 matches for “kwartsvallei”.');
	// Towns before farms before rivers; what and where under each name, marked as sample data.
	await expect(hits.nth(0)).toHaveText('Kwartsvallei Town or settlement · Western Cape (sample)');
	await expect(hits.nth(1)).toContainText('Kwartsvallei 12');
	await expect(hits.nth(1)).toContainText('Farm');
	await expect(hits.nth(2)).toContainText('River');
	// The places' credit: the synthetic source here (GeoNames' attribution in production).
	await expect(search(page).getByTestId('map-search-credit')).toContainText('Place names: SYNTHETIC test data');
	await expectNoViolations(page, { include: '[data-testid="map-search"]' });

	await hits.nth(0).click();
	await expect(search(page).getByTestId('map-search-results')).toHaveCount(0);
	await expect(search(page).getByTestId('map-search-status')).toHaveText('Showing Kwartsvallei on the map.');
	await expectCentredOn(page, FIXTURE_OUTLET);

	// Start from the map → Delineate: Enter at the crosshair (the map's centre, now the place found) asks for that point.
	await page.getByTestId('map-no-boundary').getByTestId('map-empty-start').click();
	const start = page.getByRole('dialog', { name: 'Start the model from the map' });
	await start.getByTestId('start-delineate').click();
	await expect(page.getByTestId('map-draw-bar')).toContainText('Delineating a catchment');
	const canvas = page.getByTestId('catchment-map').locator('canvas');
	await expect(canvas).toBeFocused();
	await page.keyboard.press('Enter');
	// The point lands where the search moved the map (the synthetic outlet, 33.5397° S, 20.7429° E); Delineate… asks for it.
	await expect(page.getByTestId('map-draw-bar')).toContainText('Point at 33.5397° S, 20.7429° E.');
	await page.getByTestId('map-draw-bar').getByRole('button', { name: 'Delineate…' }).click();
	const sheet = page.getByRole('dialog', { name: 'Delineate a catchment' });
	await expect(sheet).toBeVisible();
	expect(Math.abs(Number(await sheet.getByLabel('Latitude').inputValue()) - FIXTURE_OUTLET[1])).toBeLessThan(0.002);
	expect(Math.abs(Number(await sheet.getByLabel('Longitude').inputValue()) - FIXTURE_OUTLET[0])).toBeLessThan(0.002);
	await sheet.getByTestId('delineate-submit').click();
	const review = page.getByRole('dialog', { name: 'The delineated catchment' });
	// The synthetic valley above its outlet is about 547 km² (backend/src/delineation/fixture.ts).
	await expect(review.getByTestId('delineate-fact-area')).toHaveText(/^5[34]\d\.\d\d km²$/);
	await review.getByTestId('delineate-accept-boundary').click();
	await expect(page.getByTestId('map-notice')).toContainText('Saved Catchment above the outlet (delineated)');
});

test('a viewer finds codes: one match moves the map at once, a quaternary is framed whole, Escape closes a list', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Search codes');
	const viewer = await signIn('Search viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.emulateMedia({ reducedMotion: 'reduce' });
	await openMap(v, project.id);
	await mapReady(v);

	// One match (a gauge's code, spaces ignored): no list, the map is there.
	await find(v, 'z1h 003');
	await expect(search(v).getByTestId('map-search-results')).toHaveCount(0);
	await expect(search(v).getByTestId('map-search-status')).toHaveText('Showing Sandspruit @ Brandvlei on the map.');
	await expectCentredOn(v, [21.41, -33.865]);

	// Three quaternaries: a list; Escape closes it, focus back in the box.
	await find(v, 'Z01');
	await expect(search(v).getByTestId('map-search-hit')).toHaveText([/^Quaternary Z01A/, /^Quaternary Z01B/, /^Quaternary Z01C/]);
	await search(v).getByTestId('map-search-hit').nth(1).focus();
	await v.keyboard.press('Escape');
	await expect(search(v).getByTestId('map-search-results')).toHaveCount(0);
	await expect(search(v).getByRole('searchbox')).toBeFocused();
	// Picked, the quaternary is framed whole: its box is in view.
	await find(v, 'Z01B');
	await expect(search(v).getByTestId('map-search-status')).toHaveText('Showing Quaternary Z01B on the map.');
	await expect
		.poll(async () => {
			const [w, s, e, n] = await view(v);
			return w <= 21.26 && e >= 21.49 && s <= -33.74 && n >= -33.51;
		})
		.toBe(true);

	await find(v, 'zzqx');
	await expect(search(v).getByTestId('map-search-status')).toHaveText(/^Nothing found for “zzqx”\. Try a town/);
});
