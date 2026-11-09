// The Map tab's layers, download and measure (issue #326 A6, A7; docs/ui.md §
// Map, docs/maps.md). The quaternary outlines layer: its toggle is in the URL
// (`layers=quaternaries`, Back undoes it, a reload keeps it), and the codes
// around the catchment are listed beside the map (the synthetic dataset's six
// region Z cells), never read from pixels. Download GeoJSON hands over a file
// with every feature. Measure, driven from the keyboard, writes its distance
// and area in words; the distance is checked against the listed points. The
// River network (#345): its reaches listed biggest first, one picked and
// added as the project's river, which the list then marks on the map. The
// hydrological units (each parcel named by its unit), the WAAS 2007 MAP and
// the CCWR MAP (each its own grid's points in view, with their range and
// source, credited while drawn, or plainly not loaded) and the CHIRPS grid
// (its points in view), each its own toggle in the URL. The A-pan
// and S-pan grids: two toggles of their own, the year or a month, the A-pan
// said modelled and the S-pan a cross-check, each credited while drawn. The DEM
// rivers (the terrain channels drawn outside Delineate): on by default for an
// editor, `layers=-channels` turns them off and `layers=channels` on again. Axe
// with the layers on and while measuring, light and dark.
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { boundaryGeoJson, loadSyntheticQuaternaries, loadSyntheticRivers, openKey, openLayers, openMap, parcelsGeoJson, showTab, uploadThroughSheet } from '../support/map.ts';
import { loadSyntheticMapGrid } from '../support/mapGrid.ts';
import { layoutSettled } from '../support/reflow.ts';

const layers = (page: Page) => page.getByTestId('map-layers');
const codes = (page: Page) => page.getByTestId('map-quaternary-codes');
const canvas = (page: Page) => page.getByTestId('catchment-map').locator('canvas');
const measureBar = (page: Page) => page.getByTestId('map-measure-bar');
const result = (page: Page) => page.getByTestId('map-measure-result');
const mapReady = (page: Page) => expect(page.locator('.map-wrap[data-status="ready"]')).toBeVisible();

/** What in the map's bottom-left corner (Show everything, Key, the Key's panel over the map) the attribution box overlaps; [] when it clears them all. */
const footOverlap = (page: Page) =>
	page.evaluate(() => {
		const attrib = document.querySelector('.maplibregl-ctrl-attrib')?.getBoundingClientRect();
		if (!attrib) return ['no attribution'];
		return [...document.querySelectorAll<HTMLElement>('[data-testid="map-show-everything"], [data-testid="map-key-toggle"], .key-panel:not([hidden])')]
			.filter((b) => {
				const r = b.getBoundingClientRect();
				return r.width > 0 && r.left < attrib.right && attrib.left < r.right && r.top < attrib.bottom && attrib.top < r.bottom;
			})
			.map((b) => b.dataset.testid ?? b.className);
	});

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
	// The panel's open state isn't in the URL (the layers are): its button counts the layers on, the DEM rivers (on by default for an editor) among them.
	await expect(page.getByTestId('map-layers-toggle')).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByTestId('map-layers-toggle')).toHaveAccessibleName('Layers (2 on)');
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
	const toggle = layers(page).getByRole('checkbox', { name: 'Rivers (HydroRIVERS)' });
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

// The WAAS 2007 MAP and the CCWR MAP ask for their own grids by label (docs/maps.md § MAP grid). The e2e database
// keeps only the synthetic grid (a real-looking grid would become the unit MAP proposals' default in every spec), as
// a dev laptop does, so each layer draws the synthetic grid in its place and says so: the real path, no route.
// Only the credits need a real grid's lines: there, a layer's request is answered with the synthetic grid's cells
// read from the real server, under the asked grid's lines. Requests for any other label go through untouched.
const SYNTHETIC_SOURCE =
	'Invented MAP grid for tests and demos (backend/fixtures/geo/map-grid.synthetic.json): a smooth hill of rainfall over region Z, never real data';
