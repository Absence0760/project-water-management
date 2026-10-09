// Uncertainty bands (issue #4 phase 9, docs/model.md §2.10e): a behavioural
// ensemble in the GLUE sense (Beven & Binley 1992), built to the assessor's
// criteria in docs/followups.md:
//
// - Members come from a seeded Latin hypercube across the parameter bounds
//   (./sample.ts), never from the optimiser's search path, so the ensemble
//   doesn't crowd where one fit happened to look.
// - Each member also draws a pan-coefficient shift (GR4J), a rain source
//   (station rain with CHIRPS infill, or CHIRPS alone) and the observed record
//   it is judged against (gauge or logger), where the project has a choice.
// - A member is kept only if it passes stored thresholds: a skill score on
//   the first half of its record, the Phase 8 WR2012 flag (and MAR band) on
//   natural flow, and the low-flow FDC bias. The thresholds are part of the
//   stored options, so two ensembles' rules can be diffed.
// - The kept members' results give 5–95 % bands (./bands.ts), none below 30
//   members; the second half of the record is held out, and the share of its
//   observations inside the daily 5–95 % band of simulated outflow is the
//   coverage statistic (warning below 70 %).
// - Member 0 is always the run's own parameter set and forcing, judged by the
//   same rule: when it passes, the band includes the run it qualifies.
//
// One ensemble is one runoff model: results of two models are never pooled.
// Every member is a full model run of the project (runModelWithoutChecks:
// runModel less the plausibility checks, which no member result reads), so
// the same seed and options reproduce the ensemble exactly (./verify.ts checks it).
import { fromEpochDay, toEpochDay, waterYearIndex, waterYearOf, type Monthly } from '../calendar';
import { prepareCalibration } from '../calibrate/calibrate';
import { censoredObserved } from '../calibrate/dayFlags';
import { CALIBRATION_BOUNDS, CALIBRATION_PARAMS, type ParamSet } from '../calibrate/params';
import { fitScores } from '../calibrate/objective';
import { calibrationRecordsAt, parseUnitRainSeriesKey, type CalibrationFlowKind, type ModelInput, type ModelOutput } from '../project';
import type { Wr2012FlagLevel } from '../reference/wr2012';
import { chirpsColumns, runModelWithoutChecks } from '../run';
import { ENGINE_VERSION } from '../version';
import { GR4J_NO_PET, hasPotentialEvaporation } from '../runoff/pet';
import { hasDailyApanValue } from '../evaporation/apanDaily';
import { RUNOFF_MODELS, type RunoffModelId } from '../runoff/types';
import { band, MIN_BAND_MEMBERS, quantileSorted, type Band } from './bands';
import { defaultScale, latinHypercube, pickUnit, scaleUnit } from './sample';
import {
	CHIRPS_ONLY_MIN_COVERAGE,
	COVERAGE_WARNING,
	ENSEMBLE_DEFAULTS,
	ENSEMBLE_MEMBERS_MAX,
	ENSEMBLE_MEMBERS_MIN,
	FDC_POINTS,
	objectiveShortLabel,
	PAN_OFFSET_MAX,
	PAN_SHIFT_RANGE,
	RAIN_SOURCES,
	RECORD_LABELS,
	REJECT_LABELS,
	WR2012_LEVELS,
	type AcceptanceThresholds,
	type EnsembleDimension,
	type EnsembleRequest,
	type RainSource,
	type RejectReason,
	type ResolvedEnsembleOptions
} from './options';
import { OBJECTIVES } from '../calibrate/objectives';
import { prepareRun, type PreparedRun } from '../prepare';

export interface EnsembleMember {
	/** 0 = the run's own parameters and forcing; 1 … members = the Latin hypercube, in order. */
	index: number;
	reference: boolean;
	/** Every parameter of the model (the free ones sampled, the rest as the project has them). */
	params: ParamSet;
	/** Added to every month's pan coefficient (0 when not varied). */
	panOffset: number;
	rain: RainSource;
	/** The record the member is judged against. */
	record: CalibrationFlowKind;
}

export interface MemberScores {
	/** The threshold's objective on the acceptance days; null when it can't be computed. */
	skill: number | null;
	lowFlowBiasPct: number | null;
	/** null without a WR2012 reference. */
	wr2012Level: Wr2012FlagLevel | null;
	/** The simulated natural MAR the flag was judged on, Mm³/a. */
	wr2012MarMm3: number | null;
	/** Inside the project's MAR band; null without one. */
	wr2012InBand: boolean | null;
}

/** A member's outputs (rounded to 6 significant figures). Maps are keyed by node id; the outlet's Reserve site is 'outlet'. */
export interface MemberMetrics {
	/** Days the outlet EWR was not met over the run. */
	ewrDaysNotMet: number;
	/** The same by water-year month, index 0 = Oct … 11 = Sep, summed over the years. */
	ewrDaysNotMetByMonth: number[];
	/** Volume short of the outlet EWR over the run, Mm³. */
	shortfallMm3: number;
	/** Mean annual natural flow and simulated outflow over the run, Mm³/a (365.25-day years). */
	marNaturalMm3: number;
	marOutflowMm3: number;
	/** Per water year of header.waterYears, Mm³. */
	annualNaturalMm3: number[];
	annualOutflowMm3: number[];
	/** Each farm's total change in supply (curtailment report column S, m³/day; ≤ 0 = cut). */
	curtailmentM3Day: Record<string, number>;
	/** Monthly compliance with the Reserve's assurance rules (0–1) per site with a rule table. */
	reserveRate: Record<string, number | null>;
	/** Simulated outflow's flow-duration curve per water-year month, at FDC_POINTS, m³/day; [] for a month the run has no day in. */
	fdcM3Day: number[][];
	// Engine ≥ 1.33.0 (ENSEMBLE_MEASURES_SINCE, issue #71): absent on members stored before, whose bands then say so.
	/** Days the outlet's simulated outflow is below NO_FLOW_M3_DAY (summary.catchment.noFlow). */
	noFlowDays?: number;
	/** Days each EWR site's daily EWR was not met ('outlet' or the gauge's id; summary.servedWhileEwrFails). */
	ewrSiteDaysNotMet?: Record<string, number>;
	/** Each farm's and water user's mean demand and supply over the run, m³/day (their share supplied is supplied ÷ demand, 1 without demand). */
	unitDemandM3Day?: Record<string, number>;
	unitSuppliedM3Day?: Record<string, number>;
	/**
	 * The Reserve's FDC check per site with a rule table (ER5): per water-year
	 * month (0 = Oct), the impacted flow-duration curve at the table's points,
	 * in the table's unit (null for a point without a complete month).
	 */
	reserveFdc?: Record<string, (number | null)[][]>;
}

