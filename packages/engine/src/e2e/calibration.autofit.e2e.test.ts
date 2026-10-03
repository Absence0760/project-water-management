// End to end: automatic calibration (docs/model.md §2.10b, §2.10k). The
// "observed" record is the model itself run with known GR4J parameters, so a
// fit must recover them; what the fit scores must be exactly what a run with
// the fitted parameters produces; validation splits must be the documented
// ones; and a fit at a gauge inside the network must score that node's flow.
// Invented catchments and values only (the repo is public).
import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearOf } from '../calendar';
import { calibrate } from '../calibrate/calibrate';
import { fitScores, kgePrime } from '../calibrate/objective';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';

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
	lossReturnFraction: 0,
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
		// Some years wetter than others, so the dry → wet test has a contrast.
		const yearWet = 0.6 + ((Math.floor(t / 365) * 7) % 5) * 0.25;
		return rng.bool(wet * yearWet) ? Math.round(rng.logFloat(0.5, rng.bool(0.05) ? 150 : 40) * 10) / 10 : 0;
	});
}

const START = '2003-10-01';
const TRUTH = { x1: 420, x2: 0, x3: 85, x4: 2.3 };
const DEFAULTS = { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 };
const series = (out: ReturnType<typeof runModel>, key: string, nodeId: string | null = null) => out.series.find((s) => s.key === key && s.nodeId === nodeId)!.values;

/** Invented "Doringkloof": one farm to the outlet gauge; observed = the truth run's outflow (× noise, with gaps when asked). */
function single(opts: { years?: number; noise?: number; gaps?: boolean } = {}): ModelInput {
	const days = Math.round((opts.years ?? 6) * 365.25);
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { ...TRUTH, warmupDays: 365 } },
		model: {
			nodes: [node({ id: 'G', name: 'Doringkloof weir', kind: 'gauge' }), node({ id: 'F', name: 'Farm Doring', downstreamNodeId: 'G', areaKm2: 35 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: rain(days, START, 21) } }
	};
	const q = series(runModel(input), 'simulated_outflow');
	const rng = new Rng(3);
	input.series.flow_observed_m3s = {
		startDate: START,
		values: q.map((v, t) => (opts.gaps && (t % 29 === 4 || (t > 400 && t < 430)) ? null : (v / SEC) * (1 + (opts.noise ?? 0) * (rng.next() - 0.5))))
	};
	input.settings.gr4j = { ...DEFAULTS };
	return input;
}

/** Observed and simulated (m³/day) on the observed days, for the parameters given, by a plain run. */
function runPairs(input: ModelInput, params: Record<string, number>, nodeId: string | null = null, kind: 'flow_observed_m3s' | 'flow_logger_m3s' = 'flow_observed_m3s') {
	const x = structuredClone(input);
	x.settings.gr4j = { ...x.settings.gr4j!, ...params };
	const out = runModel(x);
	const sim = nodeId ? series(out, 'outflow', nodeId) : series(out, 'simulated_outflow');
	const rec = (x.series as Record<string, { values: (number | null)[] }>)[nodeId ? `${kind}@${nodeId}` : kind]!.values;
	const o: number[] = [];
	const s: number[] = [];
	const t: number[] = [];
	rec.forEach((v, i) => {
		if (v === null || !Number.isFinite(v) || v < 0) return;
		o.push(v * SEC);
		s.push(sim[i]!);
		t.push(i);
	});
	return { o, s, t, out };
}

