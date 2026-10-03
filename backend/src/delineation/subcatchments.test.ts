import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { geometryAreaM2, ringAreaM2 } from '../geo/area.js';
import { pointInGeometry, type Geometry } from '../geo/geojson.js';
import { openDem } from './dem.js';
import { delineate, DelineationRefused, worldPx } from './delineate.js';
import { DAM_CELL, FIXTURE_CELL_M, fixtureLonLat, OUTLET_CELL } from './fixture.js';
import { OUT } from './flow.js';
import { cellRowAreaM2, delineateUnits, mercatorLat, METHOD_MAX_CHARS, mostDrained, ownsLand, partition, placementText, RASTER_MAX_CROSSINGS, rasterize, START_METHOD_VERSION, startMethod, type UnitPoint } from './subcatchments.js';

// The pure core on hand-made grids, then the driver against the committed
// synthetic DEM (fixture.ts: one valley, its river south along the axis, a dam).

/** A 5 × 6 grid: column 2 a river flowing south to the outlet at the bottom; every other cell flows sideways into it. */
function riverGrid() {
	const nx = 5;
	const ny = 6;
	const dir = new Uint8Array(nx * ny);
	for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) dir[y * nx + x] = x < 2 ? 0 : x > 2 ? 4 : y === ny - 1 ? OUT : 2;
	return { nx, ny, dir, at: (x: number, y: number) => y * nx + x, outlet: (ny - 1) * nx + 2 };
}
const owned = (owner: Int32Array, o: number) => owner.reduce((n, v) => n + (v === o ? 1 : 0), 0);

describe('partition', () => {
	it('gives a unit the cells above it and the outlet the rest, every cell once', () => {
		const g = riverGrid();
		const p = partition(g.nx, g.ny, g.dir, g.outlet, [{ cell: g.at(2, 2), owns: true }]);
		expect(p.down).toEqual([-1]);
		expect(owned(p.owner, 0)).toBe(15);
		expect(owned(p.owner, 1)).toBe(15);
		expect(owned(p.owner, -1)).toBe(0);
	});

	it('orders units down the river: the upper drains into the lower, which owns only what lies between', () => {
		const g = riverGrid();
		const p = partition(g.nx, g.ny, g.dir, g.outlet, [
			{ cell: g.at(2, 3), owns: true },
			{ cell: g.at(2, 1), owns: true }
		]);
		expect(p.down).toEqual([-1, 0]);
		expect(owned(p.owner, 1)).toBe(10);
		expect(owned(p.owner, 0)).toBe(10);
		expect(owned(p.owner, 2)).toBe(10);
	});

	it('puts a water user in the network without land: its cells stay with the unit below it', () => {
		const g = riverGrid();
		const p = partition(g.nx, g.ny, g.dir, g.outlet, [
			{ cell: g.at(2, 1), owns: true },
			{ cell: g.at(2, 3), owns: false }
		]);
		// The unit drains into the user, the user into the outlet.
		expect(p.down).toEqual([1, -1]);
		expect(owned(p.owner, 1)).toBe(0);
		expect(owned(p.owner, 0)).toBe(10);
		expect(owned(p.owner, 2)).toBe(20);
	});

	it('puts a gauge in the network without land, as a water user', () => {
		const g = riverGrid();
		const p = partition(g.nx, g.ny, g.dir, g.outlet, [
			{ cell: g.at(2, 1), owns: ownsLand('dam') },
			{ cell: g.at(2, 3), owns: ownsLand('gauge') }
		]);
		expect(p.down).toEqual([1, -1]);
		expect(owned(p.owner, 1)).toBe(0);
		expect(owned(p.owner, 2)).toBe(20);
		expect([ownsLand('abstraction'), ownsLand('user'), ownsLand('gauge')]).toEqual([true, false, false]);
	});

	it('refuses a unit cell that doesn’t drain to the outlet (the caller filters those first)', () => {
		const g = riverGrid();
		g.dir[g.at(0, 0)] = OUT;
		expect(() => partition(g.nx, g.ny, g.dir, g.outlet, [{ cell: g.at(0, 0), owns: true }])).toThrow(/not upstream/);
	});
});

describe('cellRowAreaM2', () => {
	it('is a Web Mercator cell’s area on the ellipsoid, as geo/area.ts measures the cell as a polygon, at the equator and in South Africa', () => {
		const W = worldPx(13, 512);
		const [w, e] = [20, 20 + 360 / W];
		for (const y of [W / 2, Math.round(W * 0.58), Math.round(W * 0.6)]) {
			const [n, s] = [mercatorLat(y, W), mercatorLat(y + 1, W)];
			const area = cellRowAreaM2(n, s, W);
			near(area, ringAreaM2([[w, s], [e, s], [e, n], [w, n], [w, s]]), 1e-9);
			// A cell shrinks towards the pole on the map's own scale, about as its side at its centre squared.
			near(area, ((2 * Math.PI * 6_378_137 * Math.cos((((n + s) / 2) * Math.PI) / 180)) / W) ** 2, 0.01);
		}
	});
});

