import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultQualityFlags, FLOW_FLAG_CODE as C } from '@water-management/engine';
import { flagUseText, flowFlagLanes, LANE_FLAGS } from './flowFlags';

// Rule 7: dates, so under a skewed TZ (UTC+14 would move a local-midnight date a day).
let tz: string | undefined;
beforeAll(() => {
	tz = process.env.TZ;
	process.env.TZ = 'Pacific/Kiritimati';
});
afterAll(() => {
	process.env.TZ = tz;
});

describe('flowFlagLanes', () => {
	const codes = [C.inRange, C.aboveRating, C.aboveRating, C.missing, C.suspect, C.inRange, C.aboveRating, C.infilled, C.infilled, C.belowRating];

	it('one strip per flagged class, top strip first, its runs of days as date ranges; in range and missing are not drawn', () => {
		const lanes = flowFlagLanes(codes, '2020-12-30');
		expect(lanes.map((l) => l.flag)).toEqual(['aboveRating', 'belowRating', 'suspect', 'infilled']);
		expect(lanes[0]!.ranges).toEqual([
			{ start: '2020-12-31', end: '2021-01-01' },
			{ start: '2021-01-05', end: '2021-01-05' }
		]);
		expect(lanes[0]!.days).toBe(3);
		expect(lanes[3]!.ranges).toEqual([{ start: '2021-01-06', end: '2021-01-07' }]);
		// Each strip has its own colour token.
		expect(new Set(lanes.map((l) => l.color)).size).toBe(lanes.length);
	});

	it('the key names each class, its days and what Fit automatically does with them under the run’s settings', () => {
		const lanes = flowFlagLanes(codes, '2020-12-30', { ...defaultQualityFlags(), infilled: 'include' });
		expect(lanes.map((l) => l.text)).toEqual([
			'Above the highest gauging: 3 days; Fit automatically: censored at the highest gauging',
			'Below the lowest gauging: 1 day; Fit automatically: left out',
			'Suspect (outlier, flat stretch or doubtful zero flow): 1 day; Fit automatically: left out',
			'Infilled: 2 days; Fit automatically: scored as recorded'
		]);
		// Without settings (a run cached before it carried them) the key gives the days only.
		expect(flowFlagLanes(codes, '2020-12-30')[1]!.text).toBe('Below the lowest gauging: 1 day');
	});

	it('nothing flagged: no strip', () => {
		expect(flowFlagLanes([C.inRange, C.missing, C.inRange], '2021-01-01')).toEqual([]);
		expect(flowFlagLanes([], '2021-01-01')).toEqual([]);
	});

	it('names every treatment', () => {
		const d = defaultQualityFlags();
		expect(flagUseText('aboveRating', { ...d, aboveRating: 'exclude' })).toBe('Fit automatically: left out');
		expect(flagUseText('aboveRating', { ...d, aboveRating: 'include' })).toBe('Fit automatically: scored as recorded');
		expect(flagUseText('suspect', { ...d, suspect: 'include' })).toBe('Fit automatically: scored as recorded');
		expect(flagUseText('humanUse', d)).toBe('Fit automatically: scored as recorded');
		expect(flagUseText('suspect', null)).toBe('');
		expect(LANE_FLAGS).not.toContain('inRange');
		expect(LANE_FLAGS).not.toContain('missing');
	});
});
