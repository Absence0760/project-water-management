import { describe, expect, it } from 'vitest';
import { ewrChartSeries, hydrographSeries } from './flowSeries';

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

describe('ewrChartSeries', () => {
	it('draws simulated outflow against the EWR as a stepped line', () => {
		const out = ewrChartSeries({ simulated: d(2), ewr: d(1), observed: d(5) }, conv);
		expect(out.map((s) => [s.label, s.style])).toEqual([
			['Simulated outflow', undefined],
			['Pragmatic EWR', 'step']
		]);
	});
});
