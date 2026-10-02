// Each unit's piece of a proposed division, told apart on the map (#326 C3's
// follow-up; docs/maps.md § Start from the map, docs/ui.md § Map). A start or
// divide proposal is drawn piece by piece: each unit's own sub-catchment with
// its number on it, the rest of the catchment marked R, and a unit that owns
// no land (a water user, a gauge) as its number at its point. The sheet's
// cards carry the same numbers and tints, so the cards are the map's key; a
// card with the focus or the pointer lights its piece, and a piece (or its
// number) under the pointer lights its card's. Pure, so vitest checks it.
import type { DividePlan, StartPlan } from '$lib/api';
import type { MapGeometry, MapPosition } from '$lib/api/types';

/** The rest of the catchment's key among the pieces (a unit's key is its map feature's id, a uuid). */
export const REST_KEY = 'rest';

export interface ProposalPiece {
	/** The unit's key (its map feature's id), or REST_KEY. */
	key: string;
	/** What the badge says: the unit's number in the plan's order (1, 2, …), or R for the rest. */
	label: string;
	/** The unit's name, for the map's hover line. */
	name: string;
	/** Its own piece; null for a unit that owns no land (its badge sits at its point). */
	geometry: Extract<MapGeometry, { type: 'Polygon' | 'MultiPolygon' }> | null;
	/** Where its badge goes: inside the piece, else the unit's point. */
	at: MapPosition;
	/** Which of the tints its piece is filled with; -1 for none (the rest of the catchment, a unit with no land). */
	tint: number;
}

type Box = [number, number, number, number];
function boxOf(g: Extract<MapGeometry, { type: 'Polygon' | 'MultiPolygon' }>): Box {
	const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
	const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
	for (const r of rings) for (const [x, y] of r) (b[0] = Math.min(b[0], x)), (b[1] = Math.min(b[1], y)), (b[2] = Math.max(b[2], x)), (b[3] = Math.max(b[3], y));
	return b;
}
/** Boxes that touch or overlap, by a hair: taken as neighbours (more than the true neighbours, never fewer). */
const touching = (a: Box, b: Box) => {
	const e = 1e-9;
	return a[0] <= b[2] + e && b[0] <= a[2] + e && a[1] <= b[3] + e && b[1] <= a[3] + e;
};

/**
 * Tints for pieces so that neighbours differ (#326 C3's follow-up, the UI
 * review: a cycling palette gave two touching pieces one colour). Greedy, in
 * the plan's order: each takes the first tint none of its neighbours has, and
 * where all six are taken (only in a dense knot), the one fewest neighbours
 * share. Neighbours are pieces whose boxes touch, so never fewer than the
 * true ones. A unit with no land has no piece and no tint (-1).
 */
export function pieceTintsFor(geometries: readonly (Extract<MapGeometry, { type: 'Polygon' | 'MultiPolygon' }> | null)[]): number[] {
	const boxes = geometries.map((g) => (g ? boxOf(g) : null));
	const tints: number[] = [];
	boxes.forEach((b, i) => {
		if (!b) return void tints.push(-1);
		const count = new Array<number>(PIECE_TINT_COUNT).fill(0);
		for (let j = 0; j < i; j++) if (boxes[j] && tints[j]! >= 0 && touching(b, boxes[j]!)) count[tints[j]!]!++;
		const free = count.indexOf(0);
		tints.push(free >= 0 ? free : count.indexOf(Math.min(...count)));
	});
	return tints;
}

/** How many tints the pieces cycle through (mapStyle.ts pieceTints). */
export const PIECE_TINT_COUNT = 6;

/**
 * A point inside a polygon (holes kept out), for its badge: the middle of the
 * widest stretch of the horizontal line through the outer ring's centroid
 * that lies inside the polygon. Inside by construction, unlike the centroid
 * of a crescent or of a piece with a hole in its middle. Null when the ring
 * is degenerate.
 */