describe('rasterize and mostDrained', () => {
	it('fills the cells whose centres lie in the ring', () => {
		const m = rasterize(6, 5, [
			[
				[1, 1],
				[4, 1],
				[4, 3],
				[1, 3],
				[1, 1]
			]
		]);
		expect([...m].reduce((a, b) => a + b, 0)).toBe(6);
		expect(m[1 * 6 + 1]).toBe(1);
		expect(m[2 * 6 + 3]).toBe(1);
		expect(m[3 * 6 + 1]).toBe(0);
	});

	it('leaves a hole empty (even–odd)', () => {
		const sq = (a: number, b: number): [number, number][] => [
			[a, a],
			[b, a],
			[b, b],
			[a, b],
			[a, a]
		];
		const m = rasterize(6, 6, [sq(0, 6), sq(2, 4)]);
		expect([...m].reduce((a, b) => a + b, 0)).toBe(32);
		expect(m[2 * 6 + 2]).toBe(0);
	});

	it('picks the most-drained cell of a mask, never an edge cell', () => {
		const acc = Int32Array.from([5, 9, 1, 2]);
		expect(mostDrained(Uint8Array.from([1, 1, 1, 0]), acc, Uint8Array.from([0, 0, 0, 0]))).toBe(1);
		expect(mostDrained(Uint8Array.from([1, 1, 1, 0]), acc, Uint8Array.from([0, 1, 0, 0]))).toBe(0);
		expect(mostDrained(new Uint8Array(4), acc, new Uint8Array(4))).toBe(-1);
	});
});

const dem = openDem(fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url)));
const at = (x: number, y: number) => fixtureLonLat(x + 0.5, y + 0.5);
const point = (id: string, x: number, y: number, role: UnitPoint['role'] = 'dam'): UnitPoint => ({ id, role, geometry: { type: 'Point', coordinates: at(x, y) } });
const near = (a: number, b: number, tol: number) => expect(Math.abs(a / b - 1)).toBeLessThan(tol);

