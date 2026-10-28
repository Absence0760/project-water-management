// Wall-clock budget for the forecast-conditioned outlook (issue #620 step 6,
// docs/model.md §2.15d) on the invented catchment (28 water years,
// ./testCatchment.ts), in the `perf` project (vitest.config.ts: serial, not in
// `pnpm test` or CI; run alone with `pnpm test:engine:perf`). Every member
// runs only the season from the base run's one snapshot; the cost is the ESP
// members (one per analogue year), the forecast members, and the skill score's
// hindcast members (years × members), each a run of the season.
//
// Measured 2026-10-28 (Fedora workstation, Node 24, median of 5): 3 systems ×
// 10 members, 24 hindcast years: the outlook alone (27 ESP + 30 forecast
// members) 118 ms, with the skill score (+ 720 hindcast members) 1 163 ms.
// The budgets leave about 3× for a slower machine.
import { describe, expect, it } from 'vitest';
import { runModelWithoutChecks } from '../run';
import { runForecastOutlook } from './forecast';
import { syntheticSystem } from './forecastFixture';
import { testCatchment } from './testCatchment';

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

const input = testCatchment({ start: '1985-10-01', end: '2013-09-30', seed: 3 });
const baseRun = runModelWithoutChecks(input);
const HINDCAST = Array.from({ length: 24 }, (_, i) => 1988 + i);
const systems = (['skilful', 'climatology', 'mirror'] as const).map((kind, i) => syntheticSystem(baseRun, { id: `${kind}-${i}`, kind, members: 10, initMonth: 10, leads: 7, hindcastYears: HINDCAST, forecastYear: 2012, seed: i }));
const opts = { decisionDate: '2012-10-01', seasonEnd: '2013-04-30', baseRun, forecasts: systems.map((x) => x.forecast), hindcasts: systems.map((x) => x.hindcast) };

describe('forecast-conditioned outlook: the invented catchment', () => {
	it('3 systems × 10 members, capture included: under 400 ms without the skill score (median of 5)', () => {
		expect(runForecastOutlook(input, { ...opts, skill: false }).members).toHaveLength(30);
		expect(medianMs(5, () => runForecastOutlook(input, { ...opts, skill: false }))).toBeLessThan(400);
	});

	it('with the skill score over 24 hindcast years: under 3 000 ms (median of 5)', () => {
		expect(runForecastOutlook(input, opts).skill!.nYears).toBe(24);
		expect(medianMs(5, () => runForecastOutlook(input, opts))).toBeLessThan(3000);
	});
});
