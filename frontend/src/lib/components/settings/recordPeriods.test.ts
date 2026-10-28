// The per-record period lists (issue #611): which records each form lists and how a list is written back.
import { describe, expect, it } from 'vitest';
import { flowRecordOptions, rainRecordOptions, unreliableError, UNRELIABLE_PERIODS_MAX, withRecordList, withUnlisted, withUnreliable } from './recordPeriods';

const series = [
	{ id: 's-rain', kind: 'rain_catchment_mm', name: '' },
	{ id: 's-unit', kind: 'rain_catchment_mm', name: 'Farm gauge', siteNodeId: 'n-farm' },
	{ id: 's-alt', kind: 'rain_catchment_alt_mm', name: 'Hill logger' },
	{ id: 's-chirps', kind: 'rain_chirps_mm', name: '' },
	{ id: 's-obs', kind: 'flow_observed_m3s', name: '' },
	{ id: 's-weir', kind: 'flow_logger_m3s', name: 'Weir logger', siteNodeId: 'n-weir' },
	{ id: 's-ref', kind: 'flow_reference_m3s', name: 'Next valley' },
	{ id: 's-pan', kind: 'evap_apan_mm', name: '' }
];
const nodeName = (id: string) => ({ 'n-farm': 'Rooikloof', 'n-weir': 'Upper weir' })[id];

describe('the records each list is for', () => {
	it('rain: every catchment rain series (a station, a unit’s own gauge) and the alternative gauge, never CHIRPS', () => {
		expect(rainRecordOptions(series, nodeName)).toEqual([
			{ id: 's-unit', label: 'Farm gauge (Rooikloof)' },
			{ id: 's-alt', label: 'Hill logger' },
			{ id: 's-rain', label: 'Rainfall — catchment' }
		]);
	});

	it('flow: the gauge, logger and reference records, at the outlet or a gauge; a site gone from the model says so', () => {
		expect(flowRecordOptions(series, nodeName)).toEqual([
			{ id: 's-obs', label: 'Flow — observed gauge' },
			{ id: 's-ref', label: 'Next valley' },
			{ id: 's-weir', label: 'Weir logger (Upper weir)' }
		]);
		expect(flowRecordOptions([{ id: 'x', kind: 'flow_logger_m3s', name: 'L', siteNodeId: 'gone' }], nodeName)).toEqual([{ id: 'x', label: 'L (a unit no longer in the model)' }]);
		expect(flowRecordOptions(null)).toEqual([]);
	});

	it('keeps a record the setting names but the project no longer has, so its periods can be removed', () => {
		expect(withUnlisted([{ id: 'a', label: 'A' }], { a: [], b: [] })).toEqual([
			{ id: 'a', label: 'A' },
			{ id: 'b', label: 'A deleted series' }
		]);
	});
});

describe('writing a record’s list back', () => {
	it('sets or removes one record’s list; null when no record keeps one', () => {
		const p = { start: '2020-01-01', end: '2020-01-31', reason: 'x' };
		expect(withRecordList(null, 'a', [p])).toEqual({ a: [p] });
		expect(withRecordList({ a: [p], b: [p] }, 'a', [])).toEqual({ b: [p] });
		expect(withRecordList({ a: [p] }, 'a', [])).toBeNull();
	});

	it('the unreliable periods live in settings.rainStations: emptied, a setting with nothing else goes back to null; its other parts stay', () => {
		const one: [string, string][] = [['2020-01-01', '2020-01-31']];
		expect(withUnreliable(null, 's-unit', one)).toEqual({ unreliable: { 's-unit': one } });
		expect(withUnreliable({ unreliable: { 's-unit': one } }, 's-unit', [])).toBeNull();
		expect(withUnreliable({ catchment: { stationId: 's-rain' }, unreliable: { 's-unit': one } }, 's-unit', [])).toEqual({ catchment: { stationId: 's-rain' } });
	});

	it('refuses dates out of order, a blank date and too many periods, saying which', () => {
		expect(unreliableError([['2020-01-01', '2020-01-31']])).toBeNull();
		expect(unreliableError([['2020-01-01', '2020-01-31'], ['2020-03-01', '2020-02-01']])).toBe('Unreliable period 2: ends before it starts');
		expect(unreliableError([['', '2020-01-31']])).toBe('Unreliable period 1: give both dates');
		expect(unreliableError(Array.from({ length: UNRELIABLE_PERIODS_MAX + 1 }, () => ['2020-01-01', '2020-01-02'] as [string, string]))).toMatch(/^At most 200 unreliable periods a record/);
	});
});