export interface MemberResult extends EnsembleMember {
	scores: MemberScores;
	accepted: boolean;
	rejected: RejectReason[];
	/** Kept members only. */
	metrics: MemberMetrics | null;
}

export interface EnsembleHeader {
	startDate: string;
	days: number;
	/** First held-out day: acceptance scores days before it, coverage the days from it. */
	splitDate: string;
	waterYears: { waterYear: number; days: number }[];
	farms: { nodeId: string; name: string }[];
	reserveSites: { key: string; name: string }[];
	/** Every farm and water user (engine ≥ 1.33.0; absent on older headers). */
	units?: { nodeId: string; name: string }[];
	/** Every EWR site, outlet first (engine ≥ 1.33.0; absent on older headers). */
	ewrSites?: { key: string; name: string }[];
	fdcPoints: number[];
	/** Run days in each water-year month (0 = Oct): a month without any has no flow-duration curve. */
	monthDays: number[];
	/** Mean outlet EWR per water-year month, m³/day: the line the flow-duration curves are read against. */
	ewrByMonthM3Day: number[];
	records: { record: CalibrationFlowKind; acceptanceDays: number; heldOutDays: number }[];
	/** The MAR band the WR2012 check used (Mm³/a), when the project sets one. */
	wr2012Band: { lowMm3: number; highMm3: number } | null;
	hasWr2012: boolean;
}

export interface RecordCoverage {
	record: CalibrationFlowKind;
	heldOutDays: number;
	/** Held-out observations inside the daily 5–95 % band; null below minMembers kept members. */
	inside: number | null;
	fraction: number | null;
	/** fraction < coverageWarning. */
	warning: boolean;
}

export interface EnsembleResult {
	engineVersion: string;
	options: ResolvedEnsembleOptions;
	header: EnsembleHeader;
	members: MemberResult[];
	coverage: RecordCoverage[];
	cancelled: boolean;
}

export interface EnsembleProgress {
	done: number;
	total: number;
	accepted: number;
}

const DAYS_PER_YEAR = 365.25;
const r6 = (v: number): number => (Number.isFinite(v) && v !== 0 ? Number(v.toPrecision(6)) : v);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * CHIRPS on every run day (bias-corrected by the run's own factors, and with
 * the CHIRPS quantile map on, mapped as the run maps its gap days, engine ≥
 * 1.53.0), without the station rain: the 'chirps' rain source.
 */
