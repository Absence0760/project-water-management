// Automatic calibration of a runoff model (issue #4 §3): GR4J, or the legacy
// b023 model so the two can be compared on equal terms (issue #4 phase 6).
//
// What is scored is the *whole run*: runoff model → natural flow → the network (farms,
// dams, abstraction, transfers) → the series that matches the observed
// record, exactly as runModel scores it (simulated outflow for a gauge or
// logger record, natural flow for naturalised Pitman flow; audit C1). So the
// fitted parameters describe the catchment's *natural* response and the
// network adds the human impacts on top.
//
// Validation is always reported:
// - split-sample (Klemeš 1986): fit on the first half of the observed days,
//   score the second half with those parameters;
// - differential split-sample, where the record allows it: fit on the driest
//   half of the water years, score the wettest half. A short, drought-heavy
//   record can't show how the model behaves in wet years, and the report says
//   so instead of hiding it.
import { fromEpochDay, toEpochDay } from '../calendar';
import { computeNaturalFlow } from '../flow';
import { simulateNetwork } from '../network/simulate';
import { waterYearOf } from '../network/stats';
import type { ModelInput } from '../project';
import { buildNetworkPlan, pickObservedKind, prepareRun } from '../run';
import { requireCatchmentAreaKm2 } from '../runoff/area';
import { gr4j, GR4J_PARAMS, type Gr4jParams } from '../runoff/gr4j';
import { LEGACY_PARAMS } from '../runoff/legacy';
import type { ParamSpec, RunoffModelId } from '../runoff/types';
import { resolveParams, resolveWarmupDays, runoffForcing, simulateRunoff } from '../runoff/simulate';
import { dds } from './dds';
import { fitScores, OBJECTIVE_LABELS, objectiveLoss, type FitScores, type ObjectiveId } from './objective';

const SEC_PER_DAY = 86_400;

/** Parameter values by key (GR4J's x1…x4, or legacy CalibrationParams keys). */
export type ParamSet = Record<string, number>;

/** The parameters automatic calibration can fit, per runoff model. */
export const CALIBRATION_PARAMS: Record<RunoffModelId, ParamSpec<Record<string, number>>[]> = {
	gr4j: GR4J_PARAMS as unknown as ParamSpec<Record<string, number>>[],
	legacy: LEGACY_PARAMS as unknown as ParamSpec<Record<string, number>>[]
};

export interface DateRange {
	/** Inclusive ISO dates. */
	start: string;
	end: string;
}

export interface CalibrateOptions {
	/** Runoff model to fit. Default: the project's settings.runoffModel. */
	model?: RunoffModelId;
	/** Default 'kgePrime'. */
	objective?: ObjectiveId;
	/** Model runs per optimisation (the full fit, and each validation fit). Default 1 500. */
	budget?: number;
	/** Default 1. The same seed gives the same result. */
	seed?: number;
	/**
	 * Parameters to fit; the rest keep their current value. Default: every
	 * parameter not fixed by default (GR4J X1, X3, X4, with X2 as set, normally
	 * 0; legacy a, b and the season factors).
	 */
	free?: string[];
	/** Periods left out of every score (a gauge outage, a known bad stretch). */
	exclusions?: DateRange[];
	/** Also run the split-sample and differential split-sample tests. Default true. */
	validate?: boolean;
	/** Progress after every model run; return true to cancel (the best so far is returned). */
	onProgress?: (p: CalibrationProgress) => boolean | void;
}

export type CalibrationStage = 'full' | 'split' | 'dsst';

export interface CalibrationProgress {
	stage: CalibrationStage;
	/** Model runs done in this stage, and the stage's budget. */
	evaluations: number;
	budget: number;
	/** Best objective score so far in this stage (higher is better). */
	best: number;
}

export interface ScoredPeriod {
	/** First and last observed day scored. */
	start: string;
	end: string;
	scores: FitScores;
}

