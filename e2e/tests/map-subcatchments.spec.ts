// Sub-catchments from clicks on the rivers (docs/maps.md § Sub-catchments
// from clicks, docs/ui.md § Map), against the committed synthetic DEM the e2e
// API reads (DEM_URL, support/dem.ts). An editor turns Sub-catchments on,
// puts an outlet at the dam with Enter at the crosshair (the map's own click
// path, no pixels read: the map is framed on a square centred on the dam),
// then types two more, one below and one above it. Each click gets its
// incremental catchment, numbered by click: the lines say each one's area
// and where its water goes. Undo takes the last back without asking again,
// and Save keeps the pieces as areas. A click off the DEM is taken back with
// the reason; Done with unsaved clicks asks first; a viewer gets no button.
// Axe-scanned with the pieces drawn, light and dark.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, seedRunnableProject } from '../support/api.ts';
import { FIXTURE_DAM, FIXTURE_OFF_CHANNEL, FIXTURE_OUTLET, FIXTURE_UPPER } from '../support/dem.ts';
import { expect, test } from '../support/fixtures.ts';
import { openMap, uploadThroughSheet } from '../support/map.ts';

const header = (page: Page) => page.getByTestId('section-header');
const bar = (page: Page) => page.getByTestId('map-click-bar');
const lines = (page: Page) => bar(page).getByTestId('map-click-piece');
const mapReady = (page: Page) => expect(page.locator('.map-wrap[data-status="ready"]')).toBeVisible();
const canvas = (page: Page) => page.getByTestId('catchment-map').locator('canvas');

