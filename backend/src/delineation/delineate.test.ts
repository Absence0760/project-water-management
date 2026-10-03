import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pointInRing } from '../geo/geojson.js';
import { openDem } from './dem.js';
import { boundsText, delineate, DelineationRefused, METHOD_VERSION, SNAP_RADIUS_M, tooLargeText } from './delineate.js';
import { BASIN_AREA_M2, DAM_CELL, FIXTURE_CELL_M, FIXTURE_CELLS, FIXTURE_ZOOM, fixtureElevation, fixtureLonLat, OUTLET_CELL, PAN } from './fixture.js';
import { d8, DX, DY, edgeMask, fill, OUT } from './flow.js';
import { PAN_METHOD } from './pans.js';

// Against the committed synthetic DEM (backend/fixtures/dem/, fixture.ts): a
// valley in an elliptical ridge whose area is known, with a dam, a pan and a
// flat reservoir.
const dem = openDem(fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url)));
const at = (x: number, y: number) => fixtureLonLat(x + 0.5, y + 0.5);

async function refusal(p: Promise<unknown>): Promise<DelineationRefused> {
	const e = await p.then(
		() => null,
		(err: unknown) => err
	);
	expect(e).toBeInstanceOf(DelineationRefused);
	return e as DelineationRefused;
}

