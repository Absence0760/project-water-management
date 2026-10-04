// End to end: the run's calibration statistics (docs/model.md §2.10) and the
// fit's objectives (§2.10b), checked against textbook formulas computed here
// by hand, on a synthetic catchment whose "observed" record is the model run
// with known parameters plus known noise and gaps. Invented names and values
// only (the repo is public).
import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearOf } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';
import { calibrationStats } from '../network/stats';
import { fdcSignatures, fitScores, kgeLowHigh, kgeNp, kgePrime, kgeYearly, nse as nseObj } from '../calibrate/objective';
import { wr2012FitStats } from '../reference/wr2012Fit';

const SEC = 86_400;
const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'x',
	name: 'x',
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 0,
	areaHiKm2: 0,
	areaLoKm2: 0,
	flowShareManual: null,
	pctUpstreamToDam: 0,
	pctRunoffToDam: 0,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	returnFlowFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

function rain(days: number, start: string, seed: number): number[] {
	const rng = new Rng(seed);
	const d0 = toEpochDay(start);
	return Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		const wet = [5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08;
		return rng.bool(wet) ? Math.round(rng.logFloat(0.5, rng.bool(0.05) ? 150 : 40) * 10) / 10 : 0;
	});
}

const START = '2001-10-01';
const TRUTH = { x1: 420, x2: 0, x3: 85, x4: 2.3 };

/** Invented catchment "Kleinvlei": a farm draining to a gauge; observed = truth run × known noise, with gaps. */
function catchment(years = 6): { input: ModelInput; observed: (number | null)[] } {
	const days = Math.round(years * 365.25);
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { ...TRUTH, warmupDays: 365 } },
		model: {
			nodes: [node({ id: 'G', name: 'Kleinvlei weir', kind: 'gauge' }), node({ id: 'F', name: 'Farm A', downstreamNodeId: 'G', areaKm2: 35 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: rain(days, START, 11) } }
	};
	const flow = runModel(input).series.find((s) => s.key === 'natural_flow' && s.nodeId === null)!.values;
	const rng = new Rng(99);
	const observed: (number | null)[] = flow.map((q, t) => {
		// Known gaps: a blank day every 37th, a NaN every 83rd, a negative (read as missing) every 97th.
		if (t % 37 === 5) return null;
		if (t % 83 === 3) return NaN;
		if (t % 97 === 7) return -1;
		return (q / SEC) * (1 + 0.15 * (rng.next() - 0.5));
	});
	input.series.flow_observed_m3s = { startDate: START, values: observed };
	// Run with other parameters, so simulated ≠ observed.
	input.settings.gr4j = { x1: 300, x2: 0, x3: 60, x4: 1.8, warmupDays: 365 };
	return { input, observed };
}

/** Hand-written textbook statistics over paired (o, s) in m³/s. */
function textbook(o: number[], s: number[]) {
	const n = o.length;
	const mo = o.reduce((a, b) => a + b, 0) / n;
	const ms = s.reduce((a, b) => a + b, 0) / n;
	let sse = 0;
	let sst = 0;
	let cov = 0;
	let vs = 0;
	for (let i = 0; i < n; i++) {
		sse += (o[i]! - s[i]!) ** 2;
		sst += (o[i]! - mo) ** 2;
		cov += (o[i]! - mo) * (s[i]! - ms);
		vs += (s[i]! - ms) ** 2;
	}
	const so = Math.sqrt(sst / n);
	const ss = Math.sqrt(vs / n);
	const r = cov / n / (so * ss);
	const alpha = ss / so;
	const beta = ms / mo;
	const eps = mo / 100;
	const lo = o.map((v) => Math.log(v + eps));
	const ls = s.map((v) => Math.log(v + eps));
	const mlo = lo.reduce((a, b) => a + b, 0) / n;
	let lsse = 0;
	let lsst = 0;
	for (let i = 0; i < n; i++) {
		lsse += (lo[i]! - ls[i]!) ** 2;
		lsst += (lo[i]! - mlo) ** 2;
	}
	const So = o.reduce((a, b) => a + b, 0);
	const Ss = s.reduce((a, b) => a + b, 0);
	return {
		nse: 1 - sse / sst,
		pbias: (100 * (So - Ss)) / So,
		rmse: Math.sqrt(sse / n),
		kge: 1 - Math.sqrt((r - 1) ** 2 + (alpha - 1) ** 2 + (beta - 1) ** 2),
		r,
		alpha,
		beta,
		r2: r * r,
		logNse: 1 - lsse / lsst,
		volErr: (100 * (Ss - So)) / So
	};
}

