// The Map tab's layers, download and measure (issue #326 A6, A7; docs/ui.md §
// Map, docs/maps.md). The quaternary outlines layer: its toggle is in the URL
// (`layers=quaternaries`, Back undoes it, a reload keeps it), and the codes
// around the catchment are listed beside the map (the synthetic dataset's six
// region Z cells), never read from pixels. Download GeoJSON hands over a file
// with every feature. Measure, driven from the keyboard, writes its distance
// and area in words; the distance is checked against the listed points. The
// River network (#345): its reaches listed biggest first, one picked and
// added as the project's river, which the list then marks on the map. Axe
// with the layers on and while measuring, light and dark.
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { boundaryGeoJson, loadSyntheticQuaternaries, loadSyntheticRivers, openLayers, openMap, parcelsGeoJson, showTab, uploadThroughSheet } from '../support/map.ts';
import { layoutSettled } from '../support/reflow.ts';

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

	// The layers are a panel over the map's right edge, under the zoom buttons, opened from its Layers button.
	await expect(layers(page)).toBeHidden();
	await openLayers(page);
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
	// The panel's open state isn't in the URL (the layers are): its button counts the layers on.
	await expect(page.getByTestId('map-layers-toggle')).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByTestId('map-layers-toggle')).toHaveAccessibleName('Layers (1 on)');
	await openLayers(page);
	await expect(layers(page).getByRole('checkbox', { name: 'Quaternary catchments' })).toBeChecked();
	await expect(codes(page).getByRole('button')).toHaveCount(6);
	await page.goBack();
	await expect(page).not.toHaveURL(/layers=/);
	await expect(layers(page).getByRole('checkbox', { name: 'Quaternary catchments' })).not.toBeChecked();
	await expect(page.getByTestId('map-quaternaries')).toHaveCount(0);
});

test('the river network: its reaches listed biggest first, one picked and added as a river, then marked on the map', async ({ page, owner }) => {
	void owner;
	await loadSyntheticRivers();
	const project = await seedRunnableProject(page.request, 'Map layers rivers');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());

	await openLayers(page);
	const toggle = layers(page).getByRole('checkbox', { name: 'River network' });
	await expect(toggle).not.toBeChecked();
	await toggle.check();
	await expect(page).toHaveURL(/[?&]layers=rivers(&|$)/);
	// The boundary padded to 21.2–21.5 E, 33.5–33.8 S meets ten of the eleven synthetic reaches (the far one is at 22.5 E).
	await expect(page.getByTestId('map-rivers-summary')).toHaveText('10 reaches around the catchment, the biggest first, from synthetic. Synthetic test data, never real rivers.');
	// One status region, there from the start, says what loaded (WCAG 4.1.3), then the reach picked.
	const status = layers(page).getByRole('status');
	await expect(status).toHaveText('10 reaches shown.');
	const reaches = page.getByTestId('map-reach-list').getByRole('button');
	await expect(reaches).toHaveCount(10);
	await expect(reaches.first()).toHaveText('Reach 90000002 · order 3 · 655 km²');
	// The river network joins the key's lines while it is on.
	await expect(page.getByTestId('map-key').first()).toContainText('river network');

	await page.getByTestId('map-reach-list').getByRole('button', { name: 'Reach 90000003 · order 2 · 168 km²' }).click();
	const picked = page.getByTestId('map-reach-picked');
	await expect(picked).toContainText('Reach 90000003: Strahler order 2, 168 km² upstream');
	// HydroRIVERS' discharge is a model's long-term mean, not a gauged one (round 4).
	await expect(picked).toContainText('modelled mean flow');
	await expect(status).toHaveText('10 reaches shown. Picked Reach 90000003.');
	await expect(picked).toContainText('Source: SYNTHETIC test data');
	await picked.getByRole('button', { name: 'Add to the map as a river' }).click();
	await expect(page.getByTestId('map-notice')).toHaveText(/^Added “Reach 90000003” to the map as a river, from the river network\./);
	await expect(page.getByTestId('map-summary')).toContainText('2 features');
	await expect(picked).toContainText('On the map as a river.');
	await expect(page.getByTestId('map-reach-list').getByRole('button', { name: 'Reach 90000003 · order 2 · 168 km² · on the map' })).toBeVisible();
	// Show it picks the new river feature.
	await picked.getByRole('button', { name: 'Show it' }).click();
	await expect(page.getByTestId('map-feature-card').getByRole('heading')).toHaveText('Reach 90000003');
	// Back (past the pick) turns the layer off.
	await page.goBack();
	await page.goBack();
	await expect(page).not.toHaveURL(/layers=/);
	await expect(page.getByTestId('map-rivers')).toHaveCount(0);
});

