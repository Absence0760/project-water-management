import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';
import { GR4J_PARAMS } from '../runoff/gr4j';
import { band, bandHolds, MIN_BAND_MEMBERS, quantileSorted } from './bands';
import {
	bandCoverage,
	diffEnsembleOptions,
	ensembleContext,
	ensembleMembers,
	memberMetrics,
	rejectReasons,
	resolveEnsembleOptions,
	runEnsemble,
	shiftPan,
	summariseEnsemble,
	type AcceptanceThresholds,
	type MemberScores
} from './ensemble';
import { pairedRefusal, runPairedEnsemble, summarisePaired } from './paired';
import { latinHypercube } from './sample';
import { memberMismatches, pickCheckedMembers, sampleMismatches, verifyEnsemble, verifyPaired } from './verify';

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

const TRUTH = { x1: 420, x2: 0, x3: 85, x4: 2.1 };

/**
 * Two farms draining to a gauge; the gauge record is the model's own outflow
 * under TRUTH with multiplicative noise, the logger the same with other
 * noise; CHIRPS is the station rain × 0.9 with noise. Synthetic throughout.
 */
function synthetic(opts: { years?: number; params?: typeof TRUTH; dam?: boolean } = {}): ModelInput {
	const start = '1990-10-01';
	const days = Math.round((opts.years ?? 5) * 365.25);
	const r = rain(days, start, 7);
	const noise = new Rng(11);
	const input: ModelInput = {
		settings: {
			runoffModel: 'gr4j',
			apanMm: apan as never,
			gr4j: { ...TRUTH, warmupDays: 365 },
			ewrPragmaticM3PerDay: [9000, 9000, 6000, 4000, 4000, 5000, 8000, 12000, 15000, 15000, 12000, 10000] as never
		},
		model: {
			nodes: [
				node({ id: 'G', name: 'Gauge', kind: 'gauge' }),
				node({ id: 'F1', name: 'Farm one', downstreamNodeId: 'G', areaKm2: 25 }),
				node({
					id: 'F2',
					name: 'Farm two',
					downstreamNodeId: 'G',
					areaKm2: 15,
					...(opts.dam ? { pctRunoffToDam: 1, damCapacityM3: 2e6, damInitialPct: 0, damAreaFullM2: 4e5 } : {})
				})
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: start, values: r },
			rain_chirps_mm: { startDate: start, values: r.map((v) => Math.round(v * 0.9 * noise.float(0.7, 1.3) * 10) / 10) }
		}
	};
	const flow = runModel(input).series.find((s) => s.key === 'simulated_outflow')!.values;
	input.series.flow_observed_m3s = { startDate: start, values: flow.map((q) => (q / 86_400) * noise.float(0.85, 1.15)) };
	input.series.flow_logger_m3s = { startDate: start, values: flow.map((q, t) => (t % 3 === 0 ? null : (q / 86_400) * noise.float(0.8, 1.2))) };
	input.settings.gr4j = { ...(opts.params ?? TRUTH), warmupDays: 365 };
	return input;
}

/** Loose enough that most members of the synthetic catchment pass. */
const LOOSE: Partial<AcceptanceThresholds> = { minSkill: 0.3, maxLowFlowBiasPct: 200 };

describe('Latin hypercube sample', () => {
	it('puts exactly one point in each of n strata of every dimension', () => {
		const n = 37;
		const rows = latinHypercube(n, 4, 5);
		for (let j = 0; j < 4; j++) {
			const strata = rows.map((r) => Math.floor(r[j]! * n)).sort((a, b) => a - b);
			expect(strata).toEqual(Array.from({ length: n }, (_, i) => i));
		}
	});

	it('is deterministic for a seed and differs across seeds', () => {
		expect(latinHypercube(20, 3, 9)).toEqual(latinHypercube(20, 3, 9));
		expect(latinHypercube(20, 3, 9)).not.toEqual(latinHypercube(20, 3, 10));
	});
});