const close = (a: number | null | undefined, b: number, digits = 9) => {
	expect(a).not.toBeNull();
	expect(a!).toBeCloseTo(b, digits);
};

describe('run calibration statistics (§2.10) match the textbook formulas end to end', () => {
	const { input, observed } = catchment();
	const out = runModel(input);
	const sim = out.series.find((s) => s.key === 'simulated_outflow' && s.nodeId === null)!.values;
	const d0 = toEpochDay(START);

	it('whole record: every scored day is a valid observation (blank, NaN and negative days skipped)', () => {
		const cal = out.summary.calibration!;
		const o: number[] = [];
		const s: number[] = [];
		observed.forEach((v, t) => {
			if (v === null || !Number.isFinite(v) || v < 0) return;
			o.push(v);
			s.push(sim[t]! / SEC);
		});
		expect(cal.days).toBe(o.length);
		const tb = textbook(o, s);
		close(cal.nse, tb.nse);
		close(cal.pbias, tb.pbias, 7);
		close(cal.rmseM3s, tb.rmse);
		close(cal.kge, tb.kge);
		close(cal.kgeR, tb.r);
		close(cal.kgeAlpha, tb.alpha);
		close(cal.kgeBeta, tb.beta);
		close(cal.r2, tb.r2);
		close(cal.logNse, tb.logNse);
		close(cal.volumeErrorPct, tb.volErr, 7);
		// Volume error is −PBIAS by definition.
		close(cal.volumeErrorPct, -cal.pbias!, 9);
		close(cal.logEpsilonM3s, o.reduce((a, b) => a + b, 0) / o.length / 100, 12);
	});

	it('window + water-year exclusion + date-range exclusion: only days inside the window and outside both are scored', () => {
		const x = structuredClone(input);
		x.settings.calibrationStart = '2002-10-01';
		x.settings.calibrationEnd = '2006-09-30';
		x.settings.calibrationExclusions = [
			{ waterYear: 2003, reason: 'invented: weir rebuilt' },
			{ start: '2005-01-10', end: '2005-02-20', reason: 'invented: logger flooded' }
		];
		const cal = runModel(x).summary.calibration!;
		const lo = toEpochDay('2002-10-01') - d0;
		const hi = toEpochDay('2006-09-30') - d0;
		const exA = [toEpochDay('2003-10-01') - d0, toEpochDay('2004-09-30') - d0];
		const exB = [toEpochDay('2005-01-10') - d0, toEpochDay('2005-02-20') - d0];
		const o: number[] = [];
		const s: number[] = [];
		const years = new Map<number, { o: number; s: number; n: number }>();
		let excludedObs = 0;
		for (let t = lo; t <= hi; t++) {
			const v = observed[t];
			if (v === null || v === undefined || !Number.isFinite(v) || v < 0) continue;
			if ((t >= exA[0]! && t <= exA[1]!) || (t >= exB[0]! && t <= exB[1]!)) {
				excludedObs++;
				continue;
			}
			o.push(v);
			s.push(sim[t]! / SEC);
			const wy = waterYearOf(d0 + t);
			const y = years.get(wy) ?? { o: 0, s: 0, n: 0 };
			y.o += (v * SEC) / 1e6;
			y.s += sim[t]! / 1e6;
			y.n++;
			years.set(wy, y);
		}
		expect(cal.days).toBe(o.length);
		expect(cal.excludedDays).toBe(excludedObs);
		expect(cal.windowStart).toBe('2002-10-01');
		expect(cal.windowEnd).toBe('2006-09-30');
		const tb = textbook(o, s);
		close(cal.nse, tb.nse);
		close(cal.kge, tb.kge);
		close(cal.logNse, tb.logNse);
		// Annual volumes: paired days only, per water year, Mm³; the wholly excluded year has no row.
		const annual = cal.annualVolumes ?? [];
		expect(annual.map((y) => y.waterYear)).toEqual([...years.keys()].sort());
		expect(annual.some((y) => y.waterYear === 2003)).toBe(false);
		for (const y of annual) {
			const h = years.get(y.waterYear)!;
			expect(y.days).toBe(h.n);
			close(y.observedMm3, h.o, 9);
			close(y.simulatedMm3, h.s, 9);
			close(y.diffPct, (100 * (h.s - h.o)) / h.o, 7);
			// A full water year inside the window: 365 or 366 window days whether observed or excluded.
			expect([365, 366]).toContain(y.daysInWindow);
		}
	});

	it('the WR2012 five-statistic table on the run matches a hand computation from monthly volumes', () => {
		const cal = out.summary.calibration!;
		const w = cal.wr2012Fit!;
		expect(w).not.toBeNull();
		// Hand: per water year, per month, the mean of the scored days × the month's days; a month needs ≥ 90 % of its days.
		const acc = new Map<number, { n: number[]; o: number[]; s: number[]; len: number[] }>();
		for (let t = 0; t < observed.length; t++) {
			const v = observed[t];
			if (v === null || v === undefined || !Number.isFinite(v) || v < 0) continue;
			const date = new Date((d0 + t) * 86_400_000);
			const wy = waterYearOf(d0 + t);
			const m = (date.getUTCMonth() + 3) % 12; // Oct = 0
			const len = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
			let a = acc.get(wy);
			if (!a) acc.set(wy, (a = { n: Array(12).fill(0), o: Array(12).fill(0), s: Array(12).fill(0), len: Array(12).fill(0) }));
			a.n[m]!++;
			a.o[m]! += v * SEC;
			a.s[m]! += sim[t]!;
			a.len[m] = len;
		}
		const yrs: { wy: number; o: number[]; s: number[] }[] = [];
		for (const [wy, a] of [...acc.entries()].sort((p, q) => p[0] - q[0])) {
			if (a.n.some((n, m) => n === 0 || n < 0.9 * a.len[m]!)) continue;
			yrs.push({ wy, o: a.o.map((v, m) => ((v / a.n[m]!) * a.len[m]!) / 1e6), s: a.s.map((v, m) => ((v / a.n[m]!) * a.len[m]!) / 1e6) });
		}
		expect(yrs.length).toBeGreaterThanOrEqual(3);
		expect(w.waterYears).toEqual(yrs.map((y) => y.wy));
		const ann = (k: 'o' | 's') => yrs.map((y) => y[k].reduce((p, q) => p + q, 0));
		const mean = (a: number[]) => a.reduce((p, q) => p + q, 0) / a.length;
		const sd = (a: number[]) => Math.sqrt(a.reduce((p, q) => p + (q - mean(a)) ** 2, 0) / (a.length - 1));
		const si = (k: 'o' | 's') => {
			const mm = Array.from({ length: 12 }, (_, m) => mean(yrs.map((y) => y[k][m]!)));
			const mar = mm.reduce((p, q) => p + q, 0);
			return (100 * mm.reduce((p, q) => p + Math.abs(q - mar / 12), 0)) / mar;
		};
		const want = {
			mar: [mean(ann('o')), mean(ann('s'))],
			meanLog: [mean(ann('o').map(Math.log10)), mean(ann('s').map(Math.log10))],
			sd: [sd(ann('o')), sd(ann('s'))],
			logSd: [sd(ann('o').map(Math.log10)), sd(ann('s').map(Math.log10))],
			seasonalIndex: [si('o'), si('s')]
		} as const;
		for (const st of w.stats) {
			const [ob, sm] = want[st.key];
			close(st.observed, ob!, 9);
			close(st.simulated, sm!, 9);
			close(st.diffPct, (100 * (sm! - ob!)) / Math.abs(ob!), 7);
			expect(st.withinBand).toBe(Math.abs(st.diffPct!) < st.bandPct);
		}
	});
});