/** The fit with the Layers tab picked: the page doesn't scroll, the tab's panel ends inside the side column and scrolls in its box. */
const fitWithLayers = (page: Page) =>
	page.evaluate(() => {
		const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
		const map = r('.map-body');
		const panel = document.querySelector('.layers-tab') as HTMLElement;
		const side = r('.map-side');
		return {
			scroll: document.documentElement.scrollHeight,
			inner: window.innerHeight,
			panelBottom: panel.getBoundingClientRect().bottom,
			panelScrolls: panel.scrollHeight > panel.clientHeight ? getComputedStyle(panel).overflowY : 'fits',
			sideBottom: side.bottom,
			mapHeight: map.height
		};
	});

// Until 2026-10-02 the layers were a box in the side column, squeezing the list and the picked feature's card (PR #348 found the
// column running past a 1280×800 window); until 2026-10-03 a panel over the map. They are a tab of the side column now: one panel
// at a time, so with both layers on and a reach picked the tab's panel fits the column (scrolling in its own box), the page doesn't
// scroll, and a feature picked from the list shows its Details, the map's Layers button bringing the tab back with the reach kept.
for (const [width, height] of [
	[1440, 960],
	[1280, 800]
] as const) {
	test(`with both layers on and a reach picked, the Layers tab fits the side column at ${width}×${height}`, async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width, height });
		await loadSyntheticQuaternaries();
		await loadSyntheticRivers();
		const project = await seedRunnableProject(page.request, `Map layers fit ${width}`);
		await openMap(page, project.id);
		await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
		await uploadThroughSheet(page, 'farm_parcel', 'parcels.geojson', parcelsGeoJson());
		await openMap(page, project.id, '&layers=quaternaries,rivers');
		await openLayers(page);
		await expect(page.getByTestId('map-tab-layers')).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByTestId('map-reach-list').getByRole('button')).toHaveCount(10);
		await page.getByTestId('map-reach-list').getByRole('button').first().click();
		await expect(page.getByTestId('map-reach-picked')).toBeVisible();
		await layoutSettled(page);
		const fit = await fitWithLayers(page);
		expect(fit.scroll).toBeLessThanOrEqual(fit.inner);
		expect(fit.panelBottom).toBeLessThanOrEqual(fit.sideBottom + 0.5);
		expect(['fits', 'auto']).toContain(fit.panelScrolls);
		expect(fit.sideBottom).toBeLessThanOrEqual(fit.inner);
		// The map keeps the window's height: nothing stacks above it but the header.
		expect(fit.mapHeight).toBeGreaterThanOrEqual(height - 260);
		// A pick from the list shows its Details; the map's Layers button brings the tab back, the reach still picked.
		await showTab(page, 'features');
		await page.getByTestId('map-feature-list').getByRole('button', { name: /Upper farm/ }).first().click();
		await expect(page.getByTestId('map-feature-card').getByRole('heading')).toHaveText('Upper farm');
		await expect(page.getByTestId('map-layers-toggle')).toHaveAttribute('aria-expanded', 'false');
		await openLayers(page);
		await expect(page.getByTestId('map-reach-picked')).toBeVisible();
	});
}