const WAAS_LINE = 'Mean annual rainfall surface for the Southwestern Cape. Prepared for the WAAS project by Beuster Clarke & Associates. March 2007, Version 1.1.';
const LYNCH_SOURCE =
	'Lynch, S.D. 2004. Development of a raster database of annual, monthly and daily rainfall for southern Africa. WRC Report 1156/1/04; as distributed in Schulze, R.E. (Ed). 2007. South African Atlas of Climatology and Agrohydrology. WRC Report 1489/1/06';
const LYNCH_LINE =
	'Schulze, R.E. and Lynch, S.D. 2007. Annual Precipitation. In: Schulze, R.E. (Ed). South African Atlas of Climatology and Agrohydrology. WRC Report 1489/1/06, Section 6.2';
const GRID_LINES: Record<string, { source: string; attribution: string }> = {
	'WAAS-SWCape-2007': { source: WAAS_LINE, attribution: WAAS_LINE },
	'Lynch-2004': { source: LYNCH_SOURCE, attribution: LYNCH_LINE }
};
async function standInMapGrids(page: Page) {
	await page.route(/\/map\/map-grid\?/, async (route) => {
		const url = new URL(route.request().url());
		const asked = url.searchParams.get('dataset');
		const lines = asked ? GRID_LINES[asked] : undefined;
		if (!asked || !lines) return route.continue();
		url.searchParams.set('dataset', 'synthetic');
		const res = await route.fetch({ url: url.toString() });
		const body = (await res.json()) as { dataset: Record<string, unknown> | null };
		if (body.dataset) body.dataset = { ...body.dataset, dataset: asked, ...lines, synthetic: false };
		await route.fulfill({ response: res, json: body });
	});
}