export interface ValidationTest {
	/** Parameters fitted on the calibration part. */
	params: ParamSet;
	calibration: ScoredPeriod;
	validation: ScoredPeriod;
}

export interface DifferentialTest extends ValidationTest {
	/** Water years (by the calendar year they start in) fitted, and validated. */
	dryYears: number[];
	wetYears: number[];
	/** Mean observed flow of the wet years ÷ that of the dry years. */
	wetDryRatio: number;
}

export interface CalibrationReport {
	model: RunoffModelId;
	objective: ObjectiveId;
	budget: number;
	seed: number;
	free: string[];
	/** Best parameters over the whole window: what "Apply" would put in the form (settings.gr4j, or settings.calibration for legacy). */
	params: ParamSet;
	/** The parameters the project had, for comparison. */
	startParams: ParamSet;
	/** The flow record fitted to, and what it was compared with. */
	flowKind: string;
	simulatedKey: 'natural_flow' | 'simulated_outflow';
	fit: ScoredPeriod;
	/** The project's current parameters scored on the same days. */
	before: ScoredPeriod;
	splitSample: ValidationTest | null;
	differential: DifferentialTest | null;
	/** Plain-language limits of the validation (e.g. no wet years to test on). */
	notes: string[];
	/** Model runs used, over every stage. */
	evaluations: number;
	cancelled: boolean;
}

/** Everything a calibration needs, built once: forcing, network plan, observed record, scored days. */
export interface CalibrationProblem {
	model: RunoffModelId;
	startDate: string;
	days: number;
	area: number;
	startParams: ParamSet;
	flowKind: string;
	scoreNatural: boolean;
	/** Observed flow (m³/day), NaN where missing. */
	observed: Float64Array;
	/** Day indices scored: observed, inside the calibration window, outside every exclusion. */
	scoredDays: Int32Array;
	/** The simulated series to score (m³/day) for a parameter set. */
	simulate(p: ParamSet): Float64Array;
}

