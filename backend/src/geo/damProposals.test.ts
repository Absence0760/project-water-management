// The nearest-registered-dam matching behind the dam proposals (geo/damProposals.ts).
import { describe, expect, it } from 'vitest';
import { distanceM, nearestDams, searchBox, type RegisterDam } from './damProposals.js';

const dam = (registerNo: string, lon: number, lat: number, dataset = 'synthetic'): RegisterDam => ({
	registerNo,
	name: registerNo,
	river: null,
	farm: null,
	lon,
	lat,
	capacityM3: 100_000,
	wallHeightM: 6,
	surfaceAreaM2: null,
	completionYear: null,
	dataset,
	source: 'test',
	loadedAt: '2026-01-01T00:00:00.000Z'
});

describe('distanceM', () => {
	it('is about 111.2 km per degree of latitude and shrinks with cos(latitude) along a parallel', () => {
		expect(distanceM([21, -33], [21, -34])).toBeCloseTo(111_195, -1);
		expect(distanceM([21, -60], [22, -60]) / distanceM([21, 0], [22, 0])).toBeCloseTo(0.5, 3);
		expect(distanceM([21.3, -33.7], [21.3, -33.7])).toBe(0);
	});
});

describe('searchBox', () => {
	it('holds every point at the radius, in every direction', () => {
		const p: [number, number] = [21.3, -33.7];
		const b = searchBox(p, 1000);
		for (let a = 0; a < 360; a += 15) {
			const r = (a * Math.PI) / 180;
			// 999 m out along the bearing, by the local flat-earth step (well inside the box's 1 % margin).
			const q: [number, number] = [p[0] + (0.999 * Math.sin(r)) / (111.195 * Math.cos((p[1] * Math.PI) / 180)), p[1] + (0.999 * Math.cos(r)) / 111.195];
			expect(distanceM(p, q)).toBeLessThan(1000);
			expect(q[0] >= b.minLon && q[0] <= b.maxLon && q[1] >= b.minLat && q[1] <= b.maxLat).toBe(true);
		}
	});
});

describe('nearestDams', () => {
	const p: [number, number] = [21.3, -33.7];
	// 1 km east is ~0.01082° of longitude at 33.7° S.
	const dams = [dam('far', 21.32, -33.7), dam('b', 21.3, -33.695), dam('a', 21.3, -33.695), dam('near', 21.301, -33.7, 'DSO-2025-07'), dam('edge', 21.3108, -33.7)];

	it('keeps the dams within the radius, nearest first, ties by register number, marked synthetic by dataset', () => {
		const got = nearestDams(dams, p, 1000, 10);
		expect(got.map((d) => d.registerNo)).toEqual(['near', 'a', 'b', 'edge']);
		expect(got[0]!.synthetic).toBe(false);
		expect(got[1]!.synthetic).toBe(true);
		expect(got[1]!.distanceM).toBe(got[2]!.distanceM);
		expect(got.at(-1)!.distanceM).toBeLessThan(1000);
	});

	it('stops at the limit, and finds nothing when nothing is near', () => {
		expect(nearestDams(dams, p, 1000, 2).map((d) => d.registerNo)).toEqual(['near', 'a']);
		expect(nearestDams(dams, [25, -28], 1000)).toEqual([]);
	});
});
