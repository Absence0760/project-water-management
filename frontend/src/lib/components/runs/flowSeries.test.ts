import { describe, expect, it } from 'vitest';
import { OBSERVED_SERIES_LABEL } from '@water-management/engine';
import { ewrChartSeries, hydrographSeries, observedCaption, observedLabels, observedSources } from './flowSeries';

const d = (v: number) => ({ startDate: '2020-01-01', values: [v, v] });
const conv = (s: { values: (number | null)[] }) => s.values.map((v) => (v == null ? null : v * 10));

describe('hydrographSeries', () => {
	it('draws observed, then natural (hidden on screen), then simulated outflow, in the chart unit', () => {
		const out = hydrographSeries({ natural: d(3), simulated: d(2), observed: d(1), ewr: d(9) }, conv);
		expect(out.map((s) => [s.label, s.color, s.hidden ?? false])).toEqual([
			['Observed', '--chart-obs', false],
			['Natural', '--series-1', true],
			['Simulated outflow', '--series-2', false]
		]);
		expect(out[0]!.values).toEqual([10, 10]);
	});

	it('shows natural flow from the start when asked (the printed report has no legend to click)', () => {
		expect(hydrographSeries({ natural: d(3) }, conv, false)[0]!.hidden).toBe(false);
	});

	it('leaves out what the run lacks', () => {
		expect(hydrographSeries({ simulated: d(2) }, conv).map((s) => s.label)).toEqual(['Simulated outflow']);
		expect(hydrographSeries({}, conv)).toEqual([]);
	});
});

describe('observed flow by record (issue #45)', () => {
	const ref = (key: string, label: string, nodeId: string | null = null) => ({ key, label, nodeId });

	it('reads gauge or logger from the stored labels, and ignores node series with the same key', () => {
		expect(observedSources([ref('observed_flow', OBSERVED_SERIES_LABEL.flow_observed_m3s)])).toEqual({ observed: 'gauge' });
		expect(observedSources([ref('observed_flow', OBSERVED_SERIES_LABEL.flow_logger_m3s)])).toEqual({ observed: 'logger' });
		expect(
			observedSources([
				ref('observed_flow', OBSERVED_SERIES_LABEL.flow_logger_m3s),
				ref('observed_flow_other', OBSERVED_SERIES_LABEL.flow_observed_m3s),
				ref('observed_flow', 'Observed flow (logger)', 'farm-1')
			])
		).toEqual({ observed: 'logger', observedOther: 'gauge' });
		expect(observedSources([])).toEqual({});
	});

	it('labels one record by its instrument, never plain "Observed" for a logger', () => {
		const logger = hydrographSeries({ observed: d(1), simulated: d(2) }, conv, true, { observed: 'logger' });
		expect(logger.map((s) => s.label)).toEqual(['Observed logger', 'Simulated outflow']);
		expect(hydrographSeries({ observed: d(1) }, conv, true, { observed: 'gauge' })[0]!.label).toBe('Observed gauge');
	});

	it('draws both records when both exist, the calibration record named, the other dashed in its own colour', () => {
		const src = { observed: 'logger', observedOther: 'gauge' } as const;
		const out = hydrographSeries({ observed: d(1), observedOther: d(4), simulated: d(2) }, conv, true, src);
		expect(out.map((s) => [s.label, s.color, s.style])).toEqual([
			['Observed logger (calibration record)', '--chart-obs', undefined],
			['Observed gauge', '--series-4', 'dashed'],
			['Simulated outflow', '--series-2', undefined]
		]);
		expect(out[1]!.values).toEqual([40, 40]);
		expect(observedLabels(src)).toEqual({ observed: 'Observed logger (calibration record)', observedOther: 'Observed gauge' });
		// The caption says which line is which, and that the other isn't scored.
		expect(observedCaption({ observed: d(1), observedOther: d(4) }, src)).toMatch(/^Observed logger \(calibration record\) is the solid line and Observed gauge the dashed one, shown but not scored/);
		expect(observedCaption({ observed: d(1) }, { observed: 'gauge' })).toMatch(/^Observed flow is a line broken/);
	});
});

describe('ewrChartSeries', () => {
	it('draws simulated outflow against the EWR as a stepped line', () => {
		const out = ewrChartSeries({ simulated: d(2), ewr: d(1), observed: d(5) }, conv);
		expect(out.map((s) => [s.label, s.style])).toEqual([
			['Simulated outflow', undefined],
			['Pragmatic EWR', 'step']
		]);
	});
});
