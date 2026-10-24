import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultQualityFlags, FLOW_FLAG_CODE as C } from '@water-management/engine';
import { flagUseText, flowFlagLanes, LANE_FLAGS, lanesLooksNote } from './flowFlags';

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
		// Suspect and infilled are double lines, the gauged-range strips solid (flowFlagColours.test.ts says why).
		expect(lanes.map((l) => l.doubled)).toEqual([false, false, true, true]);
		// Each strip has its own colour token.
		expect(new Set(lanes.map((l) => l.color)).size).toBe(lanes.length);
	});

	it('the key names each class, its days and what Fit automatically does with them under the run’s settings', () => {
		const lanes = flowFlagLanes(codes, '2020-12-30', { ...defaultQualityFlags(), infilled: 'include' });
		expect(lanes.map((l) => l.text)).toEqual([
			'Above the highest gauging: 3 days; Fit automatically: censored at the highest gauging',
			'Below the lowest gauging: 1 day; Fit automatically: left out',
			'Suspect (outlier, flat stretch or doubtful zero flow), double line: 1 day; Fit automatically: left out',
			'Infilled, double line: 2 days; Fit automatically: scored as recorded'
		]);
		// Without settings (a run cached before it carried them) the key gives the days only.
		expect(flowFlagLanes(codes, '2020-12-30')[1]!.text).toBe('Below the lowest gauging: 1 day');
	});

	it('the key says what the two looks mean while a strip is a double line, and nothing while every strip is solid', () => {
		expect(lanesLooksNote(flowFlagLanes(codes, '2020-12-30'))).toBe('solid: outside the flow the record can be trusted at; double line: a doubtful reading, or not the river’s own flow');
		expect(lanesLooksNote(flowFlagLanes([C.aboveRating, C.belowRating], '2021-01-01'))).toBe('');
		expect(lanesLooksNote([])).toBe('');
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

describe('the low-flow period strip (issue #557)', () => {
	it('draws period-high days in their own strip under the above-range one, and says they are always left out', () => {
		const codes = [C.aboveRating, C.periodHigh, C.periodHigh, C.inRange, C.belowRating];
		const lanes = flowFlagLanes(codes, '2021-01-01', { ...defaultQualityFlags(), suspect: 'include' });
		expect(lanes.map((l) => l.flag)).toEqual(['aboveRating', 'periodHigh', 'belowRating']);
		expect(LANE_FLAGS.indexOf('periodHigh')).toBe(LANE_FLAGS.indexOf('aboveRating') + 1);
		expect(lanes[1]!.ranges).toEqual([{ start: '2021-01-02', end: '2021-01-03' }]);
		expect(lanes[1]!.text).toBe('Above a low-flow period’s threshold: 2 days; left out of Fit automatically and the run’s statistics');
		expect(new Set(lanes.map((l) => l.color)).size).toBe(lanes.length);
		// Solid, as the gauged-range strips beside it: a reading outside the flow it can be trusted at (flowFlagColours.test.ts).
		expect(lanes.map((l) => l.doubled)).toEqual([false, false, false]);
		for (const use of [defaultQualityFlags(), { ...defaultQualityFlags(), aboveRating: 'include' as const, belowRating: 'include' as const, suspect: 'include' as const, infilled: 'include' as const }])
			expect(flagUseText('periodHigh', use)).toBe('left out of Fit automatically and the run’s statistics');
	});
});
