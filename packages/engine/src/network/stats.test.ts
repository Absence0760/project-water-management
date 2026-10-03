import { describe, expect, it } from 'vitest';
import { calibrationStats } from './stats';
import { toEpochDay, waterYearOf } from '../calendar';
import { wr2012FitStats } from '../reference/wr2012Fit';

const D = 86_400;
const m3day = (m3s: number[]) => m3s.map((v) => v * D);

describe('calibrationStats — hand-computed synthetic case', () => {
	// obs = [1, 2, 3, 4] m³/s, sim = [2, 2, 4, 4] m³/s
	// ō = 2.5, s̄ = 3; o − s = [−1, 0, −1, 0] → SSE = 2; SST = 5
	// cov = Σ(o−ō)(s−s̄)/n = (1.5 + 0.5 + 0.5 + 1.5)/4 = 1; σo = √1.25; σs = 1
	// r = 1/√1.25 = 2/√5, α = 1/√1.25 = 2/√5, β = 3/2.5 = 1.2
	const obs = [1, 2, 3, 4];
	const sim = m3day([2, 2, 4, 4]);
	// 2020-09-29 and -30 are water year 2019, 2020-10-01 and -02 water year 2020.
	const c = calibrationStats(sim, obs, { startDate: '2020-09-29' });
	const r = 2 / Math.sqrt(5);

	it('keeps NSE, PBIAS, RMSE and the means', () => {
		expect(c.days).toBe(4);
		expect(c.nse).toBeCloseTo(1 - 2 / 5, 12);
		expect(c.pbias).toBeCloseTo(-20, 12); // 100 × −2 / 10
		expect(c.rmseM3s).toBeCloseTo(Math.sqrt(0.5), 12);
		expect(c.meanObservedM3s).toBe(2.5);
		expect(c.meanSimulatedM3s).toBe(3);
	});

	it('computes KGE (Gupta 2009) and its components', () => {
		expect(c.kgeR).toBeCloseTo(r, 12);
		expect(c.kgeAlpha).toBeCloseTo(r, 12);
		expect(c.kgeBeta).toBeCloseTo(1.2, 12);
		expect(c.kge).toBeCloseTo(1 - Math.sqrt(2 * (r - 1) ** 2 + 0.2 ** 2), 12);
		expect(c.kge).toBeCloseTo(0.750418, 6);
	});

	it('computes R² as r²', () => {
		expect(c.r2).toBeCloseTo(0.8, 12);
	});

	it('computes log-NSE on ln(Q + ε), ε = 1% of mean observed', () => {
		const eps = 0.025;
		expect(c.logEpsilonM3s).toBeCloseTo(eps, 12);
		const lo = obs.map((o) => Math.log(o + eps));
		const ls = [2, 2, 4, 4].map((s) => Math.log(s + eps));
		const mean = lo.reduce((a, b) => a + b) / 4;
		const sse = lo.reduce((a, v, i) => a + (v - ls[i]!) ** 2, 0);
		const sst = lo.reduce((a, v) => a + (v - mean) ** 2, 0);
		expect(c.logNse).toBeCloseTo(1 - sse / sst, 12);
		// ln(1.025) − ln(2.025) dominates: the low-flow miss costs far more than in NSE.
		expect(c.logNse!).toBeLessThan(c.nse!);
	});

	it('reports the volume error with the opposite sign to PBIAS', () => {
		expect(c.volumeErrorPct).toBeCloseTo(20, 12);
	});

	it('builds the annual water balance per water year (Mm³)', () => {
		expect(c.annualVolumes).toHaveLength(2);
		const [a, b] = c.annualVolumes!;
		expect(a!.waterYear).toBe(2019);
		expect(a!.days).toBe(2);
		expect(a!.daysInWindow).toBe(2);
		expect(a!.observedMm3).toBeCloseTo(0.2592, 12); // (1 + 2) × 86 400 / 10⁶
		expect(a!.simulatedMm3).toBeCloseTo(0.3456, 12);
		expect(a!.diffPct).toBeCloseTo(100 / 3, 10);
		expect(b!.waterYear).toBe(2020);
		expect(b!.observedMm3).toBeCloseTo(0.6048, 12);
		expect(b!.simulatedMm3).toBeCloseTo(0.6912, 12);
		expect(b!.diffPct).toBeCloseTo(100 / 7, 10);
	});

	it('reports the scored window and the observed span', () => {
		expect(c.windowStart).toBe('2020-09-29');
		expect(c.windowEnd).toBe('2020-10-02');
		expect(c.firstObservedDate).toBe('2020-09-29');
		expect(c.lastObservedDate).toBe('2020-10-02');
	});
});