function chirpsOnly(input: ModelInput, run: PreparedRun): { input: ModelInput | null; reason: string | null } {
	const chirps = input.series?.rain_chirps_mm;
	if (!chirps) return { input: null, reason: 'the project has no CHIRPS series' };
	if (!input.series?.rain_catchment_mm) return { input: null, reason: 'the project has no station rain, so CHIRPS is already the only source' };
	const cols = chirpsColumns(chirps, run.chirpsCorrection, run.start, run.days, run.month);
	const col = cols.find((c) => c.key === 'rain_chirps_mapped') ?? cols.find((c) => c.key === 'rain_chirps_corrected') ?? cols[0]!;
	const values = col.values.map((v) => (Number.isFinite(v) ? v : null));
	const covered = values.filter((v) => v !== null).length / run.days;
	if (covered < CHIRPS_ONLY_MIN_COVERAGE) {
		return { input: null, reason: `CHIRPS covers only ${Math.round(covered * 100)} % of the run's days (at least ${CHIRPS_ONLY_MIN_COVERAGE * 100} % needed)` };
	}
	// Without the station rain, and (engine ≥ 1.78.0, docs/model.md §2.4h) without a land unit's own gauge: the member runs on
	// CHIRPS alone, each unit on its own CHIRPS where it has one, levelled by its MAP (a unit without a MAP runs it raw, as the
	// member's catchment CHIRPS is). A filtered copy, never a delete by an input's key.
	const kept = Object.entries(input.series).filter(([k]) => k !== 'rain_catchment_mm' && parseUnitRainSeriesKey(k)?.kind !== 'rain_catchment_mm');
	const series = { ...Object.fromEntries(kept), rain_chirps_mm: { startDate: run.startDate, values } } as ModelInput['series'];
	return { input: { ...input, settings: { ...input.settings, chirpsBiasCorrection: 'none', chirpsQuantileMap: null }, series }, reason: null };
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** The observed records with enough scored days to judge a member on (≥ 30, as calibration needs), primary first. */
function usableRecords(input: ModelInput, run: PreparedRun, model: RunoffModelId): CalibrationFlowKind[] {
	// The records at the calibration site (engine ≥ 1.41.0): the outlet's, or an inner gauge's.
	const kinds = calibrationRecordsAt(input.series, run.settings.calibrationSiteNodeId);
	// The record calibration fits first (pickObservedKind's choice): the one asked for, else the gauge, else the logger.
	const wanted = run.settings.calibrationFlowKind;
	const primary = wanted && kinds.includes(wanted) ? wanted : kinds[0];
	kinds.sort((a, b) => (a === primary ? -1 : b === primary ? 1 : 0));
	return kinds.filter((k) => {
		try {
			prepareCalibration({ ...input, settings: { ...input.settings, calibrationFlowKind: k } }, [], model);
			return true;
		} catch {
			return false;
		}
	});
}

/**
 * Resolve a request against the project: defaults filled, every choice
 * checked, the sample's dimensions fixed. Throws on a request the project
 * can't run (no observed record, a rain source it doesn't have, …). `notes`
 * say what isn't varied and why.
 */
export function resolveEnsembleOptions(input: ModelInput, req: EnsembleRequest = {}): { options: ResolvedEnsembleOptions; notes: string[] } {
	const run = prepareRun(input);
	const settings = run.settings;
	const notes: string[] = [];
	const model = req.model ?? settings.runoffModel;
	if (!RUNOFF_MODELS.includes(model)) throw new Error(`unknown runoff model "${String(model)}"`);
	if (!hasPotentialEvaporation(settings, hasDailyApanValue(run.aligned('evap_apan_mm')))) throw new Error(GR4J_NO_PET);
	const members = req.members ?? ENSEMBLE_DEFAULTS.members;
	if (!isInt(members, ENSEMBLE_MEMBERS_MIN, ENSEMBLE_MEMBERS_MAX)) {
		throw new Error(`members must be a whole number from ${ENSEMBLE_MEMBERS_MIN} to ${ENSEMBLE_MEMBERS_MAX}`);
	}
	const seed = req.seed ?? ENSEMBLE_DEFAULTS.seed;
	if (!isInt(seed, 0, 2 ** 31 - 1)) throw new Error('seed must be a whole number from 0 to 2147483647');
	// The fit's own box and objective, when the project's parameters come from a fit of this model: the ensemble then asks how
	// uncertain *that* fit is. Otherwise Perrin et al.'s typical ranges: the wide bounds keep too few members at a few hundred.
	const fit = settings.fitRecord && settings.fitRecord.model === model ? settings.fitRecord : null;
	const bounds = req.bounds ?? fit?.bounds ?? ENSEMBLE_DEFAULTS.bounds;
	if (!CALIBRATION_BOUNDS.includes(bounds)) throw new Error(`unknown bounds "${String(bounds)}"`);
	const specs = CALIBRATION_PARAMS[model];
	const free = req.free ?? specs.filter((s) => !s.fixedByDefault).map((s) => s.key);
	if (!free.length) throw new Error('no parameters to vary');
	const unknown = free.filter((k) => !specs.some((s) => s.key === k));
	if (unknown.length) throw new Error(`not a ${model} parameter: ${unknown.join(', ')}`);
	const orderedFree = specs.filter((s) => free.includes(s.key)).map((s) => s.key);

	let panOffset = req.panOffset ?? ENSEMBLE_DEFAULTS.panOffset;
	if (!isNum(panOffset, 0, PAN_OFFSET_MAX)) throw new Error(`pan offset must be from 0 to ${PAN_OFFSET_MAX}`);
	// Under a monthly PE (settings.pe, engine ≥ 0.31.0) GR4J never reads the pan coefficient, so shifting it would be a
	// dimension that changes nothing: drop it and say so.
	if (settings.pe.kind === 'monthly' && panOffset > 0) {
		notes.push(
			'The pan coefficient is not varied: GR4J’s potential evaporation comes from the monthly PE row (Settings), which does not use it. The ensemble does not vary potential evaporation.'
		);
		panOffset = 0;
	}

	const chirps = chirpsOnly(input, run);
	const availableRain: RainSource[] = chirps.input ? ['recorded', 'chirps'] : ['recorded'];
	const rainSources = RAIN_SOURCES.filter((r) => (req.rainSources ?? availableRain).includes(r));
	if (!rainSources.length) throw new Error('choose at least one rain source');
	const noRain = rainSources.filter((r) => !availableRain.includes(r));
	if (noRain.length) throw new Error(`the CHIRPS-only rain source is not available: ${chirps.reason}`);
	if (!chirps.input) notes.push(`The rain source is not varied: ${chirps.reason}.`);

	const availableRecords = usableRecords(input, run, model);
	if (!availableRecords.length) {
		throw new Error('an uncertainty ensemble needs an observed flow record (gauge or logger) with at least 30 days inside the calibration window');
	}
	const wanted = req.records ?? availableRecords;
	const badRecord = wanted.filter((k) => !availableRecords.includes(k));
	if (badRecord.length) throw new Error(`not a usable observed record here: ${badRecord.join(', ')}`);
	const records = availableRecords.filter((k) => wanted.includes(k));
	if (!records.length) throw new Error('choose at least one observed record');
	if (availableRecords.length < 2) notes.push(`The observed record is not varied: the project has one usable record (the ${RECORD_LABELS[records[0]!]}).`);

	const t = { ...ENSEMBLE_DEFAULTS.thresholds, ...(fit ? { objective: fit.objective } : {}), ...(req.thresholds ?? {}) };
	if (!OBJECTIVES.includes(t.objective)) throw new Error(`unknown objective "${String(t.objective)}"`);
	if (!isNum(t.minSkill, -10, 1)) throw new Error('the skill threshold must be from −10 to 1');
	if (!WR2012_LEVELS.includes(t.wr2012MaxLevel)) throw new Error(`unknown WR2012 level "${String(t.wr2012MaxLevel)}"`);
	if (t.maxLowFlowBiasPct !== null && !isNum(t.maxLowFlowBiasPct, 0, 10_000)) throw new Error('the low-flow bias threshold must be from 0 to 10000 %');
	if (!settings.wr2012.reference) notes.push('The WR2012 check does not filter members: the project has no WR2012 reference.');

	const dimensions: EnsembleDimension[] = orderedFree.map((key) => {
		const s = specs.find((x) => x.key === key)!;
		const [min, max] = bounds === 'typical' ? s.typical : [s.min, s.max];
		return { kind: 'param', key, min, max, scale: defaultScale(min, max) };
	});
	if (panOffset > 0) dimensions.push({ kind: 'pan', min: -panOffset, max: panOffset, scale: 'linear' });
	if (rainSources.length > 1) dimensions.push({ kind: 'rain', values: rainSources });
	if (records.length > 1) dimensions.push({ kind: 'record', values: records });

	return {
		options: {
			model,
			method: 'lhs',
			members,
			seed,
			bounds,
			free: orderedFree,
			panOffset,
			rainSources,
			records,
			thresholds: t,
			dimensions,
			holdOut: 'secondHalf',
			percentiles: [5, 50, 95],
			minMembers: MIN_BAND_MEMBERS,
			coverageWarning: COVERAGE_WARNING
		},
		notes
	};
}

/** The members an ensemble runs: member 0 (the project's own) then the Latin hypercube. Deterministic for the options. */
export function ensembleMembers(options: ResolvedEnsembleOptions, startParams: ParamSet): EnsembleMember[] {
	const rows = latinHypercube(options.members, options.dimensions.length, options.seed);
	const out: EnsembleMember[] = [
		// The run itself: its own rain whatever sources are sampled, judged on the first record sampled (the primary one unless left out).
		{ index: 0, reference: true, params: { ...startParams }, panOffset: 0, rain: 'recorded', record: options.records[0]! }
	];
	rows.forEach((u, i) => {
		const m: EnsembleMember = { index: i + 1, reference: false, params: { ...startParams }, panOffset: 0, rain: options.rainSources[0]!, record: options.records[0]! };
		options.dimensions.forEach((d, j) => {
			if (d.kind === 'param') m.params[d.key] = scaleUnit(u[j]!, d.min, d.max, d.scale);
			else if (d.kind === 'pan') m.panOffset = scaleUnit(u[j]!, d.min, d.max, 'linear');
			else if (d.kind === 'rain') m.rain = pickUnit(u[j]!, d.values);
			else m.record = pickUnit(u[j]!, d.values);
		});
		out.push(m);
	});
	return out;
}

/** A month's pan coefficient shifted by `offset`, kept inside PAN_SHIFT_RANGE unless the project's own value is outside it. */
export function shiftPan(row: Monthly | readonly number[], offset: number): number[] {
	return row.map((pc) => Math.min(Math.max(pc + offset, Math.min(PAN_SHIFT_RANGE[0], pc)), Math.max(PAN_SHIFT_RANGE[1], pc)));
}

// ---------------------------------------------------------------------------
// Context: everything built once per ensemble
// ---------------------------------------------------------------------------

interface RecordDays {
	observed: Float64Array;
	accept: Int32Array;
	acceptYears: Int32Array;
	held: Int32Array;
	/** The censoring bound on above-rating days (calibrate/dayFlags.ts), null when none are censored. */
	censor: Float64Array | null;
}

export interface EnsembleContext {
	options: ResolvedEnsembleOptions;
	startParams: ParamSet;
	startDate: string;
	days: number;
	/** Day index of the split (first held-out day); −1 when the context doesn't score (paired runs). */
	split: number;
	base: ModelInput;
	chirps: ModelInput | null;
	panRow: readonly number[];
	records: Map<CalibrationFlowKind, RecordDays>;
	/**
	 * Where the records are and members are scored (engine ≥ 1.41.0,
	 * settings.calibrationSiteNodeId): null = the outlet's simulated outflow,
	 * else that gauge's outflow. Absent on a context from before: the outlet.
	 */
	siteNodeId?: string | null;
	/** Day indices of each water-year month (0 = Oct). */
	monthDays: Int32Array[];
	waterYears: { waterYear: number; days: number; from: number; to: number }[];
	wr2012Band: { lowMm3: number; highMm3: number } | null;
	hasWr2012: boolean;
}

/**
 * Build the ensemble's context for a project input. `scoring` false skips the
 * observed records (a paired run is scored on the baseline, not here).
 */
export function ensembleContext(input: ModelInput, options: ResolvedEnsembleOptions, scoring = true): EnsembleContext {
	const run = prepareRun(input);
	const { settings, days, startDate } = run;
	if (options.model === 'gr4j' && !hasPotentialEvaporation(settings, hasDailyApanValue(run.aligned('evap_apan_mm')))) throw new Error(GR4J_NO_PET);
	// Pin the window, so the CHIRPS-only source (without the station series) covers the same days.
	const pin = (i: ModelInput): ModelInput => ({ ...i, settings: { ...i.settings, simulationStart: startDate, simulationEnd: fromEpochDay(run.end) } });
	const base = pin(input);
	let chirps: ModelInput | null = null;
	if (options.rainSources.includes('chirps')) {
		const c = chirpsOnly(input, run);
		if (!c.input) throw new Error(`the CHIRPS-only rain source is not available: ${c.reason}`);
		chirps = pin(c.input);
	}
	const startParams = prepareCalibrationParams(base, options.model);
	const records = new Map<CalibrationFlowKind, RecordDays>();
	let split = -1;
	if (scoring) {
		const probs = options.records.map((k) => ({ k, pb: prepareCalibration({ ...base, settings: { ...base.settings, calibrationFlowKind: k } }, [], options.model) }));
		const primary = probs[0]!.pb.scoredDays;
		split = primary[Math.floor(primary.length / 2)]!;
		const d0 = run.start;
		for (const { k, pb } of probs) {
			const accept = pb.scoredDays.filter((t) => t < split);
			const held = pb.scoredDays.filter((t) => t >= split);
			records.set(k, { observed: pb.observed, accept, acceptYears: Int32Array.from(accept, (t) => waterYearOf(d0 + t)), held, censor: pb.censor ?? null });
		}
	}
	const monthDays = Array.from({ length: 12 }, () => [] as number[]);
	const byYear = new Map<number, { waterYear: number; days: number; from: number; to: number }>();
	for (let t = 0; t < days; t++) {
		monthDays[waterYearIndex(run.month[t]!)]!.push(t);
		const wy = waterYearOf(run.start + t);
		const y = byYear.get(wy);
		if (y) {
			y.days++;
			y.to = t;
		} else byYear.set(wy, { waterYear: wy, days: 1, from: t, to: t });
	}
	const pen = settings.wr2012.calibrationPenalty;
	const wr2012Band = settings.wr2012.reference && typeof pen.marLowMm3 === 'number' && typeof pen.marHighMm3 === 'number' ? { lowMm3: pen.marLowMm3, highMm3: pen.marHighMm3 } : null;
	return {
		options,
		startParams,
		startDate,
		days,
		split,
		base,
		chirps,
		panRow: settings.panCoefficient,
		records,
		siteNodeId: settings.calibrationSiteNodeId ?? null,
		monthDays: monthDays.map((d) => Int32Array.from(d)),
		waterYears: [...byYear.values()],
		wr2012Band,
		hasWr2012: !!settings.wr2012.reference
	};
}

/** The project's parameters for a model (member 0), as calibration reads them. */
function prepareCalibrationParams(input: ModelInput, model: RunoffModelId): ParamSet {
	const run = prepareRun(input);
	const specs = CALIBRATION_PARAMS[model];
	const src = (model === 'gr4j' ? run.settings.gr4j : run.settings.calibration) as unknown as Record<string, number>;
	return Object.fromEntries(specs.map((s) => [s.key, typeof src[s.key] === 'number' && Number.isFinite(src[s.key]) ? src[s.key]! : s.default]));
}

/** The project input one member runs: its parameters, pan shift, rain source and record. */
export function memberInput(ctx: EnsembleContext, m: EnsembleMember): ModelInput {
	const src = m.rain === 'chirps' ? ctx.chirps : ctx.base;
	if (!src) throw new Error('the CHIRPS-only rain source is not available for this project');
	const s = src.settings as Record<string, unknown>;
	const settings: Record<string, unknown> = { ...s, runoffModel: ctx.options.model, calibrationFlowKind: m.record };
	if (ctx.options.model === 'gr4j') settings.gr4j = { ...((s.gr4j as object) ?? {}), ...m.params };
	else settings.calibration = { ...((s.calibration as object) ?? {}), ...m.params };
	if (m.panOffset !== 0) settings.panCoefficient = shiftPan(ctx.panRow, m.panOffset);
	return { settings: settings as ModelInput['settings'], model: src.model, series: src.series };
}

// ---------------------------------------------------------------------------
// One member
// ---------------------------------------------------------------------------

const catchmentSeries = (out: ModelOutput, key: string): number[] => out.series.find((s) => s.nodeId === null && s.key === key)?.values ?? [];
/** The simulated flow a member's records are scored against: the outlet's, or the calibration site's (engine ≥ 1.41.0). */
const scoredFlow = (ctx: Pick<EnsembleContext, 'siteNodeId'>, out: ModelOutput): number[] =>
	ctx.siteNodeId ? (out.series.find((s) => s.nodeId === ctx.siteNodeId && s.key === 'outflow')?.values ?? []) : catchmentSeries(out, 'simulated_outflow');

/** Weibull duration-curve value at exceedance p % of descending `x` (as reserve/assurance.ts durationQuantile). */
function durationAt(x: Float64Array, p: number): number {
	const n = x.length;
	if (n === 0) return NaN;
	const h = (p / 100) * (n + 1);
	if (h <= 1) return x[0]!;
	if (h >= n) return x[n - 1]!;
	const i = Math.floor(h);
	return x[i - 1]! + (h - i) * (x[i]! - x[i - 1]!);
}

/** A member's outputs, from its run. */
export function memberMetrics(ctx: EnsembleContext, out: ModelOutput): MemberMetrics {
	const s = out.summary;
	const natural = catchmentSeries(out, 'natural_flow');
	const outflow = catchmentSeries(out, 'simulated_outflow');
	const byMonth = new Array<number>(12).fill(0);
	let shortfall = 0;
	for (const row of s.ewrCompliance?.outlet.daysNotMet ?? []) row.forEach((v, m) => (byMonth[m]! += v));
	for (const row of s.ewrCompliance?.outlet.shortfallM3 ?? []) for (const v of row) shortfall += v;
	let sn = 0;
	let so = 0;
	for (let t = 0; t < ctx.days; t++) {
		sn += natural[t] ?? 0;
		so += outflow[t] ?? 0;
	}
	const annual = (x: number[]) =>
		ctx.waterYears.map((y) => {
			let v = 0;
			for (let t = y.from; t <= y.to; t++) v += x[t] ?? 0;
			return r6(v / 1e6);
		});
	const curtailment: Record<string, number> = {};
	for (const f of s.curtailment?.farms ?? []) curtailment[f.nodeId] = r6(f.totalChangeM3Day);
	const reserve: Record<string, number | null> = {};
	for (const site of s.ewrAssurance ?? []) reserve[site.nodeId ?? 'outlet'] = site.overall.rate === null ? null : r6(site.overall.rate);
	const fdc = ctx.monthDays.map((idx) => {
		if (!idx.length) return [];
		const x = Float64Array.from(idx, (t) => outflow[t] ?? 0)
			.sort()
			.reverse();
		return FDC_POINTS.map((p) => r6(durationAt(x, p)));
	});
	// The run's own count (summary.catchment.noFlow); a run without an outlet has none, and neither has the member.
	const noFlow = s.catchment.noFlow?.days;
	const siteDays: Record<string, number> = {};
	for (const site of s.servedWhileEwrFails ?? []) siteDays[site.nodeId ?? 'outlet'] = site.daysNotMet;
	const demand: Record<string, number> = {};
	const supplied: Record<string, number> = {};
	for (const u of [...s.farms, ...(s.users ?? [])]) {
		demand[u.nodeId] = r6(u.avgDemandM3Day);
		supplied[u.nodeId] = r6(u.avgSuppliedM3Day);
	}
	const reserveFdc: Record<string, (number | null)[][]> = {};
	for (const site of s.ewrAssurance ?? []) reserveFdc[site.nodeId ?? 'outlet'] = site.byMonth.map((m) => m.fdc.map((p) => (p.impacted === null ? null : r6(p.impacted))));
	return {
		ewrDaysNotMet: s.catchment.ewrDaysNotMet,
		ewrDaysNotMetByMonth: byMonth,
		shortfallMm3: r6(shortfall / 1e6),
		marNaturalMm3: r6(((sn / ctx.days) * DAYS_PER_YEAR) / 1e6),
		marOutflowMm3: r6(((so / ctx.days) * DAYS_PER_YEAR) / 1e6),
		annualNaturalMm3: annual(natural),
		annualOutflowMm3: annual(outflow),
		curtailmentM3Day: curtailment,
		reserveRate: reserve,
		fdcM3Day: fdc,
		...(noFlow === undefined ? {} : { noFlowDays: noFlow }),
		ewrSiteDaysNotMet: siteDays,
		unitDemandM3Day: demand,
		unitSuppliedM3Day: supplied,
		reserveFdc
	};
}

/** A unit's share of demand supplied in a member (as FarmSummary.fractionSupplied: 1 without demand); null when the member lacks it. */
export function memberSupplyFraction(x: MemberMetrics, nodeId: string): number | null {
	const d = x.unitDemandM3Day?.[nodeId];
	const g = x.unitSuppliedM3Day?.[nodeId];
	if (typeof d !== 'number' || typeof g !== 'number') return null;
	return d > 0 ? g / d : 1;
}

/** Σ supplied ÷ Σ demand over `nodeIds` present in a member; null without demand among them or when the member lacks the measure. */
export function memberGroupSupply(x: MemberMetrics, nodeIds: readonly string[]): number | null {
	if (!x.unitDemandM3Day || !x.unitSuppliedM3Day) return null;
	let d = 0;
	let g = 0;
	for (const id of nodeIds) {
		const dd = x.unitDemandM3Day[id];
		const gg = x.unitSuppliedM3Day[id];
		if (typeof dd === 'number' && typeof gg === 'number') ((d += dd), (g += gg));
	}
	return d > 0 ? g / d : null;
}

/** A member's acceptance scores, from its run. */
export function memberScores(ctx: EnsembleContext, m: EnsembleMember, out: ModelOutput): MemberScores {
	const rec = ctx.records.get(m.record);
	if (!rec) throw new Error(`the ${RECORD_LABELS[m.record]} is not part of this ensemble`);
	const sim = scoredFlow(ctx, out);
	// Scored as the fit scores them: flagged days left out (the problem's days), censored ones met once the simulation reaches the highest gauging.
	const obs = censoredObserved(rec.observed, sim, rec.accept, rec.censor);
	const o = Float64Array.from(rec.accept, (t) => obs[t]!);
	const sv = Float64Array.from(rec.accept, (t) => sim[t] ?? NaN);
	const f = fitScores(o, sv, rec.acceptYears);
	const w = out.summary.wr2012;
	let wr2012MarMm3: number | null = null;
	let wr2012InBand: boolean | null = null;
	if (w) {
		wr2012MarMm3 = w.flag.basis === 'overlap' && w.overlap ? w.overlap.simulatedMarMm3 : w.whole.simulatedMarMm3;
		if (ctx.wr2012Band) wr2012InBand = wr2012MarMm3 >= ctx.wr2012Band.lowMm3 && wr2012MarMm3 <= ctx.wr2012Band.highMm3;
	}
	return {
		skill: f[ctx.options.thresholds.objective],
		lowFlowBiasPct: f.fdcLowPct,
		wr2012Level: w ? w.flag.level : null,
		wr2012MarMm3,
		wr2012InBand
	};
}

/** Why a member's scores fail the thresholds; empty = kept. */
export function rejectReasons(t: AcceptanceThresholds, s: MemberScores): RejectReason[] {
	const out: RejectReason[] = [];
	if (s.skill === null || !(s.skill >= t.minSkill)) out.push('skill');
	if (
		s.wr2012Level !== null &&
		t.wr2012MaxLevel !== 'unusable' &&
		(WR2012_LEVELS.indexOf(s.wr2012Level) > WR2012_LEVELS.indexOf(t.wr2012MaxLevel) || s.wr2012InBand === false)
	) {
		out.push('wr2012');
	}
	if (t.maxLowFlowBiasPct !== null && (s.lowFlowBiasPct === null || !(Math.abs(s.lowFlowBiasPct) <= t.maxLowFlowBiasPct))) out.push('lowFlow');
	return out;
}

const roundScores = (s: MemberScores): MemberScores => ({
	...s,
	skill: s.skill === null ? null : r6(s.skill),
	lowFlowBiasPct: s.lowFlowBiasPct === null ? null : r6(s.lowFlowBiasPct),
	wr2012MarMm3: s.wr2012MarMm3 === null ? null : r6(s.wr2012MarMm3)
});

/** Run one member: its run, scores, verdict and (when kept) its outputs. Also returns the run for coverage. */
export function runMember(ctx: EnsembleContext, m: EnsembleMember): { result: MemberResult; output: ModelOutput } {
	const output = runModelWithoutChecks(memberInput(ctx, m));
	const scores = memberScores(ctx, m, output);
	const rejected = rejectReasons(ctx.options.thresholds, scores);
	const accepted = rejected.length === 0;
	return {
		result: { ...m, params: { ...m.params }, scores: roundScores(scores), accepted, rejected, metrics: accepted ? memberMetrics(ctx, output) : null },
		output
	};
}

// ---------------------------------------------------------------------------
// The ensemble
// ---------------------------------------------------------------------------

/** The ensemble's header, from member 0's run (farm names, Reserve sites, the EWR line) and the context. */
export function ensembleHeader(ctx: EnsembleContext, first: ModelOutput): EnsembleHeader {
	const ewr = catchmentSeries(first, 'ewr');
	return {
		startDate: ctx.startDate,
		days: ctx.days,
		splitDate: ctx.split >= 0 ? fromEpochDay(toEpochDay(ctx.startDate) + ctx.split) : ctx.startDate,
		waterYears: ctx.waterYears.map(({ waterYear, days }) => ({ waterYear, days })),
		farms: (first.summary.curtailment?.farms ?? []).map((f) => ({ nodeId: f.nodeId, name: f.name })),
		reserveSites: (first.summary.ewrAssurance ?? []).map((s) => ({ key: s.nodeId ?? 'outlet', name: s.name })),
		units: unitsOf(first),
		ewrSites: ewrSitesOf(first),
		fdcPoints: [...FDC_POINTS],
		monthDays: ctx.monthDays.map((idx) => idx.length),
		ewrByMonthM3Day: ctx.monthDays.map((idx) => (idx.length ? r6(idx.reduce((a, t) => a + (ewr[t] ?? 0), 0) / idx.length) : 0)),
		records: [...ctx.records.entries()].map(([record, r]) => ({ record, acceptanceDays: r.accept.length, heldOutDays: r.held.length })),
		wr2012Band: ctx.wr2012Band,
		hasWr2012: ctx.hasWr2012
	};
}

/** Every farm and water user of a run, farms first (a header's `units`). */
export const unitsOf = (out: ModelOutput): { nodeId: string; name: string }[] =>
	[...out.summary.farms, ...(out.summary.users ?? [])].map((u) => ({ nodeId: u.nodeId, name: u.name }));
/** Every EWR site of a run, outlet first (a header's `ewrSites`). */
export const ewrSitesOf = (out: ModelOutput): { key: string; name: string }[] =>
	(out.summary.servedWhileEwrFails ?? []).map((s) => ({ key: s.nodeId ?? 'outlet', name: s.name }));

/**
 * Run the ensemble: member 0, then every sampled member, each a full model
 * run. `onProgress` after each member; return true to cancel (the result is
 * then marked cancelled and must not be reported as a band).
 */
export function runEnsemble(
	input: ModelInput,
	options: ResolvedEnsembleOptions,
	opts: { onProgress?: (p: EnsembleProgress) => boolean | void } = {}
): EnsembleResult {
	const ctx = ensembleContext(input, options);
	const members = ensembleMembers(options, ctx.startParams);
	// Held-out days of every record, and each kept member's simulated outflow on them.
	const heldDays = [...new Set([...ctx.records.values()].flatMap((r) => [...r.held]))].sort((a, b) => a - b);
	const heldPos = new Map(heldDays.map((t, i) => [t, i]));
	const heldSims: Float64Array[] = [];
	const results: MemberResult[] = [];
	let head: EnsembleHeader | null = null;
	let accepted = 0;
	let cancelled = false;
	for (const m of members) {
		const { result, output } = runMember(ctx, m);
		head ??= ensembleHeader(ctx, output);
		results.push(result);
		if (result.accepted) {
			accepted++;
			const sim = scoredFlow(ctx, output);
			heldSims.push(Float64Array.from(heldDays, (t) => sim[t] ?? NaN));
		}
		if (opts.onProgress?.({ done: results.length, total: members.length, accepted }) === true) {
			cancelled = true;
			break;
		}
	}
	const coverage = [...ctx.records.entries()].map(([record, r]): RecordCoverage => {
		if (heldSims.length < options.minMembers || r.held.length === 0) {
			return { record, heldOutDays: r.held.length, inside: null, fraction: null, warning: false };
		}
		const pos = Int32Array.from(r.held, (t) => heldPos.get(t)!);
		const inside = bandCoverage(
			heldSims.map((x) => Float64Array.from(pos, (j) => x[j]!)),
			Float64Array.from(r.held, (t) => r.observed[t]!)
		);
		const fraction = inside / r.held.length;
		return { record, heldOutDays: r.held.length, inside, fraction: r6(fraction), warning: fraction < options.coverageWarning };
	});
	return { engineVersion: ENGINE_VERSION, options, header: head!, members: results, coverage, cancelled };
}

/**
 * How many of the observations fall inside the day's 5–95 % band:
 * `sims[i][d]` is member i's simulated flow on day d, `observed[d]` the
 * observation that day (the band per day is quantileSorted's, as every band).
 */
export function bandCoverage(sims: readonly ArrayLike<number>[], observed: ArrayLike<number>): number {
	let inside = 0;
	const col = new Float64Array(sims.length);
	for (let d = 0; d < observed.length; d++) {
		for (let i = 0; i < sims.length; i++) col[i] = sims[i]![d]!;
		col.sort();
		const lo = quantileSorted(col, 5);
		const hi = quantileSorted(col, 95);
		const o = observed[d]!;
		if (lo !== null && hi !== null && o >= lo && o <= hi) inside++;
	}
	return inside;
}

// ---------------------------------------------------------------------------
// Summary: bands, coverage, the decision rule
// ---------------------------------------------------------------------------

export interface EnsembleBands {
	ewrDaysNotMet: Band;
	/** Water-year month order (0 = Oct). */
	ewrDaysNotMetByMonth: Band[];
	shortfallMm3: Band;
	marNaturalMm3: Band;
	marOutflowMm3: Band;
	annual: { waterYear: number; days: number; natural: Band; outflow: Band }[];
	curtailment: { nodeId: string; name: string; band: Band }[];
	reserve: { key: string; name: string; band: Band }[];
	/** Monthly flow-duration curves of simulated outflow against the EWR, water-year order, at `fdcPoints` exceedance %; only months the run has days in. */
	fdc: { month: number; ewrM3Day: number; points: Band[] }[];
	fdcPoints: number[];
	// Engine ≥ 1.33.0 (ENSEMBLE_MEASURES_SINCE): absent on summaries stored before.
	/** Days the outlet's flow is below NO_FLOW_M3_DAY. */
	noFlowDays?: Band;
	/** Days each EWR site's daily EWR is not met, outlet first. */
	ewrSites?: { key: string; name: string; band: Band }[];
	/** Each farm's and water user's share of demand supplied, 0–1. */
	supply?: { nodeId: string; name: string; band: Band }[];
	/** The Reserve's FDC check (ER5): per site with a rule table, per water-year month (0 = Oct), a band at each of the table's points, table unit. */
	reserveFdc?: { key: string; name: string; months: Band[][] }[];
}

export interface EnsembleSummary {
	model: RunoffModelId;
	/** Members run (member 0 included). */
	total: number;
	accepted: number;
	/** Fewer than minMembers kept: no percentiles anywhere. */
	gated: boolean;
	/** Whether the run's own parameters passed. */
	referenceAccepted: boolean;
	/** Member 0's outputs (the run itself), to read against its bands; null when it failed the rule. */
	reference: MemberMetrics | null;
	rejected: Record<RejectReason, number>;
	bands: EnsembleBands;
	coverage: RecordCoverage[];
	coverageWarning: boolean;
	/** The rule a member had to pass, in words: printed next to every band. */
	decisionRule: string;
	notes: string[];
}

/** Bands of the Reserve FDC check at one site: 12 water-year months × the table's points (as many as any member carries). */
export function reserveFdcBands(members: readonly MemberMetrics[], key: string, b: (f: (x: MemberMetrics) => number | null | undefined) => Band): Band[][] {
	return Array.from({ length: 12 }, (_, i) => {
		let points = 0;
		for (const x of members) points = Math.max(points, x.reserveFdc?.[key]?.[i]?.length ?? 0);
		return Array.from({ length: points }, (_, j) => b((x) => x.reserveFdc?.[key]?.[i]?.[j]));
	});
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Calendar month (1–12) of water-year month index i (0 = Oct). */
export const calendarMonthOf = (i: number) => ((i + 9) % 12) + 1;
export const monthName = (calendarMonth: number) => MONTH_NAMES[calendarMonth - 1] ?? String(calendarMonth);
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

/** The acceptance rule, the percentiles and the coverage test, in words. */
export function ensembleDecisionRule(o: ResolvedEnsembleOptions, h: Pick<EnsembleHeader, 'splitDate' | 'hasWr2012' | 'wr2012Band'>): string {
	const t = o.thresholds;
	const parts = [`${objectiveShortLabel(t.objective)} ≥ ${fmt(t.minSkill)} against its observed record before ${h.splitDate}`];
	if (h.hasWr2012 && t.wr2012MaxLevel !== 'unusable') {
		const worst = t.wr2012MaxLevel === 'ok' ? 'no WR2012 flag' : `a WR2012 MAR flag no worse than “${t.wr2012MaxLevel}”`;
		parts.push(h.wr2012Band ? `${worst} and a natural MAR inside ${fmt(h.wr2012Band.lowMm3)}–${fmt(h.wr2012Band.highMm3)} Mm³/a` : worst);
	}
	if (t.maxLowFlowBiasPct !== null) parts.push(`a low-flow FDC bias within ±${fmt(t.maxLowFlowBiasPct)} %`);
	const rule = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]!;
	return (
		`A parameter set is kept when it has ${rule}. ` +
		`Bands are the ${o.percentiles[0]}th to ${o.percentiles[2]}th percentiles of the kept sets (median in between), shown only with at least ${o.minMembers} kept. ` +
		`Coverage counts the observations from ${h.splitDate} (never used to keep a set) inside the daily ${o.percentiles[0]}–${o.percentiles[2]} % band of simulated outflow; below ${Math.round(o.coverageWarning * 100)} % it warns. ` +
		`Sample: ${o.members} Latin-hypercube sets (seed ${o.seed}, ${o.bounds} bounds) plus the run's own.`
	);
}

/** Bands, coverage and notes of an ensemble, from its kept members: what is stored and shown. */
export function summariseEnsemble(r: Pick<EnsembleResult, 'options' | 'header' | 'members' | 'coverage'>): EnsembleSummary {
	const { options: o, header: h } = r;
	const kept = r.members.filter((m) => m.accepted && m.metrics).map((m) => m.metrics!);
	const b = (f: (x: MemberMetrics) => number | null | undefined) => band(kept.map(f), o.minMembers);
	const rejected: Record<RejectReason, number> = { skill: 0, wr2012: 0, lowFlow: 0 };
	for (const m of r.members) for (const x of m.rejected) rejected[x]++;
	const bands: EnsembleBands = {
		ewrDaysNotMet: b((x) => x.ewrDaysNotMet),
		ewrDaysNotMetByMonth: Array.from({ length: 12 }, (_, i) => b((x) => x.ewrDaysNotMetByMonth[i])),
		shortfallMm3: b((x) => x.shortfallMm3),
		marNaturalMm3: b((x) => x.marNaturalMm3),
		marOutflowMm3: b((x) => x.marOutflowMm3),
		annual: h.waterYears.map((y, i) => ({ ...y, natural: b((x) => x.annualNaturalMm3[i]), outflow: b((x) => x.annualOutflowMm3[i]) })),
		curtailment: h.farms.map((f) => ({ ...f, band: b((x) => x.curtailmentM3Day[f.nodeId]) })),
		reserve: h.reserveSites.map((s) => ({ ...s, band: b((x) => x.reserveRate[s.key]) })),
		fdc: h.ewrByMonthM3Day.flatMap((ewrM3Day, i) =>
			h.monthDays[i] ? [{ month: calendarMonthOf(i), ewrM3Day, points: h.fdcPoints.map((_, j) => b((x) => x.fdcM3Day[i]?.[j])) }] : []
		),
		fdcPoints: [...h.fdcPoints],
		noFlowDays: b((x) => x.noFlowDays),
		ewrSites: (h.ewrSites ?? []).map((site) => ({ ...site, band: b((x) => x.ewrSiteDaysNotMet?.[site.key]) })),
		supply: (h.units ?? []).map((u) => ({ ...u, band: b((x) => memberSupplyFraction(x, u.nodeId)) })),
		reserveFdc: h.reserveSites.map((site) => ({ ...site, months: reserveFdcBands(kept, site.key, (f) => b(f)) }))
	};
	const gated = kept.length < o.minMembers;
	const reference = r.members.find((m) => m.reference);
	const notes: string[] = [];
	if (gated) {
		notes.push(
			`Only ${kept.length} of ${r.members.length} parameter sets passed, fewer than ${o.minMembers}, so no percentiles are shown. ` +
				'Loosen the thresholds (and say why), use typical bounds, or run more members.'
		);
	}
	if (reference && !reference.accepted) {
		notes.push(`The run's own parameters fail the rule (${reference.rejected.map((x) => REJECT_LABELS[x]).join(', ')}): the band describes other parameter sets, not this run's.`);
	}
	const low = r.coverage.filter((c) => c.warning);
	for (const c of low) {
		notes.push(
			`Only ${Math.round((c.fraction ?? 0) * 100)} % of the held-out ${RECORD_LABELS[c.record]} observations fall inside the band (below ${Math.round(o.coverageWarning * 100)} %): ` +
				'the band is too narrow to trust as it stands.'
		);
	}
	return {
		model: o.model,
		total: r.members.length,
		accepted: kept.length,
		gated,
		referenceAccepted: !!reference?.accepted,
		reference: reference?.accepted ? reference.metrics : null,
		rejected,
		bands,
		coverage: r.coverage,
		coverageWarning: low.length > 0,
		decisionRule: ensembleDecisionRule(o, h),
		notes
	};
}
