// Snapping while drawing on the catchment map (issue #326 C2; docs/maps.md §
// Assisted drawing): a corner placed (or dragged) near another feature's
// corner or edge lands exactly on it, so a parcel drawn against its
// neighbour or the boundary shares their edge, with no sliver of a gap or an
// overlap for the map's checks to find. With "Follow edges" on, two corners
// in a row on the same outline or line also take the corners between them
// along it (the shorter way round a closed outline), the way GIS tracing
// does. Pure (no MapLibre): the map hands in its projection, so vitest
// covers it (snap.test.ts), and any tool that draws (the draw bar, a guided
// start) can call it.
import type { MapFeature, MapGeometry, MapPosition } from '$lib/api/types';

/** A screen point, px. */
export type ScreenPt = { x: number; y: number };

/** One line or outline a corner can snap to: a feature's ring, line or point (a point is a line of one corner). */
export interface SnapLine {
	featureId: string;
	/** Which of the feature's rings or lines (0 for most). */
	part: number;
	/** What the said line names: “Upper farm” or “the catchment boundary”. */
	label: string;
	/** Its corners; an outline's are not closed (the last isn't the first again). */
	coords: MapPosition[];
	/** An outline (a polygon's ring): its last corner joins its first. */
	closed: boolean;
}

/** Where a corner snapped: the position, on which line, and where along it (a corner's index, or an edge's index plus how far along). */
export interface SnapHit {
	at: MapPosition;
	line: SnapLine;
	/** Along the line: corner i is i; a point on the edge from corner i to i+1 is i + t (0 < t < 1). */
	pos: number;
	what: 'corner' | 'edge';
}

/** How near (px) a corner or edge must be to catch the pointer: the draft's own corner hit area (attachDrawing's 12 px). */
export const SNAP_PX = 12;

/** The kinds a corner snaps to, and what the said line calls each one. */
const KIND_WORD: Record<MapFeature['kind'], string> = {
	catchment_boundary: 'the catchment boundary',
	farm_parcel: 'a farm parcel',
	dam: 'a dam',
	gauge: 'a gauge',
	river: 'a river',
	other: 'a feature'
};

const ringOf = (r: readonly MapPosition[]): MapPosition[] => {
	const c = r.map((p) => [p[0], p[1]] as MapPosition);
	if (c.length > 1 && c[0]![0] === c[c.length - 1]![0] && c[0]![1] === c[c.length - 1]![1]) c.pop();
	return c;
};

function linesOfGeometry(g: MapGeometry): { coords: MapPosition[]; closed: boolean }[] {
	switch (g.type) {
		case 'Point':
			return [{ coords: [[g.coordinates[0], g.coordinates[1]]], closed: false }];
		case 'LineString':
			return [{ coords: g.coordinates.map((p) => [p[0], p[1]] as MapPosition), closed: false }];
		case 'MultiLineString':
			return g.coordinates.map((l) => ({ coords: l.map((p) => [p[0], p[1]] as MapPosition), closed: false }));
		case 'Polygon':
			return g.coordinates.map((r) => ({ coords: ringOf(r), closed: true }));
		case 'MultiPolygon':
			return g.coordinates.flatMap((poly) => poly.map((r) => ({ coords: ringOf(r), closed: true })));
	}
}

/**
 * What a drawing can snap to: every ring, line and point of the project's
 * features, but the one being edited (`exclude`): its own old outline would
 * hold every corner where it was.
 */
export function snapLines(features: readonly MapFeature[], exclude: string | null = null): SnapLine[] {
	const out: SnapLine[] = [];
	for (const f of features) {
		if (f.id === exclude) continue;
		const label = f.name ? `“${f.name}”` : KIND_WORD[f.kind];
		linesOfGeometry(f.geometry).forEach((l, part) => {
			if (l.coords.length) out.push({ featureId: f.id, part, label, ...l });
		});
	}
	return out;
}

