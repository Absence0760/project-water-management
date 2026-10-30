// The rule editor's request body (PUT /projects/:id/alert-rules, routes.ts
// RulesBody): which rule names a farm, a feed or a series is checked here, as a
// 400, before the table's checks would answer it as a 409.
import { describe, expect, it } from 'vitest';
import { RulesBody } from './routes.js';

const FEED = '00000000-0000-4000-8000-000000000001';
const SERIES = '00000000-0000-4000-8000-000000000002';
const FARM = '00000000-0000-4000-8000-000000000003';
const ok = (rule: Record<string, unknown>) => RulesBody.safeParse({ rules: [{ threshold: 1, enabled: true, ...rule }] }).success;

describe('RulesBody: what a rule names', () => {
	it('a data_stale rule names its feed or its series, exactly one', () => {
		expect(ok({ kind: 'data_stale', feedId: FEED })).toBe(true);
		expect(ok({ kind: 'data_stale', seriesId: SERIES })).toBe(true);
		expect(ok({ kind: 'data_stale' })).toBe(false);
		expect(ok({ kind: 'data_stale', feedId: FEED, seriesId: SERIES })).toBe(false);
	});

	it('no other kind names a feed or a series, not even both at once (positive control: neither)', () => {
		for (const kind of ['job_dead', 'feed_failing', 'ewr_forecast_fail', 'farms_short']) {
			expect(ok({ kind })).toBe(true);
			expect(ok({ kind, feedId: FEED })).toBe(false);
			expect(ok({ kind, seriesId: SERIES })).toBe(false);
			expect(ok({ kind, feedId: FEED, seriesId: SERIES })).toBe(false);
		}
		expect(ok({ kind: 'dam_below', nodeId: FARM, threshold: 0.3 })).toBe(true);
		expect(ok({ kind: 'dam_below', nodeId: FARM, threshold: 0.3, feedId: FEED, seriesId: SERIES })).toBe(false);
	});
});
