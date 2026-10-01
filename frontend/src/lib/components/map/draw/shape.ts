// A drawing's shape on the catchment map (issue #326 C1; docs/maps.md §
// Drawing): the corners of a draft, the geometry it saves as, and what stops
// it being saved. Pure (no MapLibre), so vitest covers it (shape.test.ts) and
// the draw bar, the save sheet and the map agree. The server checks every
// saved geometry again (backend geo/geojson.ts checkGeometry); this says the
// same things earlier, while the shape is still being drawn.
import type { MapFeatureKind, MapGeometry, MapPosition } from '$lib/api/types';

export type DraftShape = 'point' | 'line' | 'polygon';

/** What can be drawn: a kind with the shape it's drawn as. "Other" comes as an area and as a line. */
export interface DrawChoice {
	id: string;
	kind: MapFeatureKind;
	shape: DraftShape;
	label: string;
}

export const DRAW_CHOICES: readonly DrawChoice[] = [
	{ id: 'catchment_boundary', kind: 'catchment_boundary', shape: 'polygon', label: 'Catchment boundary' },
	{ id: 'farm_parcel', kind: 'farm_parcel', shape: 'polygon', label: 'Farm parcel' },
	{ id: 'dam', kind: 'dam', shape: 'polygon', label: 'Dam (its water’s edge)' },
	{ id: 'river', kind: 'river', shape: 'line', label: 'River' },
	{ id: 'other-area', kind: 'other', shape: 'polygon', label: 'Other area' },
	{ id: 'other-line', kind: 'other', shape: 'line', label: 'Other line' }
];

/** The kinds a saved shape may take, by its shape (backend geo/routes.ts KIND_TYPES). */
export const KINDS_FOR_SHAPE: Record<DraftShape, readonly MapFeatureKind[]> = {
	point: ['gauge', 'dam', 'other'],
	line: ['river', 'other'],
	polygon: ['catchment_boundary', 'farm_parcel', 'dam', 'other']
};

/** What one corner is called while drawing each shape, for the bar's words. */
export const CORNER: Record<DraftShape, { one: string; many: string }> = {
	point: { one: 'point', many: 'points' },
	line: { one: 'point', many: 'points' },
	polygon: { one: 'corner', many: 'corners' }
};

const same = (a: MapPosition, b: MapPosition) => a[0] === b[0] && a[1] === b[1];

/** The corners with a corner repeated in a row (a double click) taken as one, and a polygon's closing repeat dropped. */
export function distinctCorners(coords: readonly MapPosition[], closed = false): MapPosition[] {
	const out = coords.filter((p, i) => i === 0 || !same(p, coords[i - 1]!));
	if (closed && out.length > 1 && same(out[0]!, out[out.length - 1]!)) out.pop();
	return out;
}

/** The geometry a draft saves as, or null while it has too few corners. A polygon's ring is closed here. */
export function geometryOf(shape: DraftShape, coords: readonly MapPosition[]): MapGeometry | null {
	const c = distinctCorners(coords, shape === 'polygon').map((p) => [p[0], p[1]] as MapPosition);
	if (shape === 'point') return c.length ? { type: 'Point', coordinates: c[0]! } : null;
	if (shape === 'line') return c.length >= 2 ? { type: 'LineString', coordinates: c } : null;
	return c.length >= 3 ? { type: 'Polygon', coordinates: [[...c, c[0]!]] } : null;
}

/** A geometry's shape. */
export function shapeOf(g: MapGeometry): DraftShape {
	if (g.type === 'Point') return 'point';
	if (g.type === 'LineString' || g.type === 'MultiLineString') return 'line';
	return 'polygon';
}

/**
 * The corners of a geometry that can be edited one by one (a point, one line,
 * a polygon of one ring and no holes, or a "multi" of one part), or null for
 * one of several parts or with holes: that can be saved or replaced whole, not
 * reshaped corner by corner.
 */