describe('delineate (synthetic DEM)', () => {
	it('proposes the whole valley from its outlet: the ridge’s area within 3 %, a valid polygon around the outlet', async () => {
		const r = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y));
		expect(Math.abs(r.areaM2 / BASIN_AREA_M2 - 1)).toBeLessThan(0.03);
		// The polygon's area and the cells' agree (simplification moves it a little).
		expect(Math.abs(r.areaM2 / (r.cells * r.cellAreaM2) - 1)).toBeLessThan(0.01);
		expect(r.geometry.type).toBe('Polygon');
		expect(r.geometry.coordinates).toHaveLength(1);
		const ring = r.geometry.coordinates[0]!;
		expect(ring[0]).toEqual(ring[ring.length - 1]);
		// A point well inside the valley is inside the polygon; one beyond the ridge is not.
		expect(pointInRing(at(OUTLET_CELL.x, OUTLET_CELL.y - 100), ring)).toBe(true);
		expect(pointInRing(at(OUTLET_CELL.x + 120, OUTLET_CELL.y - 100), ring)).toBe(false);
		expect(r.snapDistanceM).toBeLessThanOrEqual(1.5 * FIXTURE_CELL_M);
		expect(r.zoom).toBe(FIXTURE_ZOOM);
		expect(r.methodVersion).toBe(METHOD_VERSION);
		expect(r.method).toMatch(/Priority-Flood\+ε/);
		expect(r.dataset.label).toMatch(/Synthetic DEM/);
		expect(r.dataset.fingerprint).toMatch(/^[0-9a-f]{16}$/);
	});

	it('proposes less from the dam wall than from the outlet: the valley above the wall, not below it', async () => {
		const outlet = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y));
		const dam = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 1));
		expect(dam.areaM2).toBeGreaterThan(0.4 * outlet.areaM2);
		expect(dam.areaM2).toBeLessThan(0.8 * outlet.areaM2);
		const vertices = dam.geometry.coordinates[0]!;
		expect(pointInRing(at(DAM_CELL.x, DAM_CELL.y - 60), outlet.geometry.coordinates[0]!)).toBe(true);
		expect(pointInRing(at(DAM_CELL.x, DAM_CELL.y - 60), vertices)).toBe(true);
		// Below the dam is the outlet's, not the dam's.
		expect(pointInRing(at(DAM_CELL.x, DAM_CELL.y + 50), vertices)).toBe(false);
	});

	it('snaps a click beside the river onto it', async () => {
		const r = await delineate(dem, at(OUTLET_CELL.x + 1, OUTLET_CELL.y - 30));
		expect(r.snapDistanceM).toBeGreaterThan(0);
		expect(r.cells).toBeGreaterThan(100);
	});

	it('never snaps further than the stated radius (150 m), measured from the exact click (issue #387)', async () => {
		// Clicks 0.6–1.49 cells (77–190 m) east of the river's centre line, between the dam and the outlet, some off their
		// cell's middle. The old snap counted round(150 / 128) = 1 whole cell from the clicked cell, so it took the river from
		// up to 200 m; now a click beyond 150 m keeps to its own side of the valley.
		const river = DAM_CELL.x + 0.5;
		const row = DAM_CELL.y + 60.5;
		for (const dx of [0.6, 1.0, 1.1, 1.17, 1.2, 1.3, 1.49]) {
			for (const dy of [0, 0.3]) {
				const r = await delineate(dem, fixtureLonLat(river + dx, row + dy), { keepPoint: true });
				expect(r.snapDistanceM, `${dx}, ${dy}`).toBeLessThanOrEqual(SNAP_RADIUS_M);
				// The river's nearest cell centre is hypot(dx, dy) cells away: taken exactly when that is within 150 m.
				const onRiver = Math.abs(r.outlet[0] - fixtureLonLat(river, row)[0]) < 1e-6;
				expect(onRiver, `${dx}, ${dy}`).toBe(Math.hypot(dx, dy) * FIXTURE_CELL_M <= SNAP_RADIUS_M);
			}
		}
	});

	it('refuses a point outside the DEM', async () => {
		const r = await refusal(delineate(dem, [25, -30]));
		expect(r.code).toBe('outside');
		// In degrees south, as people read them (it said "-33.7243397° to -33.1375512° N").
		expect(r.message).toMatch(/covers 20\.39° E to 21\.09° E, 33\.72° S to 33\.14° S\)\.$/);
	});

	it('refuses a click on a slope that almost nothing drains to', async () => {
		expect((await refusal(delineate(dem, at(OUTLET_CELL.x - 91, OUTLET_CELL.y - 120), { snapRadiusM: 10 }))).code).toBe('too_small');
	});

	it('refuses a catchment that runs past the largest window rather than cut it off', async () => {
		const e = await refusal(delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y), { windows: [64, 128] }));
		expect(e.code).toBe('too_large');
		expect(e.message).toMatch(/^The catchment above that point reaches beyond the \d+ km the app delineates around a click, so it can’t be proposed whole\. Click further upstream for a smaller catchment, divide the river with Sub-catchments, one per click/);
		// The window it stopped at, so the background worker goes on from the next (requests.ts nextJobWindow).
		expect(e.windowCells).toBe(128);
	});

	it('points a main stem at Sub-catchments, not "further upstream": its reach can’t fit the window anywhere (finding 11)', async () => {
		const e = await refusal(delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y), { windows: [64, 128], expected: { km2: 340_724, reach: 'reach 7' } }));
		expect(e.code).toBe('too_large');
		expect(e.message).toMatch(/^The river here drains about 340\s724 km² \(its mapped reach\), more than fits in the \d+ km the app delineates around a click, so it can’t be proposed in one piece\. Divide it with Sub-catchments, one per click/);
		expect(e.message).not.toMatch(/further upstream/);
	});

	it('words too_large from the reach’s area and the routed side (tooLargeText)', () => {
		expect(tooLargeText('click', 100, 9_000)).toMatch(/^The catchment above that point .* Click further upstream/);
		expect(tooLargeText('click', 100, 10_001)).toMatch(/^The river here drains about 10\s001 km²/);
		expect(tooLargeText('click', null, 1e6)).toMatch(/^The catchment above that point reaches beyond the area the app delineates around a click/);
		expect(tooLargeText('outlet', 100, null)).toMatch(/^The catchment above the outlet .* Pick an outlet gauge further upstream, or type the units in\.$/);
		expect(tooLargeText('outlet', 100, 340_724)).toMatch(/^The river at the outlet drains about 340\s724 km² .* Type the units in, or outline pieces of the river with Sub-catchments, one per click/);
	});

	it('says which window it stopped at when the next would break the budget, and reports each window it starts', async () => {
		const started: [number, number][] = [];
		let t = 0;
		// Each window "takes" 10 s: after the first, the next (4× the cells) can't fit a 20 s budget.
		const e = await refusal(delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y), { windows: [128, 256, 1024], budgetMs: 20_000, now: () => (t += 5_000), onWindow: (i, of) => void started.push([i, of]) }));
		expect(e.code).toBe('too_large');
		expect(e.windowCells).toBe(128);
		expect(started).toEqual([[0, 3]]);
		const steps: [number, number][] = [];
		const r = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y), { windows: [128, 1024], onWindow: (i, of) => void steps.push([i, of]) });
		expect(r.windowCells).toBe(1024);
		expect(steps).toEqual([
			[0, 2],
			[1, 2]
		]);
	});

	it('refuses a catchment that reaches where the DEM has no data', async () => {
		// A click on the fixture's western edge: the ground there falls west, off the data, so what lies beyond is unknown.
		expect((await refusal(delineate(dem, at(0, 256)))).code).toBe('no_data');
	});
});

