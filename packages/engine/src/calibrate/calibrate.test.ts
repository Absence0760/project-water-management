import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';
import { gr4j } from '../runoff/gr4j';
import { GR4J_PARAMS, type Gr4jParams } from '../runoff/params';
import { GR4J_NO_PET } from '../runoff/pet';
import { runoffForcing, simulateRunoff } from '../runoff/simulate';
import { randomInput } from '../testing/fuzz';
import { checkAll } from '../testing/invariants';
import { calibrate, prepareCalibration, startSeed, startsNotes, validationNotes, type DifferentialTest, type ValidationTest } from './calibrate';
import { MAX_STARTS } from './params';
import { BOOTSTRAP_LEVEL, BOOTSTRAP_RESAMPLES, CLIMATOLOGY_HALF_WINDOW } from './bootstrap';
import { fitScores } from './objective';
import { wr2012FitStats } from '../reference/wr2012Fit';

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
	lossReturnFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

/** Seasonal synthetic rain: wet winters, dry summers, the odd storm. */
function rain(days: number, start: string, seed: number): number[] {
	const rng = new Rng(seed);
	const d0 = toEpochDay(start);
	return Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		const wet = [5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08;
		return rng.bool(wet) ? Math.round(rng.logFloat(0.5, rng.bool(0.05) ? 150 : 40) * 10) / 10 : 0;
	});
}

/**
 * One farm (no dam, no crops) draining to a gauge, so simulated outflow =
 * natural flow; the "observed" record is GR4J itself with known parameters.
 */
function synthetic(truth: Gr4jParams, years = 8, start = '1990-10-01'): ModelInput {
	const days = Math.round(years * 365.25);
	const r = rain(days, start, 7);
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { ...truth, warmupDays: 365 } },
		model: {
			nodes: [node({ id: 'G', name: 'Gauge', kind: 'gauge' }), node({ id: 'F', name: 'Farm', downstreamNodeId: 'G', areaKm2: 40 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: start, values: r } }
	};
	const flow = runModel(input).series.find((s) => s.key === 'natural_flow')!.values;
	input.series.flow_observed_m3s = { startDate: start, values: flow.map((q) => q / 86_400) };
	// Calibration starts from the defaults, not from the truth.
	input.settings.gr4j = { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 };
	return input;
}

describe('the pan coefficient / A-pan evaporation is forcing, never a calibratable parameter', () => {
	it('is not among GR4J_PARAMS — the trade-off with X1/X3 means it must stay fixed', () => {
		const keys = GR4J_PARAMS.map((p) => p.key);
		expect(keys).not.toContain('panCoefficient');
		expect(keys).not.toContain('apanMm');
	});

	it('calibrate never writes settings.panCoefficient or settings.apanMm, even when every GR4J parameter is free', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 3);
		input.settings.panCoefficient = [0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6];
		const beforePan = [...(input.settings.panCoefficient ?? [])];
		const beforeApan = [...(input.settings.apanMm ?? [])];
		const report = calibrate(input, { budget: 100, free: ['x1', 'x2', 'x3', 'x4'], validate: false });
		expect(input.settings.panCoefficient).toEqual(beforePan);
		expect(input.settings.apanMm).toEqual(beforeApan);
		expect(report.free).not.toContain('panCoefficient');
		expect(report.free).not.toContain('apanMm');
		expect(Object.keys(report.params)).not.toContain('panCoefficient');
		expect(Object.keys(report.params)).not.toContain('apanMm');
	}, 30_000);
});

describe('prepareCalibration scores what runModel produces', () => {
	it('on random GR4J networks, gauge/logger records against simulated outflow', () => {
		let checked = 0;
		for (let seed = 1; seed <= 150 && checked < 30; seed++) {
			const input = randomInput(seed);
			let pb;
			try {
				pb = prepareCalibration(input);
			} catch {
				continue; // no observed record, or too few observed days
			}
			const out = runModel(input);
			const want = out.series.find((s) => s.nodeId === null && s.key === 'simulated_outflow')!.values;
			const got = pb.simulate(pb.startParams);
			for (const t of pb.scoredDays) expect(got[t], `seed ${seed} day ${t}`).toBe(want[t]);
			// A validation record is simulated over its own days (beyond the calibration window) just as exactly.
			for (const kind of ['flow_observed_m3s', 'flow_logger_m3s'] as const) {
				const rec = pb.record(kind);
				if (!rec) continue;
				const g = rec.simulate(pb.startParams);
				for (const t of rec.scoredDays) expect(g[t], `seed ${seed} ${kind} day ${t}`).toBe(want[t]);
			}
			checked++;
		}
		expect(checked).toBeGreaterThanOrEqual(20);
	});
});