/** Build the calibration problem for a project. Throws when there is nothing to calibrate against. */
export function prepareCalibration(input: ModelInput, exclusions: DateRange[] = [], model?: RunoffModelId): CalibrationProblem {
	const run = prepareRun(input);
	const { settings, days, startDate, aligned, month, warnings } = run;
	const modelId = model ?? settings.runoffModel;
	const area = requireCatchmentAreaKm2(settings.calibration, input);
	const startParams: ParamSet =
		modelId === 'gr4j'
			? { ...resolveParams<Gr4jParams>(GR4J_PARAMS, settings.gr4j, 'GR4J', warnings) }
			: Object.fromEntries(LEGACY_PARAMS.map((s) => [s.key, settings.calibration[s.key] as number]));
	const natural = new Float64Array(days);
	const { plan, topo } = buildNetworkPlan(input, settings, days, month, aligned, natural, warnings);

	const kind = pickObservedKind(settings.calibrationFlowKind, input.series ?? {}, warnings);
	if (!kind) throw new Error('no observed flow series to calibrate against: upload a gauge or logger record');
	const scoreNatural = kind === 'flow_pitman_m3s';
	const obs = aligned(kind);
	const observed = Float64Array.from(obs, (v) => (v === null ? NaN : v * SEC_PER_DAY));

	const d0 = run.start;
	const lo = settings.calibrationStart ? toEpochDay(settings.calibrationStart) - d0 : 0;
	const hi = settings.calibrationEnd ? toEpochDay(settings.calibrationEnd) - d0 : days - 1;
	const excluded = new Uint8Array(days);
	for (const x of exclusions) {
		const a = Math.max(0, toEpochDay(x.start) - d0);
		const b = Math.min(days - 1, toEpochDay(x.end) - d0);
		for (let t = a; t <= b; t++) excluded[t] = 1;
	}
	const idx: number[] = [];
	for (let t = Math.max(0, lo); t <= Math.min(days - 1, hi); t++) if (Number.isFinite(observed[t]!) && !excluded[t]) idx.push(t);
	if (idx.length < 30) {
		throw new Error(`only ${idx.length} observed days inside the calibration window (outside exclusions); at least 30 are needed`);
	}

	// The network is causal: nothing after the last scored day changes a
	// score, so each evaluation stops there (the full run is ~20 ms on a
	// 44-year catchment; a record that ends early saves the rest).
	const n = idx[idx.length - 1]! + 1;
	const shortPlan = { ...plan, days: n };
	const toM3 = area * 1000;
	let runoff: (p: ParamSet) => void;
	if (modelId === 'gr4j') {
		const warmupDays = resolveWarmupDays(settings.gr4j?.warmupDays, warnings);
		const forcing = runoffForcing(settings, { startDate, days, aligned });
		// The warm-up cycles the *full* forcing, as runModel's does, so a
		// scored day sees exactly the state a normal run would give it.
		runoff = (p) => {
			const tr = simulateRunoff(gr4j, p as unknown as Gr4jParams, forcing, { warmupDays, trace: false, days: n });
			for (let t = 0; t < n; t++) natural[t] = tr.qMm[t]! * toM3;
		};
	} else {
		const inputs = {
			startDate,
			days: n,
			rainCatchmentMm: aligned('rain_catchment_mm'),
			rainChirpsMm: aligned('rain_chirps_mm'),
			rainForecastMm: aligned('rain_forecast_mm'),
			flowPitmanM3s: aligned('flow_pitman_m3s')
		};
		runoff = (p) => {
			const nf = computeNaturalFlow({ ...settings.calibration, ...p, catchmentAreaKm2: area }, inputs).naturalFlowM3Day;
			for (let t = 0; t < n; t++) natural[t] = Number.isFinite(nf[t]!) ? nf[t]! : 0;
		};
	}
	return {
		model: modelId,
		startDate,
		days,
		area,
		startParams,
		flowKind: kind,
		scoreNatural,
		observed,
		scoredDays: Int32Array.from(idx),
		simulate(p) {
			runoff(p);
			if (scoreNatural) return natural;
			if (topo.outflow < 0) return new Float64Array(days);
			return simulateNetwork(shortPlan).nodes[topo.outflow]!.outflow;
		}
	};
}

/** Observed and simulated values on the given days. */
function pair(obs: Float64Array, sim: Float64Array, idx: Int32Array): [Float64Array, Float64Array] {
	const o = new Float64Array(idx.length);
	const s = new Float64Array(idx.length);
	for (let i = 0; i < idx.length; i++) {
		o[i] = obs[idx[i]!]!;
		s[i] = sim[idx[i]!]!;
	}
	return [o, s];
}

/** Water year of each of the given run days. */
function yearsOf(pb: CalibrationProblem, idx: Int32Array): Int32Array {
	const d0 = toEpochDay(pb.startDate);
	return Int32Array.from(idx, (t) => waterYearOf(d0 + t));
}

function scored(pb: CalibrationProblem, p: ParamSet, idx: Int32Array): ScoredPeriod {
	const [o, s] = pair(pb.observed, pb.simulate(p), idx);
	const d0 = toEpochDay(pb.startDate);
	return { start: fromEpochDay(d0 + idx[0]!), end: fromEpochDay(d0 + idx[idx.length - 1]!), scores: fitScores(o, s, yearsOf(pb, idx)) };
}

interface FitResult {
	params: ParamSet;
	evaluations: number;
	cancelled: boolean;
}