test('the hydrological units, the WAAS 2007 MAP, the CCWR MAP and the CHIRPS grid: each a toggle in the URL, what they draw said beside the map', async ({ page, owner }) => {
	void owner;
	await loadSyntheticMapGrid();
	const project = await seedRunnableProject(page.request, 'Map layers grids');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await uploadThroughSheet(page, null, 'parcels.geojson', parcelsGeoJson());
	await mapReady(page);

	await openLayers(page);
	const status = layers(page).getByRole('status');
	// The units: each parcel named by the unit it is linked to, listed by name.
	await layers(page).getByRole('checkbox', { name: 'Hydrological units' }).check();
	await expect(page).toHaveURL(/[?&]layers=units(&|$)/);
	await expect(page.getByTestId('map-unit-list').getByRole('button')).toHaveText([/^Lower farm/, /^Upper farm/]);
	await expect(status).toHaveText('2 hydrological units labelled.');
	// A unit in the list shows its polygon.
	await page.getByTestId('map-unit-list').getByRole('button', { name: /^Upper farm/ }).click();
	await expect(page.getByTestId('map-feature-card').getByRole('heading')).toHaveText('Upper farm');

	// Two MAP tick boxes, the WAAS 2007 MAP first, and no other.
	await openLayers(page);
	await expect(layers(page).getByRole('checkbox', { name: /MAP/ })).toHaveCount(2);
	await expect(layers(page).getByTestId('map-layer-mapgrid')).toHaveAccessibleName('WAAS 2007 MAP');
	await expect(layers(page).getByTestId('map-layer-ccwrgrid')).toHaveAccessibleName('CCWR MAP');

	// The WAAS 2007 MAP: still `mapgrid` in the URL. With no WAAS-SWCape-2007 on this server, the synthetic grid's points
	// in the view (the catchment, 21.3–21.4 E) in its place, their range, said synthetic and standing in, and credited nowhere.
	await layers(page).getByRole('checkbox', { name: 'WAAS 2007 MAP' }).check();
	await expect(page).toHaveURL(/[?&]layers=units(%2C|,)mapgrid(&|$)/);
	await expect(page.getByTestId('map-mapgrid-summary')).toHaveText(
		// The e2e site has no glyphs, so the values aren't written on the map and the box says so.
		/^[\d\s,]+ points in view from synthetic \(0\.01° cells\): \d+ mm to \d+ mm\. Synthetic test data, never real rainfall\. The map has no fonts for labels here, so it shows the points without their values\.$/
	);
	await expect(page.getByTestId('map-mapgrid-source')).toHaveText(
		`No WAAS 2007 MAP on this server; showing the synthetic test grid in its place. Mean annual precipitation, mm a year. Source: ${SYNTHETIC_SOURCE}`
	);
	await expect(status).toContainText(/[\d\s,]+ synthetic test points shown\./);

	// The CCWR MAP beside it: its own box, both on at once, the synthetic grid standing in for it too.
	await layers(page).getByRole('checkbox', { name: 'CCWR MAP' }).check();
	await expect(page).toHaveURL(/[?&]layers=units(%2C|,)mapgrid(%2C|,)ccwrgrid(&|$)/);
	await expect(page.getByTestId('map-ccwrgrid-summary')).toHaveText(/^[\d\s,]+ points in view from synthetic \(0\.01° cells\): \d+ mm to \d+ mm\. Synthetic test data, never real rainfall\./);
	await expect(page.getByTestId('map-ccwrgrid-source')).toHaveText(
		`No CCWR MAP on this server; showing the synthetic test grid in its place. Mean annual precipitation, mm a year. Source: ${SYNTHETIC_SOURCE}`
	);
	await expect(page.getByTestId('map-mapgrid-summary')).toBeVisible();
	await expect(status).toContainText(/synthetic test points shown\. [\d\s,]+ synthetic test points shown\./);
	// The synthetic grid credits nothing: its warning says what it is.
	await expect(page.locator('.maplibregl-ctrl-attrib').getByRole('link', { name: /^MAP grid:/ })).toHaveCount(0);

	// The CHIRPS grid: its 0.05° cells' centres in view, from the grid alone.
	await layers(page).getByRole('checkbox', { name: 'CHIRPS grid' }).check();
	await expect(page).toHaveURL(/layers=units(%2C|,)mapgrid(%2C|,)ccwrgrid(%2C|,)chirps(&|$)/);
	await expect(page.getByTestId('map-chirps-summary')).toHaveText(/^[\d\s,]+ CHIRPS v3 grid points? in view, each the centre of a 0\.05° cell/);
	// The four and the DEM rivers, on by default.
	await expect(page.getByTestId('map-layers-toggle')).toHaveAccessibleName('Layers (5 on)');

	// Back turns the last one off; the others stay.
	await page.goBack();
	await expect(page).toHaveURL(/layers=units(%2C|,)mapgrid(%2C|,)ccwrgrid(&|$)/);
	await expect(page.getByTestId('map-chirps')).toHaveCount(0);
	await expect(page.getByTestId('map-mapgrid-summary')).toBeVisible();
	await expect(page.getByTestId('map-ccwrgrid-summary')).toBeVisible();
	// The WAAS 2007 MAP off: the CCWR MAP stays.
	await layers(page).getByRole('checkbox', { name: 'WAAS 2007 MAP' }).uncheck();
	await expect(page).toHaveURL(/layers=units(%2C|,)ccwrgrid(&|$)/);
	await expect(page.getByTestId('map-mapgrid')).toHaveCount(0);
	await expect(page.getByTestId('map-ccwrgrid-summary')).toBeVisible();
});

// A server with no MAP grid at all, not even the synthetic one (production before a load): the layer says so by its
// own name, in plain words. The e2e database keeps the synthetic grid once any spec has loaded it, so this answer
// (the route's none loaded, rainMap.db.test.ts's on the server side) is stood in by a route.
test('the CCWR MAP says plainly when no grid is loaded, and credits nothing', async ({ page, owner }) => {
	void owner;
	await page.route(/\/map\/map-grid\?/, (route) =>
		route.fulfill({ json: { bbox: [21, -34, 22, -33], dataset: null, datasets: [], cells: [], tooDense: false, max: 5000 } })
	);
	const project = await seedRunnableProject(page.request, 'Map grid not loaded');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await mapReady(page);
	await openLayers(page);
	await layers(page).getByRole('checkbox', { name: 'CCWR MAP' }).check();
	await expect(page.getByTestId('map-ccwrgrid-none')).toHaveText('There’s no CCWR MAP on this server yet, so there is nothing to draw.');
	await expect(layers(page).getByRole('status')).toHaveText('No CCWR MAP is loaded.');
	await expect(page.locator('.maplibregl-ctrl-attrib').getByRole('link', { name: /^MAP grid:/ })).toHaveCount(0);
});

