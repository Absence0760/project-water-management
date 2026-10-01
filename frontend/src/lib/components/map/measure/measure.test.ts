// Measure's maths and words (measure.ts, issue #326 A7): the area on the
// WGS84 ellipsoid as the server computes it (the same reference squares as
// backend/src/geo/area.test.ts), great-circle distances, and the sentences
// the measure bar shows.
import { describe, expect, it } from 'vitest';
import type { MapPosition } from '$lib/api/types';
import { distanceText, measuredAreaText, measureText, pathLengthM, perimeterM, shapeAreaM2 } from './measure';

const A = 6_378_137;
const E2 = 0.006_694_379_990_14;
const rad = Math.PI / 180;
/** A square `sideM` metres on a side centred at (lon, lat), not closed (backend area.test.ts's square). */
function square(lon: number, lat: number, sideM: number): MapPosition[] {
	const s = Math.sin(lat * rad);
	const w = 1 - E2 * s * s;
	const dLat = sideM / ((A * (1 - E2)) / Math.pow(w, 1.5)) / rad / 2;
	const dLon = sideM / ((A / Math.sqrt(w)) * Math.cos(lat * rad)) / rad / 2;
	return [
		[lon - dLon, lat - dLat],
		[lon + dLon, lat - dLat],
		[lon + dLon, lat + dLat],
		[lon - dLon, lat + dLat]
	];
}

describe('shapeAreaM2', () => {
	it('gives a 1 km² square at South African latitudes its area within 0.01 %, as the server does', () => {
		for (const lat of [-22, -30, -34.5]) expect(Math.abs(shapeAreaM2(square(25, lat, 1000)) - 1e6) / 1e6, `at ${lat}°`).toBeLessThan(1e-4);
		expect(Math.abs(shapeAreaM2(square(19.5, -33.9, 10_000)) - 1e8) / 1e8).toBeLessThan(5e-4);
	});

	it('is the same either way round, and nothing under three points', () => {
		const sq = square(21.3, -33.6, 2000);
		expect(shapeAreaM2([...sq].reverse())).toBeCloseTo(shapeAreaM2(sq), 6);
		expect(shapeAreaM2(sq.slice(0, 2))).toBe(0);
	});
});

describe('distances', () => {
	it('measures a path great-circle, along its points in order', () => {
		// One degree of latitude on the mean-radius sphere: 111.195 km.
		expect(pathLengthM([[21, -34], [21, -33]]) / 1000).toBeCloseTo(111.195, 2);
		expect(pathLengthM([[21, -34], [21, -33], [21, -34]]) / 1000).toBeCloseTo(222.39, 1);
		expect(pathLengthM([[21, -34]])).toBe(0);
	});

	it('closes the shape for the perimeter: a 1 km square is 4 km round', () => {
		expect(perimeterM(square(25, -30, 1000)) / 1000).toBeCloseTo(4, 2);
	});
});

describe('the words', () => {
	it('writes distances in m under 1 km, then km', () => {
		expect(distanceText(0)).toBe('0 m');
		expect(distanceText(849.6)).toBe('850 m');
		expect(distanceText(1240)).toBe('1.24 km');
		expect(distanceText(123_456)).toBe('123.5 km');
	});

	it('writes areas in ha under 1 km², then km² with the hectares', () => {
		expect(measuredAreaText(52_300)).toBe('5.23 ha');
		expect(measuredAreaText(523_000)).toBe('52.3 ha');
		expect(measuredAreaText(12_400_000)).toMatch(/^12\.40 km² \(1.?240 ha\)$/);
	});

	it('says what to do first, the running distance, then the area and perimeter once closed', () => {
		const sq = square(25, -30, 1000);
		expect(measureText([], false)).toBe('Click the map to add the first point, or press Enter at the crosshair.');
		expect(measureText(sq.slice(0, 1), false)).toBe('Distance: 0 m (1 point). Add the next point.');
		expect(measureText(sq.slice(0, 3), false)).toBe('Distance: 2.00 km (3 points).');
		expect(measureText(square(25, -30, 800), true)).toBe('Area: 64.0 ha. Perimeter: 3.20 km.');
		// Not closed yet: still the distance, even with four points.
		expect(measureText(sq, false)).toBe('Distance: 3.00 km (4 points).');
	});
});
