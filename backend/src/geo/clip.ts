// Polygon clipping against a grid's rows and cells, shared by the CHIRPS
// cells a boundary covers (feeds/boundaryCells.ts, issue #326 B-rain) and the
// land-cover cells a parcel covers (geo/gridShares.ts, B-landcover).
//
// Sutherland–Hodgman against axis-parallel half-planes. A cell is convex, so
// clipping a concave ring to it still gives a polygon whose signed area is
// exactly the area of the intersection: the extra edges the algorithm leaves
// along the cell's sides run there and back and cancel.
import type { Position } from './geojson.js';

/** Twice the signed area of a ring (shoelace, any closure). */
export function signedArea2(ring: readonly Position[]): number {
	let s = 0;
	for (let i = 0, n = ring.length; i < n; i++) {
		const [x1, y1] = ring[i]!;
		const [x2, y2] = ring[(i + 1) % n]!;
		s += x1 * y2 - x2 * y1;
	}
	return s;
}

/** Sutherland–Hodgman against one half-plane: keep points where `inside` holds, cutting each crossing edge at `cut`. */
function clipHalf(ring: readonly Position[], inside: (p: Position) => boolean, cut: (a: Position, b: Position) => Position): Position[] {
	const out: Position[] = [];
	const n = ring.length;
	for (let i = 0; i < n; i++) {
		const cur = ring[i]!;
		const prev = ring[(i + n - 1) % n]!;
		const inCur = inside(cur);
		if (inCur !== inside(prev)) out.push(cut(prev, cur));
		if (inCur) out.push(cur);
	}
	return out;
}

const atY = (y: number) => (a: Position, b: Position): Position => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];
const atX = (x: number) => (a: Position, b: Position): Position => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];

/** A ring clipped to the band lo ≤ y ≤ hi. */
export function clipY(ring: readonly Position[], lo: number, hi: number): Position[] {
	const a = clipHalf(ring, (p) => p[1] >= lo, atY(lo));
	return a.length ? clipHalf(a, (p) => p[1] <= hi, atY(hi)) : a;
}

/** A ring clipped to the band lo ≤ x ≤ hi. */
export function clipX(ring: readonly Position[], lo: number, hi: number): Position[] {
	const a = clipHalf(ring, (p) => p[0] >= lo, atX(lo));
	return a.length ? clipHalf(a, (p) => p[0] <= hi, atX(hi)) : a;
}

/** A ring without its closing repeat of the first position. */
export const openRing = (ring: readonly Position[]): Position[] => {
	const n = ring.length;
	return n > 1 && ring[0]![0] === ring[n - 1]![0] && ring[0]![1] === ring[n - 1]![1] ? ring.slice(0, -1) : [...ring];
};