export function interiorPoint(g: Extract<MapGeometry, { type: 'Polygon' | 'MultiPolygon' }>): MapPosition | null {
	const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
	// The largest polygon's outer ring (by the shoelace area).
	let best: MapPosition[][] | null = null;
	let bestArea = -1;
	for (const p of polys) {
		const a = Math.abs(ringArea(p[0] ?? []));
		if (a > bestArea) (bestArea = a), (best = p);
	}
	if (!best || bestArea <= 0) return null;
	const outer = best[0]!;
	let cy = 0;
	let wsum = 0;
	for (let i = 0; i + 1 < outer.length; i++) {
		const [x0, y0] = outer[i]!;
		const [x1, y1] = outer[i + 1]!;
		const cross = x0 * y1 - x1 * y0;
		cy += (y0 + y1) * cross;
		wsum += cross;
	}
	const y = wsum ? cy / (3 * wsum) : outer[0]![1];
	const xs: number[] = [];
	for (const ring of best) {
		for (let i = 0; i + 1 < ring.length; i++) {
			const [ax, ay] = ring[i]!;
			const [bx, by] = ring[i + 1]!;
			if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
		}
	}
	xs.sort((a, b) => a - b);
	let mid: number | null = null;
	let width = -1;
	for (let k = 0; k + 1 < xs.length; k += 2) {
		if (xs[k + 1]! - xs[k]! > width) (width = xs[k + 1]! - xs[k]!), (mid = (xs[k]! + xs[k + 1]!) / 2);
	}
	return mid === null ? null : [mid, y];
}

function ringArea(r: readonly MapPosition[]): number {
	let a = 0;
	for (let i = 0; i + 1 < r.length; i++) a += r[i]![0] * r[i + 1]![1] - r[i + 1]![0] * r[i]![1];
	return a / 2;
}

/**
 * Each unit's piece in the plan's order (its number), then the rest of the
 * catchment's, when it has an outline and a place for its badge. The map and
 * the sheets' cards both read these, so a card's number and tint are its
 * piece's.
 */
export function proposalPieces(plan: StartPlan | DividePlan): ProposalPiece[] {
	const tints = pieceTintsFor(plan.units.map((u) => u.geometry));
	const pieces: ProposalPiece[] = plan.units.map((u, i) => ({
		key: u.key,
		label: String(i + 1),
		name: u.name,
		geometry: u.geometry,
		at: (u.geometry && interiorPoint(u.geometry)) ?? u.point,
		tint: tints[i]!
	}));
	const rest = plan.rest.geometry;
	if (rest) {
		const at = interiorPoint(rest);
		if (at) pieces.push({ key: REST_KEY, label: 'R', name: 'Rest of the catchment', geometry: rest, at, tint: -1 });
	}
	return pieces;
}

/** What the map draws for an open proposal: its pieces, the outlet, the whole for framing, and the piece lit. */
export interface PiecesShape {
	id: string;
	/** Every piece together, for framing the map on it. */
	geometry: Extract<MapGeometry, { type: 'MultiPolygon' }>;
	outlet: MapPosition;
	pieces: ProposalPiece[];
	highlight: string | null;
}

/** The open proposal as the map draws it; null when there is nothing to draw (no outlet, no outline). */
export function piecesShape(p: { id: string; plan: StartPlan | DividePlan } | null, highlight: string | null = null): PiecesShape | null {
	if (!p?.plan.outlet.point) return null;
	const pieces = proposalPieces(p.plan);
	const polys: MapPosition[][][] = [];
	for (const x of pieces) {
		if (x.geometry?.type === 'Polygon') polys.push(x.geometry.coordinates);
		else if (x.geometry?.type === 'MultiPolygon') polys.push(...x.geometry.coordinates);
	}
	if (!polys.length) return null;
	return { id: p.id, geometry: { type: 'MultiPolygon', coordinates: polys }, outlet: p.plan.outlet.point, pieces, highlight };
}

/**
 * The same shape with another piece lit: the pieces, outline and outlet kept
 * as they are (the same objects), so lighting a piece on hover costs no
 * recomputation and the map redraws only the proposal's source.
 */
export function litPieces(shape: PiecesShape | null, highlight: string | null): PiecesShape | null {
	if (!shape) return null;
	return shape.highlight === highlight ? shape : { ...shape, highlight };
}
