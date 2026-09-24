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
//   so instead of hiding it;
// - independent record, when asked (`validationRecord`): the fitted
//   parameters scored against another observed record (a logger when the fit
//   used the gauge, or the reverse), over that record's own days. It tests
//   the fit against a second instrument, not just a second period.
import { fromEpochDay, toEpochDay } from '../calendar';
import { computeNaturalFlow } from '../flow';
import { simulateNetwork } from '../network/simulate';
import { waterYearOf } from '../network/stats';
import type { CalibrationFlowKind, ModelInput } from '../project';
import { buildNetworkPlan, pickObservedKind, prepareRun } from '../run';
import { requireCatchmentAreaKm2 } from '../runoff/area';
import { gr4j, GR4J_PARAMS, type Gr4jParams } from '../runoff/gr4j';
import { LEGACY_PARAMS } from '../runoff/legacy';
import type { ParamSpec, RunoffModelId } from '../runoff/types';
import { resolveParams, resolveWarmupDays, runoffForcing, simulateRunoff } from '../runoff/simulate';
import { runRain, wr2012Penalty, type Wr2012Penalty } from '../reference/wr2012';
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
	/**
	 * Another observed record to validate the fit against (e.g. the logger
	 * when the fit uses the gauge). Scored over that record's own observed
	 * days outside the exclusions, whatever the calibration window. Unset: no
	 * independent-record test. Set but missing from the project: none either,
	 * and a note says so.
	 */
	validationRecord?: CalibrationFlowKind;
	/** Progress after every model run; return true to cancel (the best so far is returned). */
	onProgress?: (p: CalibrationProgress) => boolean | void;
}

/** 'unpenalised': the second full fit, without the WR2012 MAR penalty, run only when the penalty is on. */
export type CalibrationStage = 'full' | 'split' | 'dsst' | 'unpenalised';

export interface CalibrationProgress {
	stage: CalibrationStage;
	/** Model runs done in this stage, and the stage's budget. */
	evaluations: number;
	budget: number;
	/** Best objective score so far in this stage (higher is better). */
	best: number;
}