describe('automatic calibration recovers known parameters (§2.10b)', () => {
	it('noise-free record, typical bounds, seed 1: X1 and X3 within 3 %, X4 within 0.1 day, and KGE′ near 1', () => {
		const input = single();
		const r = calibrate(input, { budget: 1500, seed: 1, validate: false, bounds: 'typical' });
		expect(Math.abs(r.params.x1! / TRUTH.x1 - 1)).toBeLessThan(0.03);
		expect(Math.abs(r.params.x3! / TRUTH.x3 - 1)).toBeLessThan(0.03);
		expect(Math.abs(r.params.x4! - TRUTH.x4)).toBeLessThan(0.1);
		expect(r.params.x2).toBe(0); // not free by default
		expect(r.fit.scores.kgePrime!).toBeGreaterThan(0.995);
		expect(r.before.scores.kgePrime!).toBeLessThan(r.fit.scores.kgePrime!);
		// Scoring the truth itself gives a perfect fit on the same days: the target is the run.
		const truthPairs = runPairs(input, TRUTH);
		expect(kgePrime(truthPairs.o, truthPairs.s)!).toBeCloseTo(1, 9);
	}, 30_000);

	it('the fit score is exactly the score of a plain run with the fitted parameters on the same days', () => {
		const input = single({ noise: 0.2, gaps: true });
		const r = calibrate(input, { budget: 300, seed: 7, validate: false });
		const { o, s, t } = runPairs(input, r.params);
		const d0 = toEpochDay(START);
		const years = t.map((i) => waterYearOf(d0 + i));
		const want = fitScores(Float64Array.from(o), Float64Array.from(s), Int32Array.from(years));
		expect(r.fit.scores.days).toBe(o.length);
		for (const k of ['kgePrime', 'kgeYearly', 'kgeNp', 'nse', 'nseSqrt', 'nseLog', 'kgeLowHigh', 'volumeErrorPct', 'fdcHighPct', 'fdcMidSlopePct', 'fdcLowPct'] as const) {
			expect(r.fit.scores[k], k).toBeCloseTo(want[k]!, 9);
		}
		// And the run's own statistics, with the fitted parameters, score the same days (no flags here).
		const x = structuredClone(input);
		x.settings.gr4j = { ...x.settings.gr4j!, ...r.params };
		expect(runModel(x).summary.calibration!.days).toBe(o.length);
	}, 30_000);

	it('with ±10 % noise and gaps the fit still lands near the truth (X1, X3 within 15 %, X4 within 0.4 day)', () => {
		const r = calibrate(single({ noise: 0.2, gaps: true }), { budget: 1500, seed: 1, validate: false, bounds: 'typical' });
		expect(Math.abs(r.params.x1! / TRUTH.x1 - 1)).toBeLessThan(0.15);
		expect(Math.abs(r.params.x3! / TRUTH.x3 - 1)).toBeLessThan(0.15);
		expect(Math.abs(r.params.x4! - TRUTH.x4)).toBeLessThan(0.4);
	}, 30_000);

	it('is deterministic for a seed (whole report), different for another seed, and one start equals the single-start fit', () => {
		const input = single({ noise: 0.1 });
		const a = calibrate(input, { budget: 120, seed: 5, starts: 2 });
		expect(calibrate(input, { budget: 120, seed: 5, starts: 2 })).toEqual(a);
		expect(calibrate(input, { budget: 120, seed: 6, starts: 2 }).params).not.toEqual(a.params);
		// The kept start is the best of the starts (lowest loss = highest KGE′ without a penalty).
		const best = Math.max(...a.startResults.map((s) => s.score!));
		expect(a.startResults.find((s) => s.best)!.score).toBe(best);
		expect(a.startResults[0]!.seed).toBe(5);
		expect(a.startResults[1]!.seed).toBe((5 + 1_000_003) % 2 ** 31);
		// Start 0 of a two-start fit is the one-start fit with the same seed.
		const one = calibrate(input, { budget: 120, seed: 5, starts: 1, validate: false });
		expect(one.startResults[0]!.params).toEqual(a.startResults[0]!.params);
		// Every evaluated parameter stays in bounds.
		for (const p of [a.params, a.splitSample!.params]) {
			expect(p.x1).toBeGreaterThanOrEqual(1);
			expect(p.x4).toBeGreaterThanOrEqual(0.5);
		}
	}, 30_000);
});