describe('delineateUnits (synthetic DEM)', () => {
	it('divides the valley at the dam: the dam’s unit is the catchment above the wall, the rest what lies between, and they add up', async () => {
		const outlet = at(OUTLET_CELL.x, OUTLET_CELL.y);
		const whole = await delineate(dem, outlet);
		const above = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 1));
		const r = await delineateUnits(dem, { outlet, boundary: null, points: [point('dam', DAM_CELL.x, DAM_CELL.y + 1)] });
		expect(r.units).toHaveLength(1);
		const [dam] = r.units;
		expect(dam!.drainsInto).toBeNull();
		near(dam!.areaM2, above.areaM2, 0.02);
		near(dam!.totalAreaM2, dam!.areaM2, 1e-9);
		near(r.catchment.areaM2, whole.areaM2, 0.01);
		near(r.rest.areaM2, whole.areaM2 - above.areaM2, 0.03);
		// Every area is summed from the partition's cells, so the pieces add up to the catchment exactly.
		near(dam!.areaM2 + r.rest.areaM2, r.catchment.areaM2, 1e-12);
		// The pieces are where they should be: above the wall is the dam's, below it the rest's.
		expect(pointInGeometry(at(DAM_CELL.x, DAM_CELL.y - 60), dam!.geometry as Geometry)).toBe(true);
		expect(pointInGeometry(at(DAM_CELL.x, DAM_CELL.y + 50), dam!.geometry as Geometry)).toBe(false);
		expect(pointInGeometry(at(DAM_CELL.x, DAM_CELL.y + 50), r.rest.geometry as Geometry)).toBe(true);
		expect(r.outlet.foundIn).toBe('snapped');
		expect(r.outlet.snapDistanceM).toBeLessThanOrEqual(1.5 * FIXTURE_CELL_M);
		expect(r.methodVersion).toBe(START_METHOD_VERSION);
		expect(r.method).toMatch(/routed once/);
		expect(r.dataset.fingerprint).toMatch(/^[0-9a-f]{16}$/);
	});

	it('orders two units down the river and sums the upper into the lower’s total', async () => {
		const outlet = at(OUTLET_CELL.x, OUTLET_CELL.y);
		const above = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 1));
		const r = await delineateUnits(dem, {
			outlet,
			boundary: null,
			points: [point('lower', DAM_CELL.x, DAM_CELL.y + 1), point('upper', DAM_CELL.x, DAM_CELL.y - 100, 'abstraction')]
		});
		const lower = r.units.find((u) => u.id === 'lower')!;
		const upper = r.units.find((u) => u.id === 'upper')!;
		expect(upper.drainsInto).toBe('lower');
		expect(lower.drainsInto).toBeNull();
		expect(upper.areaM2).toBeGreaterThan(0);
		near(lower.areaM2 + upper.areaM2, above.areaM2, 0.02);
		near(lower.totalAreaM2, lower.areaM2 + upper.areaM2, 1e-9);
	});

	it('takes every area from the cells: three pieces and the rest add up to the catchment, each outline’s own area a little off its piece’s', async () => {
		const r = await delineateUnits(dem, {
			outlet: at(OUTLET_CELL.x, OUTLET_CELL.y),
			boundary: null,
			points: [point('a', DAM_CELL.x, DAM_CELL.y + 1), point('b', DAM_CELL.x, DAM_CELL.y - 40), point('c', DAM_CELL.x, DAM_CELL.y + 40)]
		});
		expect(r.units).toHaveLength(3);
		const sum = r.units.reduce((s, u) => s + u.areaM2, 0) + r.rest.areaM2;
		// The simplified outlines' areas fell 0.07 % short here, 0.51 % on other divides (start-4).
		near(sum, r.catchment.areaM2, 1e-12);
		expect(r.method).toMatch(/areas summed from the cells/);
		// The outlines are simplified for the map: their own areas stay near the cells' but are not them.
		for (const u of r.units) near(geometryAreaM2(u.geometry!)!, u.areaM2, 0.01);
		near(geometryAreaM2(r.catchment.geometry)!, r.catchment.areaM2, 0.01);
	});

	it('finds the outlet inside a boundary when none is given', async () => {
		const whole = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y));
		const r = await delineateUnits(dem, { outlet: null, boundary: whole.geometry, points: [] });
		expect(r.outlet.foundIn).toBe('boundary');
		expect(r.outlet.snapDistanceM).toBeNull();
		near(r.catchment.areaM2, whole.areaM2, 0.03);
		near(r.rest.areaM2, r.catchment.areaM2, 0.01);
	});

	it('keeps a water user in the order without land, and drops points that can’t be units, saying why', async () => {
		const outlet = at(OUTLET_CELL.x, OUTLET_CELL.y);
		const r = await delineateUnits(dem, {
			outlet,
			boundary: null,
			points: [
				point('dam', DAM_CELL.x, DAM_CELL.y + 1),
				point('town', DAM_CELL.x, DAM_CELL.y + 40, 'user'),
				point('twin', DAM_CELL.x, DAM_CELL.y + 1),
				point('beyond', OUTLET_CELL.x + 150, OUTLET_CELL.y - 100),
				point('at-outlet', OUTLET_CELL.x, OUTLET_CELL.y)
			]
		});
		expect(r.units.map((u) => u.id)).toEqual(['dam', 'town']);
		const town = r.units.find((u) => u.id === 'town')!;
		expect(r.units.find((u) => u.id === 'dam')!.drainsInto).toBe('town');
		expect(town.drainsInto).toBeNull();
		expect(town.areaM2).toBe(0);
		expect(town.geometry).toBeNull();
		expect(Object.fromEntries(r.dropped.map((d) => [d.id, d.reason]))).toEqual({
			twin: expect.stringMatching(/same place on the river/),
			beyond: expect.stringMatching(/isn’t upstream of the outlet/),
			'at-outlet': expect.stringMatching(/outlet itself/)
		});
	});

	it('puts a gauge inside the catchment in the order without land, its whole catchment counted above it', async () => {
		const outlet = at(OUTLET_CELL.x, OUTLET_CELL.y);
		const atGauge = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 60));
		const r = await delineateUnits(dem, {
			outlet,
			boundary: null,
			points: [point('dam', DAM_CELL.x, DAM_CELL.y + 1), point('weir', DAM_CELL.x, DAM_CELL.y + 60, 'gauge')]
		});
		const dam = r.units.find((u) => u.id === 'dam')!;
		const weir = r.units.find((u) => u.id === 'weir')!;
		// The dam drains into the gauge, the gauge into the outlet; the gauge owns no land, so the land between stays the rest's.
		expect(dam.drainsInto).toBe('weir');
		expect(weir.drainsInto).toBeNull();
		expect(weir.areaM2).toBe(0);
		expect(weir.geometry).toBeNull();
		near(dam.areaM2 + r.rest.areaM2, r.catchment.areaM2, 0.01);
		// What the gauge measures: everything above it, the dam's piece and the land between.
		near(weir.totalAreaM2, atGauge.areaM2, 0.03);
		expect(weir.totalAreaM2).toBeGreaterThan(dam.areaM2);
		expect(r.method).toMatch(/a water user or a gauge owns none/);
	});

	it('takes a dam polygon’s most-drained cell as its outflow', async () => {
		const outlet = at(OUTLET_CELL.x, OUTLET_CELL.y);
		// The reservoir behind the wall, as a polygon.
		const ring = [at(DAM_CELL.x - 8, DAM_CELL.y - 30), at(DAM_CELL.x + 8, DAM_CELL.y - 30), at(DAM_CELL.x + 8, DAM_CELL.y - 1), at(DAM_CELL.x - 8, DAM_CELL.y - 1), at(DAM_CELL.x - 8, DAM_CELL.y - 30)];
		const r = await delineateUnits(dem, { outlet, boundary: null, points: [{ id: 'res', role: 'dam', geometry: { type: 'Polygon', coordinates: [ring] } }] });
		expect(r.units).toHaveLength(1);
		expect(r.units[0]!.snapDistanceM).toBeNull();
		expect(r.units[0]!.areaM2).toBeGreaterThan(0.3 * r.catchment.areaM2);
	});

	it('refuses with a sentence: no outlet and no boundary; a catchment past the largest window', async () => {
		const e1 = await delineateUnits(dem, { outlet: null, boundary: null, points: [] }).catch((e: unknown) => e);
		expect(e1).toBeInstanceOf(DelineationRefused);
		expect((e1 as Error).message).toMatch(/Pick the outlet gauge/);
		const e2 = await delineateUnits(dem, { outlet: at(OUTLET_CELL.x, OUTLET_CELL.y), boundary: null, points: [] }, { windows: [64] }).catch((e: unknown) => e);
		expect(e2).toBeInstanceOf(DelineationRefused);
		expect((e2 as DelineationRefused).code).toBe('too_large');
	});
});

