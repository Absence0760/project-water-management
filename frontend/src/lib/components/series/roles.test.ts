import { SERIES_KINDS, type SeriesMeta } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { KIND_ROLES, seriesInUse } from './roles';

const meta = (id: string, kind: string, name = ''): SeriesMeta => ({ id, kind, name, unit: '', startDate: '2020-01-01', length: 1 });

describe('KIND_ROLES', () => {
	it('explains every series kind', () => {
		for (const k of SERIES_KINDS) expect(KIND_ROLES[k]?.help.length).toBeGreaterThan(20);
	});
});

describe('seriesInUse', () => {
	it('takes the first series of each kind by name', () => {
		const used = seriesInUse([meta('b', 'rain_catchment_mm', 'Station B'), meta('a', 'rain_catchment_mm', 'Station A'), meta('c', 'rain_chirps_mm')]);
		expect([...used].sort()).toEqual(['a', 'c']);
	});

	it('ignores the logger when there is an observed-gauge series', () => {
		expect([...seriesInUse([meta('o', 'flow_observed_m3s'), meta('l', 'flow_logger_m3s')])]).toEqual(['o']);
		expect([...seriesInUse([meta('l', 'flow_logger_m3s')])]).toEqual(['l']);
	});

	it('never counts a reference gauge (another catchment) as in use', () => {
		expect([...seriesInUse([meta('r', 'flow_reference_m3s'), meta('l', 'flow_logger_m3s')])]).toEqual(['l']);
		expect([...seriesInUse([meta('r', 'flow_reference_m3s')])]).toEqual([]);
		expect(KIND_ROLES.flow_reference_m3s!.driver).toBe(false);
	});
});