export interface ScoredPeriod {
	/**
	 * First and last observed day scored. For a set of days that isn't one
	 * stretch (the dry → wet test's years) this is only the envelope, and two
	 * disjoint sets can have overlapping envelopes: show `waterYears` then.
	 */
	start: string;
	end: string;
	/** Water years (by the calendar year they start in) with at least one scored day, ascending. */
	waterYears: number[];
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

/** The fitted parameters scored against a second observed record (`validationRecord`). */
export interface IndependentRecordTest extends ValidationTest {
	/** The record validated against. */
	flowKind: CalibrationFlowKind;
	/** What it was compared with: natural flow for Pitman, simulated outflow for a gauge or logger. */
	simulatedKey: 'natural_flow' | 'simulated_outflow';
	/** Validation days that were also fitted to: when > 0 that part tests the instrument, not unseen days. */
	overlapDays: number;
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
	/** Validation against `validationRecord`; null when unset, missing, or too short. */
	independentRecord: IndependentRecordTest | null;
	/** Plain-language limits of the validation (e.g. no wet years to test on). */
	notes: string[];
	/**
	 * The soft WR2012 MAR penalty (settings.wr2012.calibrationPenalty), when it
	 * was on: its weight, and the fit with and without it. null (or absent) when off.
	 */
	marPenalty?: MarPenaltyResult | null;
	/** Model runs used, over every stage. */
	evaluations: number;
	cancelled: boolean;
}

export interface MarPenaltyResult {
	/** Loss = (1 − objective) + weight × |ln(simulated MAR ÷ scaled WR2012 MAR)|, on natural flow. */
	weight: number;
	/** Scaled WR2012 MAR (Mm³/a) and the years it was compared over. */
	targetMarMm3: number;
	basis: 'overlap' | 'whole';
	/** Simulated natural MAR ÷ target for the fitted (penalised) parameters. */
	marRatio: number;
	/** The same fit without the penalty, for comparison; null when cancelled before it ran. */
	unpenalised: { params: ParamSet; fit: ScoredPeriod; marRatio: number } | null;
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
	/** Natural flow (m³/day) of the last simulate() call, filled up to the last scored day. */
	natural: Float64Array;
	/** The WR2012 MAR penalty when settings.wr2012.calibrationPenalty is on (and there is a reference), else null. */
	marPenalty: Wr2012Penalty | null;
	/** The simulated series to score (m³/day) for a parameter set. */
	simulate(p: ParamSet): Float64Array;
	/**
	 * Another observed record, for independent validation: its observed days
	 * outside the exclusions (the calibration window doesn't apply), and the
	 * series it is compared with. null when the project has no such series.
	 */
	record(kind: CalibrationFlowKind): RecordProblem | null;
}

/** A second observed record to score a parameter set against. */
export interface RecordProblem {
	kind: CalibrationFlowKind;
	scoreNatural: boolean;
	/** Observed flow (m³/day), NaN where missing. */
	observed: Float64Array;
	scoredDays: Int32Array;
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
	const observedOf = (k: CalibrationFlowKind) => Float64Array.from(aligned(k), (v) => (v === null ? NaN : v * SEC_PER_DAY));
	const observed = observedOf(kind);

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
	// score, so each evaluation stops there (a full run is ~20 ms on a
	// 44-year catchment; a record that ends early saves the rest).
	const toM3 = area * 1000;
	let runoff: (p: ParamSet, n: number) => void;
	if (modelId === 'gr4j') {
		const warmupDays = resolveWarmupDays(settings.gr4j?.warmupDays, warnings);
		const forcing = runoffForcing(settings, { startDate, days, aligned });
		// The warm-up cycles the *full* forcing, as runModel's does, so a
		// scored day sees exactly the state a normal run would give it.
		runoff = (p, n) => {
			const tr = simulateRunoff(gr4j, p as unknown as Gr4jParams, forcing, { warmupDays, trace: false, days: n });
			for (let t = 0; t < n; t++) natural[t] = tr.qMm[t]! * toM3;
		};
	} else {
		const base = {
			startDate,
			rainCatchmentMm: aligned('rain_catchment_mm'),
			rainChirpsMm: aligned('rain_chirps_mm'),
			rainForecastMm: aligned('rain_forecast_mm'),
			flowPitmanM3s: aligned('flow_pitman_m3s')
		};
		runoff = (p, n) => {
			const nf = computeNaturalFlow({ ...settings.calibration, ...p, catchmentAreaKm2: area }, { ...base, days: n }).naturalFlowM3Day;
			for (let t = 0; t < n; t++) natural[t] = Number.isFinite(nf[t]!) ? nf[t]! : 0;
		};
	}
	/** The series a record is scored against, simulated for days 0 … n − 1. */
	const simulator = (n: number, toNatural: boolean) => {
		const shortPlan = { ...plan, days: n };
		return (p: ParamSet): Float64Array => {
			runoff(p, n);
			if (toNatural) return natural;
			if (topo.outflow < 0) return new Float64Array(days);
			return simulateNetwork(shortPlan).nodes[topo.outflow]!.outflow;
		};
	};
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
		natural,
		// On natural flow, never the outflow: WR2012 flows are naturalised.
		marPenalty: wr2012Penalty(
			settings.wr2012,
			startDate,
			idx[idx.length - 1]! + 1,
			area,
			runRain(aligned, !!(input.series?.rain_catchment_mm || input.series?.rain_chirps_mm || input.series?.rain_forecast_mm), idx[idx.length - 1]! + 1)
		),
		simulate: simulator(idx[idx.length - 1]! + 1, scoreNatural),
		record(k) {
			if (!input.series?.[k]) return null;
			const obs = k === kind ? observed : observedOf(k);
			const on: number[] = [];
			for (let t = 0; t < days; t++) if (Number.isFinite(obs[t]!) && !excluded[t]) on.push(t);
			const toNatural = k === 'flow_pitman_m3s';
			const n = on.length ? on[on.length - 1]! + 1 : 0;
			return { kind: k, scoreNatural: toNatural, observed: obs, scoredDays: Int32Array.from(on), simulate: simulator(n, toNatural) };
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

/** Score a parameter set on the given days of a record (the calibration record by default). */
function scored(pb: CalibrationProblem, p: ParamSet, idx: Int32Array, rec: Pick<RecordProblem, 'observed' | 'simulate'> = pb): ScoredPeriod {
	const [o, s] = pair(rec.observed, rec.simulate(p), idx);
	const d0 = toEpochDay(pb.startDate);
	const years = yearsOf(pb, idx);
	return {
		start: fromEpochDay(d0 + idx[0]!),
		end: fromEpochDay(d0 + idx[idx.length - 1]!),
		waterYears: [...new Set(years)].sort((a, b) => a - b),
		scores: fitScores(o, s, years)
	};
}

interface FitResult {
	params: ParamSet;
	evaluations: number;
	cancelled: boolean;
}

function fit(pb: CalibrationProblem, idx: Int32Array, free: string[], objective: ObjectiveId, budget: number, seed: number, stage: CalibrationStage, onProgress: CalibrateOptions['onProgress'], penalty: Wr2012Penalty | null = null): FitResult {
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
		const l = objectiveLoss(objective, obs, sim, years);
		return penalty ? l + penalty.penalty(pb.natural) : l;
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

/** How a record is named in the notes. */
const RECORD_NAME: Record<CalibrationFlowKind, string> = {
	flow_observed_m3s: 'gauge record',
	flow_logger_m3s: 'logger record',
	flow_pitman_m3s: 'Pitman record'
};

/** Fewest observed days an independent record is scored on (as for the calibration record). */
const MIN_RECORD_DAYS = 30;

/** A validation score this much below its calibration score is called out. */
export const VALIDATION_DROP = 0.2;

/**
 * Plain-language limits of the validation: a score that falls sharply on the
 * part of the record the model wasn't fitted to, or a dry → wet test resting
 * on very few years.
 */
export function validationNotes(
	objective: ObjectiveId,
	split: ValidationTest | null,
	dsst: DifferentialTest | null,
	independent: IndependentRecordTest | null = null
): string[] {
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
	const r = independent && drop(independent);
	if (r) {
		out.push(
			`Scored against the ${RECORD_NAME[independent!.flowKind]} instead, ${label} falls from ${r[0]!.toFixed(2)} to ${r[1]!.toFixed(2)}: ` +
				'the fit does not hold on the other instrument. Check which record measures this river before trusting either.'
		);
	}
	if (independent && independent.overlapDays > 0) {
		out.push(
			`${independent.overlapDays} of the ${independent.validation.scores.days} days scored against the ${RECORD_NAME[independent.flowKind]} were also fitted to: ` +
				'that part tests the instrument, not the model on days it never saw.'
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
	const penalty = pb.marPenalty;
	const run = (idx: Int32Array, stage: CalibrationStage, s: number, withPenalty = true) => {
		const r = fit(pb, idx, free, objective, budget, s, stage, opts.onProgress, withPenalty ? penalty : null);
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
	let independentRecord: IndependentRecordTest | null = null;
	if (opts.validationRecord) {
		const want = opts.validationRecord;
		const rec = pb.record(want);
		if (!rec) {
			notes.push(`The project has no ${RECORD_NAME[want]}, so the fit was not validated against one.`);
		} else if (rec.scoredDays.length < MIN_RECORD_DAYS) {
			notes.push(
				`The ${RECORD_NAME[want]} has only ${rec.scoredDays.length} observed days outside the exclusions, too few to validate against (at least ${MIN_RECORD_DAYS}).`
			);
		} else {
			const fitted = new Set(all);
			let overlapDays = 0;
			for (const t of rec.scoredDays) if (fitted.has(t)) overlapDays++;
			independentRecord = {
				flowKind: want,
				simulatedKey: rec.scoreNatural ? 'natural_flow' : 'simulated_outflow',
				params,
				calibration: scored(pb, params, all),
				validation: scored(pb, params, rec.scoredDays, rec),
				overlapDays
			};
		}
	}
	let marPenalty: MarPenaltyResult | null = null;
	if (penalty) {
		const ratio = (p: ParamSet) => {
			pb.simulate(p);
			return penalty.simulatedMar(pb.natural) / penalty.targetMarMm3;
		};
		let unpenalised: MarPenaltyResult['unpenalised'] = null;
		if (!cancelled) {
			// The same fit without the penalty, so its effect is visible.
			const p0 = run(all, 'unpenalised', seed, false);
			unpenalised = { params: p0, fit: scored(pb, p0, all), marRatio: ratio(p0) };
		}
		marPenalty = { weight: penalty.weight, targetMarMm3: penalty.targetMarMm3, basis: penalty.basis, marRatio: ratio(params), unpenalised };
	}
	notes.push(...validationNotes(objective, splitSample, differential, independentRecord));
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
		independentRecord,
		marPenalty,
		notes,
		evaluations,
		cancelled
	};
}
