// Automatic calibration of the runoff model (issue #4 §3): GR4J, the only one
// since engine 1.0.0 removed the legacy b023 model (issue #16).
//
// What is scored is the *whole run*: runoff model → natural flow → the network (farms,
// dams, abstraction, transfers) → the series that matches the observed
// record, exactly as runModel scores it (simulated outflow: a gauge or logger
// measures the impacted river). So the
// fitted parameters describe the catchment's *natural* response and the
// network adds the human impacts on top.
//
// Validation is always reported:
// - split-sample (Klemeš 1986): fit on the first half of the observed days,
//   score the second half with those parameters;
// - differential split-sample, where the record allows it: fit on the driest
//   half of the water years, score the wettest half. A short, drought-heavy
//   record can't show how the model behaves in wet years, and the report says
//   so instead of hiding it. From engine 1.19.0 the years are ranked dry → wet
//   by the project's reference gauge (flow_reference_m3s, another river) when
//   it covers them, as a regional wet/dry index only: it is never scored;
// - independent record, when asked (`validationRecord`): the fitted
//   parameters scored against another observed record (a logger when the fit
//   used the gauge, or the reverse), over that record's own days. It tests
//   the fit against a second instrument, not just a second period.
import { hasRainInput } from '../rainSourcePeriods';
import { fromEpochDay, toEpochDay, waterYearIndex, waterYearLabel, waterYearOf } from '../calendar';
import { simulateNetwork } from '../network/simulate';
import { alignFlow } from '../prepare';
import { arealRainFactors, calibrationSeriesKey, CALIBRATION_FLOW_KINDS, type CalibrationFlowKind, type ModelInput } from '../project';
import { buildNetworkPlan, fillPlanOutletEwr, naturalAtOutlet, naturalReaches, pickObservedKind } from '../run';
import { calibrationSiteIndex } from './site';
import { zoneCompleteWaterYears, resolveZones, zoneCalibrationSettings, zoneCoverageNotes, zoneParamsOf, zoneSiteName } from './zones';
import { MM_KM2_TO_M3, requireCatchmentAreaKm2 } from '../runoff/area';
import { gr4j } from '../runoff/gr4j';
import { GR4J_PARAMS, type Gr4jParams } from '../runoff/params';
import type { RunoffModelId } from '../runoff/types';
import { GR4J_NO_PET, hasPotentialEvaporation } from '../runoff/pet';
import { hasDailyApanValue } from '../evaporation/apanDaily';
import { hasDailyEt0Value } from '../evaporation/et0Daily';
import { catchmentRainUnits, resolveParams, resolveWarmupDays, runoffForcing, simulateRunoff } from '../runoff/simulate';
import { shareForcingSettings, simulateUnits, unitRainFingerprint, unitRainForcing, type UnitRainFingerprint } from '../runoff/unitRain';
import { rainStationSummary } from '../runoff/stationForcing';
import { catchmentStationFingerprint, type CatchmentStationFingerprint } from '../runoff/stationFingerprint';
import { runRain, wr2012Penalty, type Wr2012Penalty } from '../reference/wr2012';
import { wr2012FitStats, type Wr2012FitStats } from '../reference/wr2012Fit';
import { chirpsFactorSets, type ChirpsFactorSet } from '../rain';
import { dds } from './dds';
import { CALIBRATION_PARAMS, MAX_STARTS, type FitBounds, type ParamSet } from './params';
import { calibrationPriorError, priorBox, priorPenalty, sameTarget, type CalibrationPrior, type ParamPriors, type PriorFitResult, type PriorParam } from './prior';
import { excludedDayMask, exclusionRanges } from './provenance';
import { bootstrapIntervals, scoreBenchmarks, type ScoreBenchmarks, type ScoreIntervals } from './bootstrap';
import { fitScores, objectiveLoss, type FitScores } from './objective';
import { OBJECTIVE_LABELS, type ObjectiveId } from './objectives';
import { forecastTail } from '../forecastTail';
import { prepareRun } from '../prepare';
import { recordRepresentativeness, type RecordRepresentativeness } from './representativeness';
import { censoredObserved, dayQuality, rainDayFlags, ratingOf, recordFlowFlags, scoringDays, siteQualityFlags, type DayQuality } from './dayFlags';

/** The run's rain × the areal factor of each day's water-year month (engine ≥ 1.13.0), as runModel's WR2012 check reads it. */
const arealRainOn = (rain: (number | null)[] | null, areal: readonly number[] | null, month: ArrayLike<number>) =>
	rain && areal ? rain.map((v, t) => (v === null ? null : v * areal[waterYearIndex(month[t]!)]!)) : rain;

const SEC_PER_DAY = 86_400;

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
	/**
	 * The box the search is free to explore, per parameter (issue #4 phase 6
	 * §"make the logger fit identifiable"): 'wide' (default) is each
	 * parameter's min/max (GR4J_PARAMS); 'typical' is Perrin et
	 * al.'s (2003) 80 % range (`typical`), tighter but not always enough to
	 * pin down a short, drought-dominated record either; 'prior' is the regional
	 * prior's p10–p90 box (issue #622, `prior` required; docs/model.md §2.10m).
	 * The starting point is clamped into whichever box is used.
	 */
	bounds?: FitBounds;
	/** Model runs per optimisation (the full fit, and each validation fit). Default 1 500. */
	budget?: number;
	/** Default 1. The same seed gives the same result. */
	seed?: number;
	/**
	 * Independent searches of the whole record, each from its own seed
	 * (`startSeed`); the best is kept and every start is reported, so nearly
	 * equal scores with scattered parameters show the record can't pin them
	 * down (calibration research CR-2). 1–MAX_STARTS; default 1. The app asks
	 * for DEFAULT_STARTS. Validation fits run once, from the best start.
	 */
	starts?: number;
	/**
	 * Parameters to fit; the rest keep their current value. Default: every
	 * parameter not fixed by default (GR4J X1, X3, X4, with X2 as set, normally
	 * 0).
	 */
	free?: string[];
	/**
	 * Periods left out of every score (a gauge outage, a known bad stretch),
	 * on top of the project's stored settings.calibrationExclusions, which
	 * always apply.
	 */
	exclusions?: DateRange[];
	/** Also run the split-sample and differential split-sample tests. Default true. */
	validate?: boolean;
	/**
	 * How the dry → wet test ranks water years (engine ≥ 1.19.0, issue #4
	 * phase 6, "make the logger fit identifiable" step 2): 'reference' by the
	 * reference gauge's (flow_reference_m3s) mean flow over each water year, a
	 * regional wet/dry index that never becomes a scoring target; 'observed' by
	 * the fitted record's own mean flow over its scored days. Default:
	 * 'reference' when the project has a reference gauge, else 'observed'. A
	 * reference that doesn't cover every candidate year (MIN_DAYS_PER_YEAR
	 * days each) falls back to 'observed', with a note.
	 */
	rankYearsBy?: DsstRanking;
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
	/**
	 * The calibration zone to fit (engine 1.106.0, issue #555, ./zones.ts,
	 * docs/model.md §2.10n): a ticked row of settings.calibrationZones, by its
	 * gauge. Only that zone's land units take the candidate parameters; every
	 * other unit keeps its zone's (the site's zone: settings.gr4j), and the fit
	 * reads the zone's site, window, exclusions, record and quality flags
	 * (zoneCalibrationSettings). Absent or null = the calibration site's own
	 * zone (with no ticked zone, every unit: every engine before).
	 */
	zone?: string | null;
	/**
	 * The regional GR4J prior (engine 1.106.0, issue #622, ./prior.ts,
	 * docs/model.md §2.10m): with a weight over 0, every fit's loss adds
	 * weight × priorPenalty over the free parameters (the log-normal penalty);
	 * under `bounds: 'prior'` the search keeps to its p10–p90 box. It must be
	 * built for the fit's target: the catchment, or under calibration zones
	 * the zone being fitted (its gauge and land units). Absent: no prior, and
	 * the fit is every engine's before it, to the bit.
	 */
	prior?: CalibrationPrior;
}

