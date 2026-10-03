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
import { addMember, createProject, node, putModel, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { FIXTURE_DAM, FIXTURE_JUNCTION, FIXTURE_JUNCTION_RIVER, FIXTURE_JUNCTION_TRIBUTARY, FIXTURE_OFF_CHANNEL, FIXTURE_OUTLET, FIXTURE_UPPER } from '../support/dem.ts';
import { expect, test } from '../support/fixtures.ts';
import { loadRiverNetwork, openMap, uploadThroughSheet } from '../support/map.ts';

const header = (page: Page) => page.getByTestId('section-header');
const bar = (page: Page) => page.getByTestId('map-click-bar');
const lines = (page: Page) => bar(page).getByTestId('map-click-piece');
/** A piece's words (its badge aside). */
const line = (page: Page, i: number) => lines(page).nth(i).getByTestId('map-click-line');
/** Enter Sub-catchments: Delineate, then its choice. */
async function startClicks(page: Page) {
	await page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true }).click();
	await page.getByTestId('map-delineate-clicks').check();
	await expect(page.getByTestId('map-click-bar')).toBeVisible();
}
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
	await page.getByTestId('map-show-everything').click();

	// The header's actions fit one row at 1440 (Sub-catchments is Delineate's choice, Download GeoJSON is the list's).
	const tops = await header(page).locator('button, a.btn').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
	expect(new Set(tops).size).toBe(1);
	const mapHeight = (await page.locator('.map-body').boundingBox())!.height;

	// From the keyboard: Delineate, its choice of Sub-catchments; then the map has the focus and the crosshair, and Enter puts an outlet under it.
	await page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('map-draw-bar')).toContainText('Delineating a catchment');
	await page.getByTestId('map-delineate-clicks').check();
	await expect(page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(bar(page)).toBeVisible();
	await expect(page.getByTestId('map-draw-bar')).toHaveCount(0);
	await expect(canvas(page)).toBeFocused();
	// Beside the map, in the picked feature's place: the map keeps its height.
	await expect(page.getByRole('complementary', { name: 'Features' }).getByTestId('map-click-bar')).toBeVisible();
	await expect(page.getByTestId('map-feature-card')).toHaveCount(0);
	expect(Math.abs((await page.locator('.map-body').boundingBox())!.height - mapHeight)).toBeLessThan(2);
	// The elevation model's own channels are drawn while the mode is on: the view (framed on the square) is one tile.
	await expect(page.locator('.map-body')).not.toHaveAttribute('data-channel-tiles', '0');
	await expect(page.getByTestId('map-channels-note')).toHaveCount(0);
	await expect(bar(page).getByTestId('map-click-how')).toContainText('Click a red line (the elevation model’s channel) for each outlet');
	await page.keyboard.press('Enter');
	await expect(bar(page)).not.toHaveAttribute('data-busy');
	await expect(lines(page)).toHaveCount(1);
	// The synthetic valley above the dam wall is about 341 km² (backend/src/delineation/fixture.ts).
	// The fixture's pan lies in it, so the piece reports what drains into it (start-11).
	// The crosshair isn't on a cell's centre, so the click may say how far it moved.
	await expect(line(page, 0)).toHaveText(
		/^3[34]\d\.\d\d km² · the lowest point: the rest drains out here · \d+\.\d\d km² of it drains into pans \(non-contributing\)( · moved \d+ m to the channel)?$/
	);
	await expect(lines(page).nth(0).getByTestId('piece-badge')).toHaveText('Piece 1: 1');
	await expect(bar(page).getByTestId('map-click-said')).toHaveText('1 sub-catchment.');

	// Below the dam: it becomes the lowest, and the dam's piece drains into it.
	await typeOutlet(page, FIXTURE_OUTLET);
	await expect(bar(page)).not.toHaveAttribute('data-busy');
	await expect(lines(page)).toHaveCount(2);
	await expect(line(page, 0)).toHaveText(/^3[34]\d\.\d\d km² · drains into 2 · 3[34]\d\.\d\d km² upstream in all · \d+\.\d\d km² of it drains into pans \(non-contributing\)( · moved \d+ m to the channel)?$/);
	await expect(line(page, 1)).toHaveText(/^2\d\d\.\d\d km² · the lowest point: the rest drains out here · 5[34]\d\.\d\d km² upstream in all$/);

	// Above the dam: it takes the valley's head out of the dam's piece.
	await typeOutlet(page, FIXTURE_UPPER);
	await expect(bar(page)).not.toHaveAttribute('data-busy');
	await expect(lines(page)).toHaveCount(3);
	await expect(line(page, 0)).toHaveText(/^\d+\.\d\d km² · drains into 2 · 3[34]\d\.\d\d km² upstream in all · \d+\.\d\d km² of it drains into pans \(non-contributing\)( · moved \d+ m to the channel)?$/);
	// Typed on a cell's centre beside the channel: it moves one cell onto it, and says so.
	await expect(line(page, 2)).toHaveText(/^\d+\.\d\d km² · drains into 1 · \d+\.\d\d km² upstream in all · moved 128 m to the channel$/);
	await expect(bar(page).getByTestId('map-click-total')).toHaveText(/^5[34]\d\.\d\d km² in 3 sub-catchments\. A proposal from Synthetic DEM/);
	// The key: each line's badge carries its piece's tint, and touching pieces differ.
	const tints = await lines(page).getByTestId('piece-badge').evaluateAll((els) => els.map((e) => getComputedStyle(e).boxShadow));
	// Piece 1 (between the dam and the head) touches both others; 2 and 3 don't touch, so they may share one.
	expect(tints[0]).not.toBe(tints[1]);
	expect(tints[0]).not.toBe(tints[2]);

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
	await expect(page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true })).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByTestId('map-feature-card').getByRole('heading', { name: 'Sub-catchment 1' })).toBeVisible();
	await expect(page.getByTestId('map-summary')).toContainText('3 features');
});