describe('delineateUnits: each point placed as Delineate places it (start-7, the hydrologist’s review finding 3)', () => {
	// A gauge on a displaced river line: three cells (about 380 m) east of the river, on the valley's side, where a 150 m
	// snap finds only the hillside's gully. The dam point five cells up the same line, as the review placed it.
	const outlet = at(OUTLET_CELL.x, OUTLET_CELL.y);
	const gauge = at(DAM_CELL.x + 3, DAM_CELL.y + 60);
	const damPoint = (hints: Partial<UnitPoint> = {}): UnitPoint => ({ ...point('dam', DAM_CELL.x + 3, DAM_CELL.y + 20), ...hints });

	it('reproduces the old path: snapped 150 m, the gauge lands in a gully, the dam is dropped, and the guard names the river', async () => {
		const r = await delineateUnits(dem, { outlet: gauge, boundary: null, points: [damPoint()] });
		const river = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 60));
		expect(r.catchment.areaM2).toBeLessThan(0.02 * river.areaM2);
		expect(r.dropped.map((d) => d.id)).toEqual(['dam']);
		expect(r.outlet.placedBy).toBe('snapped');
		// The outlet's larger-channel guard is kept (it was discarded before start-7): the river, a few cells west.
		expect(r.outlet.larger).toMatchObject({ distanceM: expect.any(Number), km2: expect.any(Number) });
		expect(r.outlet.larger!.km2).toBeGreaterThan(100 * r.outlet.larger!.pointKm2);
		expect(r.method).toMatch(/placed on the channel: the outlet snapped, 1 point snapped \(snapped: the most-accumulating cell within 150 m, a 100× larger channel within 1000 m named\)/);
		expect(r.method).not.toMatch(/matched/);
	});

	it('matches the gauge and the dam to their reach’s area: the river’s catchment, the dam kept above it, as Delineate gives', async () => {
		const river = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 60));
		const atDam = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 20));
		const r = await delineateUnits(dem, {
			outlet: gauge,
			outletHints: { expectedKm2: river.areaM2 / 1e6 },
			boundary: null,
			points: [damPoint({ expectedKm2: atDam.areaM2 / 1e6 })]
		});
		near(r.catchment.areaM2, river.areaM2, 0.02);
		expect(r.outlet).toMatchObject({ placedBy: 'matched' });
		expect(r.outlet.larger).toBeUndefined();
		expect(r.dropped).toEqual([]);
		const dam = r.units[0]!;
		expect(dam).toMatchObject({ id: 'dam', placedBy: 'matched', drainsInto: null });
		near(dam.totalAreaM2, atDam.areaM2, 0.03);
		// The method says what ran, and only that.
		expect(r.method).toMatch(/placed on the channel: the outlet matched, 1 point matched \(matched: the cell within 1000 m .* best matching the river reach’s area \(Lehner 2012/);
		expect(r.method).not.toMatch(/snapped/);
		expect(r.methodVersion).toBe('start-9');
	});

	it('says when a reach is near but no channel matches it (unmatched), and keeps the guard', async () => {
		// An area no cell within 1 km has: matching fails and the gauge falls back to the snap.
		const r = await delineateUnits(dem, { outlet: gauge, outletHints: { expectedKm2: 1e6 }, boundary: null, points: [] });
		expect(r.outlet).toMatchObject({ placedBy: 'snapped', unmatched: true });
		expect(r.outlet.larger).toBeDefined();
	});

	it('puts a point on the larger channel when the editor chose it (useLarger), found again on the server', async () => {
		const river = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 60));
		const r = await delineateUnits(dem, { outlet: gauge, outletHints: { useLarger: true }, boundary: null, points: [damPoint({ useLarger: true })] });
		expect(r.outlet.placedBy).toBe('larger');
		near(r.catchment.areaM2, river.areaM2, 0.05);
		expect(r.units.map((u) => [u.id, u.placedBy])).toEqual([['dam', 'larger']]);
		expect(r.method).toMatch(/the outlet on the larger channel chosen, 1 point on the larger channel chosen \(snapped: /);
	});

	it('keeps a delineated outlet on its own cell (exact) instead of snapping it further down the river', async () => {
		const d = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 60));
		const exact = await delineateUnits(dem, { outlet: d.outlet, outletHints: { exact: true }, boundary: null, points: [] });
		expect(exact.outlet.point).toEqual(d.outlet);
		expect(exact.outlet.placedBy).toBe('exact');
		near(exact.catchment.areaM2, d.areaM2, 0.01);
		// The plain snap moves it to the most-drained cell within 150 m: downstream on the river, a little more area.
		const snapped = await delineateUnits(dem, { outlet: d.outlet, boundary: null, points: [] });
		expect(snapped.outlet.point).not.toEqual(d.outlet);
		expect(snapped.catchment.areaM2).toBeGreaterThan(exact.catchment.areaM2);
	});
});

