import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { geometryAreaM2, ringAreaM2 } from '../geo/area.js';
import { pointInGeometry, type Geometry } from '../geo/geojson.js';
import { openDem } from './dem.js';
import { delineate, DelineationRefused, worldPx } from './delineate.js';
import { DAM_CELL, FIXTURE_CELL_M, fixtureLonLat, OUTLET_CELL, PAN } from './fixture.js';
import { accumulate, OUT } from './flow.js';
import { LARGER_FACTOR } from './place.js';
import { cellRowAreaM2, damOutflow, delineateUnits, fitMethod, mercatorLat, METHOD_MAX_CHARS, mostDrained, offChannelOutflow, ownsLand, riverBelow, partition, placementText, RASTER_MAX_CROSSINGS, rasterize, START_METHOD_VERSION, startMethod, type PlacedBy, type UnitPoint } from './subcatchments.js';

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

	it('puts a dam polygon’s outflow at its most-drained cell when the river runs through it (an on-channel reservoir)', () => {
		const g = riverGrid();
		const acc = accumulate(g.nx, g.ny, g.dir);
		const mask = new Uint8Array(g.nx * g.ny);
		for (let y = 1; y <= 4; y++) for (let x = 1; x <= 3; x++) mask[g.at(x, y)] = 1;
		expect(damOutflow(g.nx, mask, g.dir, acc, new Uint8Array(mask.length))).toEqual({ cell: g.at(2, 4), straddled: null });
	});

	it('puts an outline that only clips the river at its own footprint’s outflow, the river offered (finding 9)', () => {
		const g = riverGrid();
		const acc = accumulate(g.nx, g.ny, g.dir);
		// The river brings a large catchment in from above the grid.
		for (let y = 0; y < g.ny; y++) acc[g.at(2, y)]! += 10_000;
		// A 2 × 2 off-channel dam east of the river whose outline takes in one river cell beside it.
		const mask = new Uint8Array(g.nx * g.ny);
		for (const [x, y] of [[3, 1], [4, 1], [3, 2], [4, 2], [2, 2]] as const) mask[g.at(x, y)] = 1;
		const edge = new Uint8Array(mask.length);
		// Before: the most-drained cell, the river's.
		expect(mostDrained(mask, acc, edge)).toBe(g.at(2, 2));
		const out = damOutflow(g.nx, mask, g.dir, acc, edge);
		expect(out.straddled).toBe(g.at(2, 2));
		expect([g.at(3, 1), g.at(3, 2)]).toContain(out.cell);
		expect(acc[out.straddled!]!).toBeGreaterThanOrEqual(LARGER_FACTOR * acc[out.cell]!);
		// A river only a few times the dam's own flow is not "much larger": taken as before.
		const small = accumulate(g.nx, g.ny, g.dir);
		expect(damOutflow(g.nx, mask, g.dir, small, edge)).toEqual({ cell: g.at(2, 2), straddled: null });
		// The same outline without the river cell is placed as before.
		mask[g.at(2, 2)] = 0;
		expect(damOutflow(g.nx, mask, g.dir, acc, edge).straddled).toBeNull();
		expect(damOutflow(g.nx, new Uint8Array(mask.length), g.dir, acc, edge)).toEqual({ cell: -1, straddled: null });
	});

	describe('a dam the editor marked on or off the river (194, map_feature.dam_position)', () => {
		/** The river grid with a large catchment brought in from above it, and a mask of the cells given. */
		const setup = (cells: readonly (readonly [number, number])[]) => {
			const g = riverGrid();
			const acc = accumulate(g.nx, g.ny, g.dir);
			for (let y = 0; y < g.ny; y++) acc[g.at(2, y)]! += 10_000;
			const mask = new Uint8Array(g.nx * g.ny);
			for (const [x, y] of cells) mask[g.at(x, y)] = 1;
			return { g, acc, mask, edge: new Uint8Array(mask.length) };
		};
		// A long off-channel dam lying along the river: two cells wide, the river its west column for its whole length.
		const along = [0, 1, 2, 3, 4].flatMap((y) => [[2, y] as const, [3, y] as const]);

		it('reproduces the gap: unset, a long dam along the river is taken as on it (its stem runs the outline’s length)', () => {
			const { g, acc, mask, edge } = setup(along);
			expect(damOutflow(g.nx, mask, g.dir, acc, edge)).toEqual({ cell: g.at(2, 4), straddled: null });
			expect(damOutflow(g.nx, mask, g.dir, acc, edge, null)).toEqual({ cell: g.at(2, 4), straddled: null });
		});

		it('off-channel: its own outflow, no river cell taken, nothing offered', () => {
			const { g, acc, mask, edge } = setup(along);
			const out = damOutflow(g.nx, mask, g.dir, acc, edge, 'off_channel');
			expect(out.straddled).toBeNull();
			expect(out.cell % g.nx).toBe(3);
			expect(acc[out.cell]!).toBeLessThan(LARGER_FACTOR * 10);
		});

		it('on the river: the river’s cell, even for an outline the automatic rule takes as only clipping it', () => {
			const { g, acc, mask, edge } = setup([[3, 1], [4, 1], [3, 2], [4, 2], [2, 2]]);
			// Unset: the clip rule puts it off the river, the river offered.
			expect(damOutflow(g.nx, mask, g.dir, acc, edge).straddled).toBe(g.at(2, 2));
			expect(damOutflow(g.nx, mask, g.dir, acc, edge, 'on_channel')).toEqual({ cell: g.at(2, 2), straddled: null });
			// Off-channel: its own, as the clip rule says, but with no channel offered.
			const off = damOutflow(g.nx, mask, g.dir, acc, edge, 'off_channel');
			expect(off.straddled).toBeNull();
			expect([g.at(3, 1), g.at(3, 2)]).toContain(off.cell);
		});

		it('off-channel with no watercourse in its outline: its most-drained cell, as any dam', () => {
			const g = riverGrid();
			const acc = accumulate(g.nx, g.ny, g.dir);
			const mask = new Uint8Array(g.nx * g.ny);
			for (const [x, y] of along) mask[g.at(x, y)] = 1;
			// The column-2 cells carry their side cells only (at most 26 cells here), under 100× the outline's 10 cells.
			expect(damOutflow(g.nx, mask, g.dir, acc, new Uint8Array(mask.length), 'off_channel').cell).toBe(g.at(2, 4));
		});

		it('off-channel drawn wholly on the river: no outflow of its own (-1)', () => {
			const { g, acc, mask, edge } = setup([[2, 1], [2, 2], [2, 3]]);
			expect(damOutflow(g.nx, mask, g.dir, acc, edge, 'off_channel')).toEqual({ cell: -1, straddled: null });
			expect(damOutflow(g.nx, mask, g.dir, acc, edge, 'on_channel').cell).toBe(g.at(2, 3));
		});

		it('off-channel leaves out every stretch of the river, where it leaves the outline and comes back too', () => {
			const { g, acc, mask, edge } = setup([[2, 0], [3, 0], [3, 1], [3, 2], [2, 3], [3, 3]]);
			// The river's cell (2, 1)–(2, 2) are outside: its re-entry at (2, 3) is the most-drained, and a stem of one cell.
			expect(offChannelOutflow(mask, acc, edge) % g.nx).toBe(3);
			expect(damOutflow(g.nx, mask, g.dir, acc, edge, 'off_channel').cell % g.nx).toBe(3);
		});
	});

	it('finds where an off-channel dam’s outflow joins its river, within the steps given', () => {
		const g = riverGrid();
		const acc = accumulate(g.nx, g.ny, g.dir);
		for (let y = 0; y < g.ny; y++) acc[g.at(2, y)]! += 10_000;
		// From (4, 1): west to (3, 1), then the river at (2, 1).
		expect(riverBelow(g.nx, g.dir, acc, g.at(4, 1), 1000, 5)).toBe(g.at(2, 1));
		expect(riverBelow(g.nx, g.dir, acc, g.at(4, 1), 1000, 1)).toBe(-1);
		// A cell on the river is its own junction; no watercourse that large anywhere: none.
		expect(riverBelow(g.nx, g.dir, acc, g.at(2, 3), 1000, 0)).toBe(g.at(2, 3));
		expect(riverBelow(g.nx, g.dir, acc, g.at(4, 1), 1e9, 99)).toBe(-1);
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
		// The river runs the reservoir's length: on the channel, nothing offered.
		expect(r.units[0]!.placedBy).toBe('polygon');
		expect(r.units[0]!.larger).toBeUndefined();
	});

	describe('a dam polygon whose outline clips the river (the hydrologist’s review, finding 9)', () => {
		const outlet = at(OUTLET_CELL.x, OUTLET_CELL.y);
		const corner = (x: number, y: number) => fixtureLonLat(x, y);
		const X = DAM_CELL.x;
		const Y = DAM_CELL.y + 40;
		// An off-channel dam: a 4 × 4-cell block east of the river, below the reservoir; `clipping` takes in one river cell at its corner.
		const beside = [corner(X + 1, Y), corner(X + 5, Y), corner(X + 5, Y + 4), corner(X + 1, Y + 4), corner(X + 1, Y)];
		const clipping = [corner(X + 1, Y), corner(X + 5, Y), corner(X + 5, Y + 4), corner(X, Y + 4), corner(X, Y + 3), corner(X + 1, Y + 3), corner(X + 1, Y)];
		const dam = (ring: [number, number][], hints: Partial<UnitPoint> = {}): UnitPoint => ({ id: 'off', role: 'dam', geometry: { type: 'Polygon', coordinates: [ring] }, ...hints });

		it('takes the dam’s own outflow, not the river’s (it took the river’s whole catchment), and offers the river', async () => {
			const own = await delineateUnits(dem, { outlet, boundary: null, points: [dam(beside)] });
			const r = await delineateUnits(dem, { outlet, boundary: null, points: [dam(clipping)] });
			const river = await delineate(dem, at(X, Y + 3));
			const u = r.units[0]!;
			expect(u.placedBy).toBe('polygon');
			// About the footprint's own catchment (the block beside the river), nowhere near the river's 100s of km².
			expect(u.totalAreaM2).toBeLessThan(2 * own.units[0]!.totalAreaM2 + 1e5);
			expect(u.totalAreaM2).toBeLessThan(0.02 * river.areaM2);
			expect(u.larger).toMatchObject({ outline: true });
			expect(u.larger!.km2).toBeGreaterThan(LARGER_FACTOR * u.larger!.pointKm2);
			near(u.larger!.km2 * 1e6, river.areaM2, 0.05);
			expect(own.units[0]!.larger).toBeUndefined();
			expect(r.method).toMatch(/1 point at a dam polygon’s outflow/);
		});

		// A long off-channel dam lying along the river: three cells wide and 20 long, the river its west column all the way.
		const along = [corner(X, Y), corner(X + 3, Y), corner(X + 3, Y + 20), corner(X, Y + 20), corner(X, Y)];

		it('a long dam along the river: unset, the dam takes the river (the gap); marked off-channel, its unit is the river’s reach and the dam’s own catchment its share; on the river, the river’s', async () => {
			const river = await delineate(dem, at(X, Y + 19));
			const unset = await delineateUnits(dem, { outlet, boundary: null, points: [dam(along)] });
			const off = await delineateUnits(dem, { outlet, boundary: null, points: [dam(along, { damPosition: 'off_channel' })] });
			const on = await delineateUnits(dem, { outlet, boundary: null, points: [dam(along, { damPosition: 'on_channel' })] });
			// Unset: the stem runs the outline's length, so the automatic rule takes it as on the river (unchanged: start-12).
			expect(unset.units[0]!.totalAreaM2).toBeGreaterThan(0.5 * river.areaM2);
			expect(unset.units[0]!.damPosition).toBeUndefined();
			expect(unset.method).not.toMatch(/marked/);
			// Off-channel: the unit is the river's reach where the dam's own outflow joins it (the river passes the dam by, River to
			// dam fills it), so the unit's area is the river's; the dam's own catchment, its share, is nowhere near it.
			const u = off.units[0]!;
			expect(u).toMatchObject({ placedBy: 'polygon', damPosition: 'off_channel' });
			expect(u.totalAreaM2).toBeGreaterThan(0.5 * river.areaM2);
			expect(u.damCatchmentM2!).toBeGreaterThan(0);
			expect(u.damCatchmentM2!).toBeLessThan(0.02 * river.areaM2);
			expect(u.damCatchmentM2!).toBeLessThanOrEqual(u.areaM2);
			expect(u.larger).toBeUndefined();
			expect(unset.units[0]!.damCatchmentM2).toBeUndefined();
			expect(off.method).toMatch(/1 point at a dam polygon’s outflow \(1 marked off-channel\)/);
			expect(off.method).toMatch(/marked off-channel: its unit on the river where its own outflow \(no cell carrying 100× the outline’s cells\) joins it within 1000 m, what drains to that outflow the dam’s share/);
			expect(off.method).not.toMatch(/its own if a river only clips it/);
			// On the river: the river's cell, as unset here.
			expect(on.units[0]!).toMatchObject({ placedBy: 'polygon', damPosition: 'on_channel' });
			near(on.units[0]!.totalAreaM2, unset.units[0]!.totalAreaM2, 0.001);
			expect(on.method).toMatch(/\(1 marked on the river\).*marked on the river: its most-accumulating cell/);
		});

		it('an outline that only clips the river, marked on it: the river’s catchment, nothing offered', async () => {
			const r = await delineateUnits(dem, { outlet, boundary: null, points: [dam(clipping, { damPosition: 'on_channel' })] });
			const river = await delineate(dem, at(X, Y + 3));
			expect(r.units[0]!).toMatchObject({ placedBy: 'polygon', damPosition: 'on_channel' });
			expect(r.units[0]!.larger).toBeUndefined();
			near(r.units[0]!.totalAreaM2, river.areaM2, 0.05);
		});

		it('takes a sub-cell off-channel dam’s own catchment from the cell under it, never the river’s', async () => {
			// A tenth of a cell, in the cell just east of the river.
			const [cx, cy] = [X + 1.1, Y + 5.1];
			const tiny = [corner(cx, cy), corner(cx + 0.1, cy), corner(cx + 0.1, cy + 0.1), corner(cx, cy + 0.1), corner(cx, cy)];
			const river = await delineate(dem, at(X, Y + 5));
			const unset = await delineateUnits(dem, { outlet, boundary: null, points: [dam(tiny)] });
			const off = await delineateUnits(dem, { outlet, boundary: null, points: [dam(tiny, { damPosition: 'off_channel' })] });
			// Unset, its corner is snapped to the most-drained cell within 150 m. Off-channel, the dam's own catchment is the cell
			// under it (never the river's), and its unit the river beside it, where that cell drains.
			expect(unset.units[0]!.placedBy).toBe('snapped');
			const u = off.units[0]!;
			expect(u).toMatchObject({ placedBy: 'polygon', damPosition: 'off_channel' });
			expect(u.totalAreaM2).toBeGreaterThan(0.5 * river.areaM2);
			expect(u.damCatchmentM2!).toBeGreaterThan(0);
			expect(u.damCatchmentM2!).toBeLessThan(0.01 * river.areaM2);
		});

		it('drops an off-channel dam drawn wholly on the river, saying why', async () => {
			const onRiver = [corner(X, Y), corner(X + 1, Y), corner(X + 1, Y + 10), corner(X, Y + 10), corner(X, Y)];
			const r = await delineateUnits(dem, { outlet, boundary: null, points: [dam(onRiver, { damPosition: 'off_channel' })] });
			expect(r.units).toHaveLength(0);
			expect(r.dropped).toEqual([expect.objectContaining({ id: 'off', damPosition: 'off_channel', reason: expect.stringMatching(/marked off-channel, but its whole outline lies on the river/) })]);
		});

		it('puts the dam on the river when the editor says it is on it (Use that channel)', async () => {
			const r = await delineateUnits(dem, { outlet, boundary: null, points: [dam(clipping, { useLarger: true })] });
			const river = await delineate(dem, at(X, Y + 3));
			expect(r.units[0]!.placedBy).toBe('larger');
			near(r.units[0]!.totalAreaM2, river.areaM2, 0.05);
		});
	});

	it('refuses with a sentence: no outlet and no boundary; a catchment past the largest window', async () => {
		const e1 = await delineateUnits(dem, { outlet: null, boundary: null, points: [] }).catch((e: unknown) => e);
		expect(e1).toBeInstanceOf(DelineationRefused);
		expect((e1 as Error).message).toMatch(/Pick the outlet gauge/);
		const e2 = await delineateUnits(dem, { outlet: at(OUTLET_CELL.x, OUTLET_CELL.y), boundary: null, points: [] }, { windows: [64] }).catch((e: unknown) => e);
		expect(e2).toBeInstanceOf(DelineationRefused);
		expect((e2 as DelineationRefused).code).toBe('too_large');
		expect((e2 as Error).message).toMatch(/Pick an outlet gauge further upstream, or type the units in\.$/);
		// A gauge on a main stem: no gauge further upstream helps; the units are typed, or the river outlined in pieces (finding 11).
		const e3 = await delineateUnits(dem, { outlet: at(OUTLET_CELL.x, OUTLET_CELL.y), outletMappedKm2: 340_724, boundary: null, points: [] }, { windows: [64] }).catch((e: unknown) => e);
		expect((e3 as DelineationRefused).code).toBe('too_large');
		expect((e3 as Error).message).toMatch(/^The river at the outlet drains about 340\s724 km² \(its mapped reach\), more than fits in the \d+ km the app delineates around it/);
	});
});