describe('calibrate', () => {
	it('recovers known GR4J parameters from noise-free flow (X1, X3 within 10 %, X4 within 0.2 days)', () => {
		const truth = { x1: 420, x2: 0, x3: 85, x4: 2.3 };
		const report = calibrate(synthetic(truth), { budget: 5000, seed: 1, validate: false });
		expect(Math.abs(report.params.x1! / truth.x1 - 1)).toBeLessThan(0.1);
		expect(Math.abs(report.params.x3! / truth.x3 - 1)).toBeLessThan(0.1);
		expect(Math.abs(report.params.x4! - truth.x4)).toBeLessThan(0.2);
		expect(report.params.x2).toBe(0);
		expect(report.fit.scores.kgePrime!).toBeGreaterThan(0.99);
		expect(report.before.scores.kgePrime!).toBeLessThan(report.fit.scores.kgePrime!);
		expect(report.evaluations).toBe(5000);
	}, 120_000);

	it('fitted parameters, applied to the project, pass every run invariant', () => {
		let checked = 0;
		for (let seed = 1; seed <= 200 && checked < 8; seed++) {
			const input = randomInput(seed);
			let report;
			try {
				report = calibrate(input, { budget: 40, seed, validate: false });
			} catch {
				continue;
			}
			const fitted = structuredClone(input);
			fitted.settings.gr4j = { ...fitted.settings.gr4j!, ...report.params };
			expect(checkAll(fitted, seed), `seed ${seed}`).toBeNull();
			checked++;
		}
		expect(checked).toBe(8);
	}, 120_000);

	it('keeps every parameter inside its bounds, and is deterministic for a seed', () => {
		const input = synthetic({ x1: 2900, x2: 0, x3: 5, x4: 0.6 }, 4);
		const a = calibrate(input, { budget: 300, seed: 4 });
		for (const p of [a.params, a.splitSample!.params, ...(a.differential ? [a.differential.params] : [])]) {
			for (const s of GR4J_PARAMS) {
				expect(p[s.key]).toBeGreaterThanOrEqual(s.min);
				expect(p[s.key]).toBeLessThanOrEqual(s.max);
			}
		}
		expect(calibrate(input, { budget: 300, seed: 4 })).toEqual(a);
		expect(calibrate(input, { budget: 300, seed: 5 }).params).not.toEqual(a.params);
	}, 60_000);

	it('bounds: "wide" (default) searches each parameter\'s min/max; "typical" restricts the search to Perrin et al.\'s (2003) 80 % range and clamps a starting point outside it', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 4);
		input.settings.gr4j = { x1: 2900, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 }; // x1 starts outside Perrin's typical range (100–1200)
		const wide = calibrate(input, { budget: 150, seed: 3, validate: false });
		expect(wide.bounds).toBe('wide');
		const typical = calibrate(input, { budget: 150, seed: 3, validate: false, bounds: 'typical' });
		expect(typical.bounds).toBe('typical');
		for (const s of GR4J_PARAMS.filter((s) => typical.free.includes(s.key))) {
			expect(typical.params[s.key]).toBeGreaterThanOrEqual(s.typical[0]);
			expect(typical.params[s.key]).toBeLessThanOrEqual(s.typical[1]);
		}
	}, 60_000);

	it('fits only the free parameters; X2 moves only when freed', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 3);
		const fixed = calibrate(input, { budget: 200, free: ['x1'], validate: false });
		expect(fixed.params).toMatchObject({ x2: 0, x3: 90, x4: 1.7 });
		expect(fixed.params.x1).not.toBe(350);
		const withX2 = calibrate(input, { budget: 200, free: ['x1', 'x2', 'x3', 'x4'], validate: false });
		expect(withX2.free).toEqual(['x1', 'x2', 'x3', 'x4']);
		const yearly = calibrate(input, { budget: 100, objective: 'kgeYearly', validate: false });
		expect(yearly.objective).toBe('kgeYearly');
		expect(yearly.fit.scores.kgeYearly!).toBeGreaterThanOrEqual(yearly.before.scores.kgeYearly!);
		// The low/high-flow objective (CR-3) is accepted, optimised and reported.
		const lowHigh = calibrate(input, { budget: 100, objective: 'kgeLowHigh', validate: false });
		expect(lowHigh.objective).toBe('kgeLowHigh');
		expect(lowHigh.fit.scores.kgeLowHigh!).toBeGreaterThanOrEqual(lowHigh.before.scores.kgeLowHigh!);
		expect(lowHigh.startResults.every((r) => r.score === null || r.score <= lowHigh.fit.scores.kgeLowHigh! + 1e-12)).toBe(true);
	}, 60_000);

	it('every scored period carries its bootstrap intervals and benchmarks (CR-5); a start’s score does not need them', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 });
		const r = calibrate(input, { budget: 50, seed: 2 });
		const years = r.fit.waterYears.length;
		expect(years).toBeGreaterThanOrEqual(3);
		expect(r.fit.intervals).toMatchObject({ level: BOOTSTRAP_LEVEL, resamples: BOOTSTRAP_RESAMPLES, years });
		const k = r.fit.scores.kgePrime!;
		expect(r.fit.intervals!.kgePrime!.lo).toBeLessThanOrEqual(k);
		expect(r.fit.intervals!.kgePrime!.hi).toBeGreaterThanOrEqual(k);
		expect(r.fit.benchmarks!.meanFlow.kgePrime).toBeCloseTo(1 - Math.SQRT2, 9);
		expect(r.fit.benchmarks!.halfWindowDays).toBe(CLIMATOLOGY_HALF_WINDOW);
		// The benchmarks depend only on the observed days: the same for the current and fitted parameters.
		expect(r.before.benchmarks).toEqual(r.fit.benchmarks);
		for (const p of [r.splitSample!.calibration, r.splitSample!.validation]) {
			expect(p.benchmarks).not.toBeNull();
			expect(p.intervals == null || p.intervals.years === p.waterYears.length).toBe(true);
		}
		// Deterministic: the same fit gives the same intervals.
		expect(calibrate(input, { budget: 50, seed: 2 }).fit.intervals).toEqual(r.fit.intervals);
	}, 60_000);

	it('scores only observed days inside the calibration window and outside exclusions', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 4);
		const obs = input.series.flow_observed_m3s!;
		obs.values[40] = null;
		input.settings.calibrationStart = '1991-10-01';
		input.settings.calibrationEnd = '1993-09-30';
		const pb = prepareCalibration(input, [{ start: '1992-01-01', end: '1992-01-31' }]);
		const d0 = toEpochDay('1990-10-01');
		const dates = Array.from(pb.scoredDays, (t) => fromEpochDay(d0 + t));
		expect(dates[0]).toBe('1991-10-01');
		expect(dates.at(-1)).toBe('1993-09-30');
		expect(dates.some((d) => d.startsWith('1992-01'))).toBe(false);
		expect(pb.scoredDays.length).toBe(731 - 31);
		const report = calibrate(input, { budget: 50, validate: false, exclusions: [{ start: '1992-01-01', end: '1992-01-31' }] });
		expect(report.fit).toMatchObject({ start: '1991-10-01', end: '1993-09-30' });
		expect(report.fit.scores.days).toBe(700);
		// The WR2012 five-statistic table (CR-28) on the same days: January 1992 is
		// excluded, so water year 1991 has a month short and only 1992 counts.
		expect(report.fit.wr2012Fit!.waterYears).toEqual([1992]);
		expect(report.before.wr2012Fit!.waterYears).toEqual([1992]);
		const sim = pb.simulate(report.params);
		expect(report.fit.wr2012Fit).toEqual(wr2012FitStats(d0, pb.observed, sim, pb.scoredDays));
	});

	it('reports the CHIRPS factors its rain used, for fit provenance (engine ≥ 0.29.0)', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 4);
		// No CHIRPS: nothing to record.
		expect(prepareCalibration(input).chirpsFactors).toBeNull();
		const rain = input.series.rain_catchment_mm!;
		input.series.rain_chirps_mm = { startDate: rain.startDate, values: rain.values.map((v) => (v == null ? null : v / 2)) };
		const sets = prepareCalibration(input).chirpsFactors!;
		expect(sets.map((x) => x.label)).toEqual(['whole record']);
		expect(sets[0]!.factors.every((f) => f !== null && Math.abs(f - 2) < 1e-9)).toBe(true);
		expect(calibrate(input, { budget: 20, validate: false }).chirpsFactors).toEqual(sets);
	});

	it('always leaves out the stored exclusions (a whole water year, a range), on top of any passed in', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 4);
		const all = prepareCalibration(input).scoredDays.length;
		input.settings.calibrationExclusions = [
			{ waterYear: 1991, reason: 'suspect rain' },
			{ start: '1993-01-01', end: '1993-01-10', reason: 'gauge outage' }
		];
		const pb = prepareCalibration(input, [{ start: '1993-01-05', end: '1993-01-20' }]);
		const d0 = toEpochDay('1990-10-01');
		const dates = Array.from(pb.scoredDays, (t) => fromEpochDay(d0 + t));
		expect(dates.some((d) => d >= '1991-10-01' && d <= '1992-09-30')).toBe(false);
		expect(dates.some((d) => d >= '1993-01-01' && d <= '1993-01-20')).toBe(false);
		expect(pb.scoredDays.length).toBe(all - 366 - 20);
		expect(pb.exclusions).toEqual([
			{ start: '1991-10-01', end: '1992-09-30' },
			{ start: '1993-01-01', end: '1993-01-10' },
			{ start: '1993-01-05', end: '1993-01-20' }
		]);
		const report = calibrate(input, { budget: 30, validate: false });
		expect(report.exclusions).toHaveLength(2);
		expect(report.fit.waterYears).not.toContain(1991);
		// The same days runModel's calibration statistics score.
		const out = runModel(input);
		const stats = out.summary.calibration!;
		expect(stats.days).toBe(report.fit.scores.days);
		expect(stats.excludedDays).toBe(366 + 10);
		// The EWR test on the observed record leaves them out too (it scores the whole record, not just the window).
		expect(out.summary.catchment.ewrAgreement!.excludedDays).toBe(366 + 10);
		expect(checkAll(input)).toBeNull();
	});

	it('runModel warns when the exclusions leave nothing to score, and drops an invalid one', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 2);
		input.settings.calibrationExclusions = [
			{ start: '1980-01-01', end: '2030-01-01', reason: 'everything' },
			{ waterYear: 1991, reason: '' }
		];
		const { summary } = runModel(input);
		expect(summary.calibration!.days).toBe(0);
		expect(summary.calibration!.exclusions).toEqual([{ start: '1980-01-01', end: '2030-01-01', reason: 'everything' }]);
		expect(summary.warnings).toContain('every observed day inside the calibration window falls in a calibration exclusion');
		expect(summary.warnings.some((w) => /calibration exclusion .* needs a reason; ignored/.test(w))).toBe(true);
	});

	it('reports a split-sample test, and a dry → wet test when there are enough water years', () => {
		const report = calibrate(synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 8), { budget: 150, seed: 2 });
		const ss = report.splitSample!;
		expect(ss.calibration.end < ss.validation.start).toBe(true);
		expect(ss.calibration.scores.days + ss.validation.scores.days).toBe(report.fit.scores.days);
		const dsst = report.differential!;
		expect(dsst.dryYears).toHaveLength(4);
		expect(dsst.wetYears).toHaveLength(4);
		expect(dsst.dryYears.some((y) => dsst.wetYears.includes(y))).toBe(false);
		expect(dsst.wetDryRatio).toBeGreaterThan(1);
		expect(report.evaluations).toBe(3 * 150);
	}, 60_000);

	it('reports the dry → wet test by the water years it used, which never overlap (skewed TZ)', () => {
		const tz = process.env.TZ;
		process.env.TZ = 'Pacific/Kiritimati'; // UTC+14: a local-time slip would move 1 October into September
		try {
			const report = calibrate(synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 8), { budget: 40, seed: 2 });
			const dsst = report.differential!;
			expect(dsst.calibration.waterYears).toEqual(dsst.dryYears);
			expect(dsst.validation.waterYears).toEqual(dsst.wetYears);
			expect(dsst.calibration.waterYears.filter((y) => dsst.validation.waterYears.includes(y))).toEqual([]);
			// Every water year of the 8-year record is 1990/91 … 1997/98.
			expect([...dsst.dryYears, ...dsst.wetYears].sort()).toEqual([1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997]);
			// Contiguous periods list their years too.
			expect(report.fit.waterYears).toEqual([1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997]);
			expect(report.fit).toMatchObject({ start: '1990-10-01' });
			const ss = report.splitSample!;
			expect(ss.calibration.waterYears.at(-1)).toBeLessThanOrEqual(ss.validation.waterYears[0]!);
		} finally {
			process.env.TZ = tz;
		}
	}, 60_000);

	it('says plainly when the record can’t test wet years', () => {
		const report = calibrate(synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 2.5), { budget: 60 });
		expect(report.differential).toBeNull();
		expect(report.notes.join(' ')).toMatch(/too few to fit on dry years and test on wet ones.*weakly constrained/);
	});

	it('states how representative the record is against the whole run’s rain (CR-34)', () => {
		// 12 years of rain, but only the first 3 water years observed.
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 12);
		const obs = input.series.flow_observed_m3s!;
		obs.values = obs.values.map((v, t) => (t < 365 * 3 ? v : null));
		const report = calibrate(input, { budget: 20, validate: false });
		const r = report.representativeness!;
		expect(r.scoredDays).toBe(report.fit.scores.days);
		expect(r.waterYears).toBe(3);
		expect(r.years.map((y) => y.waterYear)).toEqual(report.fit.waterYears);
		// The long-term reference is the whole run's rain, not the observed years.
		expect(r.longTerm).toMatchObject({ years: 12, firstYear: 1990, lastYear: 2001 });
		expect(r.years.every((y) => y.percentile !== null && y.class !== null)).toBe(true);
		expect(report.notes).toEqual(expect.arrayContaining(r.notes));
		expect(r.notes.join(' ')).toMatch(/only 3 water years, fewer than 5/);
	});

	it('flags a record whose "wet" years are hardly wetter than its dry ones', () => {
		// Identical rain every year: the wet half can't be wetter than the dry half.
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 1);
		const oneYear = input.series.rain_catchment_mm!.values.slice(0, 365);
		const years = 6;
		input.series.rain_catchment_mm!.values = Array.from({ length: years * 365 }, (_, t) => oneYear[t % 365]!);
		const truth = { ...input.settings, gr4j: { x1: 420, x2: 0, x3: 85, x4: 2.3, warmupDays: 365 } };
		const flow = runModel({ ...input, settings: truth, series: { rain_catchment_mm: input.series.rain_catchment_mm } }).series.find((s) => s.key === 'natural_flow')!.values;
		input.series.flow_observed_m3s = { startDate: '1990-10-01', values: flow.map((q) => q / 86_400) };
		const report = calibrate(input, { budget: 60 });
		expect(report.differential!.wetDryRatio).toBeLessThan(1.5);
		expect(report.notes.join(' ')).toMatch(/no clearly wet years to test on/);
	});

	describe('dry → wet ranking by the reference gauge (a regional wet/dry index, never a target)', () => {
		const truth = { x1: 420, x2: 0, x3: 85, x4: 2.3 };
		const opts = { budget: 30, seed: 2 } as const;
		/** A reference series over the 8-year record whose value in water year 1990 + i is perYear(i). */
		const referenceOf = (input: ModelInput, perYear: (i: number) => number | null) => {
			const n = input.series.rain_catchment_mm!.values.length;
			const d0 = toEpochDay('1990-10-01');
			return {
				startDate: '1990-10-01',
				values: Array.from({ length: n }, (_, t) => {
					const d = fromEpochDay(d0 + t);
					const wy = Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) >= 10 ? 0 : 1);
					return perYear(wy - 1990);
				})
			};
		};

		it('ranks the water years by the reference when it covers them, and records it', () => {
			const input = synthetic(truth, 8);
			// Reversed: 1990/91 is the reference's wettest year, 1997/98 its driest.
			input.series.flow_reference_m3s = referenceOf(input, (i) => 10 - i);
			const report = calibrate(input, opts);
			expect(report.differential!.rankedBy).toBe('reference');
			expect(report.differential!.dryYears).toEqual([1994, 1995, 1996, 1997]);
			expect(report.differential!.wetYears).toEqual([1990, 1991, 1992, 1993]);
			// The ratio stays the fitted record's own observed contrast.
			expect(Number.isFinite(report.differential!.wetDryRatio)).toBe(true);
			// Asked for 'observed', the reference is ignored.
			const own = calibrate(input, { ...opts, rankYearsBy: 'observed' });
			expect(own.differential!.rankedBy).toBe('observed');
		}, 60_000);

		it('is never scored: with it the report is exactly the report without it, bar the ranking', () => {
			const base = calibrate(synthetic(truth, 8), opts);
			expect(base.differential!.rankedBy).toBe('observed');
			const input = synthetic(truth, 8);
			// A reference that ranks the years as the observed record does, but at twice (and a tenth of) the flow:
			// were it ever scored, a score would move.
			const obs = input.series.flow_observed_m3s!.values as number[];
			input.series.flow_reference_m3s = { startDate: '1990-10-01', values: obs.map((q) => q * 2) };
			const ranked = calibrate(input, opts);
			expect(ranked.differential!.rankedBy).toBe('reference');
			expect(ranked.flowKind).toBe('flow_observed_m3s');
			expect({ ...ranked, differential: { ...ranked.differential, rankedBy: 'observed' } }).toEqual(base);
			// Asked to rank by the fitted record, it matches the report without a reference in every field.
			input.series.flow_reference_m3s = { startDate: '1990-10-01', values: obs.map((q) => q / 10) };
			expect(calibrate(input, { ...opts, rankYearsBy: 'observed' })).toEqual(base);
		}, 120_000);

		it('falls back to the observed ranking, with a note, when the reference misses a year', () => {
			const input = synthetic(truth, 8);
			input.series.flow_reference_m3s = referenceOf(input, (i) => (i < 5 ? 10 - i : null));
			const report = calibrate(input, opts);
			expect(report.differential!.rankedBy).toBe('observed');
			expect(report.notes.join(' ')).toMatch(/reference gauge has fewer than 180 days in 3 of the 8 water years .*\(WY 1995\/96, WY 1996\/97, WY 1997\/98\), so it ranks them by their own observed flow instead/);
			// Asked for 'reference' in a project without one: the same fallback, said.
			const none = calibrate(synthetic(truth, 8), { ...opts, rankYearsBy: 'reference' });
			expect(none.differential!.rankedBy).toBe('observed');
			expect(none.notes).toContain('The project has no reference gauge, so the dry → wet test ranks water years by their own observed flow.');
		}, 120_000);
	});

	it('refuses a project with no observed record, and can be cancelled', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 2);
		const noObs = { ...input, series: { rain_catchment_mm: input.series.rain_catchment_mm } };
		expect(() => calibrate(noObs)).toThrow(/no observed flow series/);
		// GR4J with no evaporation is refused, as runModel refuses it.
		const noPet = { ...input, settings: { ...input.settings, apanMm: new Array(12).fill(0) as never } };
		expect(() => calibrate(noPet, { budget: 20, validate: false })).toThrow(GR4J_NO_PET);
		const seen: string[] = [];
		const report = calibrate(input, {
			budget: 500,
			onProgress: (p) => {
				seen.push(p.stage);
				return p.evaluations >= 20;
			}
		});
		expect(report.cancelled).toBe(true);
		expect(report.evaluations).toBe(20);
		expect(report.splitSample).toBeNull();
		expect(new Set(seen)).toEqual(new Set(['full']));
		expect(report.notes.join(' ')).toMatch(/cancelled/);
	});

	it('multi-start (CR-2): every start is reported, the best is kept, and one start is the single-start fit', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 3);
		const one = calibrate(input, { budget: 150, seed: 9, validate: false });
		expect(one.starts).toBe(1);
		expect(one.startResults).toEqual([{ seed: 9, params: one.params, score: one.fit.scores.kgePrime, best: true }]);
		expect(calibrate(input, { budget: 150, seed: 9, validate: false, starts: 1 })).toEqual(one);

		const progress: { start?: number; starts?: number }[] = [];
		const three = calibrate(input, { budget: 150, seed: 9, validate: false, starts: 3, onProgress: (p) => void progress.push({ start: p.start, starts: p.starts }) });
		expect(three.starts).toBe(3);
		expect(three.startResults.map((r) => r.seed)).toEqual([9, startSeed(9, 1), startSeed(9, 2)]);
		expect(three.evaluations).toBe(3 * 150);
		// Start 0 is the single-start fit, so more starts never do worse.
		expect(three.startResults[0]!.params).toEqual(one.params);
		const best = three.startResults.filter((r) => r.best);
		expect(best).toHaveLength(1);
		expect(three.params).toEqual(best[0]!.params);
		for (const r of three.startResults) expect(best[0]!.score!).toBeGreaterThanOrEqual(r.score!);
		expect(three.fit.scores.kgePrime).toBe(best[0]!.score);
		expect(new Set(progress.map((p) => `${p.start}/${p.starts}`))).toEqual(new Set(['1/3', '2/3', '3/3']));
		expect(calibrate(input, { budget: 150, seed: 9, validate: false, starts: 3 })).toEqual(three);
	}, 60_000);

	it('multi-start: starts are clamped to 1–MAX_STARTS, and cancelling stops the remaining starts', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 2);
		expect(calibrate(input, { budget: 10, validate: false, starts: 0 }).starts).toBe(1);
		expect(calibrate(input, { budget: 10, validate: false, starts: 99 }).startResults).toHaveLength(MAX_STARTS);
		const cut = calibrate(input, { budget: 100, validate: false, starts: 4, onProgress: (p) => p.start === 2 && p.evaluations >= 5 });
		expect(cut.cancelled).toBe(true);
		expect(cut.startResults).toHaveLength(2);
		expect(cut.evaluations).toBe(100 + 5);
	});

	it('startsNotes names parameters the near-best starts disagree on, and starts that stopped short', () => {
		const specs = [
			{ key: 'x1', label: 'X1', unit: 'mm', lo: 10, hi: 3000 },
			{ key: 'x4', label: 'X4', unit: 'days', lo: 0.5, hi: 10 }
		];
		const r = (score: number | null, x1: number, x4 = 2, best = false) => ({ seed: 1, params: { x1, x4 }, score, best });
		expect(startsNotes('kgePrime', [r(0.8, 300, 2, true)], specs)).toEqual([]);
		// Agreement: nothing to say.
		expect(startsNotes('kgePrime', [r(0.8, 300, 2, true), r(0.795, 350, 2.1)], specs)).toEqual([]);
		// Equal scores, X1 across 30 % of its range: equifinality.
		const [ridge] = startsNotes('kgePrime', [r(0.8, 300, 2, true), r(0.795, 1200, 2.05), r(0.799, 700)], specs);
		expect(ridge).toMatch(/^3 of 3 starts reach nearly the same KGE′ \(0.80–0.80\) with X1 from 300 to 1200 mm: the record can’t pin these down/);
		expect(ridge).not.toMatch(/X4/);
		// A start that fell short is named, and doesn't count as scatter.
		const notes = startsNotes('kgePrime', [r(0.8, 300, 2, true), r(0.5, 2900, 9)], specs);
		expect(notes).toEqual([expect.stringMatching(/^1 of 2 starts stopped short of the best KGE′ \(lowest 0.50 against 0.80\)/)]);
		// A start with no score is left out.
		expect(startsNotes('kgePrime', [r(0.8, 300, 2, true), r(null, 2900)], specs)).toEqual([]);
	});

	it('the fast path matches the traced simulation over the scored days', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 2);
		const f = runoffForcing({ apanMm: apan as never, panCoefficient: new Array(12).fill(0.7) as never }, {
			startDate: '1990-10-01',
			days: 730,
			aligned: (k) => (k === 'rain_catchment_mm' ? input.series.rain_catchment_mm!.values.slice(0, 730) : new Array(730).fill(null))
		});
		const p = { x1: 300, x2: 0, x3: 70, x4: 2 };
		const full = simulateRunoff(gr4j, p, f, { warmupDays: 365 });
		const short = simulateRunoff(gr4j, p, f, { warmupDays: 365, trace: false, days: 400 });
		expect(Array.from(short.qMm)).toEqual(Array.from(full.qMm.slice(0, 400)));
	});
});

