import { describe, expect, it } from 'vitest';
import { DEFAULT_FLOW_GAP_SPEC, defaultFlowGapFill } from '@water-management/engine';
import { flowFillShading } from './flowFill';

const rec = (values: (number | null)[]) => ({ startDate: '2020-01-01', values });

describe('flowFillShading', () => {
	it('is null while the record is not filled', () => {
		expect(flowFillShading('flow_observed_m3s', rec([1, null, 1]), null, null)).toBeNull();
		expect(flowFillShading('flow_observed_m3s', rec([1, null, 1]), defaultFlowGapFill(), null)).toBeNull();
	});

	it('shades each run of filled days, draws only their values, and says what filled them', () => {
		const fill = { ...defaultFlowGapFill(), flow_observed_m3s: { ...DEFAULT_FLOW_GAP_SPEC, interpolateMaxDays: 2 } };
		const s = flowFillShading('flow_observed_m3s', rec([4, null, 1, 1, null, null, null, 1]), fill, null)!;
		expect(s.ranges).toEqual([{ start: '2020-01-02', end: '2020-01-02' }]);
		expect(s.filled.values.map((v) => (Number.isNaN(v) ? null : v))).toEqual([null, 2, null, null, null, null, null, null]);
		expect(s.caption).toBe('Shaded: 1 day interpolated across gaps of up to 2 days, in a run only (Settings → Flow gaps); the stored record is unchanged. 1 gap (3 days) stay open.');
	});

	it('names a refused donor', () => {
		const fill = { ...defaultFlowGapFill(), flow_observed_m3s: { ...DEFAULT_FLOW_GAP_SPEC, interpolateMaxDays: 0, donor: 'flow_logger_m3s' as const } };
		const s = flowFillShading('flow_observed_m3s', rec([1, null, 1]), fill, rec([1, 1, 1]))!;
		expect(s.ranges).toEqual([]);
		expect(s.caption).toMatch(/^No gap is filled \(Settings → Flow gaps\)\. Nothing from the logger flow: the two records share 2 days/);
	});
});
