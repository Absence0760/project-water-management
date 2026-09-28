import type { SeriesMeta } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { dataEnd, freshness, freshnessOrder, guessSeries, headerLine, newDataSinceRun } from './freshness';

const meta = (id: string, kind: string, name: string, startDate: string, length: number, updatedAt?: string) =>
	({ id, kind, name, unit: '', startDate, length, ...(updatedAt ? { updatedAt } : {}) }) as SeriesMeta & { updatedAt?: string };

describe('freshness', () => {
	const list = [meta('r', 'rain_catchment_mm', 'Rain', '2025-01-01', 90), meta('f', 'flow_observed_m3s', 'Gauge', '2025-01-01', 40)];

	it('reports the latest end date, its age and staleness', () => {
		const f = freshness(list, '2025-04-12')!;
		expect(f.latest).toBe('2025-03-31');
		expect(f.age).toBe(12);
		expect(f.stale).toBe(true);
		expect(f.perSeries.map((s) => s.id)).toEqual(['r', 'f']);
		expect(freshness(list, '2025-04-03')!.stale).toBe(false);
	});

	it('is null without series', () => expect(freshness([], '2025-01-01')).toBeNull());

	it('lists the driver series behind: recorded rain and A-pan older than the limit, never a forecast or a flow', () => {
		const all = [
			meta('r1', 'rain_catchment_mm', 'Gauge R1', '2025-01-01', 100), // ends 10 Apr: 2 days old
			meta('r2', 'rain_catchment_mm', 'Gauge R2', '2025-01-01', 90), // ends 31 Mar: 12 days old
			meta('c', 'rain_chirps_mm', '', '2025-01-01', 60),
			meta('e', 'evap_apan_mm', '', '2025-01-01', 30),
			meta('fc', 'rain_forecast_mm', '', '2024-01-01', 10),
			meta('q', 'flow_observed_m3s', '', '2024-01-01', 10)
		];
		const f = freshness(all, '2025-04-12')!;
		expect(f.behind.map((s) => s.id)).toEqual(['r2', 'c', 'e']);
		expect(freshness(all, '2025-04-12', 400)!.behind).toEqual([]);
		// With no recorded rain at all, an old A-pan series is still behind.
		expect(freshness([meta('e', 'evap_apan_mm', '', '2025-01-01', 30)], '2025-04-12')!.behind.map((s) => s.id)).toEqual(['e']);
	});

	it('measures recorded rain only: a forecast or a gauge reaching later does not make the data fresh', () => {
		const later = [...list, meta('fc', 'rain_forecast_mm', 'GFS', '2025-03-25', 30), meta('g', 'flow_observed_m3s', 'Gauge 2', '2025-01-01', 110)];
		const f = freshness(later, '2025-04-12')!;
		expect(f.latest).toBe('2025-03-31');
		expect(f.stale).toBe(true);
		// The table still lists every series, newest first.
		expect(f.perSeries.map((s) => s.id)).toEqual(['fc', 'g', 'r', 'f']);
		// CHIRPS is recorded rain too (positive control).
		expect(freshness([...later, meta('ch', 'rain_chirps_mm', 'CHIRPS', '2025-01-01', 100)], '2025-04-12')!.latest).toBe('2025-04-10');
	});

	it('counts to the last day with a value: blank days a logger stores after it ("no reading") are no data', () => {
		const blanks = { ...meta('r', 'rain_catchment_mm', 'Logger', '2025-01-01', 100), lastValueDate: '2025-03-31' };
		const f = freshness([blanks], '2025-04-12')!;
		expect(f).toMatchObject({ latest: '2025-03-31', age: 12, stale: true });
		expect(f.behind.map((s) => s.id)).toEqual(['r']);
		// Positive control: the same series with values to its stored end (10 Apr) is fresh.
		expect(freshness([{ ...blanks, lastValueDate: '2025-04-10' }], '2025-04-12')).toMatchObject({ latest: '2025-04-10', stale: false });
		// Every day blank: it ends the day before it starts. No field (an older payload): the stored end.
		expect(dataEnd({ startDate: '2025-01-01', length: 5, lastValueDate: null })).toBe('2024-12-31');
		expect(dataEnd({ startDate: '2025-01-01', length: 5 })).toBe('2025-01-05');
	});

	it('is stale with no date when there is no recorded rain at all', () => {
		expect(freshness([meta('fc', 'rain_forecast_mm', '', '2025-04-01', 30)], '2025-04-12')).toMatchObject({ latest: null, age: null, stale: true });
	});
});

