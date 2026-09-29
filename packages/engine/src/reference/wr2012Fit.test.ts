import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { seasonalIndex, WR2012_FIT_STAT_KEYS, WR2012_GOOD_FIT_BANDS, wr2012FitStats, wr2012FitStatsFromMonthly, type Wr2012FitStats } from './wr2012Fit';

const stat = (r: Wr2012FitStats | null, key: string) => r!.stats.find((s) => s.key === key)!;
const months = (first6: number, last6: number) => [...Array(6).fill(first6), ...Array(6).fill(last6)] as number[];

describe('seasonalIndex (Walsh & Lawler, as %)', () => {
	it('is 0 for an even year, 183.3 for all flow in one month, and null without flow', () => {
		expect(seasonalIndex(Array(12).fill(5))).toBeCloseTo(0, 12);
		expect(seasonalIndex([12, ...Array(11).fill(0)])).toBeCloseTo((100 * 22) / 12, 10);
		expect(seasonalIndex(Array(12).fill(0))).toBeNull();
	});
});

describe('wr2012FitStatsFromMonthly: hand-computed', () => {
	// Observed: 2 Mm³ a month Oct–Mar and none Apr–Sep (12 Mm³), then 4 (24 Mm³).
	const observed = [months(2, 0), months(4, 0)];

	it('computes the five statistics by hand', () => {
		const r = wr2012FitStatsFromMonthly(observed.map((o, i) => ({ waterYear: 2000 + i, observed: o, simulated: o.map((v) => 1.1 * v) })));
		expect(r!.waterYears).toEqual([2000, 2001]);
		expect(r!.logYears).toBe(2);
		expect(r!.stats.map((s) => s.key)).toEqual(WR2012_FIT_STAT_KEYS);
		// MAR = (12 + 24) / 2 = 18; sim 19.8 → +10 %.
		expect(stat(r, 'mar').observed).toBeCloseTo(18, 12);
		expect(stat(r, 'mar').simulated).toBeCloseTo(19.8, 12);
		expect(stat(r, 'mar').diffPct).toBeCloseTo(10, 10);
		expect(stat(r, 'mar').withinBand).toBe(false);
		// Sample SD of {12, 24} = √72.
		expect(stat(r, 'sd').observed).toBeCloseTo(Math.sqrt(72), 12);
		expect(stat(r, 'sd').diffPct).toBeCloseTo(10, 10);
		// Mean of logs: (log10 12 + log10 24) / 2 = 1.2296962; sim adds log10 1.1.
		expect(stat(r, 'meanLog').observed).toBeCloseTo(1.2296962, 6);
		expect(stat(r, 'meanLog').simulated).toBeCloseTo(1.2296962 + 0.0413927, 6);
		expect(stat(r, 'meanLog').diffPct).toBeCloseTo((100 * 0.0413927) / 1.2296962, 3); // 3.366 %
		expect(stat(r, 'meanLog').withinBand).toBe(true);
		// Log SD of {log10 12, log10 24} = log10 2 / √2; scaling doesn't change it.
		expect(stat(r, 'logSd').observed).toBeCloseTo(Math.log10(2) / Math.SQRT2, 12);
		expect(stat(r, 'logSd').diffPct).toBeCloseTo(0, 10);
		expect(stat(r, 'logSd').withinBand).toBe(true);
		// Monthly means 3 × 6, 0 × 6; MAR/12 = 1.5; Σ|·| = 18 → SI 100 %, both sides.
		expect(stat(r, 'seasonalIndex').observed).toBeCloseTo(100, 10);
		expect(stat(r, 'seasonalIndex').simulated).toBeCloseTo(100, 10);
		expect(r!.bandsConfirmed).toBe(WR2012_GOOD_FIT_BANDS.confirmed);
	});

	it('judges each statistic against its band, strictly below', () => {
		const flat = (v: number) => Array(12).fill(v) as number[];
		const r = wr2012FitStatsFromMonthly([
			{ waterYear: 2000, observed: months(2, 0), simulated: flat(1) },
			{ waterYear: 2001, observed: months(4, 0), simulated: flat(2) }
		]);
		// Same annual volumes: MAR, SD and the log statistics are exact.
		for (const k of ['mar', 'sd', 'meanLog', 'logSd']) expect(stat(r, k).withinBand).toBe(true);
		// A flat year has SI 0: −100 %.
		expect(stat(r, 'seasonalIndex').simulated).toBeCloseTo(0, 12);
		expect(stat(r, 'seasonalIndex').diffPct).toBeCloseTo(-100, 10);
		expect(stat(r, 'seasonalIndex').withinBand).toBe(false);
		expect(stat(r, 'mar').bandPct).toBe(WR2012_GOOD_FIT_BANDS.pct.mar);
		// Exactly on the band is outside it (the guideline reads "< 4 %").
		const one = (v: number) => [v, ...Array(11).fill(0)] as number[];
		const edge = wr2012FitStatsFromMonthly([{ waterYear: 2000, observed: one(100), simulated: one(104) }]);
		expect(stat(edge, 'mar').diffPct).toBe(4);
		expect(stat(edge, 'mar').withinBand).toBe(false);
		const inside = wr2012FitStatsFromMonthly([{ waterYear: 2000, observed: one(100), simulated: one(96.5) }]);
		expect(stat(inside, 'mar').withinBand).toBe(true);
	});

	it('needs 2 years for the SDs, positive years for the logs, and one year at all', () => {
		expect(wr2012FitStatsFromMonthly([])).toBeNull();
		const one = wr2012FitStatsFromMonthly([{ waterYear: 2000, observed: months(2, 0), simulated: months(2, 0) }]);
		expect(stat(one, 'sd').observed).toBeNull();
		expect(stat(one, 'sd').withinBand).toBeNull();
		expect(stat(one, 'mar').withinBand).toBe(true);
		const dry = wr2012FitStatsFromMonthly([
			{ waterYear: 2000, observed: Array(12).fill(0), simulated: months(1, 0) },
			{ waterYear: 2001, observed: months(2, 0), simulated: months(2, 0) },
			{ waterYear: 2002, observed: months(4, 0), simulated: months(4, 0) }
		]);
		expect(dry!.logYears).toBe(2);
		expect(stat(dry, 'meanLog').observed).toBeCloseTo((Math.log10(12) + Math.log10(24)) / 2, 12);
		// A negative mean of logs (annual runoff below 1 Mm³): the sign still reads "simulated higher".
		const small = wr2012FitStatsFromMonthly([{ waterYear: 2000, observed: Array(12).fill(0.01), simulated: Array(12).fill(0.02) }]);
		expect(stat(small, 'meanLog').observed).toBeLessThan(0);
		expect(stat(small, 'meanLog').diffPct).toBeGreaterThan(0);
	});
});