describe('validation splits are the documented ones (§2.10b)', () => {
	const input = single({ years: 8, noise: 0.1, gaps: true });
	const r = calibrate(input, { budget: 60, seed: 2 });
	const all = runPairs(input, DEFAULTS).t; // the observed days (no window, no flags)
	const d0 = toEpochDay(START);
	const iso = (t: number) => new Date((d0 + t) * 86_400_000).toISOString().slice(0, 10);

	it('split-sample: first half of the scored days to fit, second half to validate', () => {
		const half = Math.floor(all.length / 2);
		expect(r.splitSample!.calibration.scores.days).toBe(half);
		expect(r.splitSample!.validation.scores.days).toBe(all.length - half);
		expect(r.splitSample!.calibration.start).toBe(iso(all[0]!));
		expect(r.splitSample!.calibration.end).toBe(iso(all[half - 1]!));
		expect(r.splitSample!.validation.start).toBe(iso(all[half]!));
		expect(r.splitSample!.validation.end).toBe(iso(all[all.length - 1]!));
		// The validation score is the split's parameters scored on the second half by a plain run.
		const p = runPairs(input, r.splitSample!.params);
		const o = p.o.slice(half);
		const s = p.s.slice(half);
		expect(r.splitSample!.validation.scores.kgePrime!).toBeCloseTo(kgePrime(o, s)!, 9);
	});

	it('dry → wet: years with ≥ 180 observed days ranked by mean observed flow, the driest half fitted and the wettest half validated', () => {
		const obs = input.series.flow_observed_m3s!.values;
		const byYear = new Map<number, number[]>();
		for (const t of all) {
			const wy = waterYearOf(d0 + t);
			byYear.set(wy, [...(byYear.get(wy) ?? []), obs[t]!]);
		}
		const ranked = [...byYear.entries()]
			.filter(([, v]) => v.length >= 180)
			.map(([y, v]) => ({ y, m: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }))
			.sort((a, b) => a.m - b.m);
		expect(ranked.length).toBeGreaterThanOrEqual(4);
		const k = Math.floor(ranked.length / 2);
		const dry = ranked.slice(0, k);
		const wet = ranked.slice(ranked.length - k);
		const d = r.differential!;
		expect(d.rankedBy).toBe('observed');
		expect(d.dryYears).toEqual(dry.map((x) => x.y).sort((a, b) => a - b));
		expect(d.wetYears).toEqual(wet.map((x) => x.y).sort((a, b) => a - b));
		const mean = (xs: typeof dry) => xs.reduce((a, x) => a + x.m * x.n, 0) / xs.reduce((a, x) => a + x.n, 0);
		expect(d.wetDryRatio).toBeCloseTo(mean(wet) / mean(dry), 9);
		expect(d.calibration.scores.days).toBe(dry.reduce((a, x) => a + x.n, 0));
		expect(d.validation.scores.days).toBe(wet.reduce((a, x) => a + x.n, 0));
	});
});

describe('independent record validation (§2.10b)', () => {
	it('scores the fitted parameters against the other record on its own days, with the same objective', () => {
		const input = single({ noise: 0.1 });
		const q = input.series.flow_observed_m3s!.values;
		// A logger 15 % low with its own gaps, on a shorter stretch.
		input.series.flow_logger_m3s = { startDate: START, values: q.map((v, t) => (t < 500 || t % 11 === 0 ? null : v! * 0.85)) };
		input.settings.calibrationFlowKind = 'flow_observed_m3s';
		const r = calibrate(input, { budget: 80, seed: 3, validate: false, validationRecord: 'flow_logger_m3s' });
		const ind = r.independentRecord!;
		expect(ind.flowKind).toBe('flow_logger_m3s');
		const { o, s, t } = runPairs(input, r.params, null, 'flow_logger_m3s');
		expect(ind.validation.scores.days).toBe(o.length);
		expect(ind.validation.scores.kgePrime!).toBeCloseTo(kgePrime(o, s)!, 9);
		// Every logger day is also a gauge day, so every one was fitted to.
		expect(ind.overlapDays).toBe(t.length);
		// β ≈ 1/0.85 against the low logger: the volume error shows it.
		expect(ind.validation.scores.volumeErrorPct!).toBeGreaterThan(10);
	}, 30_000);
});