function fit(pb: CalibrationProblem, idx: Int32Array, free: string[], objective: ObjectiveId, budget: number, seed: number, stage: CalibrationStage, onProgress: CalibrateOptions['onProgress']): FitResult {
	const specs = free.map((k) => CALIBRATION_PARAMS[pb.model].find((s) => s.key === k)!);
	const p: ParamSet = { ...pb.startParams };
	const obs = new Float64Array(idx.length);
	for (let i = 0; i < idx.length; i++) obs[i] = pb.observed[idx[i]!]!;
	const sim = new Float64Array(idx.length);
	const years = yearsOf(pb, idx);
	const loss = (x: Float64Array) => {
		for (let j = 0; j < specs.length; j++) p[specs[j]!.key] = x[j]!;
		const full = pb.simulate(p);
		for (let i = 0; i < idx.length; i++) sim[i] = full[idx[i]!]!;
		return objectiveLoss(objective, obs, sim, years);
	};
	const res = dds(
		loss,
		specs.map((s) => ({ min: s.min, max: s.max })),
		{
			budget,
			seed,
			x0: specs.map((s) => pb.startParams[s.key]!),
			onEvaluation: (n, f) => onProgress?.({ stage, evaluations: n, budget, best: 1 - f }) === true
		}
	);
	const params: ParamSet = { ...pb.startParams };
	specs.forEach((s, j) => (params[s.key] = res.x[j]!));
	return { params, evaluations: res.evaluations, cancelled: res.stopped };
}

/** Days grouped by water year, for water years with at least `minDays` scored days. */
function waterYears(pb: CalibrationProblem, minDays: number): { year: number; idx: number[]; mean: number }[] {
	const d0 = toEpochDay(pb.startDate);
	const by = new Map<number, number[]>();
	for (const t of pb.scoredDays) {
		const wy = waterYearOf(d0 + t);
		let list = by.get(wy);
		if (!list) by.set(wy, (list = []));
		list.push(t);
	}
	return [...by.entries()]
		.filter(([, idx]) => idx.length >= minDays)
		.map(([year, idx]) => ({ year, idx, mean: idx.reduce((a, t) => a + pb.observed[t]!, 0) / idx.length }));
}

/** A validation score this much below its calibration score is called out. */
export const VALIDATION_DROP = 0.2;

/**
 * Plain-language limits of the validation: a score that falls sharply on the
 * part of the record the model wasn't fitted to, or a dry → wet test resting
 * on very few years.
 */
export function validationNotes(objective: ObjectiveId, split: ValidationTest | null, dsst: DifferentialTest | null): string[] {
	const out: string[] = [];
	const label = OBJECTIVE_LABELS[objective].replace(/ \(.*\)$/, '');
	const drop = (t: ValidationTest) => {
		const a = t.calibration.scores[objective];
		const b = t.validation.scores[objective];
		return a !== null && b !== null && a - b > VALIDATION_DROP ? [a, b] : null;
	};
	const s = split && drop(split);
	if (s) {
		out.push(
			`On the split-sample test ${label} falls from ${s[0]!.toFixed(2)} (the half the model was fitted to) to ${s[1]!.toFixed(2)} (the other half): ` +
				'the fit does not carry over well, so treat results outside the calibration period with caution.'
		);
	}
	const d = dsst && drop(dsst);
	if (d) {
		out.push(
			`Fitted to the dry years, ${label} falls from ${d[0]!.toFixed(2)} to ${d[1]!.toFixed(2)} on the wet years: wet-year behaviour is uncertain.`
		);
	}
	if (dsst && dsst.wetYears.length < 3) {
		out.push(
			`The dry → wet test rests on ${dsst.dryYears.length} dry and ${dsst.wetYears.length} wet water year${dsst.wetYears.length === 1 ? '' : 's'}, too few for a firm conclusion.`
		);
	}
	return out;
}

const MIN_DAYS_PER_YEAR = 180;
const WET_DRY_CONTRAST = 1.5;

