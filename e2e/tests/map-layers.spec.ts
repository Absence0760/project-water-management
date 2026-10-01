// The Map tab's layers, download and measure (issue #326 A6, A7; docs/ui.md §
// Map, docs/maps.md). The quaternary outlines layer: its toggle is in the URL
// (`layers=quaternaries`, Back undoes it, a reload keeps it), and the codes
// around the catchment are listed beside the map (the synthetic dataset's six
// region Z cells), never read from pixels. Download GeoJSON hands over a file
// with every feature. Measure, driven from the keyboard, writes its distance
// and area in words; the distance is checked against the listed points.
// Axe with the layer on and while measuring, light and dark.
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { boundaryGeoJson, loadSyntheticQuaternaries, openMap, parcelsGeoJson, uploadThroughSheet } from '../support/map.ts';

const header = (page: Page) => page.getByTestId('section-header');
const layers = (page: Page) => page.getByTestId('map-layers');
const codes = (page: Page) => page.getByTestId('map-quaternary-codes');
const canvas = (page: Page) => page.getByTestId('catchment-map').locator('canvas');
const measureBar = (page: Page) => page.getByTestId('map-measure-bar');
const result = (page: Page) => page.getByTestId('map-measure-result');
const mapReady = (page: Page) => expect(page.locator('.map-wrap[data-status="ready"]')).toBeVisible();

/** "33.6123° S, 21.3402° E" → [lon, lat]. */
function parsePosition(text: string): [number, number] {
	const m = /^(\d+\.\d+)° ([NS]), (\d+\.\d+)° ([EW])$/.exec(text.trim());
	if (!m) throw new Error(`not a position: ${text}`);
	return [Number(m[3]) * (m[4] === 'W' ? -1 : 1), Number(m[1]) * (m[2] === 'S' ? -1 : 1)];
}
/** Great-circle distance (m), the mean Earth radius: how the app measures. */
function haversineM([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
	const r = Math.PI / 180;
	const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
	return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

test('the quaternary outlines: a toggle in the URL, the codes around the catchment listed, Back undoes it', async ({ page, owner }) => {
	void owner;
	await loadSyntheticQuaternaries();
	const project = await seedRunnableProject(page.request, 'Map layers quaternaries');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());

	const toggle = layers(page).getByRole('checkbox', { name: 'Quaternary catchments' });
	await expect(toggle).not.toBeChecked();
	await expect(page.getByTestId('map-quaternaries')).toHaveCount(0);
	await toggle.check();
	await expect(page).toHaveURL(/[?&]layers=quaternaries(&|$)/);
	// The boundary (21.3–21.4 E, 33.6–33.7 S) padded to 21.2–21.5 E, 33.5–33.8 S meets all six synthetic cells.
	await expect(codes(page).getByRole('button')).toHaveText(['Z01A', 'Z01B', 'Z01C', 'Z02A', 'Z02B', 'Z02C']);
	await expect(page.getByTestId('map-quaternaries-summary')).toHaveText('6 quaternaries around the catchment, from synthetic. Synthetic test data, never real outlines.');

	// Picking a code marks it (the map draws it heavier); picking it again lets it go.
	const z01b = codes(page).getByRole('button', { name: 'Z01B' });
	await z01b.click();
	await expect(z01b).toHaveAttribute('aria-pressed', 'true');
	await z01b.click();
	await expect(z01b).toHaveAttribute('aria-pressed', 'false');

	// A reload keeps the layer on; Back turns it off.
	await page.reload();
	await expect(page.locator('.map-page[data-ready]')).toBeVisible();
	await expect(layers(page).getByRole('checkbox', { name: 'Quaternary catchments' })).toBeChecked();
	await expect(codes(page).getByRole('button')).toHaveCount(6);
	await page.goBack();
	await expect(page).not.toHaveURL(/layers=/);
	await expect(layers(page).getByRole('checkbox', { name: 'Quaternary catchments' })).not.toBeChecked();
	await expect(page.getByTestId('map-quaternaries')).toHaveCount(0);
});

test('Download GeoJSON hands over every feature with its name, kind, node and area', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Map layers download');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await uploadThroughSheet(page, 'farm_parcel', 'parcels.geojson', parcelsGeoJson());
	await expect(page.getByTestId('map-summary')).toContainText('3 features');

	const [download] = await Promise.all([page.waitForEvent('download'), header(page).getByRole('button', { name: 'Download GeoJSON' }).click()]);
	expect(download.suggestedFilename()).toMatch(/^map-layers-download-map-\d{4}-\d{2}-\d{2}\.geojson$/);
	const doc = JSON.parse(await readFile((await download.path())!, 'utf8'));
	expect(doc.type).toBe('FeatureCollection');
	expect(doc.features).toHaveLength(3);
	const byName = new Map(doc.features.map((f: { properties: { name: string } }) => [f.properties.name, f]));
	expect(byName.get('Upper farm')).toMatchObject({ type: 'Feature', properties: { kind: 'farm_parcel', node: 'Upper farm', areaKm2: expect.any(Number) }, geometry: { type: 'Polygon' } });
	expect(byName.get('Synthetic catchment')).toMatchObject({ properties: { kind: 'catchment_boundary', node: null } });
	await expect(page.getByTestId('map-notice')).toHaveText(new RegExp(`^Downloaded 3 features as ${download.suggestedFilename().replace(/\./g, '\\.')}\\.`));
});

