import { describe, expect, it } from 'vitest';
import type { FeedSource } from './config.js';
import { finalThroughAfter, latestDay } from './ingest.js';
import type { FeedRow } from './store.js';

describe('latestDay (the newest day an answer may hold; feeds.db.test.ts covers the refusal)', () => {
	it('is today for the observed sources and the 16th forecast day for CHIRPS-GEFS, across month and year ends', () => {
		expect(latestDay('chirps', '2026-09-25')).toBe('2026-09-25');
		expect(latestDay('dws', '2026-09-25')).toBe('2026-09-25');
		expect(latestDay('chirps_gefs', '2026-09-25')).toBe('2026-10-10');
		expect(latestDay('chirps_gefs', '2026-12-20')).toBe('2027-01-04');
		expect(latestDay('chirps_gefs', '2028-02-20')).toBe('2028-03-06');
	});
});

// Issue #69: the fetcher's finalThrough is a claim from an untrusted answer;
// feeds.db.test.ts covers it end to end.
describe('finalThroughAfter (the CHIRPS final marker the ingest keeps)', () => {
	const window = { start: '2026-01-10', end: '2026-01-20' };
	const feed = (finalThrough: string | null = null, source: FeedSource = 'chirps') => ({ source, finalThrough }) as FeedRow;
	const answer = (finalThrough: unknown, values: (number | null)[] = [1, 2, 3, null, 5], startDate: string | null = window.start) =>
		({ ok: true, startDate, values, meta: finalThrough === undefined ? {} : { finalThrough } }) as Parameters<typeof finalThroughAfter>[1];

	it('takes a claim on a day of the answer with a value on every day up to it (positive control)', () => {
		expect(finalThroughAfter(feed(), answer('2026-01-10'), window)).toBe('2026-01-10');
		expect(finalThroughAfter(feed(), answer('2026-01-12'), window)).toBe('2026-01-12');
	});

	it('ignores a claim that isn’t a real day of this answer from the window’s start, or runs over a gap', () => {
		for (const bad of ['2026-01-09', '2026-01-13', '2026-01-15', '2026-01-25', '2026-02-30', '2026-1-11', 'soon', 20260111]) {
			expect(finalThroughAfter(feed(), answer(bad), window), String(bad)).toBeNull();
		}
		// An answer that starts after the window's first day says nothing about that day.
		expect(finalThroughAfter(feed(), answer('2026-01-12', [1, 2], '2026-01-11'), window)).toBeNull();
		expect(finalThroughAfter(feed(), answer('2026-01-10', [], null), window)).toBeNull();
	});

	it('carries the previous marker when it reaches the day before the window: the later of the two', () => {
		expect(finalThroughAfter(feed('2026-01-09'), answer(undefined), window)).toBe('2026-01-09');
		expect(finalThroughAfter(feed('2026-01-09'), answer('2026-01-12'), window)).toBe('2026-01-12');
		expect(finalThroughAfter(feed('2026-01-09'), answer('2026-01-30'), window)).toBe('2026-01-09');
		expect(finalThroughAfter(feed('2026-01-15'), answer('2026-01-12'), window)).toBe('2026-01-15');
		// Short of the window: the days between are unknown, so only the claim counts.
		expect(finalThroughAfter(feed('2026-01-08'), answer(undefined), window)).toBeNull();
		expect(finalThroughAfter(feed('2026-01-08'), answer('2026-01-11'), window)).toBe('2026-01-11');
	});

	it('is CHIRPS only', () => {
		expect(finalThroughAfter(feed(null, 'dws'), answer('2026-01-12'), window)).toBeNull();
		expect(finalThroughAfter(feed('2026-01-09', 'chirps_gefs'), answer('2026-01-12'), window)).toBeNull();
	});
});
