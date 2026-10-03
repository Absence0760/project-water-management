// Test shapes for the GeoJSON checks (geo/geojson.ts): the unit tests and
// the perf budgets (geo/geojson.perf.test.ts) build the same rings.
import type { Position } from '../geo/geojson.js';

/** A sawtooth of `n` edges across [-1, 1] stacked northwards, closed round the west: a simple ring whose edges all overlap in longitude. */
export const sawtooth = (n: number, x0 = -1, x1 = 1, dy = 1e-6): Position[] => {
	const ring: Position[] = [];
	for (let k = 0; k < n; k++) ring.push([k % 2 ? x1 : x0, k * dy]);
	const top = ring[ring.length - 1]![1];
	ring.push([x0 - 1, top], [x0 - 1, 0], ring[0]!);
	return ring;
};

/** A closed ring of `n` vertices round a circle of 0.5° near (20, -33): every edge overlaps few others. */
export const circle = (n: number): Position[] => {
	const ring: Position[] = Array.from({ length: n }, (_, i) => [20 + 0.5 * Math.cos((2 * Math.PI * i) / n), -33 + 0.5 * Math.sin((2 * Math.PI * i) / n)]);
	ring.push(ring[0]!);
	return ring;
};
