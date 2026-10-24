import { calibrationStats, CHECK_GAUGE_FLOW_KEY, type DailySeries } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { checkFdc, checkHydrograph, checksOnlyGauges, gaugeCheckStats, gaugeStatsText, recordHref } from './checkGauges';

const g = (nodeId: string, flowKind: 'flow_observed_m3s' | 'flow_logger_m3s' = 'flow_observed_m3s') => ({ nodeId, name: `Weir ${nodeId}`, flowKind });
const day = (values: (number | null)[], startDate = '2020-10-01'): DailySeries => ({ startDate, values });
const conv = (d: DailySeries) => d.values;

describe('checksOnlyGauges', () => {
	it('lists each checked gauge but the calibration site, in the network’s order, and says which have their record stored', () => {
		const refs = [
			{ key: CHECK_GAUGE_FLOW_KEY, nodeId: 'a' },
			{ key: 'outflow', nodeId: 'b' },
			{ key: 'observed_flow', nodeId: 's' }
		];
		expect(checksOnlyGauges([g('a'), g('b', 'flow_logger_m3s'), g('s')], refs, 's')).toEqual([
			{ nodeId: 'a', name: 'Weir a', flowKind: 'flow_observed_m3s', stored: true },
			{ nodeId: 'b', name: 'Weir b', flowKind: 'flow_logger_m3s', stored: false }
		]);
		// The page's node order, not the checks' node-id order; a node it doesn't know goes last.
		const order = new Map([['b', 1], ['s', 2], ['a', 3]]);
		expect(checksOnlyGauges([g('a'), g('z'), g('b')], refs, 's', order).map((x) => x.nodeId)).toEqual(['b', 'a', 'z']);
	});

	it('is empty for a run without gauge checks', () => {
		expect(checksOnlyGauges(undefined, [], null)).toEqual([]);
	});
});

describe('gaugeCheckStats', () => {
	it('scores the record (m³/day, gaps blank) against the simulated flow with the calibration statistics’ formulas, in m³/s', () => {
		const obs = [86_400, null, 2 * 86_400, NaN, 3 * 86_400, 4 * 86_400];
		const sim = [1.2, 9, 1.8, 9, 3.3, 3.5].map((v) => v * 86_400);
		const s = gaugeCheckStats(day(obs), day(sim))!;
		const ref = calibrationStats(sim, [1, null, 2, null, 3, 4]);
		expect(s).toEqual({ days: 4, nse: ref.nse, kge: ref.kge, pbias: ref.pbias });
		// The days without a reading are left out: a perfect match on the read days scores 1.
		const perfect = gaugeCheckStats(day(obs), day([1, 9, 2, 9, 3, 4].map((v) => v * 86_400)))!;
		expect(perfect.nse).toBeCloseTo(1, 12);
		expect(perfect.pbias).toBeCloseTo(0, 12);
	});

	it('shows a unit error at a glance: a record 30× the simulated flow has PBIAS near −2 900 %', () => {
		const sim = [1, 2, 3, 2, 1].map((v) => v * 86_400);
		const s = gaugeCheckStats(day(sim.map((v) => v * 30)), day(sim))!;
		expect(s.pbias).toBeCloseTo(100 * (30 - 1) / 30, 9); // PBIAS = 100 × Σ(o − s) / Σo
		expect(s.nse!).toBeLessThan(0);
	});

	it('leaves out the run’s calibration exclusions, as the plausibility checks at the gauge do', () => {
		const obs = day([86_400, 86_400, 50 * 86_400, 86_400]);
		const sim = day([86_400, 86_400, 86_400, 86_400]);
		const all = gaugeCheckStats(obs, sim)!;
		const kept = gaugeCheckStats(obs, sim, null, [{ start: '2020-10-03', end: '2020-10-03', reason: 'Weir silted up' }])!;
		expect(all.days).toBe(4);
		expect(kept).toEqual({ days: 3, nse: null, kge: null, pbias: 0 });
	});

	it('leaves a forecast run’s forecast days out, and is null with no day read', () => {
		const obs = day([86_400, 86_400, 50 * 86_400]);
		const sim = day([86_400, 86_400, 86_400]);
		expect(gaugeCheckStats(obs, sim, '2020-10-03')!.days).toBe(2);
		expect(gaugeCheckStats(day([null, NaN]), day([1, 2]))).toBeNull();
	});

	it('writes the line with its days', () => {
		expect(gaugeStatsText({ days: 1204, nse: 0.6234, kge: 0.71, pbias: -4.25 })).toMatch(/^NSE 0\.62 · KGE 0\.71 · PBIAS −?-?4\.\d % over 1.204 days$/u);
		expect(gaugeStatsText({ days: 1, nse: null, kge: null, pbias: null })).toBe('NSE – · KGE – · PBIAS – over 1 day');
	});
});

describe('checkHydrograph and checkFdc', () => {
	it('draws the record by instrument under the simulated flow', () => {
		const s = checkHydrograph(day([1, null]), day([2, 2]), 'flow_logger_m3s', conv);
		expect(s.map((x) => x.label)).toEqual(['Observed logger', 'Simulated flow']);
		expect(s[0]!.values).toEqual([1, null]);
	});

	it('ranks the simulated flow on the record’s days only', () => {
		const f = checkFdc(day([null, 1, null, 1]), day([100, 2, 100, 2]), 'flow_observed_m3s', conv);
		expect(f.series.map((x) => x.label)).toEqual(['Simulated flow', 'Observed gauge']);
		// The 100s fall on days without a reading: the simulated curve never reaches them.
		expect(Math.max(...(f.xy.ys[0]!.filter((v) => v !== null) as number[]))).toBe(2);
	});
});

describe('recordHref', () => {
	const series = [
		{ id: 'out', kind: 'flow_observed_m3s', siteNodeId: null },
		{ id: 'a 1', kind: 'flow_observed_m3s', siteNodeId: 'a' },
		{ id: 'a-log', kind: 'flow_logger_m3s', siteNodeId: 'a' }
	];
	it('links the gauge’s own record of that kind in Series details', () => {
		expect(recordHref(series, 'a', 'flow_observed_m3s')).toBe('?tab=series&series=a%201#data-chart');
		expect(recordHref(series, 'a', 'flow_logger_m3s')).toBe('?tab=series&series=a-log#data-chart');
	});
	it('is null when the project no longer has it', () => {
		expect(recordHref(series, 'b', 'flow_observed_m3s')).toBeNull();
		expect(recordHref(null, 'a', 'flow_observed_m3s')).toBeNull();
	});
});