describe('calibrate with an independent validation record', () => {
	/**
	 * The gauge is the truth; the logger is a second instrument that reads 60 %
	 * of it, and only from 1995-10-01 (its own days, outside the gauge's
	 * calibration window).
	 */
	function twoRecords(): ModelInput {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 8);
		const gauge = input.series.flow_observed_m3s!;
		const from = toEpochDay('1995-10-01') - toEpochDay(gauge.startDate);
		input.series.flow_logger_m3s = { startDate: '1995-10-01', values: gauge.values.slice(from).map((q) => (q === null ? null : q * 0.6)) };
		input.settings.calibrationFlowKind = 'flow_observed_m3s';
		input.settings.calibrationEnd = '1995-09-30';
		return input;
	}

	it('scores the fitted parameters against the other record over its own days, beside the other tests', () => {
		const input = twoRecords();
		const report = calibrate(input, { budget: 200, seed: 3, validate: false, validationRecord: 'flow_logger_m3s' });
		const ind = report.independentRecord!;
		expect(ind.flowKind).toBe('flow_logger_m3s');
		expect(ind.simulatedKey).toBe('simulated_outflow');
		expect(ind.params).toEqual(report.params);
		expect(ind.calibration).toEqual(report.fit);
		// The logger's own days, not the gauge's calibration window.
		const loggerDays = input.series.flow_logger_m3s!.values.filter((v) => v !== null).length;
		expect(ind.validation).toMatchObject({ start: '1995-10-01', waterYears: [1995, 1996, 1997] });
		expect(ind.validation.scores.days).toBe(loggerDays);
		expect(ind.overlapDays).toBe(0);
		// Fitted to the gauge, the model overshoots a logger that reads 60 % of it by ≈ 1/0.6.
		expect(ind.validation.scores.volumeErrorPct!).toBeGreaterThan(50);
		expect(ind.validation.scores.fdcHighPct).not.toBeNull();
		expect(report.notes.join(' ')).toMatch(/Scored against the logger record instead, KGE′ falls from 0\.\d\d to .*does not hold on the other instrument/);
		// Exclusions apply to it too.
		const excl = calibrate(input, { budget: 50, validate: false, validationRecord: 'flow_logger_m3s', exclusions: [{ start: '1996-01-01', end: '1996-01-31' }] });
		expect(excl.independentRecord!.validation.scores.days).toBe(loggerDays - 31);
	}, 60_000);

	it('positive control: validating on the calibration record itself reproduces the fit score', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 3);
		const report = calibrate(input, { budget: 100, validate: false, validationRecord: 'flow_observed_m3s' });
		const ind = report.independentRecord!;
		expect(ind.validation.scores).toEqual(report.fit.scores);
		expect(ind.validation.waterYears).toEqual(report.fit.waterYears);
		expect(ind.overlapDays).toBe(report.fit.scores.days);
		expect(report.notes.join(' ')).toMatch(/were also fitted to: that part tests the instrument/);
	}, 60_000);

	it('is skipped, with a note, when the record is absent or too short; unset changes nothing', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 3);
		const plain = calibrate(input, { budget: 60, seed: 2 });
		expect(plain.independentRecord).toBeNull();
		const absent = calibrate(input, { budget: 60, seed: 2, validationRecord: 'flow_logger_m3s' });
		expect(absent.independentRecord).toBeNull();
		expect(absent.notes).toContain('The project has no logger record, so the fit was not validated against one.');
		expect({ ...absent, notes: plain.notes }).toEqual(plain);

		const short = structuredClone(input);
		short.series.flow_logger_m3s = { startDate: '1991-01-01', values: Array.from({ length: 20 }, (_, i) => 1 + i / 100) };
		const r = calibrate(short, { budget: 60, validate: false, validationRecord: 'flow_logger_m3s' });
		expect(r.independentRecord).toBeNull();
		expect(r.notes.join(' ')).toMatch(/logger record has only 20 observed days outside the exclusions, too few/);
		// Long enough, but a stuck logger: the quality flags leave its flat stretch out (CR-19), and the note says so.
		const stuck = structuredClone(input);
		stuck.series.flow_logger_m3s = { startDate: '1991-01-01', values: [...new Array(40).fill(1), ...Array.from({ length: 20 }, (_, i) => 1 + (i + 1) / 100)] };
		const rs = calibrate(stuck, { budget: 60, validate: false, validationRecord: 'flow_logger_m3s' });
		expect(rs.independentRecord).toBeNull();
		expect(rs.notes.join(' ')).toMatch(/logger record has only 20 observed days outside the exclusions once the quality flags leave out 40 extrapolated, suspect or infilled days/);
		// A second record in the project, not asked for: the report is as without it.
		expect(calibrate(short, { budget: 60, seed: 2 })).toEqual(plain);
	}, 60_000);

	it('scores an independent logger record against the simulated outflow', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 3);
		input.series.flow_logger_m3s = structuredClone(input.series.flow_observed_m3s!);
		const r = calibrate(input, { budget: 40, validate: false, validationRecord: 'flow_logger_m3s' });
		expect(r.independentRecord!.simulatedKey).toBe('simulated_outflow');
		// The same record under another name scores exactly as the fit.
		expect(r.independentRecord!.validation.scores.kgePrime).toBeCloseTo(r.fit.scores.kgePrime!, 12);
	}, 60_000);
});