/** 'unpenalised': the second full fit, without the WR2012 MAR penalty, run only when the penalty is on. */
export type CalibrationStage = 'full' | 'split' | 'dsst' | 'unpenalised';

export interface CalibrationProgress {
	stage: CalibrationStage;
	/** For the full fit: which start this is (1-based), of how many. */
	start?: number;
	starts?: number;
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
	/**
	 * 90 % block-bootstrap intervals over water years of KGE′, NSE and the
	 * low/high-flow KGE′ (engine ≥ 1.19.0, CR-5); null with fewer than
	 * BOOTSTRAP_MIN_YEARS water years. Absent on a report or stored record
	 * made before them.
	 */
	intervals?: ScoreIntervals | null;
	/** The same scores for the mean-flow and day-of-year climatology benchmarks on these days (engine ≥ 1.19.0, CR-5); absent before. */
	benchmarks?: ScoreBenchmarks | null;
	/**
	 * The WR2012 five-statistic table on these days (CR-28, engine ≥ 1.19.0;
	 * reference/wr2012Fit.ts): null when no water year has all 12 months
	 * scored, absent on reports from before.
	 */
	wr2012Fit?: Wr2012FitStats | null;
}

export interface ValidationTest {
	/** Parameters fitted on the calibration part. */
	params: ParamSet;
	calibration: ScoredPeriod;
	validation: ScoredPeriod;
}

/** What ranked the dry → wet test's water years: the fitted record's own flow, or the reference gauge. */
export type DsstRanking = 'observed' | 'reference';

export interface DifferentialTest extends ValidationTest {
	/** Water years (by the calendar year they start in) fitted, and validated. */
	dryYears: number[];
	wetYears: number[];
	/** Mean observed flow (of the fitted record) of the wet years ÷ that of the dry years, however they were ranked. */
	wetDryRatio: number;
	/** What ranked the years (engine ≥ 1.19.0); absent on a report or fit record from before: 'observed'. */
	rankedBy?: DsstRanking;
}

/** The fitted parameters scored against a second observed record (`validationRecord`). */
export interface IndependentRecordTest extends ValidationTest {
	/** The record validated against. */
	flowKind: CalibrationFlowKind;
	/** What it was compared with: always the simulated outflow. */
	simulatedKey: 'simulated_outflow';
	/** Validation days that were also fitted to: when > 0 that part tests the instrument, not unseen days. */
	overlapDays: number;
}

/** One start of the full fit (`CalibrateOptions.starts`). */
export interface StartResult {
	seed: number;
	/** Every parameter of the model as this start left it (the free ones fitted). */
	params: ParamSet;
	/** The objective over the whole window, without any WR2012 penalty (higher is better). */
	score: number | null;
	/** The start the fit kept: the lowest loss, penalty included, first on a tie. */
	best: boolean;
}

export interface CalibrationReport {
	model: RunoffModelId;
	objective: ObjectiveId;
	/** The box the search explored (issue #4 phase 6 §"make the logger fit identifiable"; 'prior': the regional prior's, issue #622). */
	bounds: FitBounds;
	budget: number;
	seed: number;
	/** Starts of the full fit, and each one's result (`CalibrateOptions.starts`). */
	starts: number;
	startResults: StartResult[];
	free: string[];
	/** Best parameters over the whole window: what "Apply" would put in the form (settings.gr4j). */
	params: ParamSet;
	/** The parameters the project had, for comparison. */
	startParams: ParamSet;
	/** The flow record fitted to, and what it was compared with. */
	flowKind: string;
	/**
	 * Where it was scored (engine ≥ 1.41.0, settings.calibrationSiteNodeId):
	 * null = the outlet, else the gauge node whose record `flowKind` is and
	 * whose simulated flow (`simulatedKey`, that node's outflow) it was
	 * compared with. Absent on a report from before: the outlet.
	 */
	siteNodeId?: string | null;
	/** The stored series fitted to (engine ≥ 1.102.0, CalibrationProblem.flowSeriesId); absent when the input didn't say. */
	flowSeriesId?: string;
	/** The calibration zone fitted (engine 1.106.0, issue #555): its gauge, null = the site's own zone; absent without zones. */
	zoneNodeId?: string | null;
	/** The land units the fitted parameters are for (engine 1.106.0); absent without zones (every unit). */
	zoneUnits?: string[];
	simulatedKey: 'simulated_outflow';
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
	/** The regional prior, when the fit used one (engine 1.106.0, issue #622): its penalty weight, box, ranges and provenance. Absent without. */
	prior?: PriorFitResult;
	/** Every period left out of the scores: the stored exclusions, then `exclusions`. */
	exclusions: DateRange[];
	/**
	 * How representative the scored days are of the long-term rainfall
	 * (engine ≥ 1.19.0, calibration research CR-34): their length, each scored
	 * water year's rain percentile, and the mean against the long-term mean.
	 * Absent before 1.19.0; null when the run has no rain to rank against.
	 */
	representativeness?: RecordRepresentativeness | null;
	/** The CHIRPS factors the fit's rain used, per fit range (engine ≥ 0.29.0; absent before, null without CHIRPS or in mode 'none'). */
	chirpsFactors?: ChirpsFactorSet[] | null;
	/** The per-unit forcing the fit ran under (engine ≥ 1.78.0, docs/model.md §2.4h); absent under catchment rain. */
	unitRain?: UnitRainFingerprint | null;
	/** Under Fragmentation, the forcing its share runs ran on (engine ≥ 1.105.0, issue #616); null without a land unit, absent under Per unit. */
	shareRain?: UnitRainFingerprint | null;
	/** The catchment's rainfall station the fit's rain read (engine ≥ 1.91.0, docs/model.md §2.4i); absent without one. */
	catchmentStation?: CatchmentStationFingerprint | null;
	/**
	 * The per-day quality flags of the fitted record and its rain (engine ≥
	 * 1.22.0, calibration research CR-18/22, ./dayFlags.ts): days by class,
	 * days scored, left out and censored, and what the record can't support.
	 * Absent before 1.22.0.
	 */
	dayQuality?: DayQuality | null;
	/**
	 * The fitted parameters scored on every observed day in the window
	 * outside the exclusion periods, flagged days included and nothing
	 * censored (engine ≥ 1.22.0, CR-19): the fit on all days, beside `fit` on
	 * the clean days. null when the flags left nothing out and censored
	 * nothing (it would equal `fit`); absent before 1.22.0.
	 */
	fitAllDays?: ScoredPeriod | null;
	/** Model runs used, over every stage. */
	evaluations: number;
	cancelled: boolean;
}

export interface MarPenaltyResult {
	/** Loss = (1 − objective) + weight × |ln(simulated MAR ÷ target)|, on natural flow (target = the nearer band bound outside a band). */
	weight: number;
	/** The MAR pulled towards (Mm³/a): the scaled WR2012 MAR for a single target, or the band's geometric mean. */
	targetMarMm3: number;
	/** The band bounds (Mm³/a, already at the modelled catchment's scale), when the penalty uses one; null for a single target. */
	marLowMm3: number | null;
	marHighMm3: number | null;
	basis: 'overlap' | 'whole';
	/** Simulated natural MAR ÷ target for the fitted (penalised) parameters. */
	marRatio: number;
	/** The same fit without the penalty, for comparison; null when cancelled before it ran. */
	unpenalised: { params: ParamSet; fit: ScoredPeriod; marRatio: number } | null;
}