test('the MAP grids credit their sources on the map while their points are drawn, both while both are on', async ({ page, owner }) => {
	void owner;
	await loadSyntheticMapGrid();
	await standInMapGrids(page);
	const project = await seedRunnableProject(page.request, 'Map grid credit');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await mapReady(page);
	// Short on the map, each link opening its line whole on the data sources page (legal.spec.ts checks that page).
	const attrib = page.locator('.maplibregl-ctrl-attrib');
	const waasCredit = attrib.getByRole('link', { name: 'MAP grid: WAAS (2007), Beuster Clarke & Associates', exact: true });
	const lynchCredit = attrib.getByRole('link', { name: 'MAP grid: Lynch (2004), WRC Atlas', exact: true });
	await expect(waasCredit).toHaveCount(0);
	await expect(lynchCredit).toHaveCount(0);

	await openLayers(page);
	await layers(page).getByRole('checkbox', { name: 'WAAS 2007 MAP' }).check();
	await expect(page.getByTestId('map-mapgrid-summary')).toContainText('points in view from WAAS-SWCape-2007');
	await expect(page.getByTestId('map-mapgrid-source')).toHaveText(`Mean annual precipitation, mm a year. Source: ${WAAS_LINE}`);
	await expect(waasCredit).toHaveAttribute('href', '/data-sources#waas-map');
	await expect(lynchCredit).toHaveCount(0);
	// The CCWR MAP on too: both credited, each once.
	await layers(page).getByRole('checkbox', { name: 'CCWR MAP' }).check();
	await expect(page.getByTestId('map-ccwrgrid-summary')).toContainText('points in view from Lynch-2004');
	await expect(lynchCredit).toHaveAttribute('href', '/data-sources#lynch-map');
	await expect(waasCredit).toHaveAttribute('href', '/data-sources#waas-map');
	await expect(attrib.getByRole('link', { name: /^MAP grid:/ })).toHaveCount(2);

	// The attribution wraps beside the map's bottom-left buttons, never under them (PR #570: the whole line ran under
	// Show everything and Key at 1280 px as on a phone), wide and at phone width, with both credits on it.
	for (const width of [1280, 390]) {
		await page.setViewportSize({ width, height: 844 });
		await expect(waasCredit).toBeVisible();
		await expect(lynchCredit).toBeVisible();
		await expect.poll(() => footOverlap(page), { message: `at ${width} px` }).toEqual([]);
	}
	// On the phone the Key opens as a panel over the map's corner: the credits move clear of that too.
	await openKey(page);
	await expect(page.locator('.key-panel')).toBeVisible();
	await expect(waasCredit).toBeVisible();
	await expect.poll(() => footOverlap(page), { message: 'with the Key open at 390 px' }).toEqual([]);
	await page.getByTestId('map-key-toggle').click();
	await expect(page.getByTestId('map-key-toggle')).toHaveAttribute('aria-expanded', 'false');

	// Each off again: its credit goes with its points, the other's stays (Layers reopened: the phone width moved its panel).
	await openLayers(page);
	await layers(page).getByRole('checkbox', { name: 'WAAS 2007 MAP' }).uncheck();
	await expect(waasCredit).toHaveCount(0);
	await expect(lynchCredit).toBeVisible();
	await layers(page).getByRole('checkbox', { name: 'CCWR MAP' }).uncheck();
	await expect(lynchCredit).toHaveCount(0);
});

