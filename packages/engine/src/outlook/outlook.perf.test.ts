// Wall-clock budgets for the seasonal outlook and the review triggers on the
// invented catchment (13 water years, ./testCatchment.ts), in the `perf`
// project (vitest.workspace.ts: serial, not in `pnpm test` or CI; run alone
// with `pnpm test:engine:perf`). Since engine 1.1.0 each member runs only
// the season from one snapshot of the history (docs/model.md §2.16); the
// budgets are set to that path and the speed-up over the re-run path
// (`warmStart: false`) is asserted too, as a ratio, which a loaded machine
// moves less than a millisecond ceiling.
//
// Measured 2026-09-26 (M3 Pro, Node 24, median): outlook 12 years × 4
// levels 35 ms (re-run path 388 ms, 11×); triggers 3 bands × 12 × 4 53 ms
// (re-run path 1 149 ms, 22×).
import { describe, expect, it } from 'vitest';
import { runModelWithoutChecks } from '../run';
import { runSeasonalOutlook } from './outlook';
import { testCatchment } from './testCatchment';
import { runReviewTriggers } from './triggers';

/** Median of `n` timed runs after one untimed warm-up. */
function medianMs(n: number, run: () => void): number {
	run();
	const ms = Array.from({ length: n }, () => {
		const t0 = performance.now();
		run();
		return performance.now() - t0;
	}).sort((a, b) => a - b);
	return ms[Math.floor(n / 2)]!;
}

const input = testCatchment({ dailyApan: true });
const baseRun = runModelWithoutChecks(input);
const levels = [1, 0.85, 0.7, 0.55].map((f) => ({ id: `f${f}`, label: `${Math.round(f * 100)} %`, ops: [{ op: 'demand.scale' as const, factor: f }] }));

describe('seasonal outlook and review triggers from a snapshot: the invented catchment', () => {
	it('outlook, 12 analogue years × 4 levels, capture included: under 150 ms, and at least 5× the re-run path (median of 7)', () => {
		const opts = { decisionDate: '2012-10-01', seasonEnd: '2013-04-30', levels, baseRun };
		expect(runSeasonalOutlook(input, opts).nYears).toBe(12);
		const warm = medianMs(7, () => runSeasonalOutlook(input, opts));
		const cold = medianMs(3, () => runSeasonalOutlook(input, { ...opts, warmStart: false }));
		expect(warm).toBeLessThan(150);
		expect(cold / warm).toBeGreaterThan(5);
	});

	it('triggers, 3 bands × 12 years × 4 levels, capture included: under 250 ms, and at least 8× the re-run path (median of 7)', () => {
		const opts = { reviewDate: '2013-01-01', seasonEnd: '2013-04-30', levels, baseRun };
		expect(runReviewTriggers(input, opts).rows).toHaveLength(3);
		const warm = medianMs(7, () => runReviewTriggers(input, opts));
		const cold = medianMs(3, () => runReviewTriggers(input, { ...opts, warmStart: false }));
		expect(warm).toBeLessThan(250);
		expect(cold / warm).toBeGreaterThan(8);
	});
});