/**
 * The WR2012 MAR penalty read on the natural flow at the outlet net of the
 * natural bed losses (engine ≥ 1.76.0, run.ts naturalAtOutlet), as the run's
 * WR2012 check reads it; the penalty itself when no reach loses.
 */
function netOfReachLosses(p: Wr2012Penalty | null, plan: Parameters<typeof naturalAtOutlet>[0], outflow: number): Wr2012Penalty | null {
	if (!p || !naturalReaches(plan) || outflow < 0) return p;
	const net = (natural: ArrayLike<number>) => naturalAtOutlet(plan, outflow, natural) ?? natural;
	return { ...p, simulatedMar: (natural) => p.simulatedMar(net(natural)), penalty: (natural) => p.penalty(net(natural)) };
}

/** Everything a calibration needs, built once: forcing, network plan, observed record, scored days. */
export interface CalibrationProblem {
	model: RunoffModelId;
	startDate: string;
	days: number;
	area: number;
	startParams: ParamSet;
	flowKind: string;
	/** Where the record is and the simulated flow is taken (engine ≥ 1.41.0): null = the outlet, else the gauge's node id. */
	siteNodeId: string | null;
	/** The calibration zone fitted (engine 1.106.0, CalibrateOptions.zone): its gauge, null = the site's own zone; absent without zones. */
	zoneNodeId?: string | null;
	/** The land units whose parameters the candidates move (engine 1.106.0); absent without zones (every unit). */
	zoneUnits?: string[];
	/** The stored series the fitted record is (DailySeries.seriesId, engine ≥ 1.102.0): whose kept checks change the scored days. Null when the input doesn't say. */
	flowSeriesId: string | null;
	/** The calibration records at the site, in CALIBRATION_FLOW_KINDS order: the fitted one and any for independent validation. */
	records: CalibrationFlowKind[];
	/** Observed flow (m³/day), NaN where missing. */
	observed: Float64Array;
	/**
	 * Day indices scored: observed, inside the calibration window, outside
	 * every exclusion, and not left out by the quality flags (engine ≥ 1.22.0,
	 * settings.qualityFlags).
	 */
	scoredDays: Int32Array;
	/**
	 * The censoring bound (m³/day) on each scored above-rating day when the
	 * settings censor them, NaN elsewhere; null when nothing is censored
	 * (engine ≥ 1.22.0, ./dayFlags.ts censoredObserved).
	 */
	censor?: Float64Array | null;
	/** Every observed day in the window outside the exclusions, flags or not: what `fitAllDays` scores. */
	allDays?: Int32Array;
	/**
	 * Every run day inside the calibration window and outside the exclusions,
	 * observed or not, and the fitted record's per-day class on every run day
	 * (./dayFlags.ts flowDayFlags): what automated calibration's exclusion
	 * rule reads (./rules.ts flaggedYearExclusions, issue #153).
	 */
	windowDays?: Int32Array;
	flowFlags?: Uint8Array;
	/** The quality flags' summary (engine ≥ 1.22.0). */
	dayQuality?: DayQuality | null;
	/**
	 * The reference gauge (flow_reference_m3s, m³/s, NaN where missing) over
	 * the whole run, or null without one: only ever used to rank water years
	 * dry → wet, never scored (engine ≥ 1.19.0).
	 */
	reference?: Float64Array | null;
	/** Natural flow (m³/day) of the last simulate() call, filled up to the last scored day. */
	natural: Float64Array;
	/** The WR2012 MAR penalty when settings.wr2012.calibrationPenalty is on (and there is a reference), else null. */
	marPenalty: Wr2012Penalty | null;
	/** The exclusions applied: settings.calibrationExclusions, then the caller's. */
	exclusions: DateRange[];
	/** The CHIRPS factors the rain used (engine ≥ 0.29.0), for fit provenance. */
	chirpsFactors?: ChirpsFactorSet[] | null;
	/** The per-unit forcing (engine ≥ 1.78.0, settings.unitRain `perUnit`), for fit provenance; absent under catchment rain. */
	unitRain?: UnitRainFingerprint | null;
	/**
	 * Under Fragmentation, the forcing its share runs ran on (engine ≥ 1.105.0, issue #616: the units' shares split the
	 * flow each candidate is scored on), for fit provenance; null without a land unit, absent under Per unit.
	 */
	shareRain?: UnitRainFingerprint | null;
	/** The catchment's rainfall station (engine ≥ 1.91.0, §2.4i), for fit provenance; absent without one. */
	catchmentStation?: CatchmentStationFingerprint | null;
	/**
	 * The run's daily rain over the whole run as calibration reads it (catchment,
	 * else bias-corrected CHIRPS, else forecast, × the areal factor; null =
	 * missing), the long-term reference for `recordRepresentativeness`. null
	 * without a rain series.
	 */
	rain?: (number | null)[] | null;
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
	/** Observed flow (m³/day), NaN where missing. */
	observed: Float64Array;
	scoredDays: Int32Array;
	/** As CalibrationProblem.censor, for this record's own rating. */
	censor?: Float64Array | null;
	/** Observed days outside the exclusions before the quality flags left any out. */
	observedDays?: number;
	simulate(p: ParamSet): Float64Array;
}