// The A-pan and S-pan grids (docs/maps.md § A-pan and S-pan grids). The e2e database keeps only the synthetic
// reference ET grid: an A-pan grid loaded there would become every evaporation proposal spec's default. So the
// A-pan layer first meets the real server's "none loaded" answer, then the answers are stood in for by a route,
// invented values with the WRC Atlas grids' lines (the server side is evaporationLayer.db.test.ts's): what the
// Layers box and the map do with them is real.
test('the A-pan and S-pan grids: two toggles of their own, the year or a month, said modelled or a cross-check, credited while drawn', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Map evaporation grids');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());
	await mapReady(page);

	// None loaded: said plainly, nothing drawn.
	await openLayers(page);
	await layers(page).getByRole('checkbox', { name: 'A-pan grid' }).check();
	await expect(page.getByTestId('map-apangrid-none')).toHaveText('There’s no A-pan grid on this server yet, so there is nothing to draw.');
	await layers(page).getByRole('checkbox', { name: 'A-pan grid' }).uncheck();
	await expect(page).not.toHaveURL(/apangrid/);

	const apanLines = {
		dataset: 'Atlas-Apan-2007',
		kind: 'apan',
		label: 'modelled A-pan equivalent reference potential evaporation (WRC Atlas, not a measured pan)',
		source: 'Modelled A-pan equivalent (WRC Atlas, Schulze and Maharaj): monthly A-pan equivalent reference potential evaporation, modelled from climate surfaces, not measured pans',
		version: 'Atlas of Agrohydrology 2008',
		method: 'Modelled, not measured.',
		attribution:
			'Schulze, R.E. and Maharaj, M. 2007. A-Pan Equivalent Reference Potential Evaporation. In: Schulze, R.E. (Ed). South African Atlas of Climatology and Agrohydrology. WRC Report 1489/1/06',
		firstYear: 1950,
		lastYear: 1999,
		cellDeg: 0.05,
		synthetic: false
	};
	const spanLines = {
		...apanLines,
		dataset: 'Atlas-Span-2007',
		kind: 'span',
		label: 'Symons-pan (S-pan) evaporation',
		source: 'Symons-pan (S-pan) evaporation (WRC Atlas, CCWR): monthly Symons-pan evaporation grids',
		attribution: 'Schulze, R.E. (Ed). 2007. South African Atlas of Climatology and Agrohydrology. WRC Report 1489/1/06 (S-pan grids; source to be confirmed)'
	};
	const asked: string[] = [];
	await page.route(/\/map\/evaporation-grid\?/, async (route) => {
		const q = new URL(route.request().url()).searchParams;
		asked.push(q.toString());
		const kind = q.get('kind');
		const month = q.get('month') ? Number(q.get('month')) : null;
		const year = kind === 'apan' ? [1812, 1840, 1866] : [1440, 1460, 1490];
		const dataset = kind === 'apan' ? apanLines : spanLines;
		// Invented values: a month is the year's twelfth.
		const cells = [
			[21.325, -33.675, year[0]],
			[21.375, -33.675, year[1]],
			[21.325, -33.625, year[2]]
		].map(([lon, lat, v]) => [lon, lat, month === null ? v : Math.round(v! / 12)]);
		await route.fulfill({ json: { bbox: (q.get('bbox') ?? '').split(',').map(Number), kind, month, dataset, datasets: [dataset], cells, tooDense: false, max: 5000 } });
	});
	const attrib = page.locator('.maplibregl-ctrl-attrib');
	const apanCredit = attrib.getByRole('link', { name: 'A-pan grid: WRC Atlas (modelled)', exact: true });
	const spanCredit = attrib.getByRole('link', { name: 'S-pan grid: WRC Atlas', exact: true });
	// A fresh page, so the layer's cached "none loaded" answer is gone.
	await page.reload();
	await mapReady(page);
	await expect(apanCredit).toHaveCount(0);
	await openLayers(page);

	// The A-pan grid: the year's totals by default, said to be modelled, credited on the map.
	await layers(page).getByRole('checkbox', { name: 'A-pan grid' }).check();
	await expect(page).toHaveURL(/[?&]layers=apangrid(&|$)/);
	await expect(page.getByTestId('map-apangrid-summary')).toHaveText(
		/^3 points in view from Atlas-Apan-2007 \(0\.05° cells, 1950–1999 means\), mm a year: 1\s812 mm to 1\s866 mm\. The map has no fonts for labels here, so it shows the points without their values\.$/
	);
	await expect(page.getByTestId('map-apangrid-source')).toContainText('Modelled A-pan equivalent reference potential evaporation (WRC Atlas, not a measured pan). Source: ');
	await expect(apanCredit).toHaveAttribute('href', '/data-sources#atlas-apan');
	await expect(layers(page).getByRole('status')).toContainText('3 A-pan grid points shown.');

	// A month: asked for and named; the year again comes from the layer's cache.
	await page.getByTestId('map-apangrid-month').selectOption({ label: 'January' });
	await expect(page.getByTestId('map-apangrid-summary')).toContainText('mm in January (mean): 151 mm to 156 mm.');
	expect(asked.at(-1)).toMatch(/(^|&)kind=apan&.*month=1(&|$)/);
	const before = asked.length;
	await page.getByTestId('map-apangrid-month').selectOption({ label: 'Year (total)' });
	await expect(page.getByTestId('map-apangrid-summary')).toContainText('mm a year');
	expect(asked).toHaveLength(before);

	// The S-pan grid beside it, its own toggle: a cross-check only, credited on its own line.
	await layers(page).getByRole('checkbox', { name: 'S-pan grid' }).check();
	await expect(page).toHaveURL(/layers=apangrid(%2C|,)spangrid(&|$)/);
	await expect(page.getByTestId('map-spangrid-source')).toContainText('Symons-pan (S-pan) evaporation: a cross-check only, never used by the model. Source: ');
	await expect(spanCredit).toHaveAttribute('href', '/data-sources#atlas-span');
	await expect(apanCredit).toBeVisible();
	await expectNoViolations(page, { include: '[data-testid="map-layers"]' });

	// The A-pan grid off: its credit goes, the S-pan grid's stays.
	await layers(page).getByRole('checkbox', { name: 'A-pan grid' }).uncheck();
	await expect(page).toHaveURL(/[?&]layers=spangrid(&|$)/);
	await expect(apanCredit).toHaveCount(0);
	await expect(spanCredit).toBeVisible();
});