describe('placementText and startMethod', () => {
	it('names only the rules that ran, the outlet first, with counts, each defined once', () => {
		expect(placementText(['matched', 'matched', 'polygon'], 0, 'exact', 150)).toBe(
			'placed on the channel: the outlet on its delineated cell, 2 points matched, 1 point at a dam polygon’s most-accumulating cell (matched: the cell within 1000 m (2500 m at a picked confluence) best matching the river reach’s area (Lehner 2012, accordance ≥ 50 %))'
		);
		const t = placementText(['snapped', 'snapped', 'junction'], 1, 'boundary', 150);
		expect(t).toBe(
			'placed on the channel: the outlet at the boundary’s most-accumulating cell, 1 point at a junction, 2 points snapped (at a junction: the DEM’s junction for the river picked; snapped: the most-accumulating cell within 150 m (1 by an unmatched reach), a 100× larger channel within 1000 m named)'
		);
		expect(t).not.toMatch(/matched:/);
		expect(placementText([], 0, null, 150)).toBe('no points placed');
	});

	it('fits start_proposal.method (1 000 characters) whatever ran, every rule at once', () => {
		// Every placement a point can have, twice, with the longest outlet's and a click outlet's note.
		const points = ['matched', 'junction', 'snapped', 'larger', 'polygon'] as const;
		const m = startMethod(99_999, 11, placementText([...points, ...points], 50, 'boundary', 150) + ' (the outlet: the click most water drains through)');
		expect(m.length).toBeLessThanOrEqual(METHOD_MAX_CHARS);
	});
});

describe('rasterize is bounded (round-4 hardening)', () => {
	it('refuses an outline whose edges cross more rows than the budget, quickly', () => {
		// A 50 000-edge zigzag up and down the whole 3 072-row window: 150 million crossings.
		const ring: [number, number][] = [];
		for (let k = 0; k < 50_000; k++) ring.push([k * 0.05, k % 2 ? 3071 : 1]);
		ring.push(ring[0]!);
		const t = performance.now();
		expect(() => rasterize(3072, 3072, [ring])).toThrow(DelineationRefused);
		expect(performance.now() - t).toBeLessThan(2_000);
		expect(RASTER_MAX_CROSSINGS).toBeGreaterThan(3072 * 50);
	});
});