/** Build the calibration problem for a project. Throws when there is nothing to calibrate against. */
export function prepareCalibration(input: ModelInput, exclusions: DateRange[] = [], model?: RunoffModelId, zoneNodeId: string | null = null): CalibrationProblem {
	const run = prepareRun(input);
	// The fit reads a record's own missing periods as gaps, as the run does (engine ≥ 1.102.0, ../recordPeriods.ts).
	if (run.series !== input.series) input = { ...input, series: run.series };
	const { settings, days, startDate, aligned, month, warnings, start } = run;
	// Calibration zones (engine 1.106.0, issue #555, ./zones.ts): the zones the run applies, and the settings this fit
	// reads its site, window, exclusions, record, quality flags and start from (the zone's, or the project's for the
	// site's own zone). No ticked zone: `zones` is null and every unit takes the candidate, as before.
	const baseParams = resolveParams<Gr4jParams>(GR4J_PARAMS, settings.gr4j, 'GR4J', warnings);
	const zones = resolveZones(input.model.nodes, settings, baseParams, warnings);
	if (zoneNodeId !== null) {
		if (!zones) throw new Error('calibration zones need Per unit flow generation and a ticked, usable gauge: there is no zone to fit');
		if (!zones.zones.some((z) => z.nodeId === zoneNodeId)) throw new Error(`no ticked calibration zone at gauge node ${zoneNodeId}`);
	}
	const cs = zoneCalibrationSettings(settings, zoneNodeId);
	const modelId = model ?? settings.runoffModel;
	// Refused as runModel refuses it (runoff/simulate.ts).
	if (!hasPotentialEvaporation(settings, hasDailyApanValue(aligned('evap_apan_mm')), hasDailyEt0Value(aligned('evap_et0_mm')))) throw new Error(GR4J_NO_PET);
	const area = requireCatchmentAreaKm2(settings.calibration, input);
	// A zone's start: its row's parameters (in bounds, sanitizeCalibrationZones) over the catchment's, already warned of.
	const startParams: ParamSet = zoneNodeId === null ? { ...baseParams } : { ...resolveParams<Gr4jParams>(GR4J_PARAMS, cs.gr4j, 'GR4J', []) };
	const natural = new Float64Array(days);
	// The days before a forecast tail, which runModel's record-wide statistics read (engine ≥ 1.28.0).
	const { historyDays } = forecastTail(run);
	// Runoff from each unit's own rain (engine ≥ 1.78.0, docs/model.md §2.4h): each evaluation runs GR4J once per land
	// unit, into buffers the plan reads as the units' local inflow, and natural flow is their sum, as runModel's.
	const perUnit = unitRainForcing(
		{ settings, series: input.series ?? {}, nodes: input.model.nodes, startDate, days, aligned, chirpsCorrection: run.chirpsCorrection, historyDays, forecastRainSource: input.forecastRainSource ?? null, stations: run.stations?.context ?? null, stationInputs: input.stations ?? null },
		warnings,
		settings.unitRain?.pinned ?? undefined
	);
	const unitBuffers = perUnit ? perUnit.units.map((u) => ({ nodeId: u.nodeId, runoffM3Day: new Float64Array(days) })) : null;
	// Fragmentation's EWR shares (engine ≥ 1.105.0, §2.5b, runoff/simulate.ts ewrShareRunoff): the same per-unit runs on
	// the Per unit forcing, into buffers the plan's EWR split reads, refilled for each candidate (its parameters move
	// the shares). Their warnings are Per unit's, not the fit's.
	const shareForcing = perUnit
		? null
		: unitRainForcing(
				{ settings: shareForcingSettings(settings), series: input.series ?? {}, nodes: input.model.nodes, startDate, days, aligned, chirpsCorrection: run.chirpsCorrection, historyDays, forecastRainSource: input.forecastRainSource ?? null, stations: run.stations?.context ?? null, stationInputs: input.stations ?? null },
				[],
				settings.unitRain?.pinned ?? undefined
			);
	const shareBuffers = shareForcing ? shareForcing.units.map((u) => ({ nodeId: u.nodeId, runoffM3Day: new Float64Array(days) })) : null;
	const { plan, topo, outletEwr, ewrSplit } = buildNetworkPlan(
		input,
		settings,
		days,
		month,
		aligned,
		natural,
		warnings,
		start,
		unitBuffers ? { unitRunoff: unitBuffers } : shareBuffers ? { shareRunoff: shareBuffers, shareCatchmentRain: catchmentRainUnits(shareForcing!.units) } : {},
		historyDays
	);

	// The site (engine ≥ 1.41.0, ./site.ts): the outlet's records and outflow, or an inner gauge's.
	const siteNodeId = cs.calibrationSiteNodeId ?? null;
	const siteIndex = calibrationSiteIndex(input.model.nodes, topo.outflow, siteNodeId);
	const series = input.series ?? {};
	const at = (k: CalibrationFlowKind) => series[calibrationSeriesKey(k, siteNodeId)];
	const siteSeries: ModelInput['series'] = siteNodeId === null ? series : Object.fromEntries(CALIBRATION_FLOW_KINDS.flatMap((k) => (at(k) ? [[k, at(k)!]] : [])));
	const kind = pickObservedKind(cs.calibrationFlowKind, siteSeries, warnings);
	if (!kind) {
		throw new Error(
			siteNodeId === null
				? 'no observed flow series to calibrate against: upload a gauge or logger record'
				: `no observed flow record at the calibration site "${input.model.nodes[siteIndex]!.name}": attach one to it on the Data page, or calibrate at the outlet`
		);
	}
	// A gauge's record is scored as stored: the gap filling is the outlet records' (prepareRun's flowFill), so it isn't read there.
	const observedOf = (k: CalibrationFlowKind) =>
		Float64Array.from(siteNodeId === null ? aligned(k) : alignFlow(at(k), start, days), (v) => (v === null ? NaN : v * SEC_PER_DAY));
	const observed = observedOf(kind);

	const d0 = run.start;
	const lo = cs.calibrationStart ? toEpochDay(cs.calibrationStart) - d0 : 0;
	const hi = cs.calibrationEnd ? toEpochDay(cs.calibrationEnd) - d0 : days - 1;
	const allExclusions: DateRange[] = [...exclusionRanges(cs.calibrationExclusions).map(({ start, end }) => ({ start, end })), ...exclusions];
	const excluded = excludedDayMask(allExclusions, startDate, days);
	const windowIdx: number[] = [];
	for (let t = Math.max(0, lo); t <= Math.min(days - 1, hi); t++) if (!excluded[t]) windowIdx.push(t);
	const allIdx = windowIdx.filter((t) => Number.isFinite(observed[t]!));
	if (allIdx.length < 30) {
		throw new Error(`only ${allIdx.length} observed days inside the calibration window (outside exclusions); at least 30 are needed`);
	}
	// Per-day quality flags (CR-18/19, ./dayFlags.ts): which observed days the objective scores, and which it censors.
	// The gauged ranges (settings.qualityFlags.ratings) are the outlet records' ratings, so a gauge's record has none:
	// no day of it can be flagged as extrapolated. The data checks' suspect days still apply.
	// The same classes the run stores as `observed_flow_quality` (recordFlowFlags).
	const qf = siteQualityFlags(cs.qualityFlags, siteNodeId);
	const flagsOf = (k: CalibrationFlowKind) => recordFlowFlags({ kind: k, series: siteSeries[k], start: d0, days, settings: cs, siteNodeId, flowFill: run.flowFill });
	const flags = flagsOf(kind);
	const scoring = scoringDays(windowIdx, flags, qf, ratingOf(qf, kind), days);
	const idx = scoring.idx;
	if (idx.length < 30) {
		throw new Error(
			`only ${idx.length} of the ${allIdx.length} observed days inside the calibration window are left once the quality flags leave out extrapolated, suspect or infilled days; ` +
				'at least 30 are needed: check the gauged range and how flagged days are treated (Calibration → Calibration record)'
		);
	}

	// The network is causal: nothing after the last scored day changes a
	// score, so each evaluation stops there (a full run is tens of ms on a
	// multi-decade record; a record that ends early saves the rest).
	const toM3 = area * 1000;
	const hasRain = hasRainInput(input.series, settings.rainSource, settings.rainStations);
	const areal = arealRainFactors(settings.arealRain);
	const warmupDays = resolveWarmupDays(settings.gr4j?.warmupDays, warnings);
	const forcing = runoffForcing(settings, { startDate, days, aligned });
	const usedRain = runRain(aligned, hasRain, days);
	const rainFlags = usedRain ? rainDayFlags(aligned('rain_catchment_mm'), usedRain, run.rainSource?.column ?? null) : null;
	// The warm-up cycles the full forcing's historical days, as runModel's does,
	// so a scored day sees exactly the state a normal run would give it.
	const runoff = (p: ParamSet, n: number) => {
		if (perUnit) {
			// The same products and the same node-id order as the run's (runoff/simulate.ts unitNaturalFlow), so a scored
			// day's flow is runModel's to the bit.
			// Under calibration zones only the fitted zone's units take the candidate; the rest keep their zone's.
			const paramsOf = zoneParamsOf(zones, baseParams, { zone: zoneNodeId, free: p as unknown as Gr4jParams });
			const traces = simulateUnits(perUnit.units, p as unknown as Gr4jParams, forcing.petMm, { warmupDays, trace: false, days: n, cycleDays: historyDays, ...(paramsOf ? { paramsOf } : {}) });
			natural.fill(0, 0, n);
			perUnit.units.forEach((u, k) => {
				const q = traces[k]!.qMm;
				const buf = unitBuffers![k]!.runoffM3Day;
				for (let t = 0; t < n; t++) {
					buf[t] = q[t]! * u.areaKm2 * MM_KM2_TO_M3;
					natural[t] = natural[t]! + buf[t]!;
				}
			});
			return;
		}
		const tr = simulateRunoff(gr4j, p as unknown as Gr4jParams, forcing, { warmupDays, trace: false, days: n, cycleDays: historyDays });
		for (let t = 0; t < n; t++) natural[t] = tr.qMm[t]! * toM3;
		if (shareForcing) {
			// The share runs, as ewrShareRunoff makes them (the products in the same order), so the shares are runModel's to the bit.
			const traces = simulateUnits(shareForcing.units, p as unknown as Gr4jParams, forcing.petMm, { warmupDays, trace: false, days: n, cycleDays: historyDays });
			shareForcing.units.forEach((u, k) => {
				const q = traces[k]!.qMm;
				const buf = shareBuffers![k]!.runoffM3Day;
				for (let t = 0; t < n; t++) buf[t] = q[t]! * u.areaKm2 * MM_KM2_TO_M3;
			});
		}
	};
	/** The series a record is scored against, simulated for days 0 … n − 1. */
	// Land cover (WP-1.35) reads the whole run's natural flow (its low-flow
	// threshold is the flow exceeded 75 % of the historical days), so a run
	// with land cover can't stop at the last scored day.
	// A daily outlet EWR scaled by natural MAR (engine ≥ 1.77.0, §2.9f) reads every historical day's natural flow too.
	const wholeRun = plan.nodes.some((nd) => nd.landCover) || outletEwr?.source.scaling === 'mar';
	// Each unit's natural MAR share (engine ≥ 1.94.0 for the EWR; from 1.105.0 every run's one share, §2.5, §2.5b) reads
	// the units' runoff over its period, the complete water years: the runoff runs to the period's end, the network
	// still stops at the last scored day.
	const splitRefill = ewrSplit.refill;
	const refillShares = ewrSplit.refillShares;
	const areaKm2 = outletEwr?.info.modelAreaKm2 ?? 0;
	const simulator = (scoredTo: number) => {
		const n = wholeRun ? days : scoredTo;
		const shortPlan = { ...plan, days: n };
		const runoffTo = splitRefill ? Math.max(n, splitRefill.days.to) : n;
		return (p: ParamSet): Float64Array => {
			runoff(p, runoffTo);
			// The unit shares follow each candidate's units' runoff (Per unit's, or Fragmentation's share runs), as a run on
			// it would: the flow under Fragmentation, the EWR and the land-cover threshold read them as the network runs,
			// and the senior users' claims are made again from them (engine 1.105.0, issue #616).
			refillShares?.();
			// The daily outlet EWR from the DRM tables follows each candidate's natural flow, as a run on it would: after
			// the shares, which the natural flow crosses the units by when a reach loses.
			if (outletEwr) fillPlanOutletEwr(plan, topo.outflow, natural, outletEwr.source, areaKm2, historyDays, n);
			if (siteIndex < 0) return new Float64Array(days);
			return simulateNetwork(shortPlan).nodes[siteIndex]!.outflow;
		};
	};
	const lastAll = allIdx[allIdx.length - 1]!;
	return {
		model: modelId,
		startDate,
		days,
		area,
		startParams,
		flowKind: kind,
		siteNodeId,
		...(zones ? { zoneNodeId, zoneUnits: zoneNodeId === null ? [...zones.primaryUnits] : [...zones.zones.find((z) => z.nodeId === zoneNodeId)!.units] } : {}),
		flowSeriesId: siteSeries[kind]?.seriesId ?? null,
		records: CALIBRATION_FLOW_KINDS.filter((k) => !!siteSeries[k]),
		observed,
		scoredDays: idx,
		censor: scoring.censor,
		allDays: Int32Array.from(allIdx),
		windowDays: Int32Array.from(windowIdx),
		flowFlags: flags,
		dayQuality: dayQuality({
			flowKind: kind,
			settings: qf,
			windowIdx,
			flags,
			scoring,
			observed,
			rainFlags,
			zeroRunMask: run.zeroRain?.mask ?? null
		}),
		reference: input.series?.flow_reference_m3s ? Float64Array.from(aligned('flow_reference_m3s'), (v) => (v === null ? NaN : v)) : null,
		natural,
		// On natural flow, never the outflow: WR2012 flows are naturalised. They are net of WRSM's Bedloss
		// too, so with bed losses on (engine ≥ 1.76.0) on the natural flow at the outlet net of them.
		// A zone above the site moves only its own units' flow, so the catchment's WR2012 MAR is no target for it.
		marPenalty: zoneNodeId !== null ? null : netOfReachLosses(
			wr2012Penalty(
				settings.wr2012,
				startDate,
				idx[idx.length - 1]! + 1,
				area,
				arealRainOn(
					runRain(aligned, hasRain, idx[idx.length - 1]! + 1),
					areal,
					month
				)
			),
			plan,
			topo.outflow
		),
		exclusions: allExclusions,
		chirpsFactors: chirpsFactorSets(run.chirpsCorrection),
		...(perUnit ? { unitRain: unitRainFingerprint(settings.unitRain, perUnit.recipes) } : { shareRain: shareForcing ? unitRainFingerprint(shareForcingSettings(settings).unitRain, shareForcing.recipes) : null }),
		...(run.stations?.catchment ? { catchmentStation: catchmentStationFingerprint(rainStationSummary(run.stations.context, run.stations.catchment, [], run.stations.plan?.map ?? null)) } : {}),
		rain: arealRainOn(usedRain, areal, month),
		// Up to the last observed day, flagged or not: `fitAllDays` scores those too.
		simulate: simulator(Math.max(idx[idx.length - 1]!, lastAll) + 1),
		record(k) {
			if (!siteSeries[k]) return null;
			const obs = k === kind ? observed : observedOf(k);
			const on: number[] = [];
			for (let t = 0; t < days; t++) if (!excluded[t]) on.push(t);
			const sc = scoringDays(on, k === kind ? flags : flagsOf(k), qf, ratingOf(qf, k), days);
			const n = sc.idx.length ? sc.idx[sc.idx.length - 1]! + 1 : 0;
			let observedDays = 0;
			for (const t of on) if (Number.isFinite(obs[t]!)) observedDays++;
			return { kind: k, observed: obs, scoredDays: sc.idx, censor: sc.censor, observedDays, simulate: simulator(n) };
		}
	};
}