describe('delineateUnits: each point on the terrain channel nearest it (start-15, issue #472)', () => {
	// A gauge on a displaced river line: three cells (about 380 m) east of the river, on one of the valley side's small terrain
	// channels. The dam point forty cells up the same line.
	const gauge = at(DAM_CELL.x + 3, DAM_CELL.y + 60);
	const damPoint = (hints: Partial<UnitPoint> = {}): UnitPoint => ({ ...point('dam', DAM_CELL.x + 3, DAM_CELL.y + 20), ...hints });

	it('puts the gauge on its own small channel, never moved onto the river, and the guard names the river', async () => {
		const r = await delineateUnits(dem, { outlet: gauge, boundary: null, points: [damPoint()] });
		const river = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 60));
		expect(r.catchment.areaM2).toBeLessThan(0.02 * river.areaM2);
		expect(r.outlet.snapDistanceM!).toBeLessThan(FIXTURE_CELL_M);
		expect(r.dropped.map((d) => d.id)).toEqual(['dam']);
		expect(r.outlet.placedBy).toBe('snapped');
		// The outlet's larger-channel guard: the river, a few cells west (the DEM alone).
		expect(r.outlet.larger).toMatchObject({ distanceM: expect.any(Number), km2: expect.any(Number) });
		expect(r.outlet.larger!.km2).toBeGreaterThan(100 * r.outlet.larger!.pointKm2);
		expect(r.method).toMatch(
			/placed on the channel: the outlet on the nearest terrain channel, 1 point on the nearest terrain channel \(the nearest terrain channel: the nearest cell within 150 m with at least 1 km² draining through it, the mapped river network not used; a 100× larger channel within 1000 m named\)/
		);
		expect(r.methodVersion).toBe(START_METHOD_VERSION);
	});

	it('puts a point on the larger channel when the editor chose it (useLarger), found again on the server', async () => {
		const river = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 60));
		const r = await delineateUnits(dem, { outlet: gauge, outletHints: { useLarger: true }, boundary: null, points: [damPoint({ useLarger: true })] });
		expect(r.outlet.placedBy).toBe('larger');
		near(r.catchment.areaM2, river.areaM2, 0.05);
		expect(r.units.map((u) => [u.id, u.placedBy])).toEqual([['dam', 'larger']]);
		expect(r.method).toMatch(/the outlet on the larger channel chosen, 1 point on the larger channel chosen \(the nearest terrain channel: /);
	});

	it('refuses an outlet with no terrain channel within the radius, and drops such a point with why', async () => {
		// Just past the ridge, where nothing drains a square kilometre.
		const slope = at(OUTLET_CELL.x - 91, OUTLET_CELL.y - 120);
		const e = await delineateUnits(dem, { outlet: slope, boundary: null, points: [] }).catch((x: unknown) => x);
		expect((e as DelineationRefused).code).toBe('off_channel');
		expect((e as Error).message).toBe('No terrain channel runs within 150 m of the outlet gauge. Move the gauge onto a terrain channel (Delineate and Sub-catchments draw them as red lines) and propose again.');
		const r = await delineateUnits(dem, { outlet: at(OUTLET_CELL.x, OUTLET_CELL.y), boundary: null, points: [{ ...point('far', 0, 0), geometry: { type: 'Point', coordinates: slope } }] });
		expect(r.dropped).toEqual([{ id: 'far', reason: 'has no terrain channel within 150 m: move it onto one of the elevation model’s channels' }]);
	});

	it('keeps a delineated outlet on its own cell (exact), and the plain snap leaves it there too: it is on a channel already', async () => {
		const d = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 60));
		const exact = await delineateUnits(dem, { outlet: d.outlet, outletHints: { exact: true }, boundary: null, points: [] });
		expect(exact.outlet.point).toEqual(d.outlet);
		expect(exact.outlet.placedBy).toBe('exact');
		near(exact.catchment.areaM2, d.areaM2, 0.01);
		// The nearest channel cell to a channel cell's centre is itself: never moved down the river to a more-drained one.
		const snapped = await delineateUnits(dem, { outlet: d.outlet, boundary: null, points: [] });
		expect(snapped.outlet.point).toEqual(d.outlet);
		expect(snapped.outlet.placedBy).toBe('snapped');
		near(snapped.catchment.areaM2, exact.catchment.areaM2, 1e-9);
	});
});