test('the DEM grid: every 10th elevation-model cell each way in view, with its elevation, a toggle in the URL', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Map DEM grid');
	await openMap(page, project.id);
	// A small boundary over the synthetic DEM's valley (e2e's DEM_URL, backend/src/delineation/fixture.ts), so the view is the DEM's.
	const valley = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Valley' }, geometry: { type: 'Polygon', coordinates: [[[20.71, -33.47], [20.77, -33.47], [20.77, -33.4], [20.71, -33.4], [20.71, -33.47]]] } }] });
	await uploadThroughSheet(page, null, 'valley.geojson', valley);
	await mapReady(page);

	await openLayers(page);
	const toggle = layers(page).getByRole('checkbox', { name: 'DEM grid' });
	await expect(toggle).not.toBeChecked();
	await toggle.check();
	await expect(page).toHaveURL(/[?&]layers=demgrid(&|$)/);
	await expect(page.getByTestId('map-demgrid-summary')).toHaveText(
		/^[\d\s,]+ points in view: every 10th cell of the elevation model each way \(cells about [\d\s,]+ m, so a point every [\d\s,]+ m\), [-−]?[\d\s,]+ m to [-−]?[\d\s,]+ m\. The map has no fonts for labels here, so it shows the points without their values\.$/
	);
	await expect(page.getByTestId('map-demgrid-source')).toContainText('Source: Synthetic DEM');
	await expect(layers(page).getByRole('status')).toContainText(/DEM grid points? shown\./);
	await page.goBack();
	await expect(page.getByTestId('map-demgrid')).toHaveCount(0);
});

