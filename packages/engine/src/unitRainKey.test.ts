import { describe, expect, it } from 'vitest';
import { mapMmError, parseGaugeSeriesKey, rainStationError, parseUnitRainSeriesKey, UNIT_RAIN_KINDS, unitRainError, unitRainSeriesKey } from './project';

describe('unit rain series keys (issue #482)', () => {
	it('round-trips every unit rain kind', () => {
		for (const kind of UNIT_RAIN_KINDS) expect(parseUnitRainSeriesKey(unitRainSeriesKey(kind, 'u1'))).toEqual({ kind, nodeId: 'u1' });
	});

	it('refuses plain kinds, flow records, other kinds and an empty node', () => {
		expect(parseUnitRainSeriesKey('rain_chirps_mm')).toBeNull();
		expect(parseUnitRainSeriesKey('flow_observed_m3s@g1')).toBeNull();
		expect(parseUnitRainSeriesKey('rain_forecast_mm@u1')).toBeNull();
		expect(parseUnitRainSeriesKey('rain_chirps_mm@')).toBeNull();
	});

	it('is never read as a gauge flow record', () => {
		expect(parseGaugeSeriesKey(unitRainSeriesKey('rain_chirps_mm', 'u1'))).toBeNull();
	});
});

describe('unitRainError and mapMmError (issue #482)', () => {
	it('accepts absent, the two modes, a gauge MAP with its source and a period of a year or more', () => {
		expect(unitRainError(undefined)).toBeNull();
		expect(unitRainError(null)).toBeNull();
		expect(unitRainError({ mode: 'catchment' })).toBeNull();
		expect(unitRainError({ mode: 'perUnit', gaugeMapMm: 650, gaugeMapSource: 'gauge record 1981–2020', mapPeriod: { start: '1991-01-01', end: '2020-12-31' } })).toBeNull();
	});

	it('refuses a bad mode, a gauge MAP without a source or out of range, and a bad or short period', () => {
		expect(unitRainError({ mode: 'both' })).toMatch(/mode/);
		expect(unitRainError('perUnit')).toMatch(/not a unit rain/);
		expect(unitRainError({ mode: 'perUnit', gaugeMapMm: 650 })).toMatch(/needs its source/);
		expect(unitRainError({ mode: 'perUnit', gaugeMapMm: 0, gaugeMapSource: 'x' })).toMatch(/from 1/);
		expect(unitRainError({ mode: 'perUnit', mapPeriod: { start: '1991-01-01' } })).toMatch(/start and an end/);
		expect(unitRainError({ mode: 'perUnit', mapPeriod: { start: '2020-01-01', end: '2020-06-30' } })).toMatch(/at least a year/);
	});

	it('mapMmError: none is fine; a MAP needs a number in range and its source', () => {
		expect(mapMmError(null, null)).toBeNull();
		expect(mapMmError(820, 'fine grid, area-weighted')).toBeNull();
		expect(mapMmError(820, '  ')).toMatch(/source/);
		expect(mapMmError(Number.NaN, 'x')).toMatch(/number/);
		expect(mapMmError(20_000, 'x')).toMatch(/number/);
	});
});

describe('rainStationError (issue #553)', () => {
	const st = (o: Partial<Record<'mapMm' | 'mapSource' | 'lat' | 'lon', unknown>>) => ({ mapMm: null, mapSource: null, lat: null, lon: null, ...o }) as never;

	it('accepts nothing recorded, a MAP with its source, and coordinates in range (edges included)', () => {
		expect(rainStationError(st({}))).toBeNull();
		expect(rainStationError(st({ mapMm: 745, mapSource: 'station record 1981–2020' }))).toBeNull();
		expect(rainStationError(st({ lat: -33.9, lon: 18.9 }))).toBeNull();
		expect(rainStationError(st({ mapMm: 745, mapSource: 'x', lat: 90, lon: -180 }))).toBeNull();
		expect(rainStationError(st({ lat: -90, lon: 180 }))).toBeNull();
		expect(rainStationError({ mapMm: 745, mapSource: 'x' } as never)).toBeNull();
	});

	it('refuses a MAP as mapMmError does', () => {
		expect(rainStationError(st({ mapMm: 745 }))).toBe(mapMmError(745, null));
		expect(rainStationError(st({ mapMm: 0, mapSource: 'x' }))).toMatch(/from 1/);
		expect(rainStationError(st({ mapMm: Number.POSITIVE_INFINITY, mapSource: 'x' }))).toMatch(/number/);
	});

	it('refuses one coordinate without the other, out of range, or not a finite number', () => {
		expect(rainStationError(st({ lat: -33.9 }))).toMatch(/both/);
		expect(rainStationError(st({ lon: 18.9 }))).toMatch(/both/);
		expect(rainStationError(st({ lat: 90.01, lon: 0 }))).toMatch(/latitude/);
		expect(rainStationError(st({ lat: -91, lon: 0 }))).toMatch(/latitude/);
		expect(rainStationError(st({ lat: 0, lon: 180.5 }))).toMatch(/longitude/);
		expect(rainStationError(st({ lat: Number.NaN, lon: 0 }))).toMatch(/latitude/);
		expect(rainStationError(st({ lat: 0, lon: Number.NEGATIVE_INFINITY }))).toMatch(/longitude/);
		expect(rainStationError(st({ lat: '-33.9', lon: 18.9 }))).toMatch(/latitude/);
	});

	it('refuses something that is not a station', () => {
		expect(rainStationError(null as never)).toMatch(/not a rainfall station/);
		expect(rainStationError([] as never)).toMatch(/not a rainfall station/);
	});
});
