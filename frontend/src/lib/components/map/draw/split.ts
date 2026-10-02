// Split a polygon along a drawn line (issue #326 C2; docs/maps.md § Assisted
// drawing): the boundary into sub-catchments, or a parcel in two. The line
// must go into the shape once and out once (its ends outside the shape, or
// on its edge: a snapped end lands on it); the two parts share the cut
// exactly, so they meet with no gap or overlap. Pure: vitest covers it
// (split.test.ts), the draw bar previews it, and the server checks each part
// again (geo/geojson.ts checkGeometry) and that their areas add up to the
// shape's before it saves them.
import type { MapPosition } from '$lib/api/types';
import { distinctCorners, outlineCrosses } from './shape';

export type SplitResult = { parts: [MapPosition[], MapPosition[]] } | { problem: string };

/** How near (degrees, about 10 cm) a line's end must be to the edge to count as on it: a snapped end, rounded to 7 decimals. */
const ON_EDGE_DEG = 1e-6;
const EPS = 1e-12;

const round = (v: number) => Math.round(v * 1e7) / 1e7;
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

interface Hit {
	/** Along the line: segment j plus how far along it. */
	lp: number;
	/** Along the outline: edge i plus how far along it. */
	rp: number;
	at: MapPosition;
}

/** Whether a point is inside an outline (ray casting; corners not closed). */
export function insideRing(p: MapPosition, ring: readonly MapPosition[]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const a = ring[i]!;
		const b = ring[j]!;
		if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
	}
	return inside;
}

/** The nearest point to p on segment a–b, and how far along it (0..1). */
function nearestOn(p: MapPosition, a: MapPosition, b: MapPosition): { t: number; at: MapPosition; d: number } {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
	const at: MapPosition = [a[0] + t * dx, a[1] + t * dy];
	return { t, at, d: Math.hypot(p[0] - at[0], p[1] - at[1]) };
}

/** Where the line meets the outline, in order along the line, each place once. */
function hitsOf(ring: readonly MapPosition[], line: readonly MapPosition[]): Hit[] {
	const n = ring.length;
	const hits: Hit[] = [];
	for (let j = 0; j < line.length - 1; j++) {
		const s1 = line[j]!;
		const s2 = line[j + 1]!;
		for (let i = 0; i < n; i++) {
			const e1 = ring[i]!;
			const e2 = ring[(i + 1) % n]!;
			const den = cross(s2[0] - s1[0], s2[1] - s1[1], e2[0] - e1[0], e2[1] - e1[1]);
			if (Math.abs(den) < EPS * EPS) continue; // parallel: an edge run along is no crossing
			const u = cross(e1[0] - s1[0], e1[1] - s1[1], e2[0] - e1[0], e2[1] - e1[1]) / den;
			const v = cross(e1[0] - s1[0], e1[1] - s1[1], s2[0] - s1[0], s2[1] - s1[1]) / den;
			if (u < -EPS || u > 1 + EPS || v < -EPS || v > 1 + EPS) continue;
			const uu = Math.max(0, Math.min(1, u));
			const vv = Math.max(0, Math.min(1, v));
			hits.push({ lp: j + uu, rp: i + vv, at: [e1[0] + vv * (e2[0] - e1[0]), e1[1] + vv * (e2[1] - e1[1])] });
		}
	}
	// A line's end on the edge (a snapped end, rounded) that stops just short of it.
	for (const [k, lp] of [
		[0, 0],
		[line.length - 1, line.length - 1]
	] as const) {
		const p = line[k]!;
		let best: Hit | null = null;
		let bestD = ON_EDGE_DEG;
		for (let i = 0; i < n; i++) {
			const q = nearestOn(p, ring[i]!, ring[(i + 1) % n]!);
			if (q.d <= bestD) {
				bestD = q.d;
				best = { lp, rp: i + q.t, at: q.at };
			}
		}
		if (best) hits.push(best);
	}
	hits.sort((a, b) => a.lp - b.lp);
	// One place met twice (a line through a corner meets both its edges; an end found both ways): keep it once.
	const out: Hit[] = [];
	for (const h of hits) {
		const last = out.at(-1);
		if (last && Math.abs(h.lp - last.lp) < 1e-9 + ON_EDGE_DEG && Math.hypot(h.at[0] - last.at[0], h.at[1] - last.at[1]) < ON_EDGE_DEG) continue;
		out.push(h);
	}
	return out;
}

/** The outline's corners strictly after ring position `from`, going forward, up to (not at) `to`. */
function forward(ring: readonly MapPosition[], from: number, to: number): MapPosition[] {
	const n = ring.length;
	const span = (((to - from) % n) + n) % n;
	const out: MapPosition[] = [];
	for (let k = Math.floor(from + 1e-9) + 1; k - from < span - 1e-9; k++) out.push(ring[k % n]!);
	return out;
}

const r7 = (p: MapPosition): MapPosition => [round(p[0]), round(p[1])];

/** Twice the signed planar area of an outline. */
function area2(c: readonly MapPosition[]): number {
	let s = 0;
	for (let i = 0; i < c.length; i++) {
		const a = c[i]!;
		const b = c[(i + 1) % c.length]!;
		s += a[0] * b[1] - b[0] * a[1];
	}
	return s;
}

/**
 * Split an outline (a polygon's corners, not closed) along a line: two
 * outlines that share the cut, or a sentence saying why it can't be cut.
 */
export function splitPolygon(ring: readonly MapPosition[], line: readonly MapPosition[]): SplitResult {
	const outline = distinctCorners(ring, true);
	const cut = distinctCorners(line);
	if (outline.length < 3) return { problem: 'Only a shape with an area can be split.' };
	if (cut.length < 2) return { problem: 'Draw the line to split it along: at least two points.' };
	const hits = hitsOf(outline, cut);
	if (hits.length < 2) {
		return { problem: 'Draw the line right across the shape: from outside its edge (or on it), through it, and out the other side.' };
	}
	if (hits.length > 2) {
		return { problem: `The line crosses the shape’s edge ${hits.length} times. Split it one cut at a time: a line that goes in once and comes out once.` };
	}
	const [h1, h2] = hits as [Hit, Hit];
	// The cut between where the line meets the edge: those two places and the line's points in between.
	const inner = cut.filter((_, k) => k > h1.lp + 1e-9 && k < h2.lp - 1e-9);
	const path = [h1.at, ...inner, h2.at];
	// Between the two places the line must run inside the shape (two ends on the edge can be joined outside it).
	const a = path[0]!;
	const b = path[1]!;
	if (!insideRing([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], outline)) {
		return { problem: 'Between the places where it meets the edge, the line runs outside the shape. Draw it through the shape.' };
	}
	const p1 = distinctCorners([h1.at, ...forward(outline, h1.rp, h2.rp), h2.at, ...[...inner].reverse()].map(r7), true);
	const p2 = distinctCorners([h2.at, ...forward(outline, h2.rp, h1.rp), h1.at, ...inner].map(r7), true);
	for (const p of [p1, p2]) {
		if (p.length < 3 || area2(p) === 0 || outlineCrosses(p)) {
			return { problem: 'One of the two parts would cross itself or have no area. Move the line, or its points.' };
		}
	}
	return { parts: [p1, p2] };
}