describe('resolveEnsembleOptions', () => {
	const input = synthetic({ years: 4 });

	it('varies the free parameters, the pan coefficient, the rain source and the record when the project has them', () => {
		const { options, notes } = resolveEnsembleOptions(input, { members: 40 });
		expect(options.dimensions.map((d) => (d.kind === 'param' ? d.key : d.kind))).toEqual(['x1', 'x3', 'x4', 'pan', 'rain', 'record']);
		expect(options.records).toEqual(['flow_observed_m3s', 'flow_logger_m3s']);
		expect(options.rainSources).toEqual(['recorded', 'chirps']);
		expect(options.bounds).toBe('typical');
		expect(options.thresholds).toEqual({ objective: 'kgePrime', minSkill: 0.5, wr2012MaxLevel: 'query', maxLowFlowBiasPct: 50 });
		expect(notes).toContain('The WR2012 check does not filter members: the project has no WR2012 reference.');
	});

	it('samples a range spanning a factor of ten or more log-uniformly, a narrower one linearly', () => {
		const wide = resolveEnsembleOptions(input, { members: 40, bounds: 'wide' }).options;
		const dim = (o: typeof wide, k: string) => o.dimensions.find((d) => d.kind === 'param' && d.key === k);
		const x1 = GR4J_PARAMS.find((p) => p.key === 'x1')!;
		expect(dim(wide, 'x1')).toEqual({ kind: 'param', key: 'x1', min: x1.min, max: x1.max, scale: 'log' });
		expect(dim(wide, 'x3')).toMatchObject({ scale: 'log' });
		expect(dim(wide, 'x4')).toMatchObject({ min: 0.5, max: 10, scale: 'log' });
		const typical = resolveEnsembleOptions(input, { members: 40, bounds: 'typical' }).options;
		expect(dim(typical, 'x4')).toMatchObject({ min: 1.1, max: 2.9, scale: 'linear' });
		expect(dim(typical, 'x1')).toMatchObject({ min: 100, max: 1200, scale: 'log' });
	});

	it('puts the primary record first: the one the run calibrates against', () => {
		const logger = { ...input, settings: { ...input.settings, calibrationFlowKind: 'flow_logger_m3s' } };
		expect(resolveEnsembleOptions(logger, { members: 40 }).options.records).toEqual(['flow_logger_m3s', 'flow_observed_m3s']);
	});

	it('does not vary the pan coefficient for the legacy model, and says so', () => {
		const { options, notes } = resolveEnsembleOptions(input, { members: 40, model: 'legacy', panOffset: 0.1 });
		expect(options.panOffset).toBe(0);
		expect(options.dimensions.some((d) => d.kind === 'pan')).toBe(false);
		expect(notes.join(' ')).toMatch(/legacy model does not use potential evaporation/);
	});

	it('refuses what the project cannot run', () => {
		expect(() => resolveEnsembleOptions(input, { members: 29 })).toThrow(/members must be/);
		expect(() => resolveEnsembleOptions(input, { members: 1001 })).toThrow(/members must be/);
		expect(() => resolveEnsembleOptions(input, { free: ['nope'] })).toThrow(/not a gr4j parameter/);
		expect(() => resolveEnsembleOptions(input, { panOffset: 0.5 })).toThrow(/pan offset/);
		const noChirps = { ...input, series: { ...input.series, rain_chirps_mm: undefined } };
		expect(() => resolveEnsembleOptions(noChirps, { rainSources: ['chirps'] })).toThrow(/CHIRPS-only rain source is not available/);
		const noFlow = { ...input, series: { rain_catchment_mm: input.series.rain_catchment_mm } };
		expect(() => resolveEnsembleOptions(noFlow)).toThrow(/needs an observed flow record/);
	});
});

describe('the sample', () => {
	const input = synthetic({ years: 4 });
	const { options } = resolveEnsembleOptions(input, { members: 60, bounds: 'wide' });
	const ctx = ensembleContext(input, options);
	const members = ensembleMembers(options, ctx.startParams);

	it('starts with the run itself: its own parameters, no pan shift, its rain and record', () => {
		expect(members[0]).toEqual({ index: 0, reference: true, params: { ...TRUTH }, panOffset: 0, rain: 'recorded', record: 'flow_observed_m3s' });
		expect(members).toHaveLength(61);
	});

	it('keeps every sampled value inside its bounds and splits categories evenly', () => {
		for (const d of options.dimensions) {
			if (d.kind === 'param') for (const m of members.slice(1)) expect(m.params[d.key]).toBeGreaterThanOrEqual(d.min), expect(m.params[d.key]).toBeLessThanOrEqual(d.max);
			if (d.kind === 'pan') for (const m of members.slice(1)) expect(Math.abs(m.panOffset)).toBeLessThanOrEqual(d.max);
		}
		const count = (f: (m: (typeof members)[number]) => boolean) => members.slice(1).filter(f).length;
		expect(count((m) => m.rain === 'chirps')).toBe(30);
		expect(count((m) => m.record === 'flow_logger_m3s')).toBe(30);
		expect(members.slice(1).every((m) => m.params.x2 === 0)).toBe(true);
	});

	it('is the same for the same seed and differs for another', () => {
		expect(ensembleMembers(options, ctx.startParams)).toEqual(members);
		expect(ensembleMembers({ ...options, seed: 2 }, ctx.startParams)).not.toEqual(members);
	});

	it('shifts the pan coefficient inside the FAO-56 range, never away from an out-of-range project value', () => {
		expect(shiftPan([0.7, 0.8, 0.4], 0.1)).toEqual([0.7999999999999999, 0.85, 0.5]);
		expect(shiftPan([0.7, 0.4], -0.1)).toEqual([0.6, 0.35]);
		expect(shiftPan([0.9], 0.1)).toEqual([0.9]);
	});
});