describe('calibrationStats edge cases (§2.10)', () => {
	const sim = (a: number[]) => a.map((q) => q * SEC);

	it('a constant observed record: NSE, KGE and log-NSE are undefined (null), PBIAS and RMSE are not', () => {
		const st = calibrationStats(sim([1, 2, 3, 4]), [2, 2, 2, 2]);
		expect(st.days).toBe(4);
		expect(st.nse).toBeNull();
		expect(st.kge).toBeNull();
		expect(st.logNse).toBeNull();
		close(st.pbias, (100 * (8 - 10)) / 8);
		close(st.rmseM3s, Math.sqrt((1 + 0 + 1 + 4) / 4));
	});

	it('a single valid day among missing ones: days 1, RMSE |o − s|, no variance-based score', () => {
		const st = calibrationStats(sim([5, 7, 9]), [null, NaN, 4]);
		expect(st.days).toBe(1);
		close(st.rmseM3s, 5);
		expect(st.nse).toBeNull();
		expect(st.kge).toBeNull();
		close(st.pbias, -125);
	});

	it('zero-flow days: log-NSE stays finite through ε = ō/100 and matches the hand value', () => {
		const o = [0, 0, 1, 3, 0, 2];
		const s = [0.1, 0, 0.8, 2.5, 0.3, 2.2];
		const st = calibrationStats(sim(s), o);
		const tb = textbook(o, s);
		close(st.logNse, tb.logNse);
		close(st.nse, tb.nse);
		close(st.kge, tb.kge);
	});

	it('an all-zero observed record: every ratio score is null (no division by zero, no NaN)', () => {
		const st = calibrationStats(sim([0.1, 0.2, 0]), [0, 0, 0]);
		for (const k of ['nse', 'pbias', 'kge', 'logNse', 'volumeErrorPct', 'kgeBeta'] as const) expect(st[k]).toBeNull();
		expect(Number.isNaN(st.rmseM3s)).toBe(false);
	});

	it('a window that lies wholly before the record start scores nothing', () => {
		const st = calibrationStats(sim([1, 2, 3]), [1, 2, 3], { startDate: '2001-01-10', windowStart: '2000-01-01', windowEnd: '2000-12-31' });
		expect(st.days).toBe(0);
		expect(st.nse).toBeNull();
	});
});

