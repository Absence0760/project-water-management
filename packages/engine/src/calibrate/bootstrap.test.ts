import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearOf } from '../calendar';
import { Rng } from '../random';
import {
	BOOTSTRAP_LEVEL,
	BOOTSTRAP_RESAMPLES,
	BOOTSTRAP_SEED,
	bootstrapIntervals,
	climatologyFlows,
	dayOfYearSlot,
	scoreBenchmarks
} from './bootstrap';
import { inverseFlows, kgeLowHigh, kgePrime, logEpsilon, nse } from './objective';

/** A synthetic seasonal daily record: `years` water years from 1 Oct 2000, observed and a noisy simulation. */
function record(years: number, seed = 1) {
	const rng = new Rng(seed);
	const d0 = toEpochDay('2000-10-01');
	const n = Math.round(years * 365.25);
	const days = Int32Array.from({ length: n }, (_, i) => d0 + i);
	const o = new Float64Array(n);
	const s = new Float64Array(n);
	let q = 1;
	for (let i = 0; i < n; i++) {
		const season = 1 + 0.8 * Math.sin((2 * Math.PI * i) / 365.25);
		q = rng.bool(0.06 * season) ? q + rng.float(1, 30) * season : q * rng.float(0.88, 0.99);
		o[i] = q;
		s[i] = q * rng.float(0.6, 1.4);
	}
	const groups = Int32Array.from(days, (d) => waterYearOf(d));
	return { days, o, s, groups };
}

describe('block-bootstrap intervals (CR-5)', () => {
	it('each resample is the scores of whole water years drawn with replacement (sums agree with scoring the resampled days)', () => {
		const { o, s, groups } = record(6);
		const years = [...new Set(groups)];
		const eps = logEpsilon(o);
		for (const seed of [1, 2, 99]) {
			// One resample: the interval collapses to its score.
			const got = bootstrapIntervals(o, s, groups, { resamples: 1, seed })!;
			const rng = new Rng(seed);
			const picks = years.map(() => years[rng.int(0, years.length - 1)]!);
			const oo: number[] = [];
			const ss: number[] = [];
			for (const y of picks) for (let i = 0; i < o.length; i++) if (groups[i] === y) (oo.push(o[i]!), ss.push(s[i]!));
			const k = kgePrime(oo, ss)!;
			// The low/high KGE′ keeps the period's ε, as its point score does.
			const lh = (k + kgePrime(inverseFlows(oo, eps), inverseFlows(ss, eps))!) / 2;
			expect(got.kgePrime!.lo).toBeCloseTo(k, 10);
			expect(got.kgePrime!.hi).toBeCloseTo(k, 10);
			expect(got.nse!.lo).toBeCloseTo(nse(oo, ss)!, 10);
			expect(got.kgeLowHigh!.lo).toBeCloseTo(lh, 10);
		}
	});

	it('is deterministic for a seed, records how it was made, and brackets the point score', () => {
		const { o, s, groups } = record(10);
		const a = bootstrapIntervals(o, s, groups)!;
		expect(bootstrapIntervals(o, s, groups)).toEqual(a);
		expect(a).toMatchObject({ level: BOOTSTRAP_LEVEL, resamples: BOOTSTRAP_RESAMPLES, seed: BOOTSTRAP_SEED, years: 11 });
		expect(bootstrapIntervals(o, s, groups, { seed: 5 })).not.toEqual(a);
		for (const [k, point] of [
			['kgePrime', kgePrime(o, s)!],
			['nse', nse(o, s)!],
			['kgeLowHigh', kgeLowHigh(o, s)!]
		] as const) {
			const iv = a[k]!;
			expect(iv.lo, k).toBeLessThan(iv.hi);
			expect(iv.lo, k).toBeLessThanOrEqual(point);
			expect(iv.hi, k).toBeGreaterThanOrEqual(point);
		}
	});

	it('a perfect simulation has a zero-width interval at 1', () => {
		const { o, groups } = record(5);
		const a = bootstrapIntervals(o, o, groups)!;
		for (const k of ['kgePrime', 'nse', 'kgeLowHigh'] as const) {
			expect(a[k]!.lo, k).toBeCloseTo(1, 10);
			expect(a[k]!.hi, k).toBeCloseTo(1, 10);
		}
	});

	it('narrows as the record lengthens (more years, less sampling error)', () => {
		const short = record(5, 3);
		const long = record(40, 3);
		const w = (r: ReturnType<typeof record>) => {
			const iv = bootstrapIntervals(r.o, r.s, r.groups)!.kgePrime!;
			return iv.hi - iv.lo;
		};
		expect(w(long)).toBeLessThan(w(short) * 0.7);
	});

	it('needs 3 water years of 30 scored days: fewer gives null, a short year does not count', () => {
		const { o, s, groups } = record(6);
		const take = (lastYear: number, extraDays = 0) => {
			const idx: number[] = [];
			for (let i = 0; i < o.length; i++) if (groups[i]! <= lastYear) idx.push(i);
			for (let i = 0, added = 0; i < o.length && added < extraDays; i++) if (groups[i] === lastYear + 1) (idx.push(i), added++);
			return [idx.map((i) => o[i]!), idx.map((i) => s[i]!), idx.map((i) => groups[i]!)] as const;
		};
		expect(bootstrapIntervals(...take(2001))).toBeNull(); // 2 years
		expect(bootstrapIntervals(...take(2001, 20))).toBeNull(); // + a 20-day year
		const three = bootstrapIntervals(...take(2001, 30))!; // + a 30-day year
		expect(three.years).toBe(3);
		expect(three.kgePrime).not.toBeNull();
		expect(bootstrapIntervals(...take(2002))).not.toBeNull();
	});
});