describe('acceptance filters', () => {
	const t: AcceptanceThresholds = { objective: 'kgePrime', minSkill: 0.5, wr2012MaxLevel: 'query', maxLowFlowBiasPct: 50 };
	const s = (over: Partial<MemberScores>): MemberScores => ({ skill: 0.7, lowFlowBiasPct: 10, wr2012Level: null, wr2012MarMm3: null, wr2012InBand: null, ...over });

	it('keeps a member passing every check', () => {
		expect(rejectReasons(t, s({}))).toEqual([]);
		expect(rejectReasons(t, s({ skill: 0.5, lowFlowBiasPct: -50, wr2012Level: 'query' }))).toEqual([]);
	});
	it('rejects on the skill score, including one that cannot be computed', () => {
		expect(rejectReasons(t, s({ skill: 0.49 }))).toEqual(['skill']);
		expect(rejectReasons(t, s({ skill: null }))).toEqual(['skill']);
	});
	it('rejects on the WR2012 flag and the MAR band; "unusable" switches the check off', () => {
		expect(rejectReasons(t, s({ wr2012Level: 'unusable' }))).toEqual(['wr2012']);
		expect(rejectReasons({ ...t, wr2012MaxLevel: 'note' }, s({ wr2012Level: 'query' }))).toEqual(['wr2012']);
		expect(rejectReasons(t, s({ wr2012Level: 'ok', wr2012InBand: false }))).toEqual(['wr2012']);
		expect(rejectReasons({ ...t, wr2012MaxLevel: 'unusable' }, s({ wr2012Level: 'unusable', wr2012InBand: false }))).toEqual([]);
	});
	it('rejects on the low-flow bias either way, and one that cannot be computed; null switches it off', () => {
		expect(rejectReasons(t, s({ lowFlowBiasPct: 51 }))).toEqual(['lowFlow']);
		expect(rejectReasons(t, s({ lowFlowBiasPct: -51 }))).toEqual(['lowFlow']);
		expect(rejectReasons(t, s({ lowFlowBiasPct: null }))).toEqual(['lowFlow']);
		expect(rejectReasons({ ...t, maxLowFlowBiasPct: null }, s({ lowFlowBiasPct: null }))).toEqual([]);
	});
	it('lists every failed check', () => {
		expect(rejectReasons(t, s({ skill: 0, wr2012Level: 'unusable', lowFlowBiasPct: 90 }))).toEqual(['skill', 'wr2012', 'lowFlow']);
	});
});