/**
 * What a fit at an inner gauge (engine ≥ 1.41.0) leaves out: the gauged
 * ranges and gap filling are the outlet records' settings, and the run's own
 * EWR test stays the outlet's.
 */
export const siteNote = (name: string): string =>
	`Scored at the gauge "${name}": its record against the simulated flow there. The gauged ranges and gap filling in Calibration → Calibration record are the outlet records', so none applies to this record. A run scores its calibration statistics here too; the outlet's EWR test stays the outlet's.`;

/** A fit of a calibration zone above the site (engine 1.106.0, issue #555): what it moves and what it leaves. */
export const zoneNote = (name: string, units: number): string =>
	`Fitted the calibration zone at the gauge "${name}": the parameters of its ${units} land unit${units === 1 ? '' : 's'} only, on that gauge's record against the simulated flow there, with every zone above it at its own parameters. The gauged ranges, gap filling and WR2012 MAR penalty are the outlet's, so none applies to this record; the run's calibration statistics stay at the calibration site.`;

/** A fit of the site's own zone when zones above it apply (engine 1.106.0). */
export const siteZoneNote = (units: number): string =>
	`Fitted the calibration site's own zone: the parameters of its ${units} land unit${units === 1 ? '' : 's'}, with the units in the calibration zones above it at their zones' parameters.`;

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