describe('fit objectives (§2.10b) match their published formulas', () => {
	const rng = new Rng(5);
	const o = Array.from({ length: 101 }, (_, i) => 0.2 + 3 * Math.exp(-((i % 30) / 6)) + rng.next() * 0.3);
	const s = o.map((v, i) => v * (0.85 + 0.3 * Math.sin(i / 7)) + 0.05);

	it("KGE′ (Kling et al. 2012) uses the ratio of coefficients of variation, not of standard deviations", () => {
		const n = o.length;
		const mo = o.reduce((a, b) => a + b, 0) / n;
		const ms = s.reduce((a, b) => a + b, 0) / n;
		const sdo = Math.sqrt(o.reduce((a, v) => a + (v - mo) ** 2, 0) / n);
		const sds = Math.sqrt(s.reduce((a, v) => a + (v - ms) ** 2, 0) / n);
		const r = o.reduce((a, v, i) => a + (v - mo) * (s[i]! - ms), 0) / n / (sdo * sds);
		const want = 1 - Math.sqrt((r - 1) ** 2 + (ms / mo - 1) ** 2 + (sds / ms / (sdo / mo) - 1) ** 2);
		close(kgePrime(o, s), want, 12);
		// Mean-flow benchmark (Knoben et al. 2019): 1 − √2.
		close(kgePrime(o, o.map(() => mo)), 1 - Math.SQRT2, 9);
		// NSE of the mean is 0.
		close(nseObj(o, o.map(() => mo)), 0, 12);
	});

	it('KGE-np (Pool et al. 2018): Spearman r, FDC-shape α, mean β', () => {
		const n = o.length;
		const rank = (a: number[]) => {
			const idx = a.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
			const r = new Array<number>(n);
			idx.forEach(([, i], k) => (r[i] = k + 1)); // no ties in this data
			return r;
		};
		const ro = rank(o);
		const rs = rank(s);
		const mr = (n + 1) / 2;
		let c = 0;
		let a = 0;
		let b = 0;
		for (let i = 0; i < n; i++) {
			c += (ro[i]! - mr) * (rs[i]! - mr);
			a += (ro[i]! - mr) ** 2;
			b += (rs[i]! - mr) ** 2;
		}
		const r = c / Math.sqrt(a * b);
		const mo = o.reduce((p, q) => p + q, 0) / n;
		const ms = s.reduce((p, q) => p + q, 0) / n;
		const so = [...o].sort((p, q) => p - q);
		const ss = [...s].sort((p, q) => p - q);
		const alpha = 1 - 0.5 * so.reduce((p, v, i) => p + Math.abs(ss[i]! / (n * ms) - v / (n * mo)), 0);
		close(kgeNp(o, s), 1 - Math.sqrt((r - 1) ** 2 + (alpha - 1) ** 2 + (ms / mo - 1) ** 2), 12);
	});

	it('NSE on √Q and on ln(Q + ε) (ε = ō/100), and the low/high KGE′ on 1/(Q + ε)', () => {
		const f = fitScores(o, s);
		const tf = (g: (q: number) => number) => {
			const to = o.map(g);
			const ts = s.map(g);
			const m = to.reduce((p, q) => p + q, 0) / to.length;
			return 1 - to.reduce((p, v, i) => p + (ts[i]! - v) ** 2, 0) / to.reduce((p, v) => p + (v - m) ** 2, 0);
		};
		const eps = o.reduce((p, q) => p + q, 0) / o.length / 100;
		close(f.nseSqrt, tf(Math.sqrt), 12);
		close(f.nseLog, tf((q) => Math.log(q + eps)), 12);
		const inv = (a: number[]) => a.map((q) => 1 / (q + eps));
		close(f.kgeLowHigh, (kgePrime(o, s)! + kgePrime(inv(o), inv(s))!) / 2, 12);
		close(kgeLowHigh(o, s), f.kgeLowHigh!, 12);
		close(f.volumeErrorPct, (100 * (s.reduce((p, q) => p + q, 0) - o.reduce((p, q) => p + q, 0))) / o.reduce((p, q) => p + q, 0), 9);
	});

	it('Yilmaz et al. (2008) FDC signatures by hand (n = 101, so the 2 %, 20 %, 70 % points fall on exact ranks)', () => {
		const fo = [...o].sort((p, q) => q - p);
		const fs = [...s].sort((p, q) => q - p);
		const eps = o.reduce((p, q) => p + q, 0) / o.length / 100;
		const lg = (q: number) => Math.log(q + eps);
		const h = 2; // 2 % of 101 days, rounded down
		const ho = fo.slice(0, h).reduce((p, q) => p + q, 0);
		const hs = fs.slice(0, h).reduce((p, q) => p + q, 0);
		const mid = (f: number[]) => lg(f[20]!) - lg(f[70]!);
		let lo = 0;
		let ls = 0;
		for (let i = 70; i <= 100; i++) {
			lo += lg(fo[i]!) - lg(fo[100]!);
			ls += lg(fs[i]!) - lg(fs[100]!);
		}
		const sig = fdcSignatures(o, s);
		close(sig.fdcHighPct, (100 * (hs - ho)) / ho, 9);
		close(sig.fdcMidSlopePct, (100 * (mid(fs) - mid(fo))) / mid(fo), 9);
		close(sig.fdcLowPct, (-100 * (ls - lo)) / lo, 9);
		// A perfect simulation has no bias anywhere.
		const perfect = fdcSignatures(o, o);
		expect(perfect).toEqual({ fdcHighPct: 0, fdcMidSlopePct: 0, fdcLowPct: -0 });
	});

	it('year-balanced KGE′ is the plain mean of each water year’s KGE′, a short year (< 30 days) left out', () => {
		const groups = o.map((_, i) => (i < 40 ? 2001 : i < 80 ? 2002 : 2003)); // 2003 has 21 days
		const k1 = kgePrime(o.slice(0, 40), s.slice(0, 40))!;
		const k2 = kgePrime(o.slice(40, 80), s.slice(40, 80))!;
		close(kgeYearly(o, s, groups), (k1 + k2) / 2, 12);
	});
});

describe('the WR2012 table (§2.10, CR-28) on a hand-built record', () => {
	it('a month with fewer than 90 % of its days scored drops its whole water year', () => {
		const start = toEpochDay('2010-10-01');
		const len = toEpochDay('2012-10-01') - start;
		const obs = Float64Array.from({ length: len }, (_, t) => 1000 + t);
		const sim = Float64Array.from(obs, (v) => v * 1.1);
		// Leave out 4 days of November 2010 (30-day month: 26 scored < 27 needed).
		const nov = toEpochDay('2010-11-05') - start;
		const days = Int32Array.from({ length: len }, (_, t) => t).filter((t) => t < nov || t >= nov + 4);
		const w = wr2012FitStats(start, obs, sim, days)!;
		expect(w.waterYears).toEqual([2011]);
		const mar = w.stats.find((x) => x.key === 'mar')!;
		close(mar.diffPct, 10, 9);
		// 3 days out of February 2012 (29 days): 26 ≥ 26.1? No: 26 < 26.1, so 2011 drops too.
		const feb = toEpochDay('2012-02-01') - start;
		const days2 = days.filter((t) => t < feb || t >= feb + 3);
		expect(wr2012FitStats(start, obs, sim, days2)).toBeNull();
	});
});
