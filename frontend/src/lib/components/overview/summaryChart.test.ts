import { describe, expect, it } from 'vitest';
import { belowReserve, flowHeading, hasRuleLine } from './summaryChart';

describe('belowReserve', () => {
	it('turns each run of short days into one inclusive range', () => {
		expect(belowReserve({ startDate: '2021-10-01', values: [0, -5, -1, 0, 0, -2, 0, -3, -3] })).toEqual([
			{ start: '2021-10-02', end: '2021-10-03' },
			{ start: '2021-10-06', end: '2021-10-06' },
			{ start: '2021-10-08', end: '2021-10-09' }
		]);
	});

	it('ends a run at a gap, and is empty when the reserve was always met', () => {
		expect(belowReserve({ startDate: '2021-12-31', values: [-1, null, -1, Number.NaN] })).toEqual([
			{ start: '2021-12-31', end: '2021-12-31' },
			{ start: '2022-01-02', end: '2022-01-02' }
		]);
		expect(belowReserve({ startDate: '2021-10-01', values: [0, 0, 1] })).toEqual([]);
		expect(belowReserve({ startDate: '2021-10-01', values: [] })).toEqual([]);
	});
});

describe('flowHeading and hasRuleLine (issue #177: name the reserve only when the chart draws it)', () => {
	it('draws the rule line only when the run stored the outlet’s rule requirement', () => {
		expect(hasRuleLine([{ key: 'simulated_outflow', nodeId: null }, { key: 'ewr_rule', nodeId: null }])).toBe(true);
		expect(hasRuleLine([{ key: 'simulated_outflow', nodeId: null }, { key: 'ewr_rule', nodeId: 'n1' }])).toBe(false);
		expect(hasRuleLine([])).toBe(false);
	});

	it('is "Flow vs reserve" without a rule table (the pragmatic EWR is the reserve) and with the outlet’s table (its line is drawn)', () => {
		expect(flowHeading(false, false)).toBe('Flow vs reserve');
		expect(flowHeading(true, true)).toBe('Flow vs reserve');
	});

	it('is "Flow vs pragmatic EWR" when the rule tables are at other sites, so the chart draws only the pragmatic EWR', () => {
		expect(flowHeading(true, false)).toBe('Flow vs pragmatic EWR');
		// Engine ≥ 1.77.0: the line drawn is the daily EWR from a DRM table when the run used one.
		expect(flowHeading(true, false, { method: 'tab' })).toBe('Flow vs daily EWR');
		expect(flowHeading(true, false, { method: 'pragmatic' })).toBe('Flow vs pragmatic EWR');
		expect(flowHeading(false, false, { method: 'tab' })).toBe('Flow vs reserve');
	});
});