export function editableCorners(g: MapGeometry): { shape: DraftShape; coords: MapPosition[] } | null {
	switch (g.type) {
		case 'Point':
			return { shape: 'point', coords: [[g.coordinates[0], g.coordinates[1]]] };
		case 'LineString':
			return { shape: 'line', coords: g.coordinates.map((p) => [p[0], p[1]]) };
		case 'MultiLineString':
			return g.coordinates.length === 1 ? editableCorners({ type: 'LineString', coordinates: g.coordinates[0]! }) : null;
		case 'Polygon':
			return g.coordinates.length === 1 ? { shape: 'polygon', coords: distinctCorners(g.coordinates[0]!, true).map((p) => [p[0], p[1]]) } : null;
		case 'MultiPolygon':
			return g.coordinates.length === 1 ? editableCorners({ type: 'Polygon', coordinates: g.coordinates[0]! }) : null;
	}
}

const orient = (a: MapPosition, b: MapPosition, c: MapPosition) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const onSegment = (a: MapPosition, b: MapPosition, c: MapPosition) =>
	Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);

/** Whether segments p1–p2 and p3–p4 cross or touch (the server's test, geo/geojson.ts). */
export function segmentsCross(p1: MapPosition, p2: MapPosition, p3: MapPosition, p4: MapPosition): boolean {
	const d1 = orient(p3, p4, p1);
	const d2 = orient(p3, p4, p2);
	const d3 = orient(p1, p2, p3);
	const d4 = orient(p1, p2, p4);
	if (d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) return true;
	return (d1 === 0 && onSegment(p3, p4, p1)) || (d2 === 0 && onSegment(p3, p4, p2)) || (d3 === 0 && onSegment(p1, p2, p3)) || (d4 === 0 && onSegment(p1, p2, p4));
}

/** Whether an outline (its corners, not closed) crosses or touches itself anywhere but where neighbouring edges meet. */
export function outlineCrosses(corners: readonly MapPosition[]): boolean {
	const n = corners.length;
	if (n < 4) return false;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			if (j === i + 1 || (i === 0 && j === n - 1)) continue;
			if (segmentsCross(corners[i]!, corners[(i + 1) % n]!, corners[j]!, corners[(j + 1) % n]!)) return true;
		}
	}
	return false;
}

/** Twice the signed planar area of an outline (degrees²): zero when its corners are in a line. */
function planarArea2(c: readonly MapPosition[]): number {
	let s = 0;
	for (let i = 0; i < c.length; i++) {
		const a = c[i]!;
		const b = c[(i + 1) % c.length]!;
		s += a[0] * b[1] - b[0] * a[1];
	}
	return s;
}

/** Why a draft can't be saved yet, in a sentence, or null when it can. */
export function draftProblem(shape: DraftShape, coords: readonly MapPosition[]): string | null {
	const c = distinctCorners(coords, shape === 'polygon');
	if (shape === 'point') return c.length ? null : 'Place the point first.';
	if (shape === 'line') return c.length >= 2 ? null : 'A line needs at least two points.';
	if (c.length < 3) return 'A shape needs at least three corners.';
	// Crossing first: a symmetric bow tie's signed area is zero too, and "crosses itself" is what's wrong with it.
	if (outlineCrosses(c)) return 'Its outline crosses itself: move or remove a corner so the edges don’t cross.';
	if (planarArea2(c) === 0) return 'Its corners are all in a line, so it has no area.';
	return null;
}

/** Whether the draft's shape is finished enough to close (Finish): the corners it needs, whatever else is wrong. */
export const canFinish = (shape: DraftShape, coords: readonly MapPosition[]) =>
	distinctCorners(coords, shape === 'polygon').length >= (shape === 'polygon' ? 3 : shape === 'line' ? 2 : 1);

/** The middle of each edge (a polygon's closing edge too): a click there adds a corner after `after`. */
export function midpoints(shape: DraftShape, coords: readonly MapPosition[]): { at: MapPosition; after: number }[] {
	if (shape === 'point') return [];
	const out: { at: MapPosition; after: number }[] = [];
	const n = coords.length;
	const edges = shape === 'polygon' && n >= 3 ? n : n - 1;
	for (let i = 0; i < edges; i++) {
		const a = coords[i]!;
		const b = coords[(i + 1) % n]!;
		out.push({ at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], after: i });
	}
	return out;
}

/** The corners with one removed, unless that leaves fewer than the shape needs (then null: delete the feature instead). */
export function withoutCorner(shape: DraftShape, coords: readonly MapPosition[], i: number): MapPosition[] | null {
	const min = shape === 'polygon' ? 3 : shape === 'line' ? 2 : 1;
	if (coords.length - 1 < min || i < 0 || i >= coords.length) return null;
	return coords.filter((_, k) => k !== i);
}