test('Use this area on a saved piece holding a pan asks which area: gross by default, the effective one when picked (195)', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Effective area from a piece');
	const weir = node('Valley weir', 'gauge', null, 0);
	const unit = node('Dam unit', 'farm', weir.id, 1, { areaKm2: 5 });
	await putModel(page.request, project.id, { nodes: [weir, unit], crops: [], cropAreas: [], transfers: [] });
	// The pieces above and below the dam, saved as Save saves them: the upper one holds the valley's pan.
	const saved = await page.request.post(`${API_URL}/projects/${project.id}/map/subcatchments/save`, {
		data: { clicks: [FIXTURE_DAM, FIXTURE_OUTLET].map(([lon, lat]) => ({ lon, lat })) }
	});
	expect(saved.status()).toBe(201);
	const [upper, lower] = (await saved.json()).features as { id: string; areaM2: number; nonContributingM2: number }[];
	expect(upper!.nonContributingM2).toBeGreaterThan(0);
	await openMap(page, project.id, `&feature=${upper!.id}`);
	const card = page.getByTestId('map-feature-card');
	await card.getByLabel('Hydrological unit to take Sub-catchment 1’s area').selectOption(unit.id);
	const basis = card.getByTestId('map-area-basis');
	// Gross until changed; the button names the area it takes (areaText: two decimals past 10 km²).
	await expect(basis).toHaveValue('gross');
	const text = (m2: number) => (m2 / 1e6).toFixed(m2 < 1e7 ? 3 : 2);
	const grossM2 = upper!.areaM2;
	const effectiveM2 = upper!.areaM2 - upper!.nonContributingM2;
	await expect(card.getByRole('button', { name: `Use ${text(grossM2)} km²` })).toBeVisible();
	await basis.selectOption('effective');
	await card.getByRole('button', { name: `Use ${text(effectiveM2)} km²` }).click();
	const dialog = page.getByRole('alertdialog', { name: 'Set Dam unit’s area from the map?' });
	await expect(dialog).toContainText(`to ${(effectiveM2 / 1e6).toFixed(3)} km², the area of “Sub-catchment 1”, its effective area, without the`);
	await dialog.getByRole('button', { name: 'Use this area' }).click();
	await expect(page.getByTestId('map-notice')).toContainText(`Dam unit’s area is now ${(effectiveM2 / 1e6).toFixed(3)} km², from the map (effective, without what drains into pans).`);
	await expect(card.getByRole('button', { name: 'In use' })).toBeDisabled();
	await expect(card.getByTestId('map-card-area-source')).toContainText('(effective, without pans)');
	// Reloaded, the card opens on the area in use.
	await page.reload();
	await expect(page.locator('.map-page[data-ready]')).toBeVisible();
	await expect(basis).toHaveValue('effective');
	await expect(card.getByRole('button', { name: 'In use' })).toBeDisabled();
	// Switching back to gross is a change again.
	await basis.selectOption('gross');
	await expect(card.getByRole('button', { name: `Use ${text(grossM2)} km²` })).toBeEnabled();
	await expectNoViolations(page);
	// The lower piece holds no pan: no choice, its area as it is.
	await openMap(page, project.id, `&feature=${lower!.id}`);
	await expect(page.getByTestId('map-feature-card').getByRole('button', { name: /^Use / })).toBeVisible();
	await expect(page.getByTestId('map-feature-card').getByTestId('map-area-basis')).toHaveCount(0);
});