describe('delineate: a click off the channel (issue #374)', () => {
	// Three cells (about 380 m) east of the river, between the dam and the outlet: on the valley's side, as a displaced river line puts a click.
	const off = at(DAM_CELL.x + 3, DAM_CELL.y + 60);
	const onRiver = at(DAM_CELL.x, DAM_CELL.y + 60);

	it('refuses beside a much larger channel, naming it: where, how far, and both areas', async () => {
		const e = await delineate(dem, off).catch((x: unknown) => x);
		expect(e).toBeInstanceOf(DelineationRefused);
		const r = e as DelineationRefused;
		expect(r.code).toBe('larger_channel');
		// The channel's whole catchment is in the window: its area, not an "about" (finding 10).
		expect(r.message).toMatch(/^A much larger channel runs \d+ m west of your point: [\d\s,]+ km² drains through it, against [\d.]+ km² at your point\. .*Use that channel, or keep your point/);
		expect(r.larger!.distanceM).toBeGreaterThan(200);
		expect(r.larger!.distanceM).toBeLessThan(1000);
		// The channel it names is the river: delineating there gives the valley above it.
		const river = await delineate(dem, r.larger!.at);
		expect(river.areaM2 / 1e6).toBeGreaterThan(100 * r.larger!.pointKm2);
	});

	it('says "at least" when the channel runs past the window, and quotes the mapped river’s own area (the hydrologist’s review, finding 10)', async () => {
		// A 128-cell window cuts the river: 619 km² was quoted for the Orange's 340 724 as "about".
		const r = (await delineate(dem, off, { windows: [128], expected: { km2: 340_724, reach: 'reach 7 of HydroRIVERS' } }).catch((x: unknown) => x)) as DelineationRefused;
		expect(r.code).toBe('larger_channel');
		expect(r.message).toMatch(
			/^A much larger channel runs \d+ m west of your point: at least [\d\s,]+ km² drains through it inside the \d+ km routed around your point, and more from beyond \(the mapped river here, reach 7 of HydroRIVERS, drains 340\s724 km²\), against [\d.]+ km² at your point\./
		);
		expect(r.message).not.toMatch(/about/);
	});

	it('keeps the point when asked: the small catchment it snaps to', async () => {
		const d = await delineate(dem, off, { keepPoint: true });
		expect(d.areaM2).toBeLessThan(0.05 * BASIN_AREA_M2);
		expect(d.method).toMatch(/is offered instead, unless the point is kept/);
		expect(d.methodVersion).toBe(METHOD_VERSION);
	});

	it('matches the outlet to a nearby reach’s upstream area: the river, not the hillside', async () => {
		const river = await delineate(dem, onRiver);
		const d = await delineate(dem, off, { expected: { km2: river.areaM2 / 1e6, reach: 'reach 1 of test' } });
		expect(Math.abs(d.areaM2 / river.areaM2 - 1)).toBeLessThan(0.05);
		expect(d.snapDistanceM).toBeGreaterThan(200);
		expect(d.method).toMatch(/best matches reach 1 of test \(\d+ km²; Lehner 2012/);
	});
});

describe('the e2e copy of the fixture’s points', () => {
	it('matches the fixture (e2e/support/dem.ts can’t import backend source)', () => {
		const text = readFileSync(new URL('../../../e2e/support/dem.ts', import.meta.url), 'utf8');
		const pair = (name: string) => JSON.parse(new RegExp(`${name}: \\[number, number\\] = (\\[[^\\]]+\\])`).exec(text)![1]!);
		expect(pair('FIXTURE_OUTLET')).toEqual(at(OUTLET_CELL.x, OUTLET_CELL.y));
		expect(pair('FIXTURE_DAM')).toEqual(at(DAM_CELL.x, DAM_CELL.y + 1));
		expect(pair('FIXTURE_MID_GAUGE')).toEqual(at(DAM_CELL.x, DAM_CELL.y + 60));
		expect(pair('FIXTURE_UPPER')).toEqual(at(DAM_CELL.x, DAM_CELL.y - 100));
		expect(pair('FIXTURE_OFF_CHANNEL')).toEqual(at(DAM_CELL.x + 3, DAM_CELL.y + 60));
		expect(pair('FIXTURE_JUNCTION')).toEqual(at(DAM_CELL.x + 3, DAM_CELL.y + 30));
	});
});

describe('boundsText', () => {
	it('names each side east or west, north or south, to two decimals', () => {
		expect(boundsText([-1.5, -2.25, 3, 4.125])).toBe('1.50° W to 3.00° E, 2.25° S to 4.13° N');
	});
});

/** What drains into the fixture's pan (m², at the fixture's nominal cell size): every cell whose D8 path enters its disc, routed here from the terrain itself. */
function panCatchmentM2(): number {
	const n = FIXTURE_CELLS;
	const z = new Float64Array(n * n);
	for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) z[y * n + x] = fixtureElevation(x, y);
	const g = { nx: n, ny: n, z };
	const edge = edgeMask(g);
	fill(g, edge);
	const dir = d8(g, edge);
	const inPan = (c: number) => Math.hypot((c % n) - PAN.x, Math.floor(c / n) - PAN.y) < PAN.radius;
	let cells = 0;
	for (let i = 0; i < n * n; i++) {
		for (let c = i, k = 0; k < n * n; k++) {
			if (inPan(c)) {
				cells++;
				break;
			}
			const d = dir[c]!;
			if (d === OUT) break;
			c += DY[d]! * n + DX[d]!;
		}
	}
	return cells * FIXTURE_CELL_M * FIXTURE_CELL_M;
}

