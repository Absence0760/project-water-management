import { SERIES_KINDS, type SeriesMeta } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { gaugeRecordsInUse, KIND_ROLES, rainSourceKinds, seriesInUse } from './roles';

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

	it('counts the alternative gauge and the reanalysis only when a rain-source period names them (engine ≥ 0.30.0)', () => {
		const list = [meta('c', 'rain_catchment_mm'), meta('alt', 'rain_catchment_alt_mm'), meta('era', 'rain_reanalysis_mm')];
		expect([...seriesInUse(list)]).toEqual(['c']);
		const kinds = rainSourceKinds([{ series: 'rain_catchment_alt_mm', fitReference: { series: 'rain_reanalysis_mm' } }]);
		expect([...seriesInUse(list, kinds)].sort()).toEqual(['alt', 'c', 'era']);
		expect([...seriesInUse(list, rainSourceKinds([{ series: 'rain_catchment_alt_mm' }]))].sort()).toEqual(['alt', 'c']);
		expect(rainSourceKinds(null).size).toBe(0);
	});
});

describe('gauge records (084_gauge_records, engine ≥ 1.4.0)', () => {
	const at = (id: string, kind: string, name: string, siteNodeId: string): SeriesMeta => ({ ...meta(id, kind, name), siteNodeId });

	it('a record at a gauge is never the outlet’s, even when it sorts first', () => {
		const list = [at('g', 'flow_observed_m3s', 'A weir', 'n1'), meta('o', 'flow_observed_m3s', 'Outlet'), meta('l', 'flow_logger_m3s')];
		expect([...seriesInUse(list)]).toEqual(['o']);
		// With only a gauge's observed record, the outlet falls back to its logger, as the run does.
		expect([...seriesInUse([at('g', 'flow_observed_m3s', '', 'n1'), meta('l', 'flow_logger_m3s')])]).toEqual(['l']);
	});

	it('reads the first record of each kind per gauge, and none on a node no longer a gauge', () => {
		const list = [
			at('g2', 'flow_observed_m3s', 'B', 'n1'),
			at('g1', 'flow_observed_m3s', 'A', 'n1'),
			at('gl', 'flow_logger_m3s', 'L', 'n1'),
			at('k', 'flow_observed_m3s', 'K', 'n2'),
			at('gone', 'flow_observed_m3s', 'Z', 'removed'),
			meta('o', 'flow_observed_m3s')
		];
		expect([...gaugeRecordsInUse(list, [{ id: 'n1' }, { id: 'n2' }])].sort()).toEqual(['g1', 'gl', 'k']);
		expect([...gaugeRecordsInUse(list, [])]).toEqual([]);
	});
});