describe('benchmarks (CR-5)', () => {
	it('calendar slots: a leap-year calendar, so 29 Feb has its own slot and 1 Mar is 60 every year', () => {
		expect(dayOfYearSlot(toEpochDay('2001-01-01'))).toBe(0);
		expect(dayOfYearSlot(toEpochDay('2004-02-29'))).toBe(59);
		expect(dayOfYearSlot(toEpochDay('2003-03-01'))).toBe(60);
		expect(dayOfYearSlot(toEpochDay('2004-03-01'))).toBe(60);
		expect(dayOfYearSlot(toEpochDay('2003-12-31'))).toBe(365);
	});

	it('climatology: each day the mean of the period’s flows within ±w calendar days, wrapping round the new year', () => {
		const days = ['2001-12-31', '2002-01-01', '2002-01-05', '2002-06-01', '2003-12-31'].map(toEpochDay);
		const slots = days.map(dayOfYearSlot);
		const o = [2, 4, 10, 7, 6];
		expect(Array.from(climatologyFlows(o, slots, 0))).toEqual([4, 4, 10, 7, 4]);
		// ±1 day: 31 Dec and 1 Jan are neighbours.
		expect(Array.from(climatologyFlows(o, slots, 1))).toEqual([4, 4, 10, 7, 4]);
		expect(Array.from(climatologyFlows(o, slots, 5))).toEqual([5.5, 5.5, 5.5, 7, 5.5]);
	});

	it('the mean-flow benchmark scores KGE′ 1 − √2 and NSE 0; a purely seasonal record is matched by its climatology', () => {
		const { days, o, groups } = record(8);
		const b = scoreBenchmarks(o, days, groups);
		expect(b.meanFlow.kgePrime).toBeCloseTo(1 - Math.SQRT2, 10);
		expect(b.meanFlow.nse).toBeCloseTo(0, 10);
		expect(b.halfWindowDays).toBe(7);
		// Random storms: climatology beats the mean flow but is far from perfect.
		expect(b.climatology.nse!).toBeGreaterThan(0);
		expect(b.climatology.kgePrime!).toBeGreaterThan(b.meanFlow.kgePrime!);
		// The same seasonal cycle every year (Julian year, so it repeats by calendar day): climatology with no smoothing is exact.
		const seasonal = Float64Array.from(days, (d) => 5 + 4 * Math.sin((2 * Math.PI * dayOfYearSlot(d)) / 366));
		const exact = scoreBenchmarks(seasonal, days, groups, 0);
		expect(exact.climatology.kgePrime).toBeCloseTo(1, 10);
		expect(exact.climatology.nse).toBeCloseTo(1, 10);
	});
});

describe('benchmarks built from a calibration period (CR-5, engine 1.62.0)', () => {
	it('applies the source’s mean and calendar-day climatology to the scored days', () => {
		const { days, o, groups } = record(8);
		const half = Math.floor(o.length / 2);
		const cal = { o: o.slice(0, half), days: days.slice(0, half) };
		const vo = o.slice(half);
		const vd = days.slice(half);
		const vg = groups.slice(half);
		const own = scoreBenchmarks(vo, vd, vg);
		const fromCal = scoreBenchmarks(vo, vd, vg, 7, cal);
		expect(own.builtFrom).toBe('period');
		expect(fromCal.builtFrom).toBe('calibration');
		// The source's mean every day: KGE′ 1 − √2 only for the period's own mean.
		expect(own.meanFlow.kgePrime).toBeCloseTo(1 - Math.SQRT2, 10);
		expect(fromCal.meanFlow.kgePrime).not.toBeCloseTo(own.meanFlow.kgePrime!, 6);
		// A benchmark that knew the validation flows is at least as good on them as one that didn't (NSE: the period's own mean is optimal).
		expect(own.meanFlow.nse!).toBeGreaterThanOrEqual(fromCal.meanFlow.nse!);
	});

	it('a purely seasonal record: the calibration half’s climatology predicts the other half exactly', () => {
		const { days, groups } = record(8);
		const seasonal = Float64Array.from(days, (d) => 5 + 4 * Math.sin((2 * Math.PI * dayOfYearSlot(d)) / 366));
		const half = Math.floor(days.length / 2);
		const b = scoreBenchmarks(seasonal.slice(half), days.slice(half), groups.slice(half), 0, { o: seasonal.slice(0, half), days: days.slice(0, half) });
		expect(b.climatology.nse).toBeCloseTo(1, 10);
	});

	it('a calendar day the source never saw takes the source’s mean', () => {
		const d = ['2001-01-10', '2001-01-11'].map(toEpochDay);
		const v = ['2001-07-01'].map(toEpochDay);
		// Source: 2 and 4 in January; scored: one July day reading 3, which the source's mean (3) predicts exactly.
		const b = scoreBenchmarks([3, 3], [v[0]!, v[0]! + 1], undefined, 0, { o: [2, 4], days: d });
		expect(b.climatology.volumeErrorPct ?? 0).toBeCloseTo(0, 10);
	});
});