/** Calibrate a runoff model's parameters against the project's observed flow. */
export function calibrate(input: ModelInput, opts: CalibrateOptions = {}): CalibrationReport {
	const objective = opts.objective ?? 'kgePrime';
	const budget = Math.max(10, Math.floor(opts.budget ?? 1500));
	const seed = opts.seed ?? 1;
	const pb = prepareCalibration(input, opts.exclusions, opts.model);
	const specs = CALIBRATION_PARAMS[pb.model];
	const free = opts.free ?? specs.filter((s) => !s.fixedByDefault).map((s) => s.key);
	if (free.length === 0) throw new Error('no parameters to calibrate');
	const unknown = free.filter((k) => !specs.some((s) => s.key === k));
	if (unknown.length) throw new Error(`not a calibratable ${pb.model} parameter: ${unknown.join(', ')}`);
	let evaluations = 0;
	let cancelled = false;
	const run = (idx: Int32Array, stage: CalibrationStage, s: number) => {
		const r = fit(pb, idx, free, objective, budget, s, stage, opts.onProgress);
		evaluations += r.evaluations;
		cancelled ||= r.cancelled;
		return r.params;
	};

	const all = pb.scoredDays;
	const params = run(all, 'full', seed);
	const notes: string[] = [];
	let splitSample: ValidationTest | null = null;
	let differential: DifferentialTest | null = null;

	if (opts.validate !== false && !cancelled) {
		// Split-sample: first half of the observed days vs the second.
		const half = Math.floor(all.length / 2);
		const a = all.slice(0, half);
		const b = all.slice(half);
		const p1 = run(a, 'split', seed + 1);
		splitSample = { params: p1, calibration: scored(pb, p1, a), validation: scored(pb, p1, b) };
	}
	if (opts.validate !== false && !cancelled) {
		// Differential split-sample: driest half of the water years vs the wettest.
		const years = waterYears(pb, MIN_DAYS_PER_YEAR).sort((x, y) => x.mean - y.mean);
		if (years.length < 4) {
			notes.push(
				`The record has ${years.length} water year${years.length === 1 ? '' : 's'} with at least ${MIN_DAYS_PER_YEAR} observed days, too few to fit on dry years and test on wet ones. ` +
					'How the model behaves in wet years is weakly constrained.'
			);
		} else {
			const k = Math.floor(years.length / 2);
			const dry = years.slice(0, k);
			const wet = years.slice(years.length - k);
			const idxOf = (ys: typeof years) => Int32Array.from(ys.flatMap((y) => y.idx).sort((p, q) => p - q));
			const di = idxOf(dry);
			const wi = idxOf(wet);
			const pd = run(di, 'dsst', seed + 2);
			const meanOf = (ys: typeof years) => ys.reduce((s, y) => s + y.mean * y.idx.length, 0) / ys.reduce((s, y) => s + y.idx.length, 0);
			const ratio = meanOf(wet) / meanOf(dry);
			differential = {
				params: pd,
				calibration: scored(pb, pd, di),
				validation: scored(pb, pd, wi),
				dryYears: dry.map((y) => y.year).sort((p, q) => p - q),
				wetYears: wet.map((y) => y.year).sort((p, q) => p - q),
				wetDryRatio: ratio
			};
			if (ratio < WET_DRY_CONTRAST) {
				notes.push(
					`The wettest years in the record carry only ${ratio.toFixed(1)}× the flow of the driest, so there are no clearly wet years to test on. ` +
						'How the model behaves in wet years is weakly constrained.'
				);
			}
		}
	}
	notes.push(...validationNotes(objective, splitSample, differential));
	if (cancelled) notes.push('Calibration was cancelled: the parameters are the best found before it stopped.');

	return {
		model: pb.model,
		objective,
		budget,
		seed,
		free,
		params,
		startParams: pb.startParams,
		flowKind: pb.flowKind,
		simulatedKey: pb.scoreNatural ? 'natural_flow' : 'simulated_outflow',
		fit: scored(pb, params, all),
		before: scored(pb, pb.startParams, all),
		splitSample,
		differential,
		notes,
		evaluations,
		cancelled
	};
}
