import { flowAtExceedance, flowDurationCurves, exceedanceGrid, sortedDescending } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { flowDurationTable } from './fdc.js';
import { flowDurationLines } from './run-tables.js';

// Synthetic catchment series in m³/day, as run_series stores them: 100 days,
// natural 1 … 100 m³/s, simulated 0.5 × natural, the gauge reading only the last 60 days.
const DAY = 86_400;
const natural = Array.from({ length: 100 }, (_, i) => (i + 1) * DAY);
const simulated = natural.map((v) => v * 0.5);
const observed = natural.map((v, i) => (i < 40 ? null : v * 0.8));
const series = [
	{ key: 'simulated_outflow', values: simulated },
	{ key: 'natural_flow', values: natural },
	{ key: 'observed_flow', values: observed },
	{ key: 'ewr', values: natural }
];

describe('flowDurationTable', () => {
	it('ranks the catchment flows in m³/s, the unit and numbers the Runs tab’s FDC table shows', () => {
		const t = flowDurationTable(series);
		expect(t.wholeRun.map((r) => r.record)).toEqual(['natural', 'simulated', 'observed']);
		// The chart converts m³/day → m³/s (v / 86 400) and reads its curve at 10 … 95 %.
		const inM3s = [natural, simulated, observed].map((s) => s.map((v) => (v === null ? null : v / DAY)));
		const grid = exceedanceGrid();
		const { ys } = flowDurationCurves(inM3s, grid);
		t.wholeRun.forEach((r, k) => expect([r.q10, r.q50, r.q90, r.q95]).toEqual([10, 50, 90, 95].map((p) => ys[k]![grid.indexOf(p)])));
		// Hand-worked: 1 … 100 at Weibull positions, Q90 sits at rank 90.9 between 11 and 10.
		expect(t.wholeRun[0]!.q90).toBeCloseTo(10.1, 12);
		expect(t.wholeRun[0]!.q90).toBe(flowAtExceedance(sortedDescending(inM3s[0]!), 90));
		expect(t.onObservedDays!.map((r) => r.n)).toEqual([60, 60, 60]);
	});

	it('leaves out a record the run has no series for, and ignores other keys', () => {
		const t = flowDurationTable(series.filter((s) => s.key !== 'observed_flow'));
		expect(t.wholeRun.map((r) => r.record)).toEqual(['natural', 'simulated']);
		expect(t.onObservedDays).toBeNull();
	});
});

describe('flowDurationLines', () => {
	it('writes the whole run, then the observed days, unrounded', () => {
		const lines = [...flowDurationLines(flowDurationTable(series))];
		expect(lines[0]).toMatch(/^Flow-duration percentiles/);
		expect(lines[1]).toBe('Days ranked,Flow record,Q10 (m³/s),Q50 (m³/s),Q90 (m³/s),Q95 (m³/s),Days');
		expect(lines.slice(2).map((l) => l.split(',').slice(0, 2).join(','))).toEqual([
			'Whole run,Natural',
			'Whole run,Simulated outflow',
			'Whole run,Observed',
			'Observed days only (60 of 100),Natural',
			'Observed days only (60 of 100),Simulated outflow',
			'Observed days only (60 of 100),Observed'
		]);
		const t = flowDurationTable(series);
		expect(lines[2]).toBe(`Whole run,Natural,${t.wholeRun[0]!.q10},${t.wholeRun[0]!.q50},${t.wholeRun[0]!.q90},${t.wholeRun[0]!.q95},100`);
	});

	it('says so when the run stored no catchment flows', () => {
		expect([...flowDurationLines(null)].slice(1)).toEqual(['No catchment flow series stored for this run']);
		expect([...flowDurationLines(flowDurationTable([]))].slice(1)).toEqual(['No catchment flow series stored for this run']);
	});
});
