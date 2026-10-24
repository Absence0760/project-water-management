import { describe, expect, it } from 'vitest';
import { rainStationError, type SeriesMeta } from '@water-management/engine';
import { emptyStation, isStationSeries, readCoordinate, readMap, stationBody, stationNames, stationProblem, type StationInput } from './stationInput';

const filled = (over: Partial<StationInput> = {}): StationInput => ({ mapMm: '745', mapSource: 'Station record 1991–2020', lat: '', lon: '', ...over });

describe('readCoordinate', () => {
	it('reads a decimal point, a decimal comma and the true minus', () => {
		expect(readCoordinate('-33.92')).toBe(-33.92);
		expect(readCoordinate('-33,92')).toBe(-33.92);
		expect(readCoordinate('−33.92')).toBe(-33.92);
		expect(readCoordinate(' 18.86 ')).toBe(18.86);
	});
	it('is null when blank and NaN when it is not a coordinate', () => {
		expect(readCoordinate('  ')).toBeNull();
		expect(readCoordinate('33°55′S')).toBeNaN();
		expect(readCoordinate('1,234.5')).toBeNaN();
	});
});

describe('readMap', () => {
	it('reads thousands separators and a decimal comma', () => {
		expect(readMap('1 200')).toBe(1200);
		expect(readMap('745,5')).toBe(745.5);
		expect(readMap('')).toBeNull();
		expect(readMap('lots')).toBeNaN();
	});
});

describe('stationProblem', () => {
	it('passes a named station with a MAP and its source, coordinates optional', () => {
		expect(stationProblem('Bergwater', filled())).toBeNull();
		expect(stationProblem('Bergwater', filled({ lat: '-33.9', lon: '18.9' }))).toBeNull();
	});
	it('asks for the name, then the MAP, then its source', () => {
		expect(stationProblem('  ', filled())?.field).toBe('name');
		expect(stationProblem('B', emptyStation())).toEqual({ field: 'mapMm', message: 'Enter the station’s MAP.' });
		expect(stationProblem('B', filled({ mapSource: '  ' }))).toEqual({ field: 'mapSource', message: 'A MAP needs its source.' });
		expect(stationProblem('B', filled({ mapSource: 'x'.repeat(601) }))?.field).toBe('mapSource');
	});
	it('holds the MAP to the API’s bounds (1 to 12 000 mm)', () => {
		expect(stationProblem('B', filled({ mapMm: '0' }))?.field).toBe('mapMm');
		expect(stationProblem('B', filled({ mapMm: '12001' }))?.field).toBe('mapMm');
		expect(stationProblem('B', filled({ mapMm: 'wet' }))?.field).toBe('mapMm');
		expect(stationProblem('B', filled({ mapMm: '1' }))).toBeNull();
		expect(stationProblem('B', filled({ mapMm: '12000' }))).toBeNull();
	});
	it('wants both coordinates or neither, each in range', () => {
		expect(stationProblem('B', filled({ lat: '-33.9' }))).toEqual({ field: 'lon', message: 'Give the longitude too, or leave both blank.' });
		expect(stationProblem('B', filled({ lon: '18.9' }))).toEqual({ field: 'lat', message: 'Give the latitude too, or leave both blank.' });
		expect(stationProblem('B', filled({ lat: '-91', lon: '18' }))?.field).toBe('lat');
		expect(stationProblem('B', filled({ lat: '-33', lon: '181' }))?.field).toBe('lon');
		expect(stationProblem('B', filled({ lat: 'south', lon: '18' }))?.field).toBe('lat');
		expect(stationProblem('B', filled({ lat: '90', lon: '-180' }))).toBeNull();
	});
});

describe('stationBody', () => {
	it('is the request’s station: numbers, the trimmed source, null coordinates when blank', () => {
		expect(stationBody('B', filled({ mapSource: '  WR2012 grid  ' }))).toEqual({ mapMm: 745, mapSource: 'WR2012 grid', lat: null, lon: null });
		expect(stationBody('B', filled({ lat: '-33,92', lon: '18,86' }))).toEqual({ mapMm: 745, mapSource: 'Station record 1991–2020', lat: -33.92, lon: 18.86 });
	});
	it('always passes the API’s rule (engine rainStationError)', () => {
		const cases = [filled(), filled({ mapMm: '1' }), filled({ mapMm: '12 000' }), filled({ lat: '-90', lon: '180' }), filled({ lat: '0', lon: '0' }), filled({ mapSource: 'x'.repeat(600) })];
		for (const c of cases) expect(rainStationError(stationBody('B', c)!)).toBeNull();
	});
	it('is null while something is wrong', () => {
		expect(stationBody('B', filled({ lat: '-33' }))).toBeNull();
		expect(stationBody('', filled())).toBeNull();
	});
});

describe('stations in the list', () => {
	const s = (over: Partial<SeriesMeta>): SeriesMeta => ({ id: over.name ?? 'x', kind: 'rain_catchment_mm', name: '', unit: 'mm', startDate: '2021-10-01', length: 1, ...over }) as SeriesMeta;
	const station = { mapMm: 745, mapSource: 'src', lat: null, lon: null };
	it('is a catchment rain series at no site', () => {
		expect(isStationSeries(s({}))).toBe(true);
		expect(isStationSeries(s({ siteNodeId: 'unit-1' }))).toBe(false);
		expect(isStationSeries(s({ kind: 'rain_chirps_mm' }))).toBe(false);
	});
	it('names only the stations that carry details', () => {
		expect(stationNames([s({ name: 'A', station }), s({ name: 'B' }), s({ name: 'C', station, siteNodeId: 'u' }), s({ name: 'D', kind: 'rain_chirps_mm' })])).toEqual(['A']);
	});
});