test('Measure from the keyboard: points at the crosshair, the distance in words, then the closed shape’s area; Escape ends it', async ({ page, owner }) => {
	void owner;
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Map layers measure');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await mapReady(page);

	await header(page).getByRole('button', { name: 'Measure' }).focus();
	await page.keyboard.press('Enter');
	await expect(measureBar(page)).toBeVisible();
	await expect(header(page).getByRole('button', { name: 'Measure' })).toHaveAttribute('aria-pressed', 'true');
	await expect(canvas(page)).toBeFocused();
	await expect(canvas(page)).toHaveAttribute('aria-label', /measuring: .*Enter adds a point there.*Escape ends the measurement/);
	await expect(result(page)).toHaveText('Click the map to add the first point, or press Enter at the crosshair.');

	for (const key of ['Enter', 'ArrowRight', 'ArrowRight', 'Enter']) await page.keyboard.press(key);
	await expect(result(page)).toHaveText(/^Distance: [\d.]+ (m|km) \(2 points\)\.$/);
	// The words agree with the points the bar lists (4 decimals: within 25 m).
	await measureBar(page).getByText('The 2 points').click();
	const points = (await page.getByTestId('map-measure-points').getByRole('listitem').allTextContents()).map(parsePosition);
	expect(points).toHaveLength(2);
	const shown = (await result(page).textContent())!;
	const m = /^Distance: ([\d.]+) (m|km)/.exec(shown)!;
	const metres = Number(m[1]) * (m[2] === 'km' ? 1000 : 1);
	expect(Math.abs(metres - haversineM(points[0]!, points[1]!))).toBeLessThan(25);

	// A third point, then Close the shape: the area and perimeter, in words.
	await canvas(page).focus();
	for (const key of ['ArrowDown', 'ArrowDown', 'Enter']) await page.keyboard.press(key);
	await expect(result(page)).toHaveText(/\(3 points\)\.$/);
	await measureBar(page).getByRole('button', { name: 'Close the shape' }).click();
	await expect(measureBar(page)).toHaveAttribute('data-closed', 'true');
	await expect(result(page)).toHaveText(/^Area: [\d.]+ (ha|km² \([\d,\s]+ ha\))\. Perimeter: [\d.]+ (m|km)\.$/);

	// Nothing to lose: Escape on the map ends it at once, without asking.
	await canvas(page).focus();
	await page.keyboard.press('Escape');
	await expect(measureBar(page)).toHaveCount(0);
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(header(page).getByRole('button', { name: 'Measure' })).toHaveAttribute('aria-pressed', 'false');
	// Nothing was saved.
	await expect(page.getByTestId('map-summary')).toContainText('1 feature');
});

for (const scheme of ['light', 'dark'] as const) {
	test(`the layers box and the measure bar have no axe violations, ${scheme}`, async ({ page, owner }) => {
		void owner;
		await page.emulateMedia({ colorScheme: scheme });
		await loadSyntheticQuaternaries();
		const project = await seedRunnableProject(page.request, `Map layers axe ${scheme}`);
		await openMap(page, project.id, '&layers=quaternaries');
		await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
		await expect(codes(page).getByRole('button')).toHaveCount(6);
		await expectNoViolations(page);
		await header(page).getByRole('button', { name: 'Measure' }).click();
		await expect(measureBar(page)).toBeVisible();
		await expectNoViolations(page);
	});
}