test('the DEM rivers: the terrain channels drawn outside Delineate, on by default, a toggle in the URL', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Map DEM rivers');
	await openMap(page, project.id);
	// A small boundary over the synthetic DEM's valley (e2e's DEM_URL), framed so the view is within the channels' 0.35°.
	const valley = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Valley' }, geometry: { type: 'Polygon', coordinates: [[[20.71, -33.47], [20.77, -33.47], [20.77, -33.4], [20.71, -33.4], [20.71, -33.47]]] } }] });
	await uploadThroughSheet(page, null, 'valley.geojson', valley);
	await mapReady(page);
	await page.getByTestId('map-show-everything').click();
	const body = page.locator('.map-body');
	// On with no `layers=` at all, and no tool on: Delineate's bar is nowhere, the channels' tiles are on the map.
	await expect(page).not.toHaveURL(/layers=/);
	await expect(page.getByTestId('map-draw-bar')).toHaveCount(0);
	await expect(body).toHaveAttribute('data-channels', 'on');
	await expect(body).not.toHaveAttribute('data-channel-tiles', '0');

	await openLayers(page);
	// The pair: HydroRIVERS' mapped rivers and the elevation model's own.
	await expect(layers(page).getByRole('checkbox', { name: 'Rivers (HydroRIVERS)' })).toBeVisible();
	const toggle = layers(page).getByRole('checkbox', { name: 'DEM rivers' });
	await expect(toggle).toBeChecked();
	await expect(page.getByTestId('map-channels')).toHaveAttribute('data-state', 'drawn');
	await expect(page.getByTestId('map-channels-line')).toHaveText(
		'The rivers delineation follows, worked out from the elevation model (the terrain channels in the Key): wider for a larger area upstream. The HydroRIVERS lines can sit a few hundred metres off them.'
	);
	// On by default, it is drawn without a word in the live region: nobody asked for it.
	await expect(layers(page).getByRole('status')).toHaveText('');
	// The over-the-map pill is Delineate's: the Layers box speaks for the layer.
	await expect(page.getByTestId('map-channels-note')).toHaveCount(0);

	// Off: written in the URL, the channels go; kept across a reload, as every layer.
	await toggle.uncheck();
	await expect(page).toHaveURL(/[?&]layers=-channels(&|$)/);
	await expect(body).not.toHaveAttribute('data-channels');
	await page.reload();
	await mapReady(page);
	await expect(body).not.toHaveAttribute('data-channels');
	// On again from its toggle: in the URL, and said in the live region.
	await openLayers(page);
	await layers(page).getByRole('checkbox', { name: 'DEM rivers' }).check();
	await expect(page).toHaveURL(/[?&]layers=channels(&|$)/);
	await expect(body).toHaveAttribute('data-channels', 'on');
	await expect(layers(page).getByRole('status')).toContainText('DEM rivers drawn.');
	// Back undoes the toggle: off again.
	await page.goBack();
	await expect(page).toHaveURL(/[?&]layers=-channels(&|$)/);
	await expect(body).not.toHaveAttribute('data-channels');
});

test('the Area fill slider: the polygons filled less, outlines kept, remembered in this browser', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Map area fill');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'parcels.geojson', parcelsGeoJson());
	await mapReady(page);
	const map = page.locator('[data-fill-scale]');
	await expect(map).toHaveAttribute('data-fill-scale', '1');

	await openLayers(page);
	const slider = layers(page).getByRole('slider', { name: 'Area fill' });
	await expect(slider).toHaveValue('100');
	await slider.fill('30');
	await expect(page.getByTestId('map-area-fill-value')).toHaveText('30 %');
	await expect(slider).toHaveAttribute('aria-valuetext', '30 %');
	await expect(map).toHaveAttribute('data-fill-scale', '0.3');
	// Not in the URL: a viewer's convenience, kept in this browser.
	await expect(page).not.toHaveURL(/fill/);

	await page.reload();
	await mapReady(page);
	await expect(map).toHaveAttribute('data-fill-scale', '0.3');
	await openLayers(page);
	await expect(layers(page).getByRole('slider', { name: 'Area fill' })).toHaveValue('30');
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
	await layers(page).getByRole('checkbox', { name: 'Rivers (HydroRIVERS)' }).check();
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
