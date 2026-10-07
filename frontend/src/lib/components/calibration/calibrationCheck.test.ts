import { describe, expect, it } from 'vitest';
import { allKeys, checkGauges, checkKeys, checkSeries, contributors, sumDaily } from './calibrationCheck';

// Out ← Weir ← A (unit) ← A1 (unit); Weir ← U (other user); Out ← B (unit). The weir is the calibration site.
const nodes = [
	{ id: 'Out', kind: 'gauge', downstreamNodeId: null },
	{ id: 'Weir', kind: 'gauge', downstreamNodeId: 'Out' },
	{ id: 'A', kind: 'farm', downstreamNodeId: 'Weir' },
	{ id: 'A1', kind: 'farm', downstreamNodeId: 'A' },
	{ id: 'U', kind: 'user', downstreamNodeId: 'Weir' },
	{ id: 'B', kind: 'farm', downstreamNodeId: 'Out' }
];
const ref = (key: string, nodeId: string | null) => ({ key, nodeId });
const refs = [
	ref('natural_flow', null),
	ref('simulated_outflow', null),
	ref('observed_flow', null),
	ref('observed_flow', 'Weir'),
	ref('outflow', 'Weir'),
	ref('outflow', 'Out'),
	...['A', 'A1', 'B'].flatMap((id) => [ref('runoff', id), ref('demand', id)]),
	ref('landcover_reduction', 'A1'),
	ref('demand', 'U')
];

describe('the gauges and what reaches them', () => {
	it('lists the outlet, then the calibration site, by their observed records', () => {
		expect(checkGauges(refs)).toEqual([null, 'Weir']);
		expect(checkGauges(refs.filter((r) => !(r.key === 'observed_flow' && r.nodeId !== null)))).toEqual([null]);
		expect(checkGauges(refs.filter((r) => r.key !== 'observed_flow'))).toEqual([]);
	});

	it('takes every node for the outlet, and the site with everything upstream of it', () => {
		expect([...contributors(nodes, null)].sort()).toEqual(['A', 'A1', 'B', 'Out', 'U', 'Weir']);
		expect([...contributors(nodes, 'Weir')].sort()).toEqual(['A', 'A1', 'U', 'Weir']);
		// A unit as the site counts itself (its outflow carries its own runoff and abstraction).
		expect([...contributors(nodes, 'A')].sort()).toEqual(['A', 'A1']);
	});
});

describe('checkKeys', () => {
	it('the outlet: its record, simulated outflow, the catchment’s natural flow and every unit’s and user’s demand', () => {
		const k = checkKeys(refs, nodes, null);
		expect(k.observed).toEqual(ref('observed_flow', null));
		expect(k.simulated).toEqual(ref('simulated_outflow', null));
		expect(k.natural).toEqual([ref('natural_flow', null)]);
		expect(k.demand.map((d) => d.nodeId)).toEqual(['A', 'A1', 'U', 'B']);
	});

	it('a gauge inside: its outflow, its units’ runoff plus land cover’s share, and only the demand above it', () => {
		const k = checkKeys(refs, nodes, 'Weir');
		expect(k.observed).toEqual(ref('observed_flow', 'Weir'));
		expect(k.simulated).toEqual(ref('outflow', 'Weir'));
		expect(k.natural).toEqual([ref('runoff', 'A'), ref('runoff', 'A1'), ref('landcover_reduction', 'A1')]);
		expect(k.demand).toEqual([ref('demand', 'A'), ref('demand', 'A1'), ref('demand', 'U')]);
	});

	it('leaves out what the run didn’t store', () => {
		const k = checkKeys([ref('observed_flow', null)], nodes, null);
		expect(k).toEqual({ observed: ref('observed_flow', null), simulated: null, natural: [], demand: [] });
	});

	it('fetches each series once across the gauges', () => {
		const keys = allKeys([checkKeys(refs, nodes, null), checkKeys(refs, nodes, 'Weir')]);
		const ids = keys.map((k) => `${k.key}|${k.nodeId}`);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain('demand|A');
		expect(ids).toContain('runoff|A1');
		expect(ids).toHaveLength(3 + 4 + 2 + 3);
	});
});

describe('sumDaily', () => {
	it('adds day by day, each series placed by its start date, a day without any value a gap', () => {
		expect(
			sumDaily([
				{ startDate: '2021-10-01', values: [1, 2, 3] },
				{ startDate: '2021-10-02', values: [10, NaN, 30] }
			])
		).toEqual({ startDate: '2021-10-01', values: [1, 12, 3, 30] });
		expect(sumDaily([{ startDate: '2021-10-03', values: [NaN, 5] }, { startDate: '2021-10-01', values: [1] }])).toEqual({ startDate: '2021-10-01', values: [1, null, null, 5] });
		expect(sumDaily([])).toBeNull();
	});
});

describe('checkSeries', () => {
	const d = (v: number) => ({ startDate: '2021-10-01', values: [v, v] });
	const perSecond = (s: { values: readonly (number | null)[] }) => s.values.map((v) => (v == null ? null : v / 86_400));

	it('draws observed, simulated, natural and the demand upstream, all in the chart’s unit', () => {
		const s = checkSeries({ observed: d(86_400), simulated: d(172_800), natural: d(259_200), demand: d(43_200) }, perSecond, 'Observed gauge');
		expect(s.map((x) => x.label)).toEqual(['Observed gauge', 'Simulated', 'Natural', 'Upstream demand']);
		// m³/day → m³/s, the demand on the flows' axis too.
		expect(s.map((x) => x.values[0])).toEqual([1, 2, 3, 0.5]);
		// The demand reads apart without colour: dashed.
		expect(s[3]).toMatchObject({ style: 'dashed', color: '--series-3' });
		expect(s.slice(0, 3).every((x) => x.style === undefined)).toBe(true);
	});

	it('draws only the lines it has', () => {
		expect(checkSeries({ observed: d(1), natural: null, demand: null }, perSecond).map((x) => x.label)).toEqual(['Observed']);
	});
});