test('a click beside a much larger channel names it, and Use the larger channel moves the click onto it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Sub-catchments larger channel');
	await openMap(page, project.id);
	await startClicks(page);
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
	await expect(line(page, 1)).toHaveText(/^[34]\d\d\.\d\d km² · drains into 1/);
	await bar(page).getByTestId('map-click-undo').click();
	await expect(bar(page).getByTestId('map-click-said')).toHaveText('Moved the click back.');
	await expect(lines(page).nth(1)).toContainText('larger channel');
});

test('a click at a confluence waits for the river to be picked, then goes on that river’s channel', async ({ page, owner }) => {
	void owner;
	await loadRiverNetwork('e2e-confluence', [
		{ id: 99100001, upstreamKm2: 400, order: 4, line: FIXTURE_JUNCTION_RIVER },
		{ id: 99100002, upstreamKm2: 3, order: 1, line: FIXTURE_JUNCTION_TRIBUTARY }
	]);
	const project = await seedRunnableProject(page.request, 'Sub-catchments confluence');
	await openMap(page, project.id);
	await startClicks(page);
	await typeOutlet(page, FIXTURE_OUTLET);
	await typeOutlet(page, FIXTURE_JUNCTION);
	const box = bar(page).getByTestId('map-click-confluence');
	await expect(box).toContainText('Click 2 is at a confluence. Which river do you mean?');
	await expect(bar(page).getByTestId('map-click-said')).toHaveText('Click 2 is at a confluence: pick the river you mean.');
	await expect(lines(page)).toHaveCount(1);
	await expectNoViolations(page);
	await box.getByTestId('map-click-choice').first().click();
	await expect(bar(page)).not.toHaveAttribute('data-busy');
	await expect(box).toHaveCount(0);
	await expect(lines(page)).toHaveCount(2);
	await expect(line(page, 1)).toContainText('on the channel matching river reach 99100001 (400.00 km²)');
});

test('a click off the elevation model is taken back with the reason; Done asks before dropping clicks; a viewer gets no Sub-catchments', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Sub-catchments refusals');
	await openMap(page, project.id);
	await startClicks(page);
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
	await expect(page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true })).toBeFocused();
	await expect(page.getByTestId('map-summary')).toHaveText('Nothing on the map yet');

	const viewer = await signIn('Sub-catchments viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await openMap(viewer.page, project.id);
	await expect(viewer.page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true })).toHaveCount(0);
	await expect(viewer.page.getByTestId('map-delineate-clicks')).toHaveCount(0);
});

test('on a phone the panel sits above the map, nothing scrolls inside itself, and One catchment switches back to Delineate', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const project = await seedRunnableProject(page.request, 'Sub-catchments phone');
	await openMap(page, project.id);
	await startClicks(page);
	await typeOutlet(page, FIXTURE_OUTLET);
	await typeOutlet(page, FIXTURE_DAM);
	await expect(lines(page)).toHaveCount(2);
	// Above the map, not after the side column: the panel's bottom is above the map's top.
	const panel = (await bar(page).boundingBox())!;
	const map = (await page.locator('.map-body').boundingBox())!;
	expect(panel.y + panel.height).toBeLessThanOrEqual(map.y + 1);
	// Every line reads whole: nothing in the panel scrolls inside itself.
	const inner = await bar(page).evaluate((el) => [el, ...el.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY)).length);
	expect(inner).toBe(0);
	await expectNoViolations(page);
	// One catchment, above a point: asks first (clicks would be lost), then Delineate's point.
	await bar(page).getByTestId('map-delineate-one').check();
	await page.getByRole('alertdialog', { name: 'Drop these clicks?' }).getByRole('button', { name: 'Drop them' }).click();
	await expect(bar(page)).toHaveCount(0);
	await expect(page.getByTestId('map-draw-bar')).toContainText('Delineating a catchment');
});
