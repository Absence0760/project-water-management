// feedRecordSwap (296_feed_area_replace): what an area replacement writes into
// the series. The DB side (the stage, the swap's transaction, the revision)
// is feeds/areaReplace.db.test.ts.
import { toEpochDay } from '@water-management/engine/calendar';
import { describe, expect, it } from 'vitest';
import type { DayRuns } from './merge.js';
import { feedRecordSwap } from './replace.js';

const d = (iso: string) => toEpochDay(iso);
const runs = (...pairs: [string, string][]): DayRuns => pairs.map(([a, b]) => [d(a), d(b)]);
const none = { agera5: [], power: [] };

describe('feedRecordSwap', () => {
	it('takes the stage on the feed’s own days and on empty ones, and keeps a person’s value and a hand edit', () => {
		// 1–6 Jan: the feed wrote 1, 2, 4, 5; a person wrote 3; 6 was edited by hand (cleared).
		const existing = { startDate: '2020-01-01', values: [1, 2, 30, 4, 5, null] };
		const owned = runs(['2020-01-01', '2020-01-03'], ['2020-01-04', '2020-01-06']);
		const hand = runs(['2020-01-06', '2020-01-07']);
		const stage = { startDate: '2020-01-01', values: [11, 12, 13, 14, null, 16, 17] };
		const r = feedRecordSwap(existing, owned, hand, stage, none);
		// 5 Jan: the feed's old-area day the stage has no value for is cleared, never left as the old area's.
		expect(r.daily).toEqual({ startDate: '2020-01-01', values: [11, 12, 30, 14, null, null, 17] });
		expect(r.feedDays).toEqual(runs(['2020-01-01', '2020-01-03'], ['2020-01-04', '2020-01-06'], ['2020-01-07', '2020-01-08']));
	});

	it('keeps a person’s days outside the stage, and the span both cover', () => {
		const existing = { startDate: '2019-12-30', values: [7, null, 1] };
		const r = feedRecordSwap(existing, runs(['2020-01-01', '2020-01-02']), [], { startDate: '2020-01-01', values: [5, 6] }, none);
		expect(r.daily).toEqual({ startDate: '2019-12-30', values: [7, null, 5, 6] });
		expect(r.feedDays).toEqual(runs(['2020-01-01', '2020-01-03']));
	});

	it('another feed’s mark is not this feed’s: its days are kept as a person’s (owned empty)', () => {
		const r = feedRecordSwap({ startDate: '2020-01-01', values: [1, null] }, [], [], { startDate: '2020-01-01', values: [9, 9] }, none);
		expect(r.daily.values).toEqual([1, 9]);
		expect(r.feedDays).toEqual(runs(['2020-01-02', '2020-01-03']));
	});

	it('a new series is the stage, all the feed’s', () => {
		const r = feedRecordSwap(null, [], [], { startDate: '2020-01-01', values: [1, 2] }, none);
		expect(r).toEqual({ daily: { startDate: '2020-01-01', values: [1, 2] }, feedDays: runs(['2020-01-01', '2020-01-03']), products: none });
	});

	it('keeps the stage’s product of each feed day (292), never on a kept day', () => {
		const stageProducts = { agera5: runs(['2020-01-01', '2020-01-03']), power: runs(['2020-01-03', '2020-01-05']) };
		const existing = { startDate: '2020-01-01', values: [1, 2, 3, 4] };
		const r = feedRecordSwap(existing, runs(['2020-01-01', '2020-01-04']), [], { startDate: '2020-01-01', values: [5, 6, 7, 8] }, stageProducts);
		// 4 Jan was a person's: theirs, and no product's.
		expect(r.daily.values).toEqual([5, 6, 7, 4]);
		expect(r.products).toEqual({ agera5: runs(['2020-01-01', '2020-01-03']), power: runs(['2020-01-03', '2020-01-04']) });
	});
});