describe('delineateUnits: pans (the hydrologist’s review, finding 8)', () => {
	it('reports what drains into the pan in the piece that holds it, its unit’s whole catchment, the catchment, and nowhere else', async () => {
		const outlet = at(OUTLET_CELL.x, OUTLET_CELL.y);
		const whole = await delineate(dem, outlet);
		const r = await delineateUnits(dem, {
			outlet,
			boundary: null,
			// The dam below the pan; a gauge on the river below the dam (it owns no land); the rest below them.
			points: [point('dam', DAM_CELL.x, DAM_CELL.y + 1), point('gauge', OUTLET_CELL.x, OUTLET_CELL.y - 10, 'gauge')]
		});
		const dam = r.units.find((u) => u.id === 'dam')!;
		const gauge = r.units.find((u) => u.id === 'gauge')!;
		expect(r.pans.count).toBe(1);
		near(r.pans.nonContributingM2, whole.pans.nonContributingM2, 1e-6);
		// The pan lies above the dam: its piece holds it all, the rest none.
		// (the report rounds to the square metre)
		near(dam.nonContributingM2, r.pans.nonContributingM2, 1e-6);
		near(dam.totalNonContributingM2, dam.nonContributingM2, 1e-9);
		expect(r.rest.nonContributingM2).toBe(0);
		// The gauge owns no land, but its whole catchment holds the pan's.
		expect(gauge.nonContributingM2).toBe(0);
		near(gauge.totalNonContributingM2, r.pans.nonContributingM2, 1e-6);
		// Reported, not taken out: the areas are what they were.
		near(dam.areaM2 + r.rest.areaM2, r.catchment.areaM2, 1e-12);
		expect(r.methodVersion).toBe(START_METHOD_VERSION);
	});

	it('never counts a depression a unit’s point is in: a dam drawn on the pan makes it that unit’s own basin', async () => {
		const outlet = at(OUTLET_CELL.x, OUTLET_CELL.y);
		// The dam's outline over the pan's floor (a point there is on no terrain channel: the pan's catchment is under a km²).
		const ring = [at(PAN.x - 3, PAN.y - 3), at(PAN.x + 3, PAN.y - 3), at(PAN.x + 3, PAN.y + 3), at(PAN.x - 3, PAN.y + 3), at(PAN.x - 3, PAN.y - 3)];
		const r = await delineateUnits(dem, { outlet, boundary: null, points: [{ ...point('on-pan', PAN.x, PAN.y), geometry: { type: 'Polygon', coordinates: [ring] } }] });
		expect(r.units.map((u) => u.id)).toEqual(['on-pan']);
		expect(r.pans.count).toBe(0);
		expect(r.pans.nonContributingM2).toBe(0);
		expect(r.units[0]!.nonContributingM2).toBe(0);
	});

	it('counts storage on a river in no piece, unit’s catchment or rest (start-14): the figures the effective area takes leave it out', async () => {
		const outlet = at(OUTLET_CELL.x, OUTLET_CELL.y);
		// A river drawn through the pan and out down the flank to the valley's river (delineate.test.ts does the same for a click).
		const through = [at(PAN.x + 12, PAN.y - 2), at(PAN.x, PAN.y), at(OUTLET_CELL.x, PAN.y + 8)];
		const points = [point('dam', DAM_CELL.x, DAM_CELL.y + 1), point('gauge', OUTLET_CELL.x, OUTLET_CELL.y - 10, 'gauge')];
		const r = await delineateUnits(dem, { outlet, boundary: null, points }, { panReference: async () => ({ rivers: [{ line: through, directed: false }], dams: [] }) });
		expect(r.pans).toMatchObject({ count: 0, nonContributingM2: 0, onRiver: { count: 1, largest: [{ by: 'river' }] } });
		for (const u of r.units) {
			expect(u.nonContributingM2 ?? 0).toBe(0);
			expect(u.totalNonContributingM2 ?? 0).toBe(0);
		}
		expect(r.rest.nonContributingM2).toBe(0);
	});
});