describe('bands', () => {
	it('show no percentiles with fewer than 30 values, and do with 30', () => {
		const v = Array.from({ length: MIN_BAND_MEMBERS - 1 }, (_, i) => i);
		expect(band(v)).toEqual({ n: 29, p5: null, p50: null, p95: null, min: 0, max: 28 });
		const b = band([...v, 29]);
		expect(b.n).toBe(30);
		expect(b.p5).toBeCloseTo(1.45, 12);
		expect(b.p50).toBeCloseTo(14.5, 12);
		expect(b.p95).toBeCloseTo(27.55, 12);
	});

	it('use the linear (type 7) percentile and ignore missing values', () => {
		expect(quantileSorted([1, 2, 3, 4], 50)).toBe(2.5);
		expect(quantileSorted([7], 95)).toBe(7);
		expect(quantileSorted([], 50)).toBeNull();
		expect(band([1, null, 2, undefined, NaN, 3], 1)).toMatchObject({ n: 3, p50: 2 });
	});

	it('always contain the median (invariant, random ensembles)', () => {
		const rng = new Rng(3);
		for (let k = 0; k < 200; k++) {
			const v = Array.from({ length: rng.int(30, 200) }, () => (rng.bool(0.3) ? rng.int(0, 5) : rng.logFloat(0.01, 1e6)) * (rng.bool(0.2) ? -1 : 1));
			const b = band(v);
			expect(b.min!).toBeLessThanOrEqual(b.p5!);
			expect(b.p5!).toBeLessThanOrEqual(b.p50!);
			expect(b.p50!).toBeLessThanOrEqual(b.p95!);
			expect(b.p95!).toBeLessThanOrEqual(b.max!);
			expect(bandHolds(b, b.p50!)).toBe(true);
		}
	});
});

describe('coverage statistic', () => {
	it('counts observations inside the day-by-day 5–95 % band', () => {
		// 100 members valued 1 … 100 every day: the band is [5.95, 95.05].
		const sims = Array.from({ length: 100 }, (_, i) => [i + 1, i + 1, i + 1, i + 1, i + 1]);
		expect(bandCoverage(sims, [50, 5.95, 95.05, 5, 96])).toBe(3);
	});
	it('reads each day on its own', () => {
		const sims = Array.from({ length: 40 }, (_, i) => [i, 100 + i]);
		expect(bandCoverage(sims, [20, 20])).toBe(1);
	});
});

