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
