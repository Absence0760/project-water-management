import type { SeriesMeta } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { freshness, guessSeries, headerLine, newDataSinceRun } from './freshness';

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