describe('calibrationStats — window', () => {
	const obs = [1, 2, 3, 4];
	const sim = m3day([2, 2, 4, 4]);

	it('scores only the days inside the window', () => {
		const c = calibrationStats(sim, obs, { startDate: '2020-09-29', windowStart: '2020-10-01', windowEnd: null });
		// o = [3, 4], s = [4, 4]: ō = 3.5, SSE = 1, SST = 0.5
		expect(c.days).toBe(2);
		expect(c.nse).toBeCloseTo(-1, 12);
		expect(c.windowStart).toBe('2020-10-01');
		expect(c.windowEnd).toBe('2020-10-02');
		expect(c.annualVolumes!.map((y) => y.waterYear)).toEqual([2020]);
		// sim is constant inside the window: no correlation, r = 0 (engine ≥ 1.69.0), so KGE still scores it:
		// α = 0, β = 4 / 3.5 = 8/7
		expect(c.kgeR).toBe(0);
		expect(c.kge).toBeCloseTo(1 - Math.sqrt(1 + 1 + (1 / 7) ** 2), 12);
		expect(c.r2).toBe(0);
		expect(c.kgeAlpha).toBe(0);
	});

	it('a large constant simulation is flat too: r = 0, not the float residue of its own mean', () => {
		// o varies by a few m³/s; s is 1e6 m³/s every day, whose (s − s̄)² residue is ~(1e-10)² a day.
		const o = [1, 3, 2, 5, 4, 2, 1, 3];
		const big = m3day(new Array(o.length).fill(1e6));
		const c = calibrationStats(big, o);
		expect(c.kgeR).toBe(0);
		expect(c.r2).toBe(0);
	});

	it('clamps the window to the run and flags part years', () => {
		const c = calibrationStats(sim, obs, { startDate: '2020-09-29', windowStart: '2000-01-01', windowEnd: '2020-09-30' });
		expect(c.days).toBe(2);
		expect(c.windowStart).toBe('2020-09-29');
		expect(c.windowEnd).toBe('2020-09-30');
		expect(c.annualVolumes![0]!.daysInWindow).toBe(2);
	});

	it('counts the days of a water year inside the window, observed or not', () => {
		const c = calibrationStats(sim, [null, 2, null, 4], { startDate: '2020-09-29' });
		expect(c.days).toBe(2);
		expect(c.firstObservedDate).toBe('2020-09-30');
		expect(c.annualVolumes!.map((y) => [y.days, y.daysInWindow])).toEqual([
			[1, 2],
			[1, 2]
		]);
	});

	it('returns empty statistics when the window misses every observation', () => {
		const c = calibrationStats(sim, obs, { startDate: '2020-09-29', windowStart: '2021-01-01', windowEnd: '2021-12-31' });
		expect(c.days).toBe(0);
		expect(c.nse).toBeNull();
		expect(c.kge).toBeNull();
		expect(c.windowStart).toBeNull();
		expect(c.annualVolumes).toEqual([]);
	});

	it('without a start date there is no window and no annual table', () => {
		const c = calibrationStats(sim, obs);
		expect(c.days).toBe(4);
		expect(c.windowStart).toBeNull();
		expect(c.annualVolumes).toEqual([]);
		expect(c.kge).toBeCloseTo(0.750418, 6);
	});

	it('leaves log-NSE null when observed flow is all zero', () => {
		const c = calibrationStats(m3day([1, 2]), [0, 0], { startDate: '2020-01-01' });
		expect(c.logNse).toBeNull();
		expect(c.pbias).toBeNull();
		expect(c.volumeErrorPct).toBeNull();
		expect(c.annualVolumes![0]!.diffPct).toBeNull();
	});
});

describe('waterYearOf', () => {
	it('labels a water year by the year its October falls in', () => {
		expect(waterYearOf(toEpochDay('2020-09-30'))).toBe(2019);
		expect(waterYearOf(toEpochDay('2020-10-01'))).toBe(2020);
		expect(waterYearOf(toEpochDay('2021-01-15'))).toBe(2020);
	});
});