const d2 = (a: ScreenPt, b: ScreenPt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** Whether a line's bounding box meets a lon/lat box (west, south, east, north). */
function meets(l: SnapLine, box: readonly [number, number, number, number]): boolean {
	let w = Infinity,
		s = Infinity,
		e = -Infinity,
		n = -Infinity;
	for (const p of l.coords) {
		if (p[0] < w) w = p[0];
		if (p[0] > e) e = p[0];
		if (p[1] < s) s = p[1];
		if (p[1] > n) n = p[1];
	}
	return !(e < box[0] || w > box[2] || n < box[1] || s > box[3]);
}

/** 7 decimals (~1 cm), the server's own rounding. */
const round = (v: number) => Math.round(v * 1e7) / 1e7;

/**
 * The corner or edge nearest the screen point `p` within `tolPx`, or null.
 * A corner wins over an edge whenever one is in reach (so a shared corner is
 * met exactly); among edges, the nearest. `project` is the map's lon/lat →
 * screen px; `box`, when given, skips lines whose bounds miss it (the
 * pointer's reach in lon/lat), so a long list is cheap per mouse move.
 */
export function snapPoint(
	p: ScreenPt,
	lines: readonly SnapLine[],
	project: (q: MapPosition) => ScreenPt,
	tolPx = SNAP_PX,
	box?: readonly [number, number, number, number]
): SnapHit | null {
	const tol2 = tolPx * tolPx;
	let corner: { hit: SnapHit; d: number } | null = null;
	let edge: { hit: SnapHit; d: number } | null = null;
	for (const l of lines) {
		if (box && !meets(l, box)) continue;
		const sc = l.coords.map(project);
		for (let i = 0; i < sc.length; i++) {
			const d = d2(p, sc[i]!);
			if (d <= tol2 && (!corner || d < corner.d)) corner = { hit: { at: [l.coords[i]![0], l.coords[i]![1]], line: l, pos: i, what: 'corner' }, d };
		}
		if (corner) continue;
		const edges = l.closed && sc.length >= 3 ? sc.length : sc.length - 1;
		for (let i = 0; i < edges; i++) {
			const a = sc[i]!;
			const b = sc[(i + 1) % sc.length]!;
			const len2 = d2(a, b);
			if (len2 === 0) continue;
			const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2));
			if (t === 0 || t === 1) continue; // at a corner: the corner pass decides
			const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
			const d = d2(p, q);
			if (d > tol2 || (edge && d >= edge.d)) continue;
			// Web Mercator is conformal: along one short edge, screen and lon/lat move in step closely enough at a few px.
			const A = l.coords[i]!;
			const B = l.coords[(i + 1) % l.coords.length]!;
			edge = { hit: { at: [round(A[0] + t * (B[0] - A[0])), round(A[1] + t * (B[1] - A[1]))], line: l, pos: i + t, what: 'edge' }, d };
		}
	}
	return corner?.hit ?? edge?.hit ?? null;
}

/** Approximate ground length of a path (degrees of longitude scaled by the cosine of the latitude): only to compare two ways round. */
function pathLength(pts: readonly MapPosition[]): number {
	let s = 0;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1]!;
		const b = pts[i]!;
		const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
		s += Math.hypot((b[0] - a[0]) * k, b[1] - a[1]);
	}
	return s;
}

const EPS = 1e-9;

/**
 * The corners of `line` strictly between two positions along it (SnapHit
 * `pos`), in order from `from` to `to`: along an open line the way it runs
 * between them; round a closed outline the shorter way. Empty when they are
 * the same place or neighbours on one edge.
 */
export function traceAlong(line: SnapLine, from: number, to: number, fromAt: MapPosition, toAt: MapPosition): MapPosition[] {
	const n = line.coords.length;
	const at = (k: number) => line.coords[((k % n) + n) % n]!;
	if (!line.closed) {
		const out: MapPosition[] = [];
		if (to > from) for (let k = Math.floor(from) + 1; k < to - EPS; k++) out.push(at(k));
		else for (let k = Math.ceil(from) - 1; k > to + EPS; k--) out.push(at(k));
		return out;
	}
	if (n < 3) return [];
	const fwdTo = (((to - from) % n) + n) % n;
	const bwdTo = (((from - to) % n) + n) % n;
	if (fwdTo < EPS || bwdTo < EPS) return [];
	const fwd: MapPosition[] = [];
	for (let k = Math.floor(from + EPS) + 1; k - from < fwdTo - EPS; k++) fwd.push(at(k));
	const bwd: MapPosition[] = [];
	for (let k = Math.ceil(from - EPS) - 1; from - k < bwdTo - EPS; k--) bwd.push(at(k));
	return pathLength([fromAt, ...fwd, toAt]) <= pathLength([fromAt, ...bwd, toAt]) ? fwd : bwd;
}

/** Two hits on the same line (the same feature's same ring or line): the second can follow the first along it. */
export const sameLine = (a: SnapHit | null, b: SnapHit | null): boolean => !!a && !!b && a.line.featureId === b.line.featureId && a.line.part === b.line.part;
