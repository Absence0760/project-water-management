// Wall-clock budgets for the self-intersection sweep (round-4 hardening),
// split out of geojson.test.ts. The unit tests there prove the sweep is
// bounded by a count (GEO_MAX_PAIR_CHECKS: the sawtooth is refused as too
// complex); these say the bound is low enough to answer fast. A hard ceiling
// in the unit project failed under coverage on a loaded CI runner (80 ms
// alone, 1.36 s there), so it lives in the `perf` project: out of `pnpm test`,
// run alone with `pnpm test:backend:perf`, median of several runs.
import { describe, expect, it } from 'vitest';
import { circle, sawtooth } from '../__tests__/shapes.js';
import { checkGeometry, GEO_MAX_VERTICES } from './geojson.js';

/** Median wall clock of `runs` calls of `f`, after one warm-up. */
function medianMs(f: () => unknown, runs = 7): number {
	f();
	const ms = Array.from({ length: runs }, () => {
		const t = performance.now();
		f();
		return performance.now() - t;
	}).sort((a, b) => a - b);
	return ms[Math.floor(runs / 2)]!;
}

describe('the self-intersection sweep answers fast', () => {
	it('refuses a 50 000-vertex sawtooth in well under a second; it used to take ~9 s', () => {
		const ring = sawtooth(GEO_MAX_VERTICES - 10);
		expect(medianMs(() => checkGeometry({ type: 'Polygon', coordinates: [ring] }))).toBeLessThan(1_000);
	});

	it('takes a 50 000-vertex circle in under 2 s', () => {
		const ring = circle(GEO_MAX_VERTICES - 1);
		expect(medianMs(() => checkGeometry({ type: 'Polygon', coordinates: [ring] }))).toBeLessThan(2_000);
	});
});