describe('calibrating at a gauge inside the network (§2.10k)', () => {
	/**
	 * Invented "Rivierplaas": Farm Bo (40 km²) → inner weir H → outlet G ← Farm Onder (60 km², with a dam).
	 * The inner weir's record is the truth run's flow at H; the outlet carries a decoy record from other parameters.
	 */
	function network(): ModelInput {
		const days = Math.round(6 * 365.25);
		const input: ModelInput = {
			settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { ...TRUTH, warmupDays: 365 } },
			model: {
				nodes: [
					node({ id: 'G', name: 'Rivierplaas outlet', kind: 'gauge' }),
					node({ id: 'H', name: 'Rivierplaas weir', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 1 }),
					node({ id: 'A', name: 'Farm Bo', downstreamNodeId: 'H', areaKm2: 40, sortOrder: 2 }),
					node({
						id: 'B',
						name: 'Farm Onder',
						downstreamNodeId: 'G',
						areaKm2: 60,
						sortOrder: 3,
						damCapacityM3: 400_000,
						damInitialPct: 0.2,
						pctRunoffToDam: 0.8,
						damAreaFullM2: 60_000
					})
				],
				crops: [],
				cropAreas: [],
				transfers: []
			},
			series: { rain_catchment_mm: { startDate: START, values: rain(days, START, 31) } }
		};
		const truthOut = runModel(input);
		const atH = series(truthOut, 'outflow', 'H');
		input.series['flow_observed_m3s@H'] = { startDate: START, values: atH.map((v) => v / SEC) };
		// A decoy at the outlet: the run with very different parameters.
		const decoy = structuredClone(input);
		decoy.settings.gr4j = { x1: 900, x2: 0, x3: 30, x4: 4, warmupDays: 365 };
		input.series.flow_observed_m3s = { startDate: START, values: series(runModel(decoy), 'simulated_outflow').map((v) => v / SEC) };
		input.settings.gr4j = { ...DEFAULTS };
		input.settings.calibrationSiteNodeId = 'H';
		return input;
	}

	it("fits to the inner gauge's record against that node's outflow, not the outlet's, and recovers the truth", () => {
		const input = network();
		const r = calibrate(input, { budget: 1000, seed: 1, validate: false, bounds: 'typical' });
		expect(r.siteNodeId).toBe('H');
		expect(r.flowKind).toBe('flow_observed_m3s');
		expect(Math.abs(r.params.x1! / TRUTH.x1 - 1)).toBeLessThan(0.05);
		expect(Math.abs(r.params.x3! / TRUTH.x3 - 1)).toBeLessThan(0.05);
		expect(Math.abs(r.params.x4! - TRUTH.x4)).toBeLessThan(0.15);
		const atH = runPairs(input, r.params, 'H');
		expect(r.fit.scores.kgePrime!).toBeCloseTo(kgePrime(atH.o, atH.s)!, 9);
		// Positive control: the same record against the outlet's outflow scores very differently.
		const outletSim = series(atH.out, 'simulated_outflow');
		expect(Math.abs(kgePrime(atH.o, atH.t.map((t) => outletSim[t]!))! - r.fit.scores.kgePrime!)).toBeGreaterThan(0.05);
		expect(r.notes.some((n) => n.includes('Rivierplaas weir'))).toBe(true);
	}, 30_000);

	it("the run's own statistics follow the site: the weir's record against the weir's outflow", () => {
		const input = network();
		const out = runModel(input);
		const cal = out.summary.calibration!;
		expect(cal.siteNodeId).toBe('H');
		const { o, s } = runPairs(input, {}, 'H');
		const oS = o.map((v) => v / SEC);
		const sS = s.map((v) => v / SEC);
		const mo = oS.reduce((a, b) => a + b, 0) / oS.length;
		const nse = 1 - oS.reduce((a, v, i) => a + (v - sS[i]!) ** 2, 0) / oS.reduce((a, v) => a + (v - mo) ** 2, 0);
		expect(cal.days).toBe(o.length);
		expect(cal.nse!).toBeCloseTo(nse, 9);
	});
});