describe('newDataSinceRun', () => {
	const run = { createdAt: '2025-04-01T10:00:00.000Z', endDate: '2025-03-31' };

	it('flags driver series that reach past the run or were updated after it', () => {
		const list = [
			meta('longer', 'rain_catchment_mm', '', '2025-01-01', 91), // ends 2025-04-01
			meta('same', 'rain_chirps_mm', '', '2025-01-01', 90),
			meta('fixed', 'rain_forecast_mm', '', '2025-01-01', 90, '2025-04-02T08:00:00.000Z'),
			meta('pitman', 'flow_pitman_m3s', '', '2025-01-01', 200), // engine ≤ 0.9.0 only: no longer drives a run
			meta('obs', 'flow_observed_m3s', '', '2025-01-01', 200), // scores runs, doesn't drive them
			meta('pan', 'evap_apan_mm', '', '2025-01-01', 91) // daily A-pan drives demand, dams and GR4J (issue #45)
		];
		expect(newDataSinceRun(list, run).map((s) => s.id)).toEqual(['longer', 'fixed', 'pan']);
	});

	it('blank days past the run are no new data (positive control: a value past it is)', () => {
		const blank = { ...meta('blank', 'rain_catchment_mm', '', '2025-01-01', 95), lastValueDate: '2025-03-31' };
		expect(newDataSinceRun([blank], run)).toEqual([]);
		expect(newDataSinceRun([{ ...blank, lastValueDate: '2025-04-02' }], run).map((s) => s.id)).toEqual(['blank']);
	});

	it('is empty with no run', () => expect(newDataSinceRun([meta('x', 'rain_catchment_mm', '', '2025-01-01', 9)], null)).toEqual([]));
});

describe('guessSeries', () => {
	const list = [
		meta('a', 'rain_catchment_mm', 'Average Catchment Rainfall', '2020-01-01', 1),
		meta('b', 'flow_observed_m3s', 'Flow W7', '2020-01-01', 1),
		meta('c', 'flow_logger_m3s', 'Logger L3', '2020-01-01', 1)
	];

	it('prefers an existing series named in the file or header', () => {
		expect(guessSeries('export.csv', 'date,Flow W7', list)).toEqual({ kind: 'flow_observed_m3s', name: 'Flow W7' });
		expect(guessSeries('logger_l3_2025.csv', '', list)).toEqual({ kind: 'flow_logger_m3s', name: 'Logger L3' });
	});

	it('falls back to keywords, using the only series of that kind', () => {
		expect(guessSeries('rain-april.csv', '', list)).toEqual({ kind: 'rain_catchment_mm', name: 'Average Catchment Rainfall' });
		expect(guessSeries('chirps.csv', '', list)).toEqual({ kind: 'rain_chirps_mm', name: '' });
		expect(guessSeries('reference-gauge.csv', '', list)).toEqual({ kind: 'flow_reference_m3s', name: '' });
		expect(guessSeries('gauge.csv', '', list)).toEqual({ kind: 'flow_observed_m3s', name: 'Flow W7' });
		expect(guessSeries('data.csv', 'date,value', list)).toBeNull();
		// A pan record is in mm too: evaporation wins over the rain keyword.
		expect(guessSeries('station-apan.csv', 'date,evaporation mm', list)).toEqual({ kind: 'evap_apan_mm', name: '' });
		expect(guessSeries('pan_evap.csv', '', list)).toEqual({ kind: 'evap_apan_mm', name: '' });
		expect(guessSeries('japan-rain.csv', '', list)).toEqual({ kind: 'rain_catchment_mm', name: 'Average Catchment Rainfall' });
	});

	it('reads the header line only when the first cell is not a date', () => {
		expect(headerLine('﻿date,rain mm\n2025-01-01,3')).toBe('date,rain mm');
		expect(headerLine('2025-01-01,3\n')).toBe('');
	});
});

describe('freshnessOrder', () => {
	const ids = (l: { id: string }[]) => l.map((s) => s.id);
	const list = [{ id: 'q' }, { id: 'r1' }, { id: 'r2' }, { id: 'c' }, { id: 'ref' }, { id: 'e' }];

	it('puts the series behind first, most days behind first, then those a run reads, then the rest, keeping list order within a group', () => {
		const behind = [
			{ id: 'c', age: 12 },
			{ id: 'e', age: 40 }
		];
		const inUse = new Set(['q', 'r1', 'c', 'e']);
		expect(ids(freshnessOrder(list, behind, inUse))).toEqual(['e', 'c', 'q', 'r1', 'r2', 'ref']);
	});

	it('keeps the list order when nothing is behind and every series is read', () => {
		expect(ids(freshnessOrder(list, [], new Set(ids(list))))).toEqual(ids(list));
	});

	it('orders by the same rule the badge counts: freshness().behind fed straight in', () => {
		const m = (id: string, kind: string, length: number) => meta(id, kind, id, '2025-01-01', length);
		const all = [m('q', 'flow_observed_m3s', 10), m('r', 'rain_catchment_mm', 100), m('c', 'rain_chirps_mm', 60)];
		const f = freshness(all, '2025-04-12')!;
		expect(f.behind.map((b) => b.id)).toEqual(['c']);
		expect(ids(freshnessOrder(all, f.behind, new Set(['q', 'r', 'c'])))).toEqual(['c', 'q', 'r']);
	});
});
