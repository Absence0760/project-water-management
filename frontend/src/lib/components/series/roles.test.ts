import { SERIES_KINDS, type SeriesMeta } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { gaugeRecordsInUse, KIND_ROLES, newSeriesEffect, rainSourceKinds, roleBadge, seriesInUse } from './roles';

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

describe('newSeriesEffect', () => {
	const station = meta('s', 'rain_catchment_mm', 'Station 0021');

	it('the first series of a kind just creates it', () => {
		expect(newSeriesEffect([meta('c', 'rain_chirps_mm')], 'rain_catchment_mm', 'Station 0021')).toEqual({ effect: 'first', current: null, didYouMean: null });
	});

	it('a name that sorts first will replace the series runs read', () => {
		const e = newSeriesEffect([station], 'rain_catchment_mm', 'Aa station');
		expect(e.effect).toBe('replaces');
		expect(e.current?.id).toBe('s');
		// A blank name sorts first too.
		expect(newSeriesEffect([station], 'rain_catchment_mm', '').effect).toBe('replaces');
	});

	it('a name that sorts after keeps runs on the one they read', () => {
		const e = newSeriesEffect([station], 'rain_catchment_mm', 'Zz station');
		expect(e.effect).toBe('keeps');
		expect(e.current?.id).toBe('s');
		expect(e.didYouMean).toBeNull();
	});

	it('offers the existing name when one differs only in case or spacing', () => {
		expect(newSeriesEffect([station], 'rain_catchment_mm', 'station  0021').didYouMean?.id).toBe('s');
		expect(newSeriesEffect([station], 'rain_catchment_mm', 'Station 0022').didYouMean).toBeNull();
	});

	it('says nothing about which when runs read none of the kind either way', () => {
		// A reference gauge is never read; a logger beside an observed gauge isn't either.
		expect(newSeriesEffect([meta('r', 'flow_reference_m3s', 'Ref')], 'flow_reference_m3s', 'A').effect).toBe('unread');
		expect(newSeriesEffect([meta('o', 'flow_observed_m3s', 'Weir'), meta('l', 'flow_logger_m3s', 'L')], 'flow_logger_m3s', 'A').effect).toBe('unread');
	});

	it('a gauge’s record (sited) doesn’t count: an upload goes to the outlet', () => {
		const sited = { ...meta('g', 'flow_observed_m3s', 'Upper'), siteNodeId: 'n1' };
		expect(newSeriesEffect([sited], 'flow_observed_m3s', 'Weir').effect).toBe('first');
	});
});

describe('roleBadge', () => {
	const ctx = (list: SeriesMeta[], extra: Partial<Parameters<typeof roleBadge>[1]> = {}) => ({
		list,
		inUse: seriesInUse(list),
		gaugeInUse: gaugeRecordsInUse(list, [{ id: 'n1' }]),
		gaugeIds: new Set(['n1']),
		calibrationSite: null,
		...extra
	});

	it('names the role of a series a run reads, and marks the others unused with the reason in the badge', () => {
		const a = meta('a', 'rain_catchment_mm', 'A');
		const b = meta('b', 'rain_catchment_mm', 'B');
		expect(roleBadge(a, ctx([a, b]))).toEqual({ label: 'Main rainfall', unused: false, why: null });
		expect(roleBadge(b, ctx([a, b]))).toEqual({ label: 'Not used (another series of this kind is)', unused: true, why: null });
	});

	it('says in words where a gauge record is checked and scored', () => {
		const g = { ...meta('g', 'flow_observed_m3s', 'Upper'), siteNodeId: 'n1' };
		const checks = roleBadge(g, ctx([g]));
		expect(checks?.label).toBe('Gauge record (checks only)');
		expect(checks?.why).toMatch(/Settings → Calibration record/);
		expect(roleBadge(g, ctx([g], { calibrationSite: 'n1' }))?.label).toBe('Gauge record (calibration site)');
		const gone = { ...g, siteNodeId: 'n9' };
		expect(roleBadge(gone, ctx([gone]))?.label).toBe('Not used: its gauge is no longer in the model');
	});
});