test('the river network with nothing on the map yet: zoom in and it asks for the map’s view', async ({ page, owner }) => {
	void owner;
	await loadSyntheticRivers();
	const project = await seedRunnableProject(page.request, 'Map layers rivers empty');
	await openMap(page, project.id);
	await mapReady(page);
	await openLayers(page);
	await layers(page).getByRole('checkbox', { name: 'River network' }).check();
	// The whole country is in view: too wide to ask for, so it says to zoom in, and asks nothing.
	const rivers = page.getByTestId('map-rivers');
	await expect(rivers).toContainText('Zoom in to see the river network here');
	// Zoomed in far enough, it asks for the view (no features needed), at most 2° a side.
	const asked = page.waitForRequest((r) => /\/map\/rivers\?bbox=/.test(r.url()));
	const zoomIn = page.getByTestId('catchment-map').getByRole('button', { name: /zoom in/i });
	const wrap = page.locator('.map-wrap');
	// One step at a time, each waited out on the map's settled view (a click mid-animation would cancel it).
	for (let i = 0; i < 5; i++) {
		const before = await wrap.getAttribute('data-view');
		await zoomIn.click();
		await expect(wrap).not.toHaveAttribute('data-view', before ?? '');
	}
	const [w, s, e, n] = new URL((await asked).url()).searchParams.get('bbox')!.split(',').map(Number) as [number, number, number, number];
	expect(e - w).toBeLessThanOrEqual(2);
	expect(n - s).toBeLessThanOrEqual(2);
	await expect(rivers).toContainText('No reach of the loaded river network is in view.');
});

test('Download GeoJSON hands over every feature with its name, kind, node and area', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Map layers download');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await uploadThroughSheet(page, 'farm_parcel', 'parcels.geojson', parcelsGeoJson());
	await expect(page.getByTestId('map-summary')).toContainText('3 features');

	// Download sits with the list, on the side column's Features tab.
	await showTab(page, 'features');
	const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('map-download-geojson').click()]);
	expect(download.suggestedFilename()).toMatch(/^map-layers-download-map-\d{4}-\d{2}-\d{2}\.geojson$/);
	const doc = JSON.parse(await readFile((await download.path())!, 'utf8'));
	expect(doc.type).toBe('FeatureCollection');
	expect(doc.features).toHaveLength(3);
	const byName = new Map(doc.features.map((f: { properties: { name: string } }) => [f.properties.name, f]));
	expect(byName.get('Upper farm')).toMatchObject({ type: 'Feature', properties: { kind: 'farm_parcel', node: 'Upper farm', areaKm2: expect.any(Number) }, geometry: { type: 'Polygon' } });
	expect(byName.get('Synthetic catchment')).toMatchObject({ properties: { kind: 'catchment_boundary', node: null } });
	await expect(page.getByTestId('map-notice')).toHaveText(new RegExp(`^Downloaded 3 features as ${download.suggestedFilename().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
});

test('Measure from the keyboard: points at the crosshair, the distance in words, then the closed shape’s area; Escape ends it', async ({ page, owner }) => {
	void owner;
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Map layers measure');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await mapReady(page);

	await page.getByTestId('map-tools').getByRole('button', { name: 'Measure', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(measureBar(page)).toBeVisible();
	await expect(page.getByTestId('map-tools').getByRole('button', { name: 'Measure', exact: true })).toHaveAttribute('aria-pressed', 'true');
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
	await expect(page.getByTestId('map-tools').getByRole('button', { name: 'Measure', exact: true })).toHaveAttribute('aria-pressed', 'false');
	// Nothing was saved.
	await expect(page.getByTestId('map-summary')).toContainText('1 feature');
});

for (const scheme of ['light', 'dark'] as const) {
	test(`the layers box and the measure bar have no axe violations, ${scheme}`, async ({ page, owner }) => {
		void owner;
		await page.emulateMedia({ colorScheme: scheme });
		await loadSyntheticQuaternaries();
		await loadSyntheticRivers();
		const project = await seedRunnableProject(page.request, `Map layers axe ${scheme}`);
		await openMap(page, project.id, '&layers=quaternaries,rivers');
		await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
		await openLayers(page);
		await expect(codes(page).getByRole('button')).toHaveCount(6);
		await expect(page.getByTestId('map-reach-list').getByRole('button')).toHaveCount(10);
		await page.getByTestId('map-reach-list').getByRole('button').first().click();
		await expect(page.getByTestId('map-reach-picked')).toBeVisible();
		await expectNoViolations(page);
		await page.getByTestId('map-tools').getByRole('button', { name: 'Measure', exact: true }).click();
		await expect(measureBar(page)).toBeVisible();
		await expectNoViolations(page);
	});
}