describe('more validation details (§2.10b)', () => {
	it('dry → wet ranked by a reference gauge: years follow the reference, never scored; the ratio stays the fitted record’s own', () => {
		const input = single({ years: 8, noise: 0.1 });
		const d0 = toEpochDay(START);
		const obs = input.series.flow_observed_m3s!.values;
		// A reference that ranks the water years in the reverse of the record's own order.
		const own = new Map<number, number[]>();
		obs.forEach((v, t) => own.set(waterYearOf(d0 + t), [...(own.get(waterYearOf(d0 + t)) ?? []), v!]));
		const full = [...own.entries()].filter(([, v]) => v.length >= 180).map(([y, v]) => ({ y, m: v.reduce((a, b) => a + b, 0) / v.length }));
		const order = [...full].sort((a, b) => a.m - b.m).map((x) => x.y); // driest first by the record
		const refLevel = new Map(order.map((y, i) => [y, 100 - i])); // reversed
		input.series.flow_reference_m3s = { startDate: START, values: obs.map((_, t) => refLevel.get(waterYearOf(d0 + t)) ?? 1) };
		const r = calibrate(input, { budget: 30, seed: 2 });
		const d = r.differential!;
		expect(d.rankedBy).toBe('reference');
		const k = Math.floor(order.length / 2);
		expect(d.dryYears).toEqual([...order.slice(order.length - k)].sort((a, b) => a - b));
		expect(d.wetYears).toEqual([...order.slice(0, k)].sort((a, b) => a - b));
		// The reference only ranks: the wet/dry ratio is the record's, here below 1.
		expect(d.wetDryRatio).toBeLessThan(1);
		// …and the split-sample test and the fit are what they are without it.
		const plain = structuredClone(input);
		delete plain.series.flow_reference_m3s;
		const p = calibrate(plain, { budget: 30, seed: 2 });
		expect(p.params).toEqual(r.params);
		expect(p.splitSample).toEqual(r.splitSample);
	}, 30_000);

	it('benchmarks of a validation period are built from its calibration period (engine ≥ 1.62.0): the mean-flow benchmark uses the first half’s mean', () => {
		const input = single({ noise: 0.1 });
		const r = calibrate(input, { budget: 30, seed: 2 });
		const { o } = runPairs(input, r.params);
		const half = Math.floor(o.length / 2);
		const calMean = o.slice(0, half).reduce((a, b) => a + b, 0) / half;
		const val = o.slice(half);
		const b = r.splitSample!.validation.benchmarks!;
		expect(b.builtFrom).toBe('calibration');
		expect(b.meanFlow.kgePrime!).toBeCloseTo(kgePrime(val, val.map(() => calMean))!, 9);
		// The fitted period's own benchmark is the textbook 1 − √2.
		expect(r.fit.benchmarks!.meanFlow.kgePrime!).toBeCloseTo(1 - Math.SQRT2, 9);
	}, 30_000);

	it('the WR2012 MAR penalty ratio is the simulated natural MAR over the complete water years inside the reference period ÷ the area-scaled target', () => {
		const input = single({ years: 6 });
		input.settings.wr2012 = {
			reference: { quaternary: 'Z98B', areaKm2: 70, marMm3: 6, monthlyMm3: Array.from({ length: 12 }, () => 0.5), periodStart: 2004, periodEnd: 2006, mapMm: null, source: 'Invented' },
			scaling: 'area',
			calibrationPenalty: { enabled: true, weight: 1, marLowMm3: null, marHighMm3: null }
		} as never;
		const r = calibrate(input, { budget: 30, seed: 1, validate: false });
		const p = r.marPenalty!;
		expect(p.basis).toBe('overlap');
		const target = 6 * (35 / 70);
		expect(p.targetMarMm3).toBeCloseTo(target, 12);
		const x = structuredClone(input);
		x.settings.gr4j = { ...x.settings.gr4j!, ...r.params };
		const nat = series(runModel(x), 'natural_flow');
		const d0 = toEpochDay(START);
		let s = 0;
		for (const wy of [2004, 2005, 2006]) for (let t = toEpochDay(`${wy}-10-01`) - d0; t <= toEpochDay(`${wy + 1}-09-30`) - d0; t++) s += nat[t]!;
		expect(p.marRatio).toBeCloseTo(s / 3 / 1e6 / target, 9);
	}, 30_000);
});
