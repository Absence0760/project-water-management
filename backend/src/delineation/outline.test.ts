import { describe, expect, it } from 'vitest';
import { ringSelfIntersects } from '../geo/geojson.js';
import { signedArea, simplifyRing, traceOutline } from './outline.js';

const maskOf = (rows: string[]) => {
	const ny = rows.length;
	const nx = rows[0]!.length;
	const m = new Uint8Array(nx * ny);
	rows.forEach((r, y) => [...r].forEach((c, x) => (m[y * nx + x] = c === '#' ? 1 : 0)));
	return { nx, ny, m };
};

describe('traceOutline', () => {
	it('outlines one cell as its square', () => {
		const { nx, ny, m } = maskOf(['...', '.#.', '...']);
		const ring = traceOutline(nx, ny, m);
		expect(ring).toHaveLength(5);
		expect(ring[0]).toEqual(ring[4]);
		expect(Math.abs(signedArea(ring))).toBe(1);
	});

	it('keeps only corners, and its area is the cells’ (an L)', () => {
		const { nx, ny, m } = maskOf(['#...', '#...', '###.']);
		const ring = traceOutline(nx, ny, m);
		expect(ring).toHaveLength(7);
		expect(Math.abs(signedArea(ring))).toBe(5);
	});

	it('keeps cells that touch only at a corner in one ring that never touches itself', () => {
		const { nx, ny, m } = maskOf(['##..', '##..', '..##', '..##']);
		const ring = traceOutline(nx, ny, m);
		// The two corner chamfers move the area by a sixteenth of a cell at most.
		expect(Math.abs(Math.abs(signedArea(ring)) - 8)).toBeLessThanOrEqual(0.0625);
		expect(ringSelfIntersects(ring)).toBe(false);
	});

	it('drops a hole', () => {
		const { nx, ny, m } = maskOf(['###', '#.#', '###']);
		expect(Math.abs(signedArea(traceOutline(nx, ny, m)))).toBe(9);
	});
});

describe('simplifyRing', () => {
	it('removes vertices within the tolerance and keeps a closed ring', () => {
		const ring: [number, number][] = [];
		for (let i = 0; i <= 100; i++) ring.push([i, (i % 2) * 0.2]);
		ring.push([100, 10], [0, 10], [0, 0]);
		const s = simplifyRing(ring, 1);
		expect(s.length).toBeLessThan(8);
		expect(s[0]).toEqual(s[s.length - 1]);
		expect(Math.abs(signedArea(s))).toBeCloseTo(1000, -1);
	});

	it('leaves a ring alone at tolerance 0', () => {
		const ring: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 0]];
		expect(simplifyRing(ring, 0)).toEqual(ring);
	});
});