/** A small square centred on `[lon, lat]`: Show everything then puts that point under the crosshair. */
const squareAround = ([lon, lat]: [number, number], d = 0.004) =>
	JSON.stringify({
		type: 'FeatureCollection',
		features: [
			{
				type: 'Feature',
				properties: { name: 'Around the dam' },
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

async function typeOutlet(page: Page, [lon, lat]: [number, number]) {
	const b = bar(page);
	const coords = b.getByText('Enter coordinates');
	if (!(await b.getByTestId('map-click-lat').isVisible())) await coords.click();
	await b.getByTestId('map-click-lat').fill(String(lat));
	await b.getByTestId('map-click-lon').fill(String(lon));
	await b.getByTestId('map-click-add').click();
}

test('an editor clicks the river at the dam, then below and above it: each click gets its own piece, Undo takes one back, Save keeps them as areas', async ({ page, owner }) => {
	void owner;
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Sub-catchments golden path');
	await openMap(page, project.id);
	await uploadThroughSheet(page, 'other', 'around-dam.geojson', squareAround(FIXTURE_DAM));
	await mapReady(page);
	await header(page).getByRole('button', { name: 'Show everything' }).click();

	// From the keyboard: the button, then the map has the focus and the crosshair; Enter puts an outlet under it.
	await header(page).getByRole('button', { name: 'Sub-catchments' }).focus();
	await page.keyboard.press('Enter');
	await expect(header(page).getByRole('button', { name: 'Sub-catchments' })).toHaveAttribute('aria-pressed', 'true');
	await expect(bar(page)).toBeVisible();
	await expect(page.getByTestId('map-draw-bar')).toHaveCount(0);
	await expect(canvas(page)).toBeFocused();
	// The elevation model's own channels are drawn while the mode is on: the view (framed on the square) is one tile.
	await expect(page.getByTestId('map-channels-note')).toContainText('Red lines: the elevation model’s channels, where a click goes.');
	await expect(page.getByTestId('map-channels-note')).not.toHaveAttribute('data-tiles', '0');
	await page.keyboard.press('Enter');
	await expect(bar(page)).not.toHaveAttribute('data-busy');
	await expect(lines(page)).toHaveCount(1);
	// The synthetic valley above the dam wall is about 341 km² (backend/src/delineation/fixture.ts).
	await expect(lines(page).nth(0)).toHaveText(/^1 Sub-catchment 1: 3[34]\d\.\d\d km² · the lowest click: everything above it drains out here$/);
	await expect(bar(page).getByTestId('map-click-said')).toHaveText('1 sub-catchment.');

	// Below the dam: it becomes the lowest, and the dam's piece drains into it.
	await typeOutlet(page, FIXTURE_OUTLET);
	await expect(bar(page)).not.toHaveAttribute('data-busy');
	await expect(lines(page)).toHaveCount(2);
	await expect(lines(page).nth(0)).toHaveText(/^1 Sub-catchment 1: 3[34]\d\.\d\d km² · drains into 2 · 3[34]\d\.\d\d km² upstream in all$/);
	await expect(lines(page).nth(1)).toHaveText(/^2 Sub-catchment 2: 2\d\d\.\d\d km² · the lowest click: everything above it drains out here · 5[34]\d\.\d\d km² upstream in all$/);

	// Above the dam: it takes the valley's head out of the dam's piece.
	await typeOutlet(page, FIXTURE_UPPER);
	await expect(bar(page)).not.toHaveAttribute('data-busy');
	await expect(lines(page)).toHaveCount(3);
	await expect(lines(page).nth(0)).toHaveText(/^1 Sub-catchment 1: \d+\.\d\d km² · drains into 2 · 3[34]\d\.\d\d km² upstream in all$/);
	await expect(lines(page).nth(2)).toHaveText(/^3 Sub-catchment 3: \d+\.\d\d km² · drains into 1 · \d+\.\d\d km² upstream in all$/);
	await expect(bar(page).getByTestId('map-click-total')).toContainText('3 sub-catchments');

	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expectNoViolations(page);
	}
	await page.emulateMedia({ colorScheme: 'light' });

	// Undo goes back to two pieces at once (the answer it had).
	await bar(page).getByTestId('map-click-undo').click();
	await expect(lines(page)).toHaveCount(2);
	await expect(bar(page).getByTestId('map-click-said')).toHaveText('Took back click 3.');

	await bar(page).getByTestId('map-click-save').click();
	await expect(page.getByTestId('map-notice')).toContainText(/Saved 2 sub-catchments, 5[34]\d\.\d\d km² in all on the map as areas/);
	await expect(bar(page)).toHaveCount(0);
	await expect(header(page).getByRole('button', { name: 'Sub-catchments' })).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByTestId('map-feature-card').getByRole('heading', { name: 'Sub-catchment 1' })).toBeVisible();
	await expect(page.getByTestId('map-summary')).toContainText('3 features');
});

test('a click beside a much larger channel names it, and Use the larger channel moves the click onto it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Sub-catchments larger channel');
	await openMap(page, project.id);
	await header(page).getByRole('button', { name: 'Sub-catchments' }).click();
	await typeOutlet(page, FIXTURE_OUTLET);
	await typeOutlet(page, FIXTURE_OFF_CHANNEL);
	await expect(bar(page)).not.toHaveAttribute('data-busy');
	const off = lines(page).nth(1);
	await expect(off).toContainText(/a much larger channel \([\d ,]+ km²\) runs \d+ m west: the river line may sit off the channel the elevation model sees/);
	await expect(bar(page).getByTestId('map-click-said')).toHaveText(/^Click 2: a much larger channel/);
	await expectNoViolations(page);
	await off.getByTestId('map-click-use-larger').click();
	await expect(bar(page)).not.toHaveAttribute('data-busy');
	await expect(lines(page).nth(1)).not.toContainText('larger channel');
	// On the river above the outlet: the valley's land above the mid gauge, hundreds of km².
	await expect(lines(page).nth(1)).toHaveText(/^2 Sub-catchment 2: [34]\d\d\.\d\d km² · drains into 1/);
	await bar(page).getByTestId('map-click-undo').click();
	await expect(bar(page).getByTestId('map-click-said')).toHaveText('Moved the click back.');
	await expect(lines(page).nth(1)).toContainText('larger channel');
});

test('a click off the elevation model is taken back with the reason; Done asks before dropping clicks; a viewer gets no Sub-catchments', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Sub-catchments refusals');
	await openMap(page, project.id);
	await header(page).getByRole('button', { name: 'Sub-catchments' }).click();
	await typeOutlet(page, FIXTURE_DAM);
	await expect(lines(page)).toHaveCount(1);

	await typeOutlet(page, [25, -30]);
	await expect(bar(page).getByTestId('map-click-error')).toHaveText(/^Click not added: The clicks are outside the elevation model/);
	await expect(lines(page)).toHaveCount(1);

	await bar(page).getByTestId('map-click-done').click();
	const ask = page.getByRole('alertdialog', { name: 'Drop these clicks?' });
	await ask.getByRole('button', { name: 'Keep clicking' }).click();
	await expect(lines(page)).toHaveCount(1);
	await bar(page).getByTestId('map-click-done').click();
	await ask.getByRole('button', { name: 'Drop them' }).click();
	await expect(bar(page)).toHaveCount(0);
	await expect(header(page).getByRole('button', { name: 'Sub-catchments' })).toBeFocused();
	await expect(page.getByTestId('map-summary')).toHaveText('Nothing on the map yet');

	const viewer = await signIn('Sub-catchments viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await openMap(viewer.page, project.id);
	await expect(header(viewer.page).getByRole('button', { name: 'Delineate' })).toHaveCount(0);
	await expect(header(viewer.page).getByRole('button', { name: 'Sub-catchments' })).toHaveCount(0);
});