describe('placementText and startMethod', () => {
	const NEAREST = 'the nearest terrain channel: the nearest cell within 150 m with at least 1 km² draining through it, the mapped river network not used; a 100× larger channel within 1000 m named';

	it('names only the rules that ran, the outlet first, with counts, each defined once', () => {
		expect(placementText(['snapped', 'snapped', 'polygon'], 'exact', 150)).toBe(
			`placed on the channel: the outlet on its delineated cell, 2 points on the nearest terrain channel, 1 point at a dam polygon’s outflow (outflow: its own if a river only clips it; ${NEAREST})`
		);
		expect(placementText(['larger'], 'boundary', 150)).toBe(`placed on the channel: the outlet at the boundary’s most-accumulating cell, 1 point on the larger channel chosen (${NEAREST})`);
		expect(placementText(['polygon'], 'exact', 150)).not.toMatch(/terrain channel:/);
		expect(placementText([], null, 150)).toBe('no points placed');
	});

	it('names a dam’s marked position only when one was marked (194), the unmarked rule only while a dam is unmarked', () => {
		const unmarked = placementText(['polygon', 'polygon'], null, 150);
		expect(placementText(['polygon', 'polygon'], null, 150, false, [])).toBe(unmarked);
		expect(unmarked).not.toMatch(/marked/);
		expect(placementText(['polygon', 'polygon', 'polygon'], null, 150, false, ['off_channel', 'on_channel'])).toBe(
			'placed on the channel: 3 points at a dam polygon’s outflow (1 marked off-channel, 1 marked on the river) (outflow: its own if a river only clips it; marked off-channel: its unit on the river where its own outflow (no cell carrying 100× the outline’s cells) joins it within 1000 m, what drains to that outflow the dam’s share; marked on the river: its most-accumulating cell)'
		);
		expect(placementText(['polygon'], null, 150, false, ['off_channel'])).toBe(
			'placed on the channel: 1 point at a dam polygon’s outflow (1 marked off-channel) (marked off-channel: its unit on the river where its own outflow (no cell carrying 100× the outline’s cells) joins it within 1000 m, what drains to that outflow the dam’s share)'
		);
		// The brief form keeps the counts, the rules named by the version.
		expect(placementText(['polygon'], null, 150, true, ['on_channel'])).toBe(
			`placed on the channel: 1 point at a dam polygon’s outflow (1 marked on the river) (each rule as ${START_METHOD_VERSION} defines it, docs/maps.md)`
		);
	});

	it('fits start_proposal.method (1 000 characters) whatever ran, every rule at once', () => {
		// Every placement a point can have (a Record so a new kind fails to compile here until it's listed), twice, with the
		// longest outlet's and a click outlet's note.
		const kinds: Record<PlacedBy, true> = { snapped: true, larger: true, exact: true, polygon: true, boundary: true };
		const points = Object.keys(kinds) as PlacedBy[];
		const placement = (brief: boolean) => placementText([...points, ...points], 'boundary', 99_999, brief, ['off_channel', 'on_channel']) + ' (the outlet: the click most water drains through)';
		// In full it runs past the column, so the stored method names the version for the rules instead of failing the insert.
		expect(startMethod(99_999, 11, placement(false)).length).toBeGreaterThan(METHOD_MAX_CHARS);
		const m = fitMethod(99_999, 11, placement);
		expect(m.length).toBeLessThanOrEqual(METHOD_MAX_CHARS);
		expect(m).toContain(`each rule as ${START_METHOD_VERSION} defines it`);
		expect(m).toContain('2 points on the nearest terrain channel');
		// An ordinary proposal keeps every definition.
		const usual = fitMethod(30, 11, (brief) => placementText(['snapped', 'polygon'], 'exact', 150, brief));
		expect(usual).toContain('the nearest terrain channel: the nearest cell within 150 m');
		expect(usual).not.toContain('defines it');
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
