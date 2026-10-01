// The nearest-station ranking (geo/stations.ts): haversine distance, the
// bounding-box first pass, record length, and the order and filters of a
// proposal (issue #326 B-gauge).
import { describe, expect, it } from 'vitest';
import { boxAround, haversineKm, rankStations, recordYears, type StationCandidate } from './stations.js';

const station = (code: string, lon: number, lat: number, over: Partial<StationCandidate> = {}): StationCandidate => ({
	code,
	name: code,
	river: 'River',
	lon,
	lat,
	catchmentKm2: null,
	recordStart: '1980-01-01',
	recordEnd: '1999-12-31',
	dataset: 'synthetic',
	source: 'SYNTHETIC',
	...over
});

describe('haversineKm', () => {
	it('is zero at a point, symmetric, and a degree of latitude is about 111.2 km', () => {
		expect(haversineKm([21.3, -33.7], [21.3, -33.7])).toBe(0);
		expect(haversineKm([21, -33], [22, -34])).toBeCloseTo(haversineKm([22, -34], [21, -33]), 9);
		expect(haversineKm([21, -33], [21, -34])).toBeCloseTo(111.19, 1);
	});

	it('shrinks a degree of longitude with the cosine of the latitude', () => {
		expect(haversineKm([21, 0], [22, 0])).toBeCloseTo(111.19, 1);
		// At 60° S a degree of longitude is half as long (to the sphere's rounding).
		expect(haversineKm([21, -60], [22, -60]) / haversineKm([21, 0], [22, 0])).toBeCloseTo(0.5, 2);
	});

	it('agrees with a published distance: Cape Town to Johannesburg is about 1 260 km', () => {
		expect(haversineKm([18.4241, -33.9249], [28.0473, -26.2041])).toBeGreaterThan(1250);
		expect(haversineKm([18.4241, -33.9249], [28.0473, -26.2041])).toBeLessThan(1275);
	});
});

describe('boxAround', () => {
	it('holds every point within the radius, in each compass direction', () => {
		const p: [number, number] = [21.3, -33.8];
		const b = boxAround(p, 50);
		const dirs: [number, number][] = [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
			[0.7, 0.7]
		];
		for (const [dx, dy] of dirs) {
			// Walk out along the direction until 49.9 km, then check the point is in the box.
			let t = 0;
			while (haversineKm(p, [p[0] + dx * t, p[1] + dy * t]) < 49.9) t += 0.001;
			const q: [number, number] = [p[0] + dx * t, p[1] + dy * t];
			expect(q[0]).toBeGreaterThanOrEqual(b.minLon);
			expect(q[0]).toBeLessThanOrEqual(b.maxLon);
			expect(q[1]).toBeGreaterThanOrEqual(b.minLat);
			expect(q[1]).toBeLessThanOrEqual(b.maxLat);
		}
	});
});

describe('recordYears', () => {
	it('counts the years between the dates, to one decimal; an open record runs to today; no start, no figure', () => {
		expect(recordYears('1980-01-01', '1999-12-31', '2026-10-01')).toBe(20);
		expect(recordYears('2000-01-01', null, '2010-07-02')).toBe(10.5);
		expect(recordYears(null, '1999-12-31', '2026-10-01')).toBeNull();
		expect(recordYears('2000-01-01', '1999-01-01', '2026-10-01')).toBeNull();
	});
});

describe('rankStations', () => {
	const at: [number, number] = [21.3, -33.8];
	const today = '2026-10-01';

	it('lists river gauges nearest first, with the distance and record length, marked synthetic', () => {
		const out = rankStations(at, [station('Z1H003', 21.4, -33.8), station('Z1H001', 21.31, -33.8), station('Z1H002', 21.3, -33.9)], 50, today);
		expect(out.map((s) => s.code)).toEqual(['Z1H001', 'Z1H003', 'Z1H002']);
		expect(out[0]!.distanceKm).toBeCloseTo(0.93, 1);
		expect(out.every((s, i) => i === 0 || s.distanceKm >= out[i - 1]!.distanceKm)).toBe(true);
		expect(out[0]).toMatchObject({ recordYears: 20, synthetic: true });
	});

	it('leaves out reservoirs and other station types (the DWS feed reads river gauges only), and stations beyond the radius', () => {
		const out = rankStations(at, [station('Z1R001', 21.3, -33.8), station('Z1H001', 21.31, -33.8), station('Z1H009', 22.3, -33.8)], 50, today);
		expect(out.map((s) => s.code)).toEqual(['Z1H001']);
	});

	it('breaks a tie by code, so the order is stable, and keeps at most the limit', () => {
		const tied = ['Z1H005', 'Z1H002', 'Z1H004', 'Z1H001', 'Z1H003'].map((c) => station(c, 21.31, -33.8));
		expect(rankStations(at, tied, 50, today, 3).map((s) => s.code)).toEqual(['Z1H001', 'Z1H002', 'Z1H003']);
	});

	it('marks a station from another dataset as real', () => {
		expect(rankStations(at, [station('A2H012', 21.31, -33.8, { dataset: 'DWS 2026-10' })], 50, today)[0]!.synthetic).toBe(false);
	});
});