describe('wr2012FitStats: daily records to hydrological-year months', () => {
	const SEC = 86_400;
	/** Daily flows (m³/day) from 1 Oct of `wy0` for `years` water years: 1 m³/s Oct–Mar, 0.5 m³/s Apr–Sep. */
	function record(wy0: number, years: number) {
		const d0 = toEpochDay(`${wy0}-10-01`);
		const n = toEpochDay(`${wy0 + years}-10-01`) - d0;
		const obs = new Float64Array(n);
		for (let t = 0; t < n; t++) {
			const m = new Date((d0 + t) * SEC * 1000).getUTCMonth() + 1;
			obs[t] = (m >= 10 || m <= 3 ? 1 : 0.5) * SEC;
		}
		return { d0, obs, all: Int32Array.from({ length: n }, (_, t) => t) };
	}
	// Oct–Mar: 31+30+31+31+28+31 = 182 days (183 in a leap year), Apr–Sep 183 days.
	const annual = (feb: number) => ((182 - 28 + feb) * SEC + 183 * 0.5 * SEC) / 1e6;

	it('sums months to water years, with the actual February (leap years too)', () => {
		const { d0, obs, all } = record(2002, 2); // 2002/03 (Feb 28), 2003/04 (Feb 29)
		const r = wr2012FitStats(d0, obs, obs, all);
		expect(r!.waterYears).toEqual([2002, 2003]);
		expect(stat(r, 'mar').observed).toBeCloseTo((annual(28) + annual(29)) / 2, 9);
		expect(stat(r, 'sd').observed).toBeCloseTo(Math.abs(annual(29) - annual(28)) / Math.SQRT2, 9);
		for (const s of r!.stats) if (s.diffPct !== null) expect(s.diffPct).toBeCloseTo(0, 10);
	});

	it('counts a month with ≥ 90 % of its days scored, infilling by the paired mean; drops the year otherwise', () => {
		const { d0, obs, all } = record(2002, 2);
		// 3 of October 2002's 31 days missing: 28/31 ≥ 0.9, the year still counts and its volume is unchanged.
		const missing3 = Int32Array.from([...all].filter((t) => t < 0 || t >= 3));
		const r3 = wr2012FitStats(d0, obs, obs, missing3);
		expect(r3!.waterYears).toEqual([2002, 2003]);
		expect(stat(r3, 'mar').observed).toBeCloseTo((annual(28) + annual(29)) / 2, 9);
		// 4 missing: 27/31 < 0.9, the whole water year 2002 drops out.
		const missing4 = Int32Array.from([...all].filter((t) => t >= 4));
		expect(wr2012FitStats(d0, obs, obs, missing4)!.waterYears).toEqual([2003]);
		// A NaN simulated day doesn't count either.
		const sim = Float64Array.from(obs);
		for (let t = 0; t < 4; t++) sim[t] = NaN;
		expect(wr2012FitStats(d0, obs, sim, all)!.waterYears).toEqual([2003]);
		// No complete year at all: null.
		expect(wr2012FitStats(d0, obs, obs, all.slice(0, 300))).toBeNull();
	});

	it('scores simulated against observed on the same days', () => {
		const { d0, obs, all } = record(2002, 3);
		const sim = Float64Array.from(obs, (v) => v * 0.97);
		const r = wr2012FitStats(d0, obs, sim, all);
		expect(stat(r, 'mar').diffPct).toBeCloseTo(-3, 9);
		expect(stat(r, 'mar').withinBand).toBe(true);
		expect(stat(r, 'sd').diffPct).toBeCloseTo(-3, 9);
		expect(stat(r, 'seasonalIndex').diffPct).toBeCloseTo(0, 9);
	});
});