describe('validationNotes', () => {
	const period = (kge: number) => ({ start: '2003-10-01', end: '2004-09-30', waterYears: [2003], scores: { ...fitScores([1, 2, 3], [1, 2, 3]), kgePrime: kge } });
	const test = (cal: number, val: number): ValidationTest => ({ params: {}, calibration: period(cal), validation: period(val) });

	it('calls out a validation score well below the calibration score, and a dry → wet test on few years', () => {
		const dsst: DifferentialTest = { ...test(0.78, 0.31), dryYears: [2003, 2005], wetYears: [2002, 2004], wetDryRatio: 2.2 };
		expect(validationNotes('kgePrime', test(0.86, 0.41), dsst)).toEqual([
			'On the split-sample test KGE′ falls from 0.86 (the half the model was fitted to) to 0.41 (the other half): the fit does not carry over well, so treat results outside the calibration period with caution.',
			'Fitted to the dry years, KGE′ falls from 0.78 to 0.31 on the wet years: wet-year behaviour is uncertain.',
			'The dry → wet test rests on 2 dry and 2 wet water years, too few for a firm conclusion.'
		]);
	});

	it('says nothing when the fit carries over', () => {
		const dsst: DifferentialTest = { ...test(0.8, 0.7), dryYears: [1, 2, 3], wetYears: [4, 5, 6], wetDryRatio: 2 };
		expect(validationNotes('kgePrime', test(0.8, 0.75), dsst)).toEqual([]);
		expect(validationNotes('kgePrime', null, null)).toEqual([]);
	});
});

