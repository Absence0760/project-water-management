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
});

describe('newDataSinceRun', () => {
	const run = { createdAt: '2025-04-01T10:00:00.000Z', endDate: '2025-03-31' };

	it('flags driver series that reach past the run or were updated after it', () => {
		const list = [
			meta('longer', 'rain_catchment_mm', '', '2025-01-01', 91), // ends 2025-04-01
			meta('same', 'rain_chirps_mm', '', '2025-01-01', 90),
			meta('fixed', 'rain_forecast_mm', '', '2025-01-01', 90, '2025-04-02T08:00:00.000Z'),
			meta('pitman', 'flow_pitman_m3s', '', '2025-01-01', 200), // engine ≤ 0.9.0 only: no longer drives a run
			meta('obs', 'flow_observed_m3s', '', '2025-01-01', 200) // scores runs, doesn't drive them
		];
		expect(newDataSinceRun(list, run).map((s) => s.id)).toEqual(['longer', 'fixed']);
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
	});

	it('reads the header line only when the first cell is not a date', () => {
		expect(headerLine('﻿date,rain mm\n2025-01-01,3')).toBe('date,rain mm');
		expect(headerLine('2025-01-01,3\n')).toBe('');
	});
});
