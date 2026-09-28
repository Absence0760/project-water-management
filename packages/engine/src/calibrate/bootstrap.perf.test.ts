// Wall-clock budget of the score intervals and benchmarks (CR-5): every
// scored period of a fit report gets them (up to nine periods), so on a
// realistic 10-year daily record they must stay well under 200 ms each.
// `perf` project (median of 7 after a warm-up; run alone, `pnpm test:engine:perf`).
import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearOf } from '../calendar';
import { Rng } from '../random';
import { bootstrapIntervals, scoreBenchmarks } from './bootstrap';

function medianMs(n: number, run: () => void): number {
	run();
	const ms = Array.from({ length: n }, () => {
		const t0 = performance.now();
		run();
		return performance.now() - t0;
	}).sort((a, b) => a - b);
	return ms[Math.floor(n / 2)]!;
}

describe('score intervals and benchmarks (10 years of daily flows)', () => {
	const rng = new Rng(7);
	const n = 3653;
	const d0 = toEpochDay('2010-10-01');
	const days = Int32Array.from({ length: n }, (_, i) => d0 + i);
	const groups = Int32Array.from(days, waterYearOf);
	let q = 1;
	const o = Float64Array.from({ length: n }, () => (q = rng.bool(0.07) ? q + rng.float(1, 30) : q * rng.float(0.88, 0.99)));
	const s = Float64Array.from(o, (v) => v * rng.float(0.6, 1.4));

	it('1 000 block-bootstrap resamples and both benchmarks well under 200 ms (median of 7)', () => {
		const ms = medianMs(7, () => {
			bootstrapIntervals(o, s, groups);
			scoreBenchmarks(o, days, groups);
		});
		expect(ms).toBeLessThan(200);
	});
});
