import { describe, expect, it } from 'vitest';
import { RECESSION_DEFAULTS, recessionSegments } from './segments';
import { exponential, syntheticRecord } from './testSeries';

const k = exponential(0.05);

describe('recessionSegments (TOSSH util_RecessionSegments + CR-13 rain rule)', () => {
	it('ports TOSSH defaults: length 5, n_start 1, eps 0, ETS; CR-13 rain threshold 1 mm', () => {
		expect(RECESSION_DEFAULTS).toEqual({ recessionLength: 5, nStart: 1, epsM3s: 0, rainThresholdMm: 1, dQdtMethod: 'ETS' });
	});

	it('finds a rain-free recession: from two days after the storm (the day after is wet-yesterday, then n_start) to its last day', () => {
		const r = syntheticRecord([{ peakM3s: 10, dryDays: 10 }], k);
		const w = r.stormDays[0]!;
		// Step w → w+1 fails (rain on w), so the run's peak is w+1; n_start drops it.
		expect(recessionSegments(r)).toEqual([[w + 2, w + 10]]);
	});

	it('discards short runs: a run needs recession_length + n_start falling steps', () => {
		const six = syntheticRecord([{ peakM3s: 10, dryDays: 6 }, { peakM3s: 10, dryDays: 7 }], k);
		// 6 dry days: peak w+1, 5 steps < 6 → none. 7 dry days: 6 steps → a 6-day segment.
		const w = six.stormDays[1]!;
		expect(recessionSegments(six)).toEqual([[w + 2, w + 7]]);
		expect(recessionSegments(six, { recessionLength: 4 })).toEqual([
			[six.stormDays[0]! + 2, six.stormDays[0]! + 6],
			[w + 2, w + 7]
		]);
	});

	it('rain above the threshold breaks a segment, on the day and the day after', () => {
		const r = syntheticRecord([{ peakM3s: 10, dryDays: 20 }], k);
		const w = r.stormDays[0]!;
		r.rainMm[w + 10] = 5; // the flow keeps falling, but the day is wet
		expect(recessionSegments(r)).toEqual([
			[w + 2, w + 9],
			[w + 12, w + 20]
		]);
		// At the threshold still counts as dry.
		r.rainMm[w + 10] = 1;
		expect(recessionSegments(r)).toEqual([[w + 2, w + 20]]);
		expect(recessionSegments(r, { rainThresholdMm: 0.5 })).toHaveLength(2);
	});

	it('a missing rain day breaks a segment like a wet one', () => {
		const r = syntheticRecord([{ peakM3s: 10, dryDays: 20 }], k);
		const w = r.stormDays[0]!;
		r.rainMm[w + 10] = null;
		expect(recessionSegments(r)).toEqual([
			[w + 2, w + 9],
			[w + 12, w + 20]
		]);
	});

	it('a gap in the flow breaks a segment; so does a zero flow (TOSSH sets zeros to NaN) and an excluded day', () => {
		const r = syntheticRecord([{ peakM3s: 10, dryDays: 20 }], k);
		const w = r.stormDays[0]!;
		const split = [
			[w + 2, w + 9],
			[w + 12, w + 20]
		];
		for (const bad of [null, NaN, 0, -1]) {
			const flow = [...r.flowM3s];
			flow[w + 10] = bad;
			// Days w+9 → w+10 and w+10 → w+11 can't be steps; the second run's peak is w+11.
			expect(recessionSegments({ flowM3s: flow, rainMm: r.rainMm })).toEqual(split);
		}
		const excluded = new Uint8Array(r.flowM3s.length);
		excluded[w + 10] = 1;
		expect(recessionSegments({ ...r, excluded })).toEqual(split);
	});

	it('a rise ends a segment; eps allows a small one', () => {
		const r = syntheticRecord([{ peakM3s: 10, dryDays: 20 }], k);
		const w = r.stormDays[0]!;
		r.flowM3s[w + 10] = r.flowM3s[w + 9]! + 0.01;
		expect(recessionSegments(r)).toEqual([
			[w + 2, w + 9],
			[w + 11, w + 20]
		]);
		expect(recessionSegments(r, { epsM3s: 0.02 })).toEqual([[w + 2, w + 20]]);
		// Flat flow is not falling (strict with eps 0).
		r.flowM3s[w + 10] = r.flowM3s[w + 9]!;
		expect(recessionSegments(r)).toHaveLength(2);
	});

	it('keeps a run cut off by the end of the record; n_start 0 keeps the peak', () => {
		const r = syntheticRecord([{ peakM3s: 10, dryDays: 8 }], k);
		const w = r.stormDays[0]!;
		expect(recessionSegments(r)).toEqual([[w + 2, w + 8]]);
		expect(recessionSegments(r, { nStart: 0 })).toEqual([[w + 1, w + 8]]);
	});

	it('finds every storm’s recession in order', () => {
		const r = syntheticRecord(
			[5, 8, 3].map((p) => ({ peakM3s: p, dryDays: 12 })),
			k
		);
		expect(recessionSegments(r)).toEqual(r.stormDays.map((w) => [w + 2, w + 12]));
	});
});
