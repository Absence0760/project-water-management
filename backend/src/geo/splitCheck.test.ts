// Whether a split's parts lie within the shape (splitCheck.ts): the browser's
// own kind of split passes (a square in halves, an L in its two rectangles,
// a cut with a bend); a part outside the shape, a chord across a notch, a
// part reaching just past an edge and a cut of too many edges are refused.
import { describe, expect, it } from 'vitest';
import type { Position } from './geojson.js';
import { partsWithin, SPLIT_CHECK_MAX_EDGES } from './splitCheck.js';

const box = (x0: number, y0: number, x1: number, y1: number): Position[] => [
	[x0, y0],
	[x1, y0],
	[x1, y1],
	[x0, y1],
	[x0, y0]
];
// The L: [0,2]×[0,1] plus [0,1]×[1,2], in a hundredth of a degree.
const d = 0.01;
const L: Position[] = [
	[0, 0],
	[2 * d, 0],
	[2 * d, d],
	[d, d],
	[d, 2 * d],
	[0, 2 * d],
	[0, 0]
];

describe('partsWithin', () => {
	it('passes a square in halves, cut points on its edges (positive control)', () => {
		expect(partsWithin(box(0, 0, d, d), [box(0, 0, d / 2, d), box(d / 2, 0, d, d)])).toBeNull();
	});

	it('passes the L in its two rectangles, and a cut point rounded to 7 decimals just off the edge', () => {
		expect(partsWithin(L, [box(0, 0, 2 * d, d), box(0, d, d, 2 * d)])).toBeNull();
		const m = 0.00500004; // 4e-8 off the bottom edge's true middle, as the browser rounds
		expect(partsWithin(box(0, 0, d, d), [box(0, 0, m, d), box(m, 0, d, d)])).toBeNull();
	});

	it('passes a cut with a bend inside the shape', () => {
		const bend: Position = [d / 2 + 0.002, d / 2];
		const west: Position[] = [[0, 0], [d / 2, 0], bend, [d / 2, d], [0, d], [0, 0]];
		const east: Position[] = [[d / 2, 0], [d, 0], [d, d], [d / 2, d], bend, [d / 2, 0]];
		expect(partsWithin(box(0, 0, d, d), [west, east])).toBeNull();
	});

	it('refuses a part wholly outside the L, though within its bounds (the audit’s case)', () => {
		expect(partsWithin(L, [box(0, 0, 2 * d, d), box(d, d, 2 * d, 2 * d)])).toBe('part 2 reaches outside the shape');
	});

	it('refuses a chord across the L’s notch, whose ends are both the L’s own corners', () => {
		const tri: Position[] = [[2 * d, d], [d, 2 * d], [d, d], [2 * d, d]];
		expect(partsWithin(L, [tri])).toBe('part 1 reaches outside the shape');
	});

	it('refuses a part reaching a little past an edge', () => {
		expect(partsWithin(box(0, 0, d, d), [box(0, 0, d / 2, d + 1e-5), box(d / 2, 0, d, d)])).toBe('part 1 reaches outside the shape');
	});

	it('refuses an edge that leaves and comes back between two inside points', () => {
		// A U: [0,3]×[0,3] without [1,2]×[1,3]. An edge across the U's gap has both ends inside, its middle outside.
		const U: Position[] = [[0, 0], [3 * d, 0], [3 * d, 3 * d], [2 * d, 3 * d], [2 * d, d], [d, d], [d, 3 * d], [0, 3 * d], [0, 0]];
		const across: Position[] = [[0.5 * d, 2 * d], [2.5 * d, 2 * d], [2.5 * d, 2.5 * d], [0.5 * d, 2.5 * d], [0.5 * d, 2 * d]];
		expect(partsWithin(U, [across])).toBe('part 1 reaches outside the shape');
	});

	it('refuses a cut of more than SPLIT_CHECK_MAX_EDGES edges', () => {
		const n = SPLIT_CHECK_MAX_EDGES + 5;
		const zig: Position[] = [[0, 0], ...Array.from({ length: n }, (_, i): Position => [((i + 1) / (n + 1)) * d, (i % 2 ? 0.4 : 0.6) * d]), [d, 0], [0, 0]];
		expect(partsWithin(box(0, 0, d, d), [zig])).toMatch(/more than/);
	});
});