describe('calibrationStats — exclusions', () => {
	// Four days, 2020-09-29 … 2020-10-02; the last two are water year 2020.
	const obs = [1, 2, 3, 4];
	const sim = m3day([2, 2, 4, 4]);

	it('leaves excluded days out of every score and reports what was left out', () => {
		const c = calibrationStats(sim, obs, {
			startDate: '2020-09-29',
			exclusions: [{ start: '2020-10-01', end: '2020-10-02', reason: 'gauge outage' }]
		});
		const onlyFirstTwo = calibrationStats(sim.slice(0, 2), obs.slice(0, 2), { startDate: '2020-09-29' });
		expect(c.days).toBe(2);
		expect(c.nse).toBe(onlyFirstTwo.nse);
		expect(c.pbias).toBe(onlyFirstTwo.pbias);
		expect(c.excludedDays).toBe(2);
		expect(c.exclusions).toEqual([{ start: '2020-10-01', end: '2020-10-02', reason: 'gauge outage' }]);
		// The excluded water year has no paired days, so no row.
		expect(c.annualVolumes!.map((y) => y.waterYear)).toEqual([2019]);
	});

	it("keeps excluded days in the year's window but not its scored days, so the year reads as a part year", () => {
		const c = calibrationStats(sim, obs, { startDate: '2020-09-29', exclusions: [{ start: '2020-09-29', end: '2020-09-29', reason: 'x' }] });
		expect(c.annualVolumes!.find((y) => y.waterYear === 2019)).toMatchObject({ days: 1, daysInWindow: 2 });
	});

	it('is unchanged, with no exclusion fields, when there are none', () => {
		const plain = calibrationStats(sim, obs, { startDate: '2020-09-29' });
		expect(calibrationStats(sim, obs, { startDate: '2020-09-29', exclusions: [] })).toEqual(plain);
		expect('excludedDays' in plain).toBe(false);
	});

	it('when everything is excluded, scores nothing', () => {
		const c = calibrationStats(sim, obs, { startDate: '2020-09-29', exclusions: [{ start: '2020-01-01', end: '2021-01-01', reason: 'x' }] });
		expect(c.days).toBe(0);
		expect(c.excludedDays).toBe(4);
	});
});

describe('calibrationStats — WR2012 five-statistic table (CR-28)', () => {
	// Two water years, 2002/03 and 2003/04, observed 1 m³/s Oct–Mar and 0.5 Apr–Sep; simulated 10 % wetter.
	const start = '2002-10-01';
	const d0 = toEpochDay(start);
	const n = toEpochDay('2004-10-01') - d0;
	const obs = Array.from({ length: n }, (_, t) => {
		const m = new Date((d0 + t) * D * 1000).getUTCMonth() + 1;
		return m >= 10 || m <= 3 ? 1 : 0.5;
	}) as (number | null)[];
	const sim = obs.map((v) => v! * 1.1 * D);

	it('scores the same days as the other statistics, converted to m³/day', () => {
		const c = calibrationStats(sim, obs, { startDate: start });
		const direct = wr2012FitStats(d0, Float64Array.from(obs, (v) => v! * D), sim, Int32Array.from({ length: n }, (_, t) => t));
		expect(c.wr2012Fit).toEqual(direct);
		expect(c.wr2012Fit!.waterYears).toEqual([2002, 2003]);
		expect(c.wr2012Fit!.stats.find((s) => s.key === 'mar')!.diffPct).toBeCloseTo(10, 9);
	});

	it('leaves out days outside the window, excluded days and missing observations', () => {
		expect(calibrationStats(sim, obs, { startDate: start, windowStart: '2003-10-01' }).wr2012Fit!.waterYears).toEqual([2003]);
		expect(calibrationStats(sim, obs, { startDate: start, exclusions: [{ start: '2003-10-01', end: '2004-09-30', reason: 'x' }] }).wr2012Fit!.waterYears).toEqual([2002]);
		const gappy = obs.slice();
		for (let t = 0; t < 4; t++) gappy[t] = null; // 27 of October 2002's 31 days: below 90 %
		expect(calibrationStats(sim, gappy, { startDate: start }).wr2012Fit!.waterYears).toEqual([2003]);
	});

	it('is null without a start date, or with no complete water year', () => {
		expect(calibrationStats(sim, obs).wr2012Fit).toBeNull();
		expect(calibrationStats(sim.slice(0, 200), obs.slice(0, 200), { startDate: start }).wr2012Fit).toBeNull();
	});
});
