// The nearest-gauging-stations proposal's words (nearestGauges.ts, issue #326 B-gauge).
import { describe, expect, it } from 'vitest';
import type { GaugeStationLookup } from '$lib/api/types';
import { distanceText, emptyLine, pointLine, recordText } from './nearestGauges';

const lookup = (over: Partial<GaugeStationLookup> = {}): GaugeStationLookup => ({
	point: [21.3, -33.8],
	pointFrom: 'outlet_gauge',
	pointName: 'Sandspruit Outlet',
	withinKm: 50,
	stations: [],
	datasets: [{ dataset: 'synthetic', count: 6 }],
	...over
});

describe('pointLine', () => {
	it('names the rule that chose the point: the outlet gauge, else the boundary’s centre, else neither', () => {
		expect(pointLine(lookup())).toBe('River gauges within 50 km of the outlet gauge “Sandspruit Outlet” on the map, nearest first.');
		expect(pointLine(lookup({ pointFrom: 'boundary_centre', pointName: 'Catchment' }))).toMatch(/^River gauges within 50 km of the centre of the catchment boundary “Catchment”, nearest first\. The outflow gauge has no point/);
		expect(pointLine(lookup({ pointFrom: 'query', pointName: null, withinKm: 12.5 }))).toBe('River gauges within 12.5 km of the point, nearest first.');
		expect(pointLine(lookup({ point: null, pointFrom: null, pointName: null }))).toMatch(/^Put the catchment boundary or the outflow gauge on the map/);
	});
});

describe('recordText', () => {
	it('gives the years and their span; an open record runs to now; no start, no dates', () => {
		expect(recordText({ recordStart: '1968-10-01', recordEnd: '2024-09-30', recordYears: 56 })).toBe('1968–2024 (56 years)');
		expect(recordText({ recordStart: '1931-01-01', recordEnd: null, recordYears: 95.7 })).toBe('1931 to now (95.7 years)');
		expect(recordText({ recordStart: '2025-01-01', recordEnd: '2025-12-31', recordYears: 1 })).toBe('2025–2025 (1 year)');
		expect(recordText({ recordStart: null, recordEnd: null, recordYears: null })).toBe('Record dates not given');
	});
});

describe('distanceText', () => {
	it('keeps a decimal under 10 km and rounds beyond', () => {
		expect(distanceText(2.83)).toBe('2.8 km');
		expect(distanceText(3)).toBe('3 km');
		expect(distanceText(12.53)).toBe('13 km');
	});
});

describe('emptyLine', () => {
	it('says why nothing is proposed: no list loaded, or none within the radius; nothing to say with stations or without a point', () => {
		expect(emptyLine(lookup({ datasets: [] }))).toMatch(/^No list of gauging stations is loaded/);
		expect(emptyLine(lookup())).toBe('No river gauge in the loaded list lies within 50 km. Type the station code instead.');
		expect(emptyLine(lookup({ point: null, pointFrom: null }))).toBeNull();
		expect(
			emptyLine(
				lookup({
					stations: [
						{ code: 'Z1H001', name: '', river: '', lon: 0, lat: 0, catchmentKm2: null, recordStart: null, recordEnd: null, recordYears: null, distanceKm: 1, dataset: 'synthetic', synthetic: true, source: 'S' }
					]
				})
			)
		).toBeNull();
	});
});