describe('runEnsemble on a synthetic catchment', () => {
	const input = synthetic({ years: 5 });
	const { options } = resolveEnsembleOptions(input, { members: 45, thresholds: LOOSE });
	const result = runEnsemble(input, options);
	const summary = summariseEnsemble(result);

	it('is reproducible: the same seed and options give the same ensemble, another seed another', () => {
		expect(runEnsemble(input, options)).toEqual(result);
		const other = runEnsemble(input, { ...options, seed: 99 });
		expect(other.members.slice(1).map((m) => m.params)).not.toEqual(result.members.slice(1).map((m) => m.params));
	});

	it('keeps exactly the members that pass the stored thresholds, with outputs only for them', () => {
		expect(result.members).toHaveLength(46);
		for (const m of result.members) {
			expect(m.accepted).toBe(rejectReasons(options.thresholds, m.scores).length === 0);
			expect(m.metrics === null).toBe(!m.accepted);
		}
		expect(summary.accepted).toBe(result.members.filter((m) => m.accepted).length);
		expect(summary.accepted).toBeGreaterThanOrEqual(MIN_BAND_MEMBERS);
		expect(summary.gated).toBe(false);
	});

	it('member 0 is the run itself: its outputs are the plain run’s', () => {
		const ref = result.members[0]!;
		expect(ref.reference && ref.accepted).toBe(true);
		const ctx = ensembleContext(input, options);
		expect(ref.metrics).toEqual(memberMetrics(ctx, runModel(input)));
		expect(ref.metrics!.ewrDaysNotMet).toBe(runModel(input).summary.catchment.ewrDaysNotMet);
	});

	it('invariant: the best-fit run lies within [min, max] of the ensemble when it passes acceptance', () => {
		const ref = result.members[0]!.metrics!;
		const within = (b: { min: number | null; max: number | null }, x: number) => {
			expect(b.min!).toBeLessThanOrEqual(x);
			expect(b.max!).toBeGreaterThanOrEqual(x);
		};
		const b = summary.bands;
		within(b.ewrDaysNotMet, ref.ewrDaysNotMet);
		within(b.shortfallMm3, ref.shortfallMm3);
		within(b.marNaturalMm3, ref.marNaturalMm3);
		within(b.marOutflowMm3, ref.marOutflowMm3);
		b.ewrDaysNotMetByMonth.forEach((x, i) => within(x, ref.ewrDaysNotMetByMonth[i]!));
		b.annual.forEach((y, i) => within(y.outflow, ref.annualOutflowMm3[i]!));
		b.curtailment.forEach((f) => within(f.band, ref.curtailmentM3Day[f.nodeId]!));
		b.fdc.forEach((m, i) => m.points.forEach((p, j) => within(p, ref.fdcM3Day[i]![j]!)));
	});

	it('invariant: every band contains its median', () => {
		const all = [
			summary.bands.ewrDaysNotMet,
			summary.bands.shortfallMm3,
			summary.bands.marNaturalMm3,
			...summary.bands.ewrDaysNotMetByMonth,
			...summary.bands.annual.flatMap((y) => [y.natural, y.outflow]),
			...summary.bands.fdc.flatMap((m) => m.points)
		];
		for (const b of all) expect(bandHolds(b, b.p50!)).toBe(true);
	});

	it('reports coverage of the held-out half for each record, and the rule it used', () => {
		expect(result.coverage.map((c) => c.record)).toEqual(['flow_observed_m3s', 'flow_logger_m3s']);
		for (const c of result.coverage) {
			expect(c.heldOutDays).toBeGreaterThan(300);
			expect(c.fraction).toBeCloseTo(c.inside! / c.heldOutDays, 5);
			expect(c.warning).toBe(c.fraction! < 0.7);
		}
		expect(result.header.splitDate > '1992-10-01' && result.header.splitDate < '1994-06-01').toBe(true);
		expect(summary.decisionRule).toContain(`KGE′ ≥ 0.30 against its observed record before ${result.header.splitDate}`);
		expect(summary.decisionRule).toContain('a low-flow FDC bias within ±200 %');
		expect(summary.decisionRule).toContain('shown only with at least 30 kept');
		expect(summary.decisionRule).toContain('seed 1');
	});

	it('bands every output the criteria ask for', () => {
		const b = summary.bands;
		expect(b.ewrDaysNotMetByMonth).toHaveLength(12);
		expect(b.curtailment.map((f) => f.name)).toEqual(['Farm one', 'Farm two']);
		expect(b.annual.map((y) => y.waterYear)).toEqual([1990, 1991, 1992, 1993, 1994]);
		expect(b.annual.every((y) => y.days >= 365)).toBe(true);
		expect(b.fdc).toHaveLength(12);
		expect(b.fdc[0]!.month).toBe(10);
		expect(b.fdc[0]!.ewrM3Day).toBe(9000);
		expect(b.fdc[0]!.points).toHaveLength(result.header.fdcPoints.length);
		// A flow-duration curve never rises with exceedance.
		for (const m of b.fdc) for (let j = 1; j < m.points.length; j++) expect(m.points[j]!.p50!).toBeLessThanOrEqual(m.points[j - 1]!.p50! + 1e-9);
	});

	it('shows no percentiles when fewer than 30 members pass, and says so', () => {
		const strict = runEnsemble(input, { ...options, members: 30, thresholds: { ...options.thresholds, minSkill: 0.999 } });
		const s = summariseEnsemble(strict);
		expect(s.gated).toBe(true);
		expect(s.bands.ewrDaysNotMet.p50).toBeNull();
		expect(strict.coverage.every((c) => c.fraction === null)).toBe(true);
		expect(s.notes.join(' ')).toMatch(/fewer than 30, so no percentiles are shown/);
		expect(s.notes.join(' ')).toMatch(/run's own parameters fail the rule \(skill score\)/);
	});

	it('stops when asked and marks the result cancelled', () => {
		const r = runEnsemble(input, options, { onProgress: (p) => p.done >= 5 });
		expect(r.cancelled).toBe(true);
		expect(r.members).toHaveLength(5);
	});

	it('verifies an honest ensemble and catches a tampered one', () => {
		const ctx = ensembleContext(input, options);
		expect(sampleMismatches(ctx, result.members)).toEqual([]);
		expect(verifyEnsemble(input, options, result.members, 3, new Rng(1).next.bind(new Rng(1)))).toEqual([]);
		const moved = result.members.map((m, i) => (i === 7 ? { ...m, params: { ...m.params, x1: m.params.x1! * 1.01 } } : m));
		expect(sampleMismatches(ctx, moved)[0]).toMatch(/^member 7 \.params\.x1|^member 7\.params\.x1/);
		const kept = result.members.findIndex((m, i) => i > 0 && m.accepted);
		const forged = result.members.map((m, i) => (i === kept ? { ...m, metrics: { ...m.metrics!, ewrDaysNotMet: m.metrics!.ewrDaysNotMet + 50 } } : m));
		expect(memberMismatches(ctx, forged, [kept]).join(' ')).toMatch(/ewrDaysNotMet/);
		const flipped = result.members.map((m, i) => (i === kept ? { ...m, accepted: false } : m));
		expect(memberMismatches(ctx, flipped, [kept]).join(' ')).toMatch(/kept false, recomputed true/);
	});

	it('picks distinct members to check, kept ones first', () => {
		const picks = pickCheckedMembers(result.members, 3, new Rng(4).next.bind(new Rng(4)));
		expect(new Set(picks).size).toBe(3);
		expect(picks.filter((i) => result.members[i]!.accepted).length).toBeGreaterThanOrEqual(2);
		expect(pickCheckedMembers([{ accepted: true }, { accepted: true }], 3, Math.random)).toEqual([0, 1]);
	});

	it('diffs two ensembles’ rules, thresholds first', () => {
		const b = resolveEnsembleOptions(input, { members: 45, thresholds: { ...LOOSE, minSkill: 0.6 }, seed: 5 }).options;
		expect(diffEnsembleOptions(options, b)).toEqual([
			{ label: 'Lowest skill kept', a: '0.3', b: '0.6' },
			{ label: 'Seed', a: '1', b: '5' }
		]);
		expect(diffEnsembleOptions(options, options)).toEqual([]);
	});
});

describe('paired bands on the difference between a run and its baseline', () => {
	const base = synthetic({ years: 5 });
	const withDam = synthetic({ years: 5, dam: true });
	// The application's inputs: the baseline's observed record, with a new dam on farm two.
	const application: ModelInput = { ...base, model: withDam.model };
	const { options } = resolveEnsembleOptions(base, { members: 40, thresholds: LOOSE });
	const baseline = runEnsemble(base, options);

	it('are exactly zero when the other run has the same inputs', () => {
		const same = summarisePaired(baseline, runPairedEnsemble(base, baseline));
		expect(same.members).toBe(baseline.members.filter((m) => m.accepted).length);
		for (const b of [same.ewrDaysNotMet, same.shortfallMm3, same.marOutflowMm3, ...same.ewrDaysNotMetByMonth]) {
			expect([b.p5, b.p50, b.p95, b.min, b.max]).toEqual([0, 0, 0, 0, 0]);
		}
		expect(same.ewrDaysNotMetWorse).toBe(0);
	});

	it('take the difference member by member, so the new dam’s impact is banded', () => {
		const paired = runPairedEnsemble(application, baseline);
		const s = summarisePaired(baseline, paired);
		const keptBase = baseline.members.filter((m) => m.accepted);
		const diffs = paired.members.map((p, i) => p.metrics.marOutflowMm3 - keptBase[i]!.metrics!.marOutflowMm3);
		expect(s.marOutflowMm3).toEqual(band(diffs));
		// A dam that stores and evaporates water lowers the outflow in every member.
		expect(s.marOutflowMm3.max!).toBeLessThan(0);
		expect(s.marNaturalMm3.max).toBe(0);
		expect(s.ewrDaysNotMet.min!).toBeGreaterThanOrEqual(0);
		expect(s.ewrDaysNotMetWorse!).toBeGreaterThan(0.5);
		expect(s.curtailment.map((f) => f.nodeId)).toEqual(['F1', 'F2']);
		expect(s.decisionRule).toMatch(/percentiles of the difference \(other − baseline\)/);
		// The server's check agrees, and catches a forged pair.
		const kept = baseline.members.filter((m) => m.accepted);
		expect(verifyPaired(application, options, kept, paired.members, 3, new Rng(2).next.bind(new Rng(2)))).toEqual([]);
		const forged = paired.members.map((p) => ({ ...p, metrics: { ...p.metrics, ewrDaysNotMet: 0 } }));
		expect(verifyPaired(application, options, kept, forged, 1, () => 0).join(' ')).toMatch(/ewrDaysNotMet/);
	});

	it('refuse two runoff models (never pooled) and two different periods', () => {
		expect(pairedRefusal({ ...application, settings: { ...application.settings, runoffModel: 'legacy' } }, baseline)).toMatch(/different runoff models/);
		expect(() => runPairedEnsemble({ ...application, settings: { ...application.settings, runoffModel: 'legacy' } }, baseline)).toThrow(/different runoff models/);
		const shorter = { ...application, settings: { ...application.settings, simulationEnd: '1994-09-30' } };
		expect(pairedRefusal(shorter, baseline)).toMatch(/different periods/);
		expect(pairedRefusal(application, baseline)).toBeNull();
	});
});