describe('calibrate reads the per-day quality flags (CR-18/19, engine ≥ 1.22.0)', () => {
	const truth = { x1: 420, x2: 0, x3: 85, x4: 2.3 };
	/** Observed flow, m³/s, of the synthetic record (no nulls in it). */
	const flowOf = (input: ModelInput) => input.series.flow_observed_m3s!.values as number[];
	/** The q-th quantile of the observed flow. */
	const quantile = (input: ModelInput, q: number) => {
		const xs = [...flowOf(input)].sort((a, b) => a - b);
		return xs[Math.floor(q * (xs.length - 1))]!;
	};

	it('leaves a flat stretch (suspect) out of the fit by default, and scores it in the fit on all days', () => {
		const input = synthetic(truth, 3);
		const flow = flowOf(input);
		for (let t = 400; t < 431; t++) flow[t] = 0.5; // 31 days of one value: a stuck logger
		const pb = prepareCalibration(input);
		expect(pb.dayQuality!.flow.suspect).toBe(31);
		expect(Array.from(pb.scoredDays).some((t) => t >= 400 && t < 431)).toBe(false);
		expect(pb.allDays!.length).toBe(pb.scoredDays.length + 31);
		const report = calibrate(input, { budget: 40, validate: false });
		expect(report.fit.scores.days).toBe(pb.scoredDays.length);
		expect(report.fitAllDays!.scores.days).toBe(pb.scoredDays.length + 31);
		expect(report.dayQuality).toEqual(pb.dayQuality);
		expect(report.dayQuality!.leftOutDays).toBe(31);

		// "Score as recorded": the stretch is fitted, and the fit on all days is the fit itself.
		input.settings.qualityFlags = { ...pb.dayQuality!.use, ratings: {}, suspect: 'include' };
		const inc = prepareCalibration(input);
		expect(inc.scoredDays.length).toBe(pb.allDays!.length);
		expect(calibrate(input, { budget: 40, validate: false }).fitAllDays).toBeNull();
	}, 30_000);

	it('suspect days follow the project’s data-check limits: a lower outlier factor leaves more days out', () => {
		const input = synthetic(truth, 3);
		const base = prepareCalibration(input);
		expect(base.dayQuality!.flow.suspect).toBe(0);
		// Flows above twice the 99th percentile become outliers under a project limit of 2 (default 10).
		input.settings.dataQuality = { outlierFactorFlow: 2 } as never;
		const strict = prepareCalibration(input);
		expect(strict.dayQuality!.flow.suspect).toBeGreaterThan(0);
		expect(strict.scoredDays.length).toBe(base.scoredDays.length - strict.dayQuality!.flow.suspect);
	});

	it('with no flag set, the fit is the one before engine 1.22.0: every observed day, no fit on all days', () => {
		const input = synthetic(truth, 3);
		const pb = prepareCalibration(input);
		expect(pb.scoredDays.length).toBe(pb.allDays!.length);
		expect(pb.censor).toBeNull();
		expect(pb.dayQuality!.flow.inRange).toBe(pb.scoredDays.length);
		expect(pb.dayQuality!.notes).toEqual([expect.stringMatching(/No highest gauging is recorded for the gauge record/)]);
		expect(calibrate(input, { budget: 30, validate: false }).fitAllDays).toBeNull();
	}, 30_000);

	it('censors days above the highest gauging: how far the record reads above it never changes the fit', () => {
		const a = synthetic(truth, 4);
		const hi = quantile(a, 0.97);
		const rating = { gaugedMaxM3s: hi, gaugedMinM3s: null, source: 'synthetic rating table' };
		a.settings.qualityFlags = { ratings: { flow_observed_m3s: rating }, aboveRating: 'censor', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude' };
		const b = structuredClone(a);
		// Record B's floods read 50 % higher: an extrapolated rating that disagrees with A's.
		flowOf(b).forEach((q, t, xs) => (xs[t] = q > hi ? q * 1.5 : q));
		const pa = prepareCalibration(a);
		expect(pa.dayQuality!.flow.aboveRating).toBeGreaterThan(20);
		expect(pa.dayQuality!.censoredDays).toBe(pa.dayQuality!.flow.aboveRating);
		const opts = { budget: 60, validate: false, seed: 3 };
		const ra = calibrate(a, opts);
		const rb = calibrate(b, opts);
		expect(rb.params).toEqual(ra.params);
		expect(rb.fit.scores).toEqual(ra.fit.scores);
		// The fit on all days reads the record as it is, so it does see the difference.
		expect(rb.fitAllDays!.scores).not.toEqual(ra.fitAllDays!.scores);
		// Positive control: scored as recorded, the two records give different fits.
		for (const x of [a, b]) x.settings.qualityFlags = { ...x.settings.qualityFlags!, aboveRating: 'include' };
		expect(calibrate(b, opts).fit.scores).not.toEqual(calibrate(a, opts).fit.scores);
	}, 60_000);

	it('"exclude" leaves the days above the highest gauging out altogether', () => {
		const input = synthetic(truth, 3);
		const hi = quantile(input, 0.95);
		input.settings.qualityFlags = { ratings: { flow_observed_m3s: { gaugedMaxM3s: hi, gaugedMinM3s: null, source: 's' } }, aboveRating: 'exclude', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude' };
		const pb = prepareCalibration(input);
		expect(pb.censor).toBeNull();
		expect(Array.from(pb.scoredDays).every((t) => pb.observed[t]! <= hi * 86_400)).toBe(true);
		expect(pb.scoredDays.length).toBe(pb.allDays!.length - pb.dayQuality!.flow.aboveRating);
	});

	it('refuses, naming the flags, when they leave fewer than 30 days', () => {
		const input = synthetic(truth, 1);
		const lo = quantile(input, 0.99);
		// Every day but the top 1 % is below the lowest gauging.
		input.settings.qualityFlags = { ratings: { flow_observed_m3s: { gaugedMaxM3s: null, gaugedMinM3s: lo, source: 's' } }, aboveRating: 'censor', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude' };
		expect(() => prepareCalibration(input)).toThrow(/left once the quality flags leave out/);
	});

	it('an independent record is scored under its own gauged range', () => {
		const input = synthetic(truth, 3);
		input.series.flow_logger_m3s = { startDate: input.series.flow_observed_m3s!.startDate, values: [...flowOf(input)] };
		const hi = quantile(input, 0.95);
		input.settings.qualityFlags = { ratings: { flow_logger_m3s: { gaugedMaxM3s: hi, gaugedMinM3s: null, source: 's' } }, aboveRating: 'exclude', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude' };
		const pb = prepareCalibration(input);
		// The gauge has no rating: nothing left out of it.
		expect(pb.scoredDays.length).toBe(pb.allDays!.length);
		const rec = pb.record('flow_logger_m3s')!;
		expect(rec.scoredDays.length).toBeLessThan(pb.scoredDays.length);
		expect(Array.from(rec.scoredDays).every((t) => rec.observed[t]! <= hi * 86_400)).toBe(true);
	});

	it('the run’s recession segments leave out days below the lowest gauging (CR-13 day mask)', () => {
		const input = synthetic(truth, 4);
		input.settings.gr4j = { ...truth, warmupDays: 365 };
		const segDays = (i: ModelInput) => runModel(i).summary.plausibility!.recession!.segments.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k));
		const lo = quantile(input, 0.3);
		const flow = flowOf(input);
		// Positive control: without a rating, segments run through low flows.
		expect(segDays(input).some((t) => flow[t]! < lo)).toBe(true);
		input.settings.qualityFlags = { ratings: { flow_observed_m3s: { gaugedMaxM3s: null, gaugedMinM3s: lo, source: 's' } }, aboveRating: 'censor', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude' };
		const days = segDays(input);
		expect(days.length).toBeGreaterThan(0);
		expect(days.some((t) => flow[t]! < lo)).toBe(false);
	}, 30_000);
});