describe('delineate: pans (the hydrologist’s review, finding 8)', () => {
	const expected = panCatchmentM2();

	it('reports what drains into the valley’s pan as non-contributing, beside the catchment it leaves whole', async () => {
		const r = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y));
		expect(r.pans.count).toBe(1);
		// Ellipsoid row areas against the nominal cell: within 1 %.
		expect(Math.abs(r.pans.nonContributingM2 / expected - 1)).toBeLessThan(0.01);
		const [pan] = r.pans.largest;
		expect(pan!.drainsM2).toBe(r.pans.nonContributingM2);
		expect(pan!.depthM).toBeGreaterThanOrEqual(PAN.depthM);
		expect(pan!.floorM2).toBeGreaterThan(0.9 * Math.PI * PAN.radius ** 2 * FIXTURE_CELL_M ** 2);
		expect(pan!.storageMm).toBeGreaterThan(1000);
		// Its deepest point is on the pan.
		const [lon, lat] = fixtureLonLat(PAN.x + 0.5, PAN.y + 0.5);
		expect(Math.hypot((pan!.at[0] - lon) * Math.cos((lat * Math.PI) / 180), pan!.at[1] - lat) * 111_320).toBeLessThan(PAN.radius * FIXTURE_CELL_M);
		expect(r.pans.method).toBe(PAN_METHOD);
		// The catchment is the gross one, as before: the pan's area is inside it, and named in the method.
		expect(Math.abs(r.areaM2 / BASIN_AREA_M2 - 1)).toBeLessThan(0.03);
		expect(pointInRing(at(PAN.x, PAN.y), r.geometry.coordinates[0]!)).toBe(true);
		expect(r.method).toMatch(/pans \(closed depressions\) reported beside it as non-contributing, not taken out/);
	});

	it('counts the pan above a dam wall but never the dam’s own reservoir (it holds a few mm over its catchment, and is at the point)', async () => {
		const r = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 1));
		expect(r.pans.count).toBe(1);
		expect(Math.abs(r.pans.nonContributingM2 / expected - 1)).toBeLessThan(0.01);
	});

	it('finds no pan in a catchment without one (positive control above)', async () => {
		// A slope west of the river, away from the pan on the east flank.
		const side = await delineate(dem, at(OUTLET_CELL.x - 30, OUTLET_CELL.y - 60), { keepPoint: true });
		expect(side.pans).toEqual({ nonContributingM2: 0, count: 0, largest: [], method: PAN_METHOD });
	});
});
