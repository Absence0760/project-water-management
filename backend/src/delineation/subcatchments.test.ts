import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pointInGeometry, type Geometry } from '../geo/geojson.js';
import { openDem } from './dem.js';
import { delineate, DelineationRefused } from './delineate.js';
import { DAM_CELL, FIXTURE_CELL_M, fixtureLonLat, OUTLET_CELL } from './fixture.js';
import { OUT } from './flow.js';
import { delineateUnits, mostDrained, partition, rasterize, START_METHOD_VERSION, type UnitPoint } from './subcatchments.js';

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

	it('refuses a unit cell that doesn’t drain to the outlet (the caller filters those first)', () => {
		const g = riverGrid();
		g.dir[g.at(0, 0)] = OUT;
		expect(() => partition(g.nx, g.ny, g.dir, g.outlet, [{ cell: g.at(0, 0), owns: true }])).toThrow(/not upstream/);
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
		near(dam!.areaM2 + r.rest.areaM2, r.catchment.areaM2, 0.01);
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
