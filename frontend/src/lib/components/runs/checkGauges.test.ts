import { CHECK_GAUGE_FLOW_KEY, type DailySeries } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { checkFdc, checkHydrograph, checksOnlyGauges, gaugeStatsLine, gaugeStatsText, recordHref } from './checkGauges';

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

	it('carries the summary’s fit, and leaves it out for a run made before it', () => {
		const fit = { days: 3, nse: 0.5, kge: 0.6, pbias: 1 };
		const [a, b] = checksOnlyGauges([{ ...g('a'), fit }, g('b')], [], null);
		expect(a!.fit).toEqual(fit);
		expect('fit' in b!).toBe(false);
	});

	it('is empty for a run without gauge checks', () => {
		expect(checksOnlyGauges(undefined, [], null)).toEqual([]);
	});
});

describe('gaugeStatsText', () => {
	it('writes the line with its days', () => {
		expect(gaugeStatsText({ days: 1204, nse: 0.6234, kge: 0.71, pbias: -4.25 })).toMatch(/^NSE 0\.62 · KGE 0\.71 · PBIAS −?-?4\.\d % over 1.204 days$/u);
		expect(gaugeStatsText({ days: 1, nse: null, kge: null, pbias: null })).toBe('NSE – · KGE – · PBIAS – over 1 day');
	});

	it('gaugeStatsLine says why there are no statistics: no day read, or a run without them', () => {
		expect(gaugeStatsLine({ days: 1, nse: null, kge: null, pbias: null })).toBe('NSE – · KGE – · PBIAS – over 1 day.');
		expect(gaugeStatsLine(null)).toBe('no day of the record falls in the run outside its excluded periods.');
		expect(gaugeStatsLine(undefined)).toBe('not in this run’s summary: run the model again.');
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
