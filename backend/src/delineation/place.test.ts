import { describe, expect, it } from 'vitest';
import { GUARD_RADIUS_M, LARGER_FACTOR, place, type PlaceGrid } from './place.js';

// Hand-made accumulation grids with 100 m cells (0.01 km² each): a river down
// column 20 whose upstream cells grow southward, a gully beside the click, and
// the click itself off the river, the way a displaced river line puts it.

const N = 41;
const CELL = 100;
function grid(): PlaceGrid & { at: (x: number, y: number) => number } {
	const acc = new Int32Array(N * N).fill(1);
	const at = (x: number, y: number) => y * N + x;
	// The river: 10 000 cells (100 km²) at row 0, growing by 100 a row.
	for (let y = 0; y < N; y++) acc[at(20, y)] = 10_000 + 100 * y;
	const edge = new Uint8Array(N * N);
	for (let i = 0; i < N; i++) edge[at(i, 0)] = edge[at(i, N - 1)] = edge[at(0, i)] = edge[at(N - 1, i)] = 1;
	return { nx: N, ny: N, acc, edge, cellSizeM: CELL, at };
}

describe('place: matched to an expected upstream area (Lehner 2012)', () => {
	it('puts a click 400 m off the river on the river cell whose area matches, not the gully beside it', () => {
		const g = grid();
		g.acc[g.at(24, 20)] = 30; // the gully at the click
		const p = place(g, 24.5, 20.5, { snapRadiusM: 150, expectedKm2: 120 })!;
		expect(p.how).toBe('matched');
		// Row 20 holds 12 000 cells = 120 km²: the exact match, 400 m away.
		expect(p.cell).toBe(g.at(20, 20));
		expect(p.larger).toBeNull();
	});

	it('weighs distance: of two cells that match about as well, the nearer one', () => {
		const g = grid();
		// A second river at column 30, as big: the click at column 23 is nearer column 20.
		for (let y = 0; y < N; y++) g.acc[g.at(30, y)] = 10_000 + 100 * y;
		const p = place(g, 23.5, 20.5, { snapRadiusM: 150, expectedKm2: 120 })!;
		expect(p.cell).toBe(g.at(20, 20));
	});

	it('falls back to the snap when no cell within the radius is within 50 % of the area', () => {
		const g = grid();
		const p = place(g, 24.5, 20.5, { snapRadiusM: 150, expectedKm2: 5000 })!;
		expect(p.how).toBe('snapped');
	});

	it('never matches past the radius', () => {
		const g = grid();
		// The click 1.5 km from the river: nothing within 1 km matches.
		const p = place(g, 35.5, 20.5, { snapRadiusM: 150, expectedKm2: 120 })!;
		expect(p.how).toBe('snapped');
	});
});

describe('place: snapped, with the larger-channel guard', () => {
	it('snaps to the most-drained cell within the radius and names a channel with 100× its cells within 1 km', () => {
		const g = grid();
		g.acc[g.at(24, 20)] = 30;
		const p = place(g, 24.5, 20.5, { snapRadiusM: 150 })!;
		expect(p).toMatchObject({ how: 'snapped', cell: g.at(24, 20) });
		expect(p.larger).not.toBeNull();
		// The river's cell nearest the click, straight across (400 m), not its most-drained one 1 km downstream.
		expect(p.larger!.cell).toBe(g.at(20, 20));
		expect(p.larger!.distanceM).toBeCloseTo(400, 0);
		expect(g.acc[p.larger!.cell]!).toBeGreaterThanOrEqual(LARGER_FACTOR * 30);
		expect(p.larger!.distanceM).toBeLessThanOrEqual(GUARD_RADIUS_M);
	});

	it('names nothing when the click is on the big channel itself', () => {
		const g = grid();
		const p = place(g, 20.5, 20.5, { snapRadiusM: 150 })!;
		expect(p.larger).toBeNull();
	});

	it('names nothing when the channel nearby is under 100× larger', () => {
		const g = grid();
		g.acc[g.at(24, 20)] = 200; // 200 × 100 = 20 000 > the river's ~12 000
		expect(place(g, 24.5, 20.5, { snapRadiusM: 150 })!.larger).toBeNull();
	});

	it('is null when every cell in reach is an edge', () => {
		const g = grid();
		g.edge.fill(1);
		expect(place(g, 20.5, 20.5, { snapRadiusM: 150 })).toBeNull();
	});
});

describe('place: the snap distance never exceeds the stated radius (issue #387)', () => {
	// Cell sizes the DEM is read at: zoom 11 with 512 px tiles (TARGET_ZOOM, GLO-30 via Mapterhorn) at the equator and across
	// South Africa's latitudes, and the synthetic fixture's 128 m (zoom 10, 256 px). The old rule counted round(radius / cell)
	// whole cells from the clicked cell, so a corner click reached up to about (round(r) + 0.7) cells: 156–200 m against 150 m.
	const W11 = 2 ** 11 * 512;
	const cellAt = (lat: number) => (2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180)) / W11;
	const SIZES = [...[0, -22, -28, -34.5].map((lat) => [`zoom 11 at ${lat}°`, cellAt(lat)] as const), ['the fixture’s 128 m', 127.6] as const];

	/** A deterministic pseudo-random sequence (mulberry32). */
	function rng(seed: number) {
		return () => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	it.each(SIZES)('%s: the chosen cell’s centre is within 150 m of the exact click, and is the most-drained cell that is', (_, cellSizeM) => {
		const n = 31;
		const rand = rng(Math.round(cellSizeM * 1000));
		let worst = 0;
		for (let k = 0; k < 400; k++) {
			const acc = new Int32Array(n * n);
			for (let i = 0; i < acc.length; i++) acc[i] = 1 + Math.floor(rand() * 1000);
			const edge = new Uint8Array(n * n);
			const cx = 15 + rand();
			const cy = 15 + rand();
			const p = place({ nx: n, ny: n, acc, edge, cellSizeM }, cx, cy, { snapRadiusM: 150 })!;
			const x = p.cell % n;
			const y = (p.cell - x) / n;
			const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) * cellSizeM;
			worst = Math.max(worst, d);
			expect(d).toBeLessThanOrEqual(150);
			// Brute force: the most cells of any cell within 150 m (the click's own cell counts always).
			let max = 0;
			for (let j = 0; j < acc.length; j++) {
				const jx = j % n;
				const jy = (j - jx) / n;
				const own = jx === Math.floor(cx) && jy === Math.floor(cy);
				if (own || Math.hypot(jx + 0.5 - cx, jy + 0.5 - cy) * cellSizeM <= 150) max = Math.max(max, acc[j]!);
			}
			expect(acc[p.cell]).toBe(max);
		}
		// The bound is reached, not merely respected: some placements land in the radius's outer ring.
		expect(worst).toBeGreaterThan(150 - cellSizeM);
	});

	it('leaves a river just past 150 m alone, though it is within the old whole-cell reach', () => {
		const g = grid();
		// The click 1.6 cells (160 m) east of the river's centre line, in row 20: the old rule (round(1.5) = 2 whole cells from cell 22) took the river.
		const p = place(g, 22.1, 20.5, { snapRadiusM: 150 })!;
		expect(g.acc[p.cell]).toBe(1);
		// Positive control: 1.4 cells (140 m) from it, the river is in reach and taken.
		expect(place(g, 21.9, 20.5, { snapRadiusM: 150 })!.cell).toBe(g.at(20, 20));
	});
});
