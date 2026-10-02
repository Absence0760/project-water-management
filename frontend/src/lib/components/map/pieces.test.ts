import { describe, expect, it } from 'vitest';
import type { StartPlan, StartUnit } from '$lib/api';
import type { MapPosition } from '$lib/api/types';
import { interiorPoint, PIECE_TINT_COUNT, piecesShape, proposalPieces, REST_KEY } from './pieces';
import { unitOffers } from './startFlow';

const square = (x0: number, y0: number, s: number): MapPosition[] => [
	[x0, y0],
	[x0 + s, y0],
	[x0 + s, y0 + s],
	[x0, y0 + s],
	[x0, y0]
];
const poly = (...rings: MapPosition[][]) => ({ type: 'Polygon' as const, coordinates: rings });
/** Inside a ring by the even–odd rule (for checking a badge's place). */
function inside([x, y]: MapPosition, rings: MapPosition[][]): boolean {
	let c = false;
	for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (r[i]![1] > y !== r[j]![1] > y && x < ((r[j]![0] - r[i]![0]) * (y - r[i]![1])) / (r[j]![1] - r[i]![1]) + r[i]![0]) c = !c;
	return c;
}

const unit = (key: string, over: Partial<StartUnit> = {}): StartUnit => ({
	key,
	featureName: key,
	role: 'dam',
	name: key,
	point: [5, 5],
	snapDistanceM: 0,
	areaM2: 1e6,
	totalAreaM2: 1e6,
	geometry: poly(square(0, 0, 1)),
	drainsInto: null,
	drainsIntoProposed: true,
	...over
});
const plan = (units: StartUnit[], rest: StartPlan['rest']['geometry'] = poly(square(10, 10, 2))): StartPlan => ({
	fromDem: true,
	outlet: { featureId: null, name: 'Outflow gauge', point: [11, 9], snapDistanceM: 0, foundIn: 'boundary' },
	catchment: { areaM2: 9e6, boundaryAreaM2: null },
	units,
	rest: { name: 'Rest of the catchment', areaM2: 4e6, geometry: rest },
	dropped: [],
	warnings: [],
	cellSizeM: 30,
	zoom: 11,
	windowCells: 1024
});

describe('interiorPoint (where a piece’s number goes)', () => {
	it('lands inside a crescent and beside a hole, where the centroid would not', () => {
		// A U shape: its centroid sits in the gap between the arms.
		const u: MapPosition[] = [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3], [0, 0]];
		const p = interiorPoint(poly(u))!;
		expect(inside(p, [u])).toBe(true);
		// A square with a square hole in its middle: the point is in the ring, not the hole.
		const outer = square(0, 0, 3);
		const hole = square(1, 1, 1);
		const q = interiorPoint(poly(outer, hole))!;
		expect(inside(q, [outer, hole])).toBe(true);
	});

	it('takes the largest part of a multipolygon, and is null for a degenerate ring', () => {
		const p = interiorPoint({ type: 'MultiPolygon', coordinates: [[square(0, 0, 1)], [square(10, 10, 4)]] })!;
		expect(p[0]).toBeGreaterThan(10);
		expect(interiorPoint(poly([[0, 0], [1, 1], [0, 0]]))).toBeNull();
	});
});

describe('proposalPieces', () => {
	it('numbers the units in the plan’s order, cycling the tints, and marks the rest R', () => {
		const units = Array.from({ length: PIECE_TINT_COUNT + 1 }, (_, i) => unit(`u${i}`));
		const pieces = proposalPieces(plan(units));
		expect(pieces.map((p) => p.label)).toEqual([...units.map((_, i) => String(i + 1)), 'R']);
		expect(pieces.map((p) => p.tint)).toEqual([0, 1, 2, 3, 4, 5, 0, -1]);
		expect(pieces.at(-1)).toMatchObject({ key: REST_KEY, name: 'Rest of the catchment' });
	});

	it('puts a land unit’s number inside its piece, a gauge’s or user’s at its point', () => {
		const pieces = proposalPieces(plan([unit('farm'), unit('weir', { role: 'gauge', geometry: null, areaM2: null, point: [7, 8] })]));
		expect(inside(pieces[0]!.at, [square(0, 0, 1)])).toBe(true);
		expect(pieces[1]).toMatchObject({ label: '2', geometry: null, at: [7, 8] });
	});

	it('leaves the rest out when it has no outline', () => {
		expect(proposalPieces(plan([unit('a')], null)).map((p) => p.key)).toEqual(['a']);
	});
});

describe('piecesShape (the open proposal as the map draws it)', () => {
	it('gathers every piece for framing, with the outlet and the piece lit', () => {
		const s = piecesShape({ id: 'p', plan: plan([unit('a'), unit('town', { role: 'user', geometry: null })]) }, 'a')!;
		expect(s.geometry.coordinates).toHaveLength(2);
		expect(s.outlet).toEqual([11, 9]);
		expect(s.highlight).toBe('a');
		expect(s.pieces.map((p) => p.key)).toEqual(['a', 'town', REST_KEY]);
	});

	it('is null with nothing to draw: no proposal, no outlet, no outline', () => {
		expect(piecesShape(null)).toBeNull();
		expect(piecesShape({ id: 'p', plan: plan([], null) })).toBeNull();
		const noOutlet = plan([unit('a')]);
		noOutlet.outlet = { ...noOutlet.outlet, point: null };
		expect(piecesShape({ id: 'p', plan: noOutlet })).toBeNull();
	});
});

describe('a gauge in a start proposal', () => {
	it('offers its order only: it owns no land, and has no dam', () => {
		expect(unitOffers(unit('weir', { role: 'gauge', areaM2: null, geometry: null }))).toEqual({ area: false, drainsInto: true, runoffToDam: false });
	});
});