/**
 * Score a parameter set on the given days of a record (the calibration
 * record by default), with the scores' bootstrap intervals and benchmarks
 * unless `bare` (a start's score, where only the objective is read). Given
 * `benchFrom` (a validation period's calibration days on the same record),
 * the benchmarks are built from those days' flows (engine ≥ 1.62.0, CR-5).
 */
function scored(
	pb: CalibrationProblem,
	p: ParamSet,
	idx: Int32Array,
	rec: Pick<RecordProblem, 'observed' | 'simulate' | 'censor'> = pb,
	bare = false,
	benchFrom?: Int32Array
): ScoredPeriod {
	const sim = rec.simulate(p);
	// Censored above-rating days count as met once the simulation reaches the highest gauging (CR-19).
	const observed = censoredObserved(rec.observed, sim, idx, rec.censor ?? null);
	const [o, s] = pair(observed, sim, idx);
	const d0 = toEpochDay(pb.startDate);
	const years = yearsOf(pb, idx);
	const out: ScoredPeriod = {
		start: fromEpochDay(d0 + idx[0]!),
		end: fromEpochDay(d0 + idx[idx.length - 1]!),
		waterYears: [...new Set(years)].sort((a, b) => a - b),
		scores: fitScores(o, s, years),
		wr2012Fit: wr2012FitStats(d0, observed, sim, idx)
	};
	if (bare) return out;
	out.intervals = bootstrapIntervals(o, s, years);
	out.benchmarks = scoreBenchmarks(
		o,
		Int32Array.from(idx, (t) => d0 + t),
		years,
		undefined,
		benchFrom?.length
			? { o: Float64Array.from(benchFrom, (t) => rec.observed[t]!), days: Int32Array.from(benchFrom, (t) => d0 + t) }
			: undefined
	);
	return out;
}

interface FitResult {
	params: ParamSet;
	/** The best loss found (minimised; penalty included when on). */
	loss: number;
	evaluations: number;
	cancelled: boolean;
}

/** Seed of start `i` (0-based) of a fit seeded `seed`: start 0 is the seed itself, so one start reproduces a single-start fit. */
export const startSeed = (seed: number, i: number): number => (seed + i * 1_000_003) % 2 ** 31;

/** Starts within this of the best score count as reaching it. */
export const NEAR_BEST = 0.01;
/** A parameter whose near-best starts span more than this share of its search range is called unidentifiable. */
export const SCATTER_SHARE = 0.1;

/**
 * What the starts say about the fit: parameters the near-best starts
 * disagree on (equifinality), or starts that stopped short of the best.
 * Nothing when there is one start or they agree.
 */
export function startsNotes(
	objective: ObjectiveId,
	results: readonly StartResult[],
	specs: readonly { key: string; label: string; unit: string; lo: number; hi: number }[],
	/** The regional prior's penalty was on (issue #622): the start kept is the one with the lowest penalised loss, not the best score. */
	priorPenalised = false
): string[] {
	const scored = results.filter((r): r is StartResult & { score: number } => r.score !== null);
	if (scored.length < 2) return [];
	const label = OBJECTIVE_LABELS[objective].replace(/ \(.*\)$/, '');
	const top = Math.max(...scored.map((r) => r.score));
	const near = scored.filter((r) => r.score >= top - NEAR_BEST);
	const out: string[] = [];
	const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
	const scattered = specs
		.map((s) => {
			const v = near.map((r) => r.params[s.key]!);
			const lo = Math.min(...v);
			const hi = Math.max(...v);
			return { s, lo, hi, share: s.hi > s.lo ? (hi - lo) / (s.hi - s.lo) : 0 };
		})
		.filter((x) => x.share > SCATTER_SHARE);
	if (near.length >= 2 && scattered.length) {
		const low = Math.min(...near.map((r) => r.score));
		out.push(
			`${near.length} of ${results.length} starts reach nearly the same ${label} (${fmt(low)}–${fmt(top)}) with ` +
				scattered.map((x) => `${x.s.label} from ${fmt(x.lo)} to ${fmt(x.hi)}${x.s.unit ? ` ${x.s.unit}` : ''}`).join(', ') +
				': the record can’t pin these down, so the fitted values are one choice among near-equals.'
		);
	}
	const short = scored.filter((r) => r.score < top - NEAR_BEST);
	if (short.length) {
		out.push(
			`${short.length} of ${results.length} starts stopped short of the best ${label} (lowest ${fmt(Math.min(...short.map((r) => r.score)))} against ${fmt(top)}); ` +
				(priorPenalised
					? 'the start with the lowest loss, the regional prior’s penalty included, is kept, so it need not be the one with the best score.'
					: 'the best is kept. If many do, a larger budget may find better parameters.')
		);
	}
	return out;
}

function fit(
	pb: CalibrationProblem,
	idx: Int32Array,
	free: string[],
	objective: ObjectiveId,
	budget: number,
	seed: number,
	stage: CalibrationStage,
	onProgress: CalibrateOptions['onProgress'],
	penalty: Wr2012Penalty | null = null,
	bounds: FitBounds = 'wide',
	start?: { start: number; starts: number },
	prior: FitPrior | null = null
): FitResult {
	const specs = free.map((k) => CALIBRATION_PARAMS[pb.model].find((s) => s.key === k)!);
	const p: ParamSet = { ...pb.startParams };
	const obs = new Float64Array(idx.length);
	for (let i = 0; i < idx.length; i++) obs[i] = pb.observed[idx[i]!]!;
	const sim = new Float64Array(idx.length);
	const years = yearsOf(pb, idx);
	// Censored days (CR-19): positions and bounds, so each evaluation sets the observation the objective reads.
	const cen: number[] = [];
	if (pb.censor) for (let i = 0; i < idx.length; i++) if (!Number.isNaN(pb.censor[idx[i]!]!)) cen.push(i);
	const loss = (x: Float64Array) => {
		for (let j = 0; j < specs.length; j++) p[specs[j]!.key] = x[j]!;
		const full = pb.simulate(p);
		for (let i = 0; i < idx.length; i++) sim[i] = full[idx[i]!]!;
		for (const i of cen) {
			const c = pb.censor![idx[i]!]!;
			obs[i] = sim[i]! >= c ? sim[i]! : c;
		}
		const l = objectiveLoss(objective, obs, sim, years);
		const m = penalty ? l + penalty.penalty(pb.natural) : l;
		// The regional prior's log-normal penalty over the free parameters (issue #622), when its weight is over 0.
		return prior && prior.weight > 0 ? m + prior.weight * priorPenalty(prior.ranges, p) : m;
	};
	const res = dds(
		loss,
		specs.map((s) => boxOf(s, bounds, prior)),
		{
			budget,
			seed,
			x0: specs.map((s) => pb.startParams[s.key]!),
			onEvaluation: (n, f) => onProgress?.({ stage, ...start, evaluations: n, budget, best: 1 - f }) === true
		}
	);
	const params: ParamSet = { ...pb.startParams };
	specs.forEach((s, j) => (params[s.key] = res.x[j]!));
	return { params, loss: res.f, evaluations: res.evaluations, cancelled: res.stopped };
}

/** The prior as a fit reads it: its weight, and its ranges for the free parameters only (a fixed one is no choice of the fit's). */
interface FitPrior {
	weight: number;
	ranges: Partial<ParamPriors>;
	box: ReturnType<typeof priorBox>;
}

