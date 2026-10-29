import { describe, expect, it } from 'vitest';
import { centralMeridian, fromUtm, toUtm, utmEpsgFor, utmZone } from './utm.js';

// Reference values from PROJ 9 (pyproj Transformer EPSG:4326 → the code,
// always_xy), computed once and pasted here: [lon, lat, epsg, x, y].
const PROJ: [number, number, number, number, number][] = [
	[19.05, -33.95, 32634, 319803.092, -3758324.9879],
	[21.0, -34.0, 32734, 500000.0, 6237844.0224],
	[18.0, -30.0, 32634, 210590.3468, -3322575.9044],
	[27.0, -25.5, 32735, 500000.0, 7179686.0945],
	[32.9, -26.8, 32736, 490060.9863, 7035712.3726],
	[15.0, 0.0, 32633, 500000.0, 0.0],
	[17.999, -34.8, 32634, 225445.0328, -3854969.9762],
	[24.0, -30.0, 32634, 789409.6532, -3322575.9044],
	// A point well outside its zone (DE Africa writes scenes that straddle zones in one zone's code).
	[31.5, -22.0, 32635, 964839.9213, -2439674.8085],
	[3.0, 60.0, 32631, 500000.0, 6651411.1904]
];

describe('toUtm', () => {
	it.each(PROJ)('(%f, %f) in EPSG %i agrees with PROJ to a millimetre', (lon, lat, epsg, x, y) => {
		const p = toUtm(lon, lat, epsg);
		expect(Math.abs(p.x - x)).toBeLessThan(0.001);
		expect(Math.abs(p.y - y)).toBeLessThan(0.001);
	});

	it('gives the same easting in the north and south codes, northings 10 000 km apart', () => {
		const n = toUtm(19.05, -33.95, 32634);
		const s = toUtm(19.05, -33.95, 32734);
		expect(s.x).toBeCloseTo(n.x, 6);
		expect(s.y - n.y).toBeCloseTo(10_000_000, 6);
	});

	// PROJ's areal scale (Proj.get_factors) is k²: [lon, lat, epsg, areal scale].
	it.each([
		[19.05, -33.95, 32634, 1.0000005906],
		[18.0, -30.0, 32634, 1.0012674353],
		[24.0, -30.0, 32634, 1.0012674353],
		[21.0, -34.0, 32734, 0.99920016]
	])('the scale factor at (%f, %f) squares to PROJ’s areal scale', (lon, lat, epsg, areal) => {
		expect(toUtm(lon, lat, epsg).k ** 2).toBeCloseTo(areal, 9);
	});

	it('is k0 on the central meridian at the equator', () => {
		expect(toUtm(15, 0, 32633).k).toBeCloseTo(0.9996, 12);
	});

	it('refuses a code that is not UTM, and points it cannot place', () => {
		expect(() => toUtm(19, -34, 4326)).toThrow(/not WGS 84 \/ UTM/);
		expect(() => toUtm(19, -34, 32661)).toThrow(/not WGS 84 \/ UTM/);
		expect(() => toUtm(19, -89, 32734)).toThrow(/outside/);
		expect(() => toUtm(Number.NaN, -34, 32734)).toThrow(/outside/);
		expect(() => toUtm(100, -34, 32734)).toThrow(/too far/);
	});
});

describe('fromUtm', () => {
	it.each(PROJ)('takes PROJ’s (%f, %f) in EPSG %i back to its point, to 1e-8°', (lon, lat, epsg, x, y) => {
		const p = fromUtm(x, y, epsg);
		// 1e-8° is ~1 mm; PROJ's numbers are printed to 0.1 mm.
		expect(Math.abs(p.lon - lon)).toBeLessThan(1e-8);
		expect(Math.abs(p.lat - lat)).toBeLessThan(1e-8);
	});

	// The zone 34 / 35 line, 24° E: a point there is 3° east of zone 34's meridian and 3° west of zone 35's,
	// so its eastings mirror about 500 km (PROJ: 789 409.6532 in 34, 210 590.3468 in 35, as (18°, −30°) in 34).
	it('places 24° E, 30° S in both zones as PROJ does, and carries it from one to the other', () => {
		expect(fromUtm(789409.6532, 6677424.0956, 32734)).toMatchObject({ lon: expect.closeTo(24, 9), lat: expect.closeTo(-30, 9) });
		expect(fromUtm(210590.3468, 6677424.0956, 32735)).toMatchObject({ lon: expect.closeTo(24, 9), lat: expect.closeTo(-30, 9) });
		const g = fromUtm(789409.6532, -3322575.9044, 32634);
		const q = toUtm(g.lon, g.lat, 32735);
		expect(q.x).toBeCloseTo(210590.3468, 3);
		expect(q.y).toBeCloseTo(6677424.0956, 3);
	});

	it.each([-0.05, -0.02, 0, 0.02, 0.05])('round-trips points %f° from the zone line at 24° E in both zones to a millimetre', (dLon) => {
		for (const lat of [-22.4, -28, -33.9]) {
			for (const epsg of [32734, 32735, 32634, 32635]) {
				const p = toUtm(24 + dLon, lat, epsg);
				const g = fromUtm(p.x, p.y, epsg);
				const back = toUtm(g.lon, g.lat, epsg);
				expect(Math.hypot(back.x - p.x, back.y - p.y)).toBeLessThan(0.001);
				expect(Math.abs(g.lon - (24 + dLon))).toBeLessThan(1e-9);
				expect(Math.abs(g.lat - lat)).toBeLessThan(1e-9);
			}
		}
	});

	it('refuses a code that is not UTM, and a point beyond its reach', () => {
		expect(() => fromUtm(500000, 6000000, 4326)).toThrow(/not WGS 84 \/ UTM/);
		expect(() => fromUtm(Number.NaN, 6000000, 32734)).toThrow(/not a number/);
		expect(() => fromUtm(9_000_000, 6000000, 32734)).toThrow(/reach/);
	});
});

describe('zones', () => {
	it('names the zone and its meridian', () => {
		expect(utmZone(32634)).toBe(34);
		expect(utmZone(32735)).toBe(35);
		expect(centralMeridian(34)).toBe(21);
	});
	it('picks the zone a point falls in', () => {
		expect(utmEpsgFor(19.05, -33.95)).toBe(32734);
		expect(utmEpsgFor(24.0, 1)).toBe(32635);
		expect(utmEpsgFor(180, 0)).toBe(32660);
		expect(utmEpsgFor(-180, -1)).toBe(32701);
	});
});
