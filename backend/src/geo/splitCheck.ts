// Whether a split's parts lie within the shape they were cut from (issue #326
// C2; docs/security.md § Map uploads, "a split can't smuggle in an unrelated
// shape"). The route already checks each part (checkGeometry) and that their
// areas add up to the shape's; this checks that neither part reaches outside
// it, which areas and a bounding box alone don't (an L cut into two
// rectangles, one of them outside the L, passed). Pure.
//
// A part made in the browser (frontend draw/split.ts) is runs of the shape's
// own outline plus the cut: the shape's vertices exactly, the cut's ends on
// its edges (rounded to 7 decimals) and the line's points inside. So an edge
// of a part that is one of the shape's own edges is inside by construction;
// every other edge (the cut, or a chord a crafted part adds) must have its
// ends and middle inside the shape or on its outline, and cross none of the
// shape's edges. Only those other edges are checked, at most
// SPLIT_CHECK_MAX_EDGES of them (a drawn line's few), each against every
// edge of the shape: bounded work for the 50 000-position limit.
import { pointInRing } from './geojson.js';
import type { Position } from './geojson.js';

/** How near the outline (degrees, about 10 cm) counts as on it: the browser rounds a cut's ends to 7 decimals. */
export const ON_OUTLINE_DEG = 1e-6;
/** The most edges of the parts that aren't the shape's own: a drawn cut has a handful; refused past this. */
export const SPLIT_CHECK_MAX_EDGES = 500;

const key = (p: Position) => `${p[0]},${p[1]}`;
const closed = (r: readonly Position[]) => r.length > 1 && r[0]![0] === r[r.length - 1]![0] && r[0]![1] === r[r.length - 1]![1];
const open = (r: readonly Position[]) => (closed(r) ? r.slice(0, -1) : [...r]);

/** Distance (degrees) from p to segment a–b. */
function toSegment(p: Position, a: Position, b: Position): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Signed distance (degrees) of p from the line through a–b. */
function side(p: Position, a: Position, b: Position): number {
	const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
	return len > 0 ? ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / len : 0;
}

/** Whether segments p–q and a–b cross properly: each's ends lie clearly (beyond ON_OUTLINE_DEG) on both sides of the other. */
function crosses(p: Position, q: Position, a: Position, b: Position): boolean {
	const s1 = side(p, a, b);
	const s2 = side(q, a, b);
	if (!((s1 > ON_OUTLINE_DEG && s2 < -ON_OUTLINE_DEG) || (s1 < -ON_OUTLINE_DEG && s2 > ON_OUTLINE_DEG))) return false;
	const s3 = side(a, p, q);
	const s4 = side(b, p, q);
	return (s3 > ON_OUTLINE_DEG && s4 < -ON_OUTLINE_DEG) || (s3 < -ON_OUTLINE_DEG && s4 > ON_OUTLINE_DEG);
}

/**
 * Null when every part lies within `shape` (one outline, no holes), else why
 * not. `parts` are each one outline, closed or not.
 */
export function partsWithin(shape: readonly Position[], parts: readonly (readonly Position[])[]): string | null {
	const ring = open(shape);
	const n = ring.length;
	const own = new Set<string>();
	for (let i = 0; i < n; i++) {
		const a = key(ring[i]!);
		const b = key(ring[(i + 1) % n]!);
		own.add(`${a}|${b}`).add(`${b}|${a}`);
	}
	const inside = (p: Position) => {
		if (pointInRing(p, ring)) return true;
		for (let i = 0; i < n; i++) if (toSegment(p, ring[i]!, ring[(i + 1) % n]!) <= ON_OUTLINE_DEG) return true;
		return false;
	};
	let checked = 0;
	for (const [k, part] of parts.entries()) {
		const r = open(part);
		for (let i = 0; i < r.length; i++) {
			const p = r[i]!;
			const q = r[(i + 1) % r.length]!;
			if (own.has(`${key(p)}|${key(q)}`)) continue;
			if (++checked > SPLIT_CHECK_MAX_EDGES) return `the cut has more than ${SPLIT_CHECK_MAX_EDGES} edges`;
			const mid: Position = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
			if (!inside(p) || !inside(q) || !inside(mid)) return `part ${k + 1} reaches outside the shape`;
			const lo = [Math.min(p[0], q[0]) - ON_OUTLINE_DEG, Math.min(p[1], q[1]) - ON_OUTLINE_DEG];
			const hi = [Math.max(p[0], q[0]) + ON_OUTLINE_DEG, Math.max(p[1], q[1]) + ON_OUTLINE_DEG];
			for (let j = 0; j < n; j++) {
				const a = ring[j]!;
				const b = ring[(j + 1) % n]!;
				if (Math.max(a[0], b[0]) < lo[0]! || Math.min(a[0], b[0]) > hi[0]! || Math.max(a[1], b[1]) < lo[1]! || Math.min(a[1], b[1]) > hi[1]!) continue;
				if (crosses(p, q, a, b)) return `part ${k + 1} reaches outside the shape`;
			}
		}
	}
	return null;
}