/** A parameter's search box: GR4J's min/max, Perrin's typical range, or the prior's p10–p90 (inside the min/max). */
function boxOf(s: (typeof CALIBRATION_PARAMS)['gr4j'][number], bounds: FitBounds, prior: FitPrior | null): { min: number; max: number } {
	if (bounds === 'prior') return prior!.box[s.key as PriorParam];
	return bounds === 'typical' ? { min: s.typical[0], max: s.typical[1] } : { min: s.min, max: s.max };
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

/**
 * Mean reference flow of each water year of the run with at least `minDays`
 * reference days (over the whole water year, whatever the calibration
 * window: a regional index of how wet the year was).
 */
export function referenceYearMeans(reference: ArrayLike<number>, startDate: string, minDays: number): Map<number, number> {
	const d0 = toEpochDay(startDate);
	const by = new Map<number, { sum: number; n: number }>();
	for (let t = 0; t < reference.length; t++) {
		const v = reference[t]!;
		if (!Number.isFinite(v)) continue;
		const wy = waterYearOf(d0 + t);
		const y = by.get(wy);
		if (y) {
			y.sum += v;
			y.n++;
		} else by.set(wy, { sum: v, n: 1 });
	}
	const out = new Map<number, number>();
	for (const [wy, y] of by) if (y.n >= minDays) out.set(wy, y.sum / y.n);
	return out;
}

/** How a record is named in the notes. */
const RECORD_NAME: Record<CalibrationFlowKind, string> = {
	flow_observed_m3s: 'gauge record',
	flow_logger_m3s: 'logger record'
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

/**
 * The prior as the fits read it, after checking it (issue #622): null with no
 * prior. Throws on a prior that can't be one, `bounds: 'prior'` without one, a
 * prior that would do nothing (no weight, no box), or one built for another
 * target than the fit's (the catchment, or the calibration zone fitted).
 */
function fitPriorOf(p: CalibrationPrior | undefined, bounds: FitBounds, free: readonly string[], pb: CalibrationProblem): FitPrior | null {
	if (!p) {
		if (bounds === 'prior') throw new Error('the prior bounds need a regional prior');
		return null;
	}
	const err = calibrationPriorError(p);
	if (err) throw new Error(err);
	if (!(p.weight > 0) && bounds !== 'prior') throw new Error('a regional prior with no penalty weight is used only as the search box (bounds “prior”)');
	const t = p.provenance.target;
	const units = pb.zoneUnits ? [...pb.zoneUnits] : null;
	if (!sameTarget(t, { zoneNodeId: units === null ? null : (pb.zoneNodeId ?? null), units })) {
		throw new Error(
			units === null
				? 'the regional prior was built for a calibration zone, but this fit is of the whole catchment: build the prior for the catchment'
				: 'the regional prior was built for another target than the calibration zone fitted: build it for this zone’s land units'
		);
	}
	const ranges: Partial<ParamPriors> = {};
	for (const k of free) if (k in p.ranges) ranges[k as PriorParam] = p.ranges[k as PriorParam];
	return { weight: p.weight, ranges, box: priorBox(p.ranges) };
}

/**
 * What a fit with the regional prior says about it (issue #622): what it did,
 * a free parameter its box pins (clipped to GR4J's bounds or with no spread),
 * and when the prior has no skill or no score.
 */
export function priorNotes(p: CalibrationPrior, bounded: boolean, free: readonly string[] = []): string[] {
	const n = p.provenance.donors.length;
	const how = [p.weight > 0 ? `a penalty of weight ${p.weight} pulled the parameters toward its medians` : null, bounded ? 'the search kept to its p10–p90 box' : null]
		.filter(Boolean)
		.join(', and ');
	const out = [`The fit used the regional GR4J prior from ${n} donor basin${n === 1 ? '' : 's'} of ${p.provenance.donorCount} (${p.provenance.dataset}${p.provenance.synthetic ? ', invented donors' : ''}): ${how}.`];
	if (bounded) {
		const box = priorBox(p.ranges);
		const pinned = free.filter((k): k is PriorParam => k in box && !(box[k as PriorParam].max - box[k as PriorParam].min > 1e-9));
		if (pinned.length) out.push(`The prior’s box holds ${pinned.join(', ')} at one value (no spread among the donors, or clipped to GR4J’s bounds), so the fit doesn’t move ${pinned.length === 1 ? 'it' : 'them'}.`);
	}
	const skill = p.provenance.leaveOneOutSkill;
	if (skill === null || skill <= 0) {
		out.push(
			skill === null
				? 'The prior has no leave-one-out score (too few donors), so how well it predicts a catchment’s parameters is unknown.'
				: `The prior has no skill: left out in turn, the donors’ parameters are predicted no better than by the plain median of the others (skill ${skill.toFixed(2)}).`
		);
	}
	return out;
}

/** Calibrate a runoff model's parameters against the project's observed flow. */
export function calibrate(input: ModelInput, opts: CalibrateOptions = {}): CalibrationReport {
	const objective = opts.objective ?? 'kgePrime';
	const bounds = opts.bounds ?? 'wide';
	const budget = Math.max(10, Math.floor(opts.budget ?? 1500));
	const seed = opts.seed ?? 1;
	const starts = Math.min(MAX_STARTS, Math.max(1, Math.floor(opts.starts ?? 1)));
	const pb = prepareCalibration(input, opts.exclusions, opts.model, opts.zone ?? null);
	const specs = CALIBRATION_PARAMS[pb.model];
	const free = opts.free ?? specs.filter((s) => !s.fixedByDefault).map((s) => s.key);
	if (free.length === 0) throw new Error('no parameters to calibrate');
	const unknown = free.filter((k) => !specs.some((s) => s.key === k));
	if (unknown.length) throw new Error(`not a calibratable ${pb.model} parameter: ${unknown.join(', ')}`);
	const prior = fitPriorOf(opts.prior, bounds, free, pb);
	let evaluations = 0;
	let cancelled = false;
	const penalty = pb.marPenalty;
	const fitOnce = (idx: Int32Array, stage: CalibrationStage, s: number, withPenalty = true, start?: { start: number; starts: number }) => {
		const r = fit(pb, idx, free, objective, budget, s, stage, opts.onProgress, withPenalty ? penalty : null, bounds, start, prior);
		evaluations += r.evaluations;
		cancelled ||= r.cancelled;
		return r;
	};
	const run = (idx: Int32Array, stage: CalibrationStage, s: number, withPenalty = true) => fitOnce(idx, stage, s, withPenalty).params;

	const all = pb.scoredDays;
	// The whole record from each start; the lowest loss is kept (CR-2).
	const fulls: { seed: number; r: FitResult }[] = [];
	for (let i = 0; i < starts && !cancelled; i++) {
		const s = startSeed(seed, i);
		fulls.push({ seed: s, r: fitOnce(all, 'full', s, true, starts > 1 ? { start: i + 1, starts } : undefined) });
	}
	const kept = fulls.reduce((b, x) => (x.r.loss < b.r.loss ? x : b), fulls[0]!);
	const params = kept.r.params;
	const startResults: StartResult[] = fulls.map((x) => ({
		seed: x.seed,
		params: x.r.params,
		score: scored(pb, x.r.params, all, pb, true).scores[objective],
		best: x === kept
	}));
	// How typical the scored years' rain is of the long-term record (CR-34).
	const representativeness = pb.rain ? recordRepresentativeness(pb.rain, pb.startDate, all) : null;
	const notes: string[] = [...(representativeness?.notes ?? [])];
	let splitSample: ValidationTest | null = null;
	let differential: DifferentialTest | null = null;

	if (opts.validate !== false && !cancelled) {
		// Split-sample: first half of the observed days vs the second.
		const half = Math.floor(all.length / 2);
		const a = all.slice(0, half);
		const b = all.slice(half);
		const p1 = run(a, 'split', seed + 1);
		splitSample = { params: p1, calibration: scored(pb, p1, a), validation: scored(pb, p1, b, pb, false, a) };
	}
	if (opts.validate !== false && !cancelled) {
		// Differential split-sample: driest half of the water years vs the wettest,
		// ranked by the reference gauge when it covers them (a regional index,
		// never scored), else by the fitted record's own flow.
		const years = waterYears(pb, MIN_DAYS_PER_YEAR);
		const want: DsstRanking = opts.rankYearsBy ?? (pb.reference ? 'reference' : 'observed');
		let rankedBy: DsstRanking = 'observed';
		let rankOf = new Map(years.map((y) => [y.year, y.mean]));
		if (want === 'reference' && years.length >= 4) {
			if (!pb.reference) {
				notes.push('The project has no reference gauge, so the dry → wet test ranks water years by their own observed flow.');
			} else {
				const ref = referenceYearMeans(pb.reference, pb.startDate, MIN_DAYS_PER_YEAR);
				const missing = years.filter((y) => !ref.has(y.year)).map((y) => y.year);
				if (missing.length) {
					notes.push(
						`The reference gauge has fewer than ${MIN_DAYS_PER_YEAR} days in ${missing.length} of the ${years.length} water years the dry → wet test uses ` +
							`(${missing.map((y) => `WY ${waterYearLabel(y)}`).join(', ')}), so it ranks them by their own observed flow instead.`
					);
				} else {
					rankOf = ref;
					rankedBy = 'reference';
				}
			}
		}
		years.sort((x, y) => rankOf.get(x.year)! - rankOf.get(y.year)!);
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
				validation: scored(pb, pd, wi, pb, false, di),
				dryYears: dry.map((y) => y.year).sort((p, q) => p - q),
				wetYears: wet.map((y) => y.year).sort((p, q) => p - q),
				wetDryRatio: ratio,
				rankedBy
			};
			if (ratio < WET_DRY_CONTRAST) {
				notes.push(
					(rankedBy === 'reference'
						? `The years the reference gauge ranks wettest carry only ${ratio.toFixed(1)}× the observed flow of those it ranks driest, so there are no clearly wet years to test on. `
						: `The wettest years in the record carry only ${ratio.toFixed(1)}× the flow of the driest, so there are no clearly wet years to test on. `) +
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
			notes.push(
				pb.siteNodeId === null
					? `The project has no ${RECORD_NAME[want]}, so the fit was not validated against one.`
					: `The calibration site has no ${RECORD_NAME[want]}, so the fit was not validated against one.`
			);
		} else if (rec.scoredDays.length < MIN_RECORD_DAYS) {
			const flagged = (rec.observedDays ?? rec.scoredDays.length) - rec.scoredDays.length;
			notes.push(
				`The ${RECORD_NAME[want]} has only ${rec.scoredDays.length} observed days outside the exclusions` +
					(flagged > 0 ? ` once the quality flags leave out ${flagged} extrapolated, suspect or infilled days` : '') +
					`, too few to validate against (at least ${MIN_RECORD_DAYS}).`
			);
		} else {
			const fitted = new Set(all);
			let overlapDays = 0;
			for (const t of rec.scoredDays) if (fitted.has(t)) overlapDays++;
			independentRecord = {
				flowKind: want,
				simulatedKey: 'simulated_outflow',
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
		marPenalty = {
			weight: penalty.weight,
			targetMarMm3: penalty.targetMarMm3,
			marLowMm3: penalty.marLowMm3,
			marHighMm3: penalty.marHighMm3,
			basis: penalty.basis,
			marRatio: ratio(params),
			unpenalised
		};
	}
	notes.push(...validationNotes(objective, splitSample, differential, independentRecord));
	notes.push(
		...startsNotes(
			objective,
			startResults,
			free.map((k) => {
				const s = specs.find((x) => x.key === k)!;
				const { min: lo, max: hi } = boxOf(s, bounds, prior);
				return { key: k, label: s.label, unit: s.unit, lo, hi };
			}),
			!!prior && prior.weight > 0
		)
	);
	if (pb.zoneNodeId != null) notes.push(zoneNote(input.model.nodes.find((n) => n.id === pb.zoneNodeId)?.name ?? pb.zoneNodeId, pb.zoneUnits?.length ?? 0));
	else if (pb.siteNodeId !== null) notes.push(siteNote(input.model.nodes.find((n) => n.id === pb.siteNodeId)?.name ?? pb.siteNodeId));
	if (pb.zoneNodeId === null && pb.zoneUnits) notes.push(siteZoneNote(pb.zoneUnits.length));
	// Under calibration zones each step warns of a short record or no dry year at its gauge (issue #555).
	if (pb.zoneUnits) {
		const at = pb.siteNodeId === null ? zoneSiteName(input.model.nodes, null) : (input.model.nodes.find((n) => n.id === pb.siteNodeId)?.name ?? pb.siteNodeId);
		notes.push(...zoneCoverageNotes(at, zoneCompleteWaterYears(pb.startDate, pb.allDays ?? all).length, differential !== null));
	}
	if (opts.prior) notes.push(...priorNotes(opts.prior, bounds === 'prior', free));
	if (cancelled) notes.push('Calibration was cancelled: the parameters are the best found before it stopped.');

	const fitClean = scored(pb, params, all);
	// The fit on every observed day, flagged ones included and nothing censored (CR-19), when the flags changed anything.
	const allDays = pb.allDays ?? all;
	const fitAllDays =
		allDays.length !== all.length || (pb.dayQuality?.censoredDays ?? 0) > 0 ? scored(pb, params, allDays, { observed: pb.observed, simulate: pb.simulate, censor: null }) : null;
	return {
		model: pb.model,
		objective,
		bounds,
		budget,
		seed,
		starts,
		startResults,
		free,
		params,
		startParams: pb.startParams,
		flowKind: pb.flowKind,
		siteNodeId: pb.siteNodeId,
		...(pb.zoneUnits ? { zoneNodeId: pb.zoneNodeId ?? null, zoneUnits: [...pb.zoneUnits] } : {}),
		...(pb.flowSeriesId ? { flowSeriesId: pb.flowSeriesId } : {}),
		simulatedKey: 'simulated_outflow',
		fit: fitClean,
		before: scored(pb, pb.startParams, all),
		splitSample,
		differential,
		independentRecord,
		marPenalty,
		...(opts.prior && prior
			? {
					prior: {
						weight: opts.prior.weight,
						bounded: bounds === 'prior',
						ranges: structuredClone(opts.prior.ranges),
						provenance: structuredClone(opts.prior.provenance),
						penaltyAtFit: priorPenalty(prior.ranges, params),
						penaltyAtStart: priorPenalty(prior.ranges, pb.startParams)
					}
				}
			: {}),
		notes,
		exclusions: pb.exclusions,
		representativeness,
		chirpsFactors: pb.chirpsFactors ?? null,
		...(pb.unitRain ? { unitRain: pb.unitRain } : {}),
		...(pb.shareRain !== undefined ? { shareRain: pb.shareRain } : {}),
		...(pb.catchmentStation ? { catchmentStation: pb.catchmentStation } : {}),
		dayQuality: pb.dayQuality ?? null,
		fitAllDays,
		evaluations,
		cancelled
	};
}
