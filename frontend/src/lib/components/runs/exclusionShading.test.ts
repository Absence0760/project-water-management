import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clipExclusions, exclusionKeyText, runExclusions, seriesSpan } from './exclusionShading';

// Rule 7: dates, so under a skewed TZ (UTC+14 would move a local-midnight date a day).
let tz: string | undefined;
beforeAll(() => {
	tz = process.env.TZ;
	process.env.TZ = 'Pacific/Kiritimati';
});
afterAll(() => {
	process.env.TZ = tz;
});

describe('runExclusions', () => {
	it('takes the run’s settings snapshot: water years and ranges, valid ones only, oldest first', () => {
		const got = runExclusions(
			{
				calibrationExclusions: [
					{ start: '2018-01-01', end: '2018-03-31', reason: 'gauge outage' },
					{ waterYear: 2015, reason: 'suspect rain' },
					{ waterYear: 2016, reason: '' }, // no reason: the engine ignores it, so it isn't shaded
					{ start: '2019-05-01', end: '2019-04-01', reason: 'reversed' }
				]
			},
			[{ start: '1990-01-01', end: '1990-12-31', reason: 'not this one' }]
		);
		expect(got).toEqual([
			{ start: '2015-10-01', end: '2016-09-30', label: 'WY 2015/16', reason: 'suspect rain', clipped: false },
			{ start: '2018-01-01', end: '2018-03-31', label: '2018-01-01 – 2018-03-31', reason: 'gauge outage', clipped: false }
		]);
	});

	it('an empty snapshot list means none, even if statistics recorded some', () => {
		expect(runExclusions({ calibrationExclusions: [] }, [{ start: '2015-10-01', end: '2016-09-30', reason: 'x' }])).toEqual([]);
	});

	it('falls back to what the run’s statistics applied when the detail has no settings, labelling a whole water year as one', () => {
		const got = runExclusions(undefined, [
			{ start: '2015-10-01', end: '2016-09-30', reason: 'suspect rain' },
			{ start: '2012-02-01', end: '2012-02-29', reason: 'outage' }
		]);
		expect(got.map((x) => x.label)).toEqual(['2012-02-01 – 2012-02-29', 'WY 2015/16']);
		expect(runExclusions(null, null)).toEqual([]);
		expect(runExclusions({}, undefined)).toEqual([]);
	});
});

describe('seriesSpan', () => {
	it('spans the earliest first day to the latest last day, ignoring empty series', () => {
		expect(
			seriesSpan([
				{ startDate: '2015-01-01', values: [1, 2, 3] },
				{ startDate: '2014-12-30', values: [1] },
				{ startDate: '2010-01-01', values: [] }
			])
		).toEqual({ start: '2014-12-30', end: '2015-01-03' });
		expect(seriesSpan([])).toBeNull();
	});
});

describe('clipExclusions', () => {
	const list = runExclusions({
		calibrationExclusions: [
			{ waterYear: 2009, reason: 'before the run' },
			{ waterYear: 2010, reason: 'straddles the start' },
			{ start: '2012-03-01', end: '2012-03-31', reason: 'inside' },
			{ start: '2014-09-01', end: '2015-02-01', reason: 'straddles the end' },
			{ waterYear: 2016, reason: 'after the run' }
		]
	});
	const span = { start: '2011-01-01', end: '2014-12-31' };

	it('keeps the periods that overlap the chart, clipped to it, and says which were cut', () => {
		expect(clipExclusions(list, span)).toEqual([
			{ start: '2011-01-01', end: '2011-09-30', label: 'WY 2010/11', reason: 'straddles the start', clipped: true },
			{ start: '2012-03-01', end: '2012-03-31', label: '2012-03-01 – 2012-03-31', reason: 'inside', clipped: false },
			{ start: '2014-09-01', end: '2014-12-31', label: '2014-09-01 – 2015-02-01', reason: 'straddles the end', clipped: true }
		]);
	});

	it('keeps a period that touches the chart by one day, and none without a span', () => {
		const edge = runExclusions({ calibrationExclusions: [{ start: '2010-06-01', end: '2011-01-01', reason: 'one day in' }] });
		expect(clipExclusions(edge, span)).toEqual([{ start: '2011-01-01', end: '2011-01-01', label: '2010-06-01 – 2011-01-01', reason: 'one day in', clipped: true }]);
		expect(clipExclusions(list, null)).toEqual([]);
	});

	it('writes each key line with its reason, and marks a clipped one', () => {
		const [a, b] = clipExclusions(list, span);
		expect(exclusionKeyText(a!)).toBe('WY 2010/11: straddles the start (partly outside the run)');
		expect(exclusionKeyText(b!)).toBe('2012-03-01 – 2012-03-31: inside');
	});
});
