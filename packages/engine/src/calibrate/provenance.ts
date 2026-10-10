// Calibration provenance (issue #4, assessor review): the stored calibration
// exclusions, and the record of the fit whose parameters a project uses.
//
// - settings.calibrationExclusions: periods left out of every calibration
//   score (Fit automatically and the run's calibration statistics), each a
//   whole water year or a date range, and each with a reason, so an awkward
//   period can't be dropped without leaving a record.
// - settings.fitRecord: what "Apply to form" wrote, and how it was found
//   (objective, seed, budget, window, exclusions, the validation scores and
//   notes, engine version, time). It describes the parameters only while they
//   are the fitted ones: `editedParams` lists those changed by hand since
//   (the backend recomputes it on every save, and each run snapshots it).
import { toEpochDay, waterYearLabel, isIsoDate as isRealDate } from '../calendar';
import { DEFAULT_UNIT_MAP_PERIOD, defaultDataQualitySettings, rainCheckLimits, resolveArealRain, resolveUnitRain, resolveChirpsQuantileMap, resolvePe, type ArealRain, type CalibrationFitStatus, type CalibrationFlowKind, type ChirpsBiasMode, type ChirpsFitPeriod, type ChirpsQuantileMap, type PeInput, type ProjectSettings, type RainCheckLimits, type RainSourcePeriod, type ZeroRainSettings } from '../project';
import type { ChirpsFactorSet } from '../rain';
import { GR4J_PARAMS } from '../runoff/params';
import { unitRainFingerprintChanged, type UnitRainFingerprint } from '../runoff/unitRainFingerprint';
import type { RunoffModelId } from '../runoff/types';
import { sameOrigin, sameProvenance, type SeriesOrigin, type SeriesProvenance } from '../seriesProvenance';
import type { FlowGapFillSettings, FlowGapFillSpec } from '../flowGapFill';
import type { AutoCalibrationReport } from './auto';
import type { CalibrationReport, DifferentialTest, IndependentRecordTest, MarPenaltyResult, ScoredPeriod, StartResult, ValidationTest } from './calibrate';
import type { CalibrationBounds, ParamSet } from './params';
import type { DayQuality } from './dayFlags';
import { resolveQualityFlags, type QualityFlagSettings } from './qualityFlagSettings';
import type { ObjectiveId } from './objectives';
import { resolveCalibrationRules, sameRules, type CalibrationRules } from './rulesSettings';

/** A period left out of calibration scores: a whole water year (Oct–Sep), or a date range. Always with a reason. */
export type CalibrationExclusion = { waterYear: number; reason: string } | { start: string; end: string; reason: string };

/** An exclusion as the inclusive dates it covers. */
export interface ExclusionRange {
	start: string;
	end: string;
	reason: string;
}

/** Longest reason stored. */
export const EXCLUSION_REASON_MAX = 500;
/** Most exclusions a project may store. */
export const EXCLUSIONS_MAX = 100;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && isRealDate(v);

/** The dates an exclusion covers: water year Y is 1 October Y to 30 September Y + 1. */
export function exclusionRange(x: CalibrationExclusion): ExclusionRange {
	return 'waterYear' in x
		? { start: `${x.waterYear}-10-01`, end: `${x.waterYear + 1}-09-30`, reason: x.reason }
		: { start: x.start, end: x.end, reason: x.reason };
}

export const exclusionRanges = (list: readonly CalibrationExclusion[] | null | undefined): ExclusionRange[] => (list ?? []).map(exclusionRange);

/** "WY 2015/16" or "2015-01-01 – 2015-03-31". */
export const exclusionLabel = (x: CalibrationExclusion): string =>
	'waterYear' in x ? `WY ${waterYearLabel(x.waterYear)}` : `${x.start} – ${x.end}`;

/** Why an exclusion is invalid, or null. */
export function exclusionError(x: unknown): string | null {
	if (typeof x !== 'object' || x === null) return 'not an exclusion';
	const o = x as Record<string, unknown>;
	if (typeof o.reason !== 'string' || !o.reason.trim()) return 'needs a reason';
	if (o.reason.length > EXCLUSION_REASON_MAX) return `reason longer than ${EXCLUSION_REASON_MAX} characters`;
	if ('waterYear' in o) {
		return Number.isInteger(o.waterYear) && (o.waterYear as number) >= 1800 && (o.waterYear as number) <= 2200 ? null : 'water year must be a whole year';
	}
	if (!isIsoDate(o.start) || !isIsoDate(o.end)) return 'dates must be YYYY-MM-DD';
	return o.start > o.end ? 'ends before it starts' : null;
}

/** What identifies an exclusion (its period): the same period can't be listed twice. */
export const exclusionKey = (x: CalibrationExclusion): string => ('waterYear' in x ? `wy:${x.waterYear}` : `${x.start}/${x.end}`);

/**
 * The first problem with a list of exclusions ("Exclusion 2: needs a reason"),
 * or null. `noun` names the entries of another dated-period list, such as
 * settings.zeroRainRuns' "keep-dry period".
 */
export function exclusionsError(list: readonly unknown[], noun = 'exclusion'): string | null {
	const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
	if (list.length > EXCLUSIONS_MAX) return `at most ${EXCLUSIONS_MAX} ${noun}s`;
	const seen = new Set<string>();
	for (let i = 0; i < list.length; i++) {
		const err = exclusionError(list[i]);
		if (err) return `${Noun} ${i + 1}: ${err}`;
		const key = exclusionKey(list[i] as CalibrationExclusion);
		if (seen.has(key)) return `${Noun} ${i + 1}: ${exclusionLabel(list[i] as CalibrationExclusion)} is listed twice`;
		seen.add(key);
	}
	return null;
}

/**
 * Stored exclusions as the engine uses them: invalid entries are dropped with
 * a warning (the backend rejects them on save; this guards older or imported
 * settings).
 */
export function sanitizeExclusions(raw: unknown, warnings: string[], what = 'calibration exclusion'): CalibrationExclusion[] {
	if (raw == null) return [];
	if (!Array.isArray(raw)) {
		warnings.push(`${what}s are not a list; ignored`);
		return [];
	}
	const out: CalibrationExclusion[] = [];
	for (const x of raw) {
		const err = exclusionError(x);
		if (err) {
			warnings.push(`${what} ${JSON.stringify(x).slice(0, 80)} ${err}; ignored`);
			continue;
		}
		const o = x as Record<string, unknown>;
		const reason = (o.reason as string).trim();
		out.push('waterYear' in o ? { waterYear: o.waterYear as number, reason } : { start: o.start as string, end: o.end as string, reason });
	}
	return out;
}

/** Day flags (1 = excluded) for a run of `days` days from `startDate`. */
export function excludedDayMask(ranges: readonly { start: string; end: string }[], startDate: string, days: number): Uint8Array {
	const d0 = toEpochDay(startDate);
	const mask = new Uint8Array(days);
	for (const x of ranges) {
		const a = Math.max(0, toEpochDay(x.start) - d0);
		const b = Math.min(days - 1, toEpochDay(x.end) - d0);
		for (let t = a; t <= b; t++) mask[t] = 1;
	}
	return mask;
}

// ---------------------------------------------------------------------------
// Fit record
// ---------------------------------------------------------------------------

/**
 * The fit whose parameters "Apply to form" wrote into the settings, and how
 * it was made: enough to reproduce it (same engine version, inputs and seed
 * give the same parameters) and to judge it by its validation, not its
 * in-sample score.
 */
export interface FitRecord {
	/** ISO timestamp of the fit. */
	fittedAt: string;
	engineVersion: string;
	model: RunoffModelId;
	objective: ObjectiveId;
	/** The box the search explored (issue #4 phase 6 §"make the logger fit identifiable"). */
	bounds: CalibrationBounds;
	seed: number;
	/** Starts of the full fit and each one's result (calibration research CR-2); absent on records made before it: one start. */
	starts?: number;
	startResults?: StartResult[];
	/** Model runs per optimisation. */
	budget: number;
	/** Model runs used over every stage. */
	evaluations: number;
	cancelled: boolean;
	/** Parameters fitted; the rest kept their value. */
	free: string[];
	/** Every parameter of `model` as fitted (what Apply wrote, for the free ones). */
	params: ParamSet;
	/** The parameters before the fit. */
	startParams: ParamSet;
	/** The record fitted to, and the series it was compared with. */
	flowKind: string;
	/**
	 * Where the fit was scored (engine ≥ 1.41.0, settings.calibrationSiteNodeId):
	 * null = the outlet, else the gauge node whose record `flowKind` is and
	 * whose simulated flow it was compared with. Absent on a record made
	 * before it: the outlet.
	 */
	siteNodeId?: string | null;
	simulatedKey: 'simulated_outflow';
	/** The calibration window and exclusions the fit used (the form's, at the time). */
	calibrationStart: string | null;
	calibrationEnd: string | null;
	exclusions: CalibrationExclusion[];
	/**
	 * settings.qualityFlags at the time (engine ≥ 1.22.0, CR-18/19): the gauged
	 * ranges and how flagged days were scored, which decide the days fitted as
	 * the window and exclusions do. Absent on a record made before it.
	 */
	qualityFlags?: QualityFlagSettings;
	/** The report's quality-flag summary (CR-22) and the fit on all days (CR-19); absent before engine 1.22.0. */
	dayQuality?: DayQuality | null;
	fitAllDays?: ScoredPeriod | null;
	/** Whether the split-sample and dry → wet tests were asked for, and the independent record. */
	validate: boolean;
	validationRecord: CalibrationFlowKind | null;
	/** The fitted parameters over the whole window: in-sample. */
	fit: ScoredPeriod;
	/** The parameters before the fit, on the same days. */
	before: ScoredPeriod;
	/**
	 * The forcing the fit ran under: `settings.panCoefficient`,
	 * `settings.apanMm` (water-year months) and `settings.chirpsBiasCorrection`
	 * at the time. GR4J's parameters trade off against evaporation, so a fit
	 * is only valid for the forcing it was fitted under — the pan coefficient
	 * must be held fixed, never calibrated. CHIRPS bias correction changes the
	 * rain fed to the model on the days CHIRPS fills a gap in the catchment
	 * record, so a fit's parameters are comparable only under the mode it ran
	 * under too. Absent on records made before `forcing` existed;
	 * `chirpsBiasCorrection` absent on a `forcing` made before it was tracked.
	 * `settings.zeroRainRuns` (engine ≥ 0.15.0) is recorded too: it decides
	 * which zero-rain days CHIRPS fills, and (engine ≥ 0.20.0, its
	 * accumulation fields) which multi-day accumulations are spread, so it
	 * changes the rain the fit saw; absent on a `forcing` made before it, and
	 * the accumulation fields absent on one made before 0.20.0.
	 * `settings.chirpsFitPeriod` (engine ≥ 0.29.0) decides which factors fill
	 * each gap, so it is recorded too, with the factors themselves per fit
	 * range (`chirpsFactors`, from the fit's own run); both absent on a
	 * `forcing` made before them.
	 * `chirpsSource` is the product and version the CHIRPS series held
	 * (issue #40 part c; null = not recorded, absent on a record made before
	 * it was tracked): the monthly CHIRPS factors are fitted on those values,
	 * so a different version changes the rain on every gap-filled day.
	 * `settings.rainSource` (engine ≥ 0.30.0) replaces the rain over its
	 * periods, so it is recorded too; a `forcing` without it ran with none.
	 * `settings.pe` (engine ≥ 0.31.0, issue #39) is where GR4J's potential
	 * evaporation came from: a `forcing` without it ran `{ kind: 'pan' }`
	 * (pan coefficient × A-pan). Under `kind: 'monthly'` the pan coefficient
	 * and A-pan don't reach GR4J, so a change to them alone is no GR4J
	 * forcing change (it still changes demand and dam evaporation, which the
	 * run records).
	 * `rainChecks` (engine ≥ 1.20.0, issue #66) is settings.dataQuality's
	 * zero-run and low-vs-CHIRPS limits: they decide which zero runs a run
	 * treats as missing and which years the CHIRPS fit leaves out, so they
	 * change the rain the fit saw. A `forcing` without it ran the defaults
	 * (they were engine constants).
	 */
	forcing?: {
		panCoefficient: number[];
		apanMm: number[];
		chirpsBiasCorrection?: ChirpsBiasMode;
		zeroRainRuns?: ZeroRainSettings;
		chirpsFitPeriod?: ChirpsFitPeriod;
		chirpsFactors?: ChirpsFactorSet[] | null;
		chirpsSource?: SeriesProvenance | null;
		rainSource?: RainSourcePeriod[];
		pe?: PeInput;
		/**
		 * The areal rainfall correction the fit ran under (engine ≥ 1.13.0,
		 * docs/model.md §2.4g); null = none. Absent on a record made before it,
		 * which ran with none, so a correction added since is a change.
		 */
		arealRain?: ArealRain | null;
		/**
		 * The CHIRPS gap map the fit ran under (engine ≥ 1.53.0, CR-23,
		 * settings.chirpsQuantileMap). Recorded only when it was on: absent =
		 * off, as every fit before it ran, so a map turned on since is a change.
		 */
		chirpsQuantileMap?: ChirpsQuantileMap | null;
		/** Where the pan-coefficient row came from (engine ≥ 0.31.1); provenance only, never a forcing change. */
		panCoefficientSource?: string;
		/**
		 * The daily A-pan series the fit ran on (engine ≥ 0.40.0, issue #45,
		 * docs/model.md §2.3a): its start, length and the SHA-256 of its values,
		 * as a run's input snapshot records them; null = the project had none.
		 * Absent on a record made before it was tracked, which is never flagged.
		 */
		apanDaily?: ApanDailyFingerprint | null;
		/** settings.dataQuality's rain-check limits (engine ≥ 1.20.0); absent = the defaults. */
		rainChecks?: RainCheckLimits;
		/**
		 * Runoff from each unit's own rain (engine ≥ 1.78.0, settings.unitRain
		 * `perUnit`, docs/model.md §2.4h): the setting and each land unit's rule,
		 * the record it names and its factors. Recorded only when on: absent =
		 * catchment rain, as every fit before it ran, so turning it on since is
		 * a change, and so is any unit's rule, record or factor changing.
		 */
		unitRain?: UnitRainFingerprint | null;
	};
	/**
	 * Where the fitted record (flowKind) came from and the unit it was given
	 * in (107_series_source.sql, engine ≥ 1.23.0): null = not recorded,
	 * absent on a record made before it was tracked (never flagged).
	 */
	observedOrigin?: SeriesOrigin | null;
	/**
	 * The fitted record's gap filling (settings.flowGapFill, engine ≥ 1.23.0):
	 * its spec (null = not filled). Whether the fit scored the filled days is
	 * `qualityFlags.infilled`. Absent on a record made before it. A record
	 * from the branch before the quality flags may carry a `useFilledDays`,
	 * never read.
	 */
	flowGapFill?: { spec: FlowGapFillSpec | null; useFilledDays?: boolean };
	splitSample: ValidationTest | null;
	differential: DifferentialTest | null;
	independentRecord: IndependentRecordTest | null;
	/**
	 * The soft WR2012 MAR penalty when it was on: its weight, the simulated
	 * MAR ratio, and the fit without it. null when it was off.
	 */
	marPenalty: MarPenaltyResult | null;
	/** The report's notes (limits of the validation, cancellation). */
	notes: string[];
	/**
	 * Set when automated calibration (engine ≥ 1.25.0, issue #153, ./auto.ts)
	 * picked this fit, rather than a person: the rules it ran under, the water
	 * years they left out and every case it fitted, with why each was or wasn't
	 * kept. The seed and engine version are the record's own. Absent on a fit a
	 * person chose.
	 */
	auto?: AutoFitRecord;
	/**
	 * Fitted parameters whose value in the settings no longer matches the fit
	 * (edited by hand since). Empty = the settings hold the fitted values. Set
	 * by the server on save and by each run; a client can't clear it.
	 */
	editedParams: string[];
}

/** How automated calibration chose a fit (FitRecord.auto). */
export interface AutoFitRecord {
	/** settings.calibrationRules as the fit ran, revision and sign-off included. */
	rules: CalibrationRules;
	/** The water years the exclusion rule left out, on top of `exclusions`, each with the rule's reason. */
	ruleExclusions: CalibrationExclusion[];
	/** Index of the kept case in `cases`. */
	chosen: number;
	cases: AutoFitCase[];
}

/** One case of an automated fit, as the record keeps it: enough to see why the kept one won. */
export interface AutoFitCase {
	label: string;
	/** 'project' or a pan coefficient preset id. */
	pan: string;
	bounds: CalibrationBounds;
	objective: ObjectiveId;
	/** The held-out score the rules select by; null when there was none. */
	score: number | null;
	eligible: boolean;
	reasons: string[];
	/** The case's fitted parameters; null when it failed. */
	params: ParamSet | null;
}

/** What the fit record keeps of a report whose `chosen` case was applied (FitRecord.auto). */
export function autoFitRecordOf(r: AutoCalibrationReport & { chosen: number }): AutoFitRecord {
	return {
		rules: resolveCalibrationRules(r.rules, []),
		ruleExclusions: r.ruleExclusions.map((x) => ({ ...x })),
		chosen: r.chosen,
		cases: r.cases.map((c) => ({
			label: c.label,
			pan: c.pan.id,
			bounds: c.bounds,
			objective: c.objective,
			score: c.score,
			eligible: c.eligible,
			reasons: [...c.reasons],
			params: c.report ? { ...c.report.params } : null
		}))
	};
}

/**
 * Which daily A-pan series (`evap_apan_mm`) a fit ran on: what a run's input
 * snapshot records for it (`RunSeriesSnapshot`: start, length, and
 * `valuesSha256`, the SHA-256 hex of `seriesDigest(values)`).
 */
export interface ApanDailyFingerprint {
	startDate: string;
	length: number;
	valuesSha256: string;
}

const sameApanDaily = (a: ApanDailyFingerprint | null, b: ApanDailyFingerprint | null): boolean =>
	a === null || b === null ? a === b : a.startDate === b.startDate && a.length === b.length && a.valuesSha256 === b.valuesSha256;

export interface FitContext {
	/** The Settings form the fit ran on. */
	settings: Pick<ProjectSettings, 'calibrationStart' | 'calibrationEnd' | 'panCoefficient' | 'apanMm' | 'chirpsBiasCorrection'> & {
		calibrationExclusions?: CalibrationExclusion[] | null;
		/** Engine ≥ 1.22.0; absent = the defaults. */
		qualityFlags?: QualityFlagSettings | null;
		zeroRainRuns?: ZeroRainSettings;
		chirpsFitPeriod?: ChirpsFitPeriod;
		rainSource?: RainSourcePeriod[];
		/** GR4J's PE input (engine ≥ 0.31.0); absent = `{ kind: 'pan' }`. */
		pe?: PeInput | null;
		/** The areal rainfall correction (engine ≥ 1.13.0); absent = none. */
		arealRain?: ArealRain | null;
		/** The CHIRPS gap map (engine ≥ 1.53.0); absent = off. */
		chirpsQuantileMap?: ChirpsQuantileMap | null;
		panCoefficientSource?: string;
		/** Gap filling of the observed flow records (engine ≥ 1.23.0); absent = none. */
		flowGapFill?: FlowGapFillSettings | null;
		/** settings.dataQuality (engine ≥ 1.20.0): its rain-check limits are recorded; absent = the defaults. */
		dataQuality?: Partial<RainCheckLimits> | null;
	};
	validate: boolean;
	validationRecord: CalibrationFlowKind | null;
	engineVersion: string;
	fittedAt: string;
	/** The CHIRPS series' product and version when the fit ran (null = not recorded); omit when not known. */
	chirpsSource?: SeriesProvenance | null;
	/** The daily A-pan series the fit ran on (null = none); omit when not known. */
	apanDaily?: ApanDailyFingerprint | null;
	/** The fitted record's source and unit (null = not recorded); omit when not known. */
	observedOrigin?: SeriesOrigin | null;
	/** How automated calibration chose the fit; omit for a fit a person chose. */
	auto?: AutoFitRecord;
}

/** The settings exclude exactly the fit's exclusions and the water years its rule left out (date ranges compared). */
function withRuleYears(settings: Partial<ProjectSettings>, record: FitRecord): boolean {
	const rule = record.auto?.ruleExclusions ?? [];
	if (!rule.length) return false;
	const key = (xs: readonly CalibrationExclusion[]) => JSON.stringify(exclusionRanges(xs).map((r) => [r.start, r.end]).sort());
	return key(settings.calibrationExclusions ?? []) === key([...(record.exclusions ?? []), ...rule]);
}

/** Whether any water year an automated fit's rule left out is still scored under these exclusions. */
function ruleYearsScored(exclusions: readonly CalibrationExclusion[], ruleYears: readonly CalibrationExclusion[]): boolean {
	if (!ruleYears.length) return false;
	const kept = exclusionRanges(exclusions);
	return exclusionRanges(ruleYears).some((r) => !kept.some((k) => k.start <= r.start && k.end >= r.end));
}

/** The fit record for a report, as Apply stores it. */
export function fitRecordFromReport(r: CalibrationReport, ctx: FitContext): FitRecord {
	return {
		fittedAt: ctx.fittedAt,
		engineVersion: ctx.engineVersion,
		model: r.model,
		objective: r.objective,
		bounds: r.bounds,
		seed: r.seed,
		starts: r.starts,
		startResults: r.startResults.map((x) => ({ ...x, params: { ...x.params } })),
		budget: r.budget,
		evaluations: r.evaluations,
		cancelled: r.cancelled,
		free: [...r.free],
		params: { ...r.params },
		startParams: { ...r.startParams },
		flowKind: r.flowKind,
		siteNodeId: r.siteNodeId ?? null,
		simulatedKey: r.simulatedKey,
		calibrationStart: ctx.settings.calibrationStart ?? null,
		calibrationEnd: ctx.settings.calibrationEnd ?? null,
		exclusions: (ctx.settings.calibrationExclusions ?? []).map((x) => ({ ...x })),
		qualityFlags: resolveQualityFlags(ctx.settings.qualityFlags, []),
		...(r.dayQuality !== undefined ? { dayQuality: structuredClone(r.dayQuality) } : {}),
		...(r.fitAllDays !== undefined ? { fitAllDays: r.fitAllDays } : {}),
		validate: ctx.validate,
		validationRecord: ctx.validationRecord,
		fit: r.fit,
		before: r.before,
		forcing: {
			panCoefficient: [...ctx.settings.panCoefficient],
			apanMm: [...ctx.settings.apanMm],
			chirpsBiasCorrection: ctx.settings.chirpsBiasCorrection,
			...(ctx.settings.zeroRainRuns ? { zeroRainRuns: structuredClone(ctx.settings.zeroRainRuns) } : {}),
			chirpsFitPeriod: structuredClone(ctx.settings.chirpsFitPeriod ?? 'all'),
			...(r.chirpsFactors !== undefined ? { chirpsFactors: structuredClone(r.chirpsFactors) } : {}),
			...(ctx.chirpsSource !== undefined ? { chirpsSource: ctx.chirpsSource ? { ...ctx.chirpsSource } : null } : {}),
			rainSource: structuredClone(ctx.settings.rainSource ?? []),
			pe: structuredClone(resolvePe(ctx.settings.pe, [])),
			arealRain: resolveArealRain(ctx.settings.arealRain, []),
			...(gapMapOf(ctx.settings) ? { chirpsQuantileMap: gapMapOf(ctx.settings) } : {}),
			...(ctx.settings.panCoefficientSource ? { panCoefficientSource: ctx.settings.panCoefficientSource } : {}),
			...(ctx.apanDaily !== undefined ? { apanDaily: ctx.apanDaily ? { ...ctx.apanDaily } : null } : {}),
			rainChecks: rainChecksOf(ctx.settings.dataQuality),
			...(r.unitRain ? { unitRain: structuredClone(r.unitRain) } : {})
		},
		...(ctx.observedOrigin !== undefined ? { observedOrigin: ctx.observedOrigin ? { ...ctx.observedOrigin } : null } : {}),
		// A gauge's record is never gap filled (the specs are the outlet records').
		flowGapFill: { spec: r.siteNodeId ? null : fillSpecOf(ctx.settings.flowGapFill, r.flowKind) },
		splitSample: r.splitSample,
		differential: r.differential,
		independentRecord: r.independentRecord,
		marPenalty: r.marPenalty ?? null,
		notes: [...r.notes],
		// JSON, not structuredClone: a page may hand in a reactive proxy.
		...(ctx.auto ? { auto: JSON.parse(JSON.stringify(ctx.auto)) as AutoFitRecord } : {}),
		editedParams: []
	};
}

/** Keys of a runoff model's calibratable parameters. */
const PARAM_KEYS: Record<RunoffModelId, readonly string[]> = {
	gr4j: GR4J_PARAMS.map((p) => p.key)
};

/** The settings' current value of a model's parameter. */
function currentParam(settings: Partial<ProjectSettings>, _model: RunoffModelId, key: string): unknown {
	return (settings.gr4j as Record<string, unknown> | undefined)?.[key];
}

const close = (a: unknown, b: unknown) =>
	typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Fitted parameters whose value in `settings` differs from the fit. */
export function editedParams(settings: Partial<ProjectSettings>, record: Pick<FitRecord, 'model' | 'free' | 'params'>): string[] {
	const keys = PARAM_KEYS[record.model] ?? [];
	return record.free.filter((k) => keys.includes(k) && !close(currentParam(settings, record.model, k), record.params[k]));
}

/**
 * The settings' fit record with `editedParams` recomputed against the
 * settings' parameters; null when there is none. The backend stores this on
 * every save and each run snapshots it.
 */
export function resolveFitRecord(settings: Partial<ProjectSettings> & Record<string, unknown>): FitRecord | null {
	const r = settings.fitRecord as FitRecord | null | undefined;
	if (!r || typeof r !== 'object' || !(r.model in PARAM_KEYS) || !Array.isArray(r.free) || typeof r.params !== 'object') return null;
	return { ...r, editedParams: editedParams(settings, r) };
}

/** How the fit record relates to the settings it sits in: what a reader must know before trusting it. */
export interface FitRecordStatus {
	/** Parameters changed by hand since the fit. */
	editedParams: string[];
	/**
	 * The fit is of another runoff model than the one the run uses (GR4J): a
	 * stored fit of the legacy model, removed in engine 1.0.0 (issue #16).
	 */
	otherModel: boolean;
	/** The calibration window, exclusions or flow record differ from the fit's. */
	windowChanged: boolean;
	exclusionsChanged: boolean;
	/**
	 * An automated fit's rule left water years out (FitRecord.auto.ruleExclusions)
	 * that the settings' exclusions don't: a run scores days the fit never saw,
	 * so its statistics aren't in-sample (engine ≥ 1.69.0).
	 */
	ruleYearsScored?: boolean;
	/**
	 * The quality-flag settings (a gauged range, or how extrapolated, suspect
	 * or infilled days are scored; engine ≥ 1.22.0) differ from the fit's, so
	 * other days would be fitted. False on a record made before them.
	 */
	qualityFlagsChanged: boolean;
	flowKindChanged: boolean;
	/**
	 * The calibration site (settings.calibrationSiteNodeId, engine ≥ 1.41.0)
	 * differs from the fit's: another gauge's record, or the outlet's. A
	 * record made before it was fitted at the outlet.
	 */
	siteChanged: boolean;
	/**
	 * The potential-evaporation input (`settings.pe`: its kind, or its
	 * monthly row; not its source note), the pan coefficient and A-pan
	 * evaporation (only while `pe` is `{ kind: 'pan' }`, the only time GR4J
	 * reads them), CHIRPS bias correction, CHIRPS fit period, rain-source
	 * periods, zero-rain run settings or the data-quality rain-check limits
	 * (engine ≥ 1.20.0; the forcing GR4J runs under) have changed since the fit. False for records made before `forcing` was recorded, and a
	 * field added to `forcing` later (`chirpsBiasCorrection`, `zeroRainRuns`)
	 * never flags a record made before it: there is nothing to compare
	 * against. Also true when `chirpsSourceChanged`.
	 */
	forcingChanged: boolean;
	/**
	 * The CHIRPS series now holds another product or version than the fit ran
	 * on (CHIRPS v2.0 → v3.0): the monthly CHIRPS factors, and so every
	 * gap-filled day's rain, changed. False when the record or the caller
	 * doesn't know the version.
	 */
	chirpsSourceChanged: boolean;
	/**
	 * The daily A-pan series (engine ≥ 0.40.0, issue #45) was added, removed
	 * or changed since a GR4J fit that ran on pan coefficient × A-pan, and
	 * GR4J still does: the PE on the days it covers changed. False when the
	 * record or the caller doesn't know the series, and
	 * under a monthly PE (the series doesn't reach GR4J). Also sets
	 * `forcingChanged`.
	 */
	apanDailyChanged: boolean;
	/**
	 * The monthly CHIRPS factors the run applies drifted from those the fit
	 * recorded (`forcing.chirpsFactors`) by more than CHIRPS_FACTOR_TOLERANCE
	 * in some month, with the same bias-correction mode, fit period and CHIRPS
	 * product (issue #51): the factors are fitted on every day the catchment
	 * rain and CHIRPS share, so a logger reporting beside a daily CHIRPS feed,
	 * or preliminary CHIRPS turning final, moves them run to run, and with
	 * them the rain on every gap CHIRPS fills. False when the record or the
	 * caller doesn't know the factors, and when one of those settings (or the
	 * product) changed, which forcingChanged / chirpsSourceChanged already
	 * say. Also sets `forcingChanged`.
	 */
	chirpsFactorsChanged: boolean;
	/**
	 * The fitted record now comes from another source, or was given in
	 * another unit, than when it was fitted (107_series_source.sql, engine ≥
	 * 1.23.0): a unit conversion error or another station changes what the
	 * parameters were fitted to. False when the record or the caller doesn't
	 * know the source.
	 */
	observedOriginChanged: boolean;
	/**
	 * The fitted record's gap filling spec changed while infilled days are
	 * scored both at the fit and now (engine ≥ 1.23.0): the filled days the fit
	 * scored aren't the ones a run scores. A change of the infilled treatment
	 * itself is qualityFlagsChanged, never this too.
	 */
	flowFillChanged: boolean;
	/**
	 * An automated fit's calibration rules (FitRecord.auto) no longer match
	 * settings.calibrationRules: the rules would now pick another way. False
	 * on a fit a person chose. A sign-off alone is no change.
	 */
	rulesChanged: boolean;
	/** An automated fit ran under draft rules, not signed off (#90): not evidence. False on a fit a person chose. */
	draftRules: boolean;
}

/**
 * How far a monthly CHIRPS factor may move from the fit's before the fit's
 * forcing counts as changed (issue #51): 2 % relative. Below it the drift of
 * a growing overlap is noise against the factors' own uncertainty (§2.4b
 * fits each on at least 90 shared days); above it the gap-filled rain moves
 * by more than a gauge's typical catch error.
 */
export const CHIRPS_FACTOR_TOLERANCE = 0.02;

/**
 * Whether two CHIRPS factor sets (the fit's and a run's, rain.ts
 * chirpsFactorSets) differ beyond the tolerance: another number of fit
 * ranges, a month with a factor on one side only, or a month whose factor
 * moved by more than CHIRPS_FACTOR_TOLERANCE of the fit's. Null (no monthly
 * correction) on both sides is the same.
 */
export function chirpsFactorsDrifted(then: readonly ChirpsFactorSet[] | null, now: readonly ChirpsFactorSet[] | null, tolerance = CHIRPS_FACTOR_TOLERANCE): boolean {
	if (!then || !now) return !then !== !now;
	if (then.length !== now.length) return true;
	return then.some((set, i) => {
		const a = set.factors;
		const b = now[i]!.factors;
		if (a.length !== b.length) return true;
		return a.some((f, m) => {
			const g = b[m];
			if (f == null || g == null) return (f == null) !== (g == null);
			return Math.abs(g - f) > tolerance * Math.abs(f);
		});
	});
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Every element of two same-length numeric arrays is `close`. */
const closeArray = (a: readonly number[] | null | undefined, b: readonly number[] | null | undefined): boolean =>
	!!a && !!b && a.length === b.length && a.every((v, i) => close(v, b[i]));

/**
 * The rain-check limits of a stored settings.dataQuality or a forcing's
 * `rainChecks`, over the defaults: absent (a record or settings from before
 * engine 1.20.0) ran the defaults, when they were engine constants.
 */
function rainChecksOf(dq: Partial<RainCheckLimits> | undefined | null): RainCheckLimits {
	return rainCheckLimits({ ...defaultDataQualitySettings(), ...(dq ?? {}) });
}

/** Settings without zeroRainRuns predate it (engine < 0.15.0): flagged zero runs ran as recorded. */
const zeroRainOf = (s: Partial<ProjectSettings>) => {
	const z = { mode: 'asRecorded', keepDry: [], missing: [], ...(s.zeroRainRuns ?? {}) } as Partial<ZeroRainSettings>;
	return { mode: z.mode, keepDry: z.keepDry, missing: z.missing };
};
/**
 * The accumulation fields (engine ≥ 0.20.0), absent ones as the engine runs
 * them today ('spread', no periods). Compared only when the fit recorded them:
 * a forcing made before them has nothing to compare against.
 */
const accumulationOf = (z: Partial<ZeroRainSettings> | undefined) => ({
	accumulationMode: z?.accumulationMode ?? 'spread',
	keepReadings: z?.keepReadings ?? [],
	addAccumulations: z?.addAccumulations ?? []
});

/**
 * Whether two PE inputs give GR4J different potential evaporation: another
 * kind, or another `monthly` row. The `source` note is left out on purpose:
 * rewording where the numbers came from doesn't change what GR4J ran on, so
 * it must not ask for a refit (the fit record still keeps the note).
 */
const peChanged = (a: PeInput, b: PeInput): boolean =>
	a.kind !== b.kind || (a.kind === 'monthly' && b.kind === 'monthly' && !closeArray(a.mm, b.mm));

/**
 * Whether two areal rainfall corrections give GR4J different rain: one where
 * there was none (or the reverse), or another factor in some month. The method
 * and source note are left out, as the PE source is: rewording where a factor
 * came from doesn't change the rain the fit ran on. A correction of all 1s is
 * the same rain as none.
 */
const ONES = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
const arealRainChanged = (a: ArealRain | null, b: ArealRain | null): boolean => !closeArray(a?.factors ?? ONES, b?.factors ?? ONES);

/** The CHIRPS gap map a run under these settings applies (engine ≥ 1.53.0): only in mode 'monthly'; null = off. */
function gapMapOf(s: { chirpsQuantileMap?: unknown; chirpsBiasCorrection?: ChirpsBiasMode }): ChirpsQuantileMap | null {
	return (s.chirpsBiasCorrection ?? 'monthly') === 'monthly' ? resolveChirpsQuantileMap(s.chirpsQuantileMap, []) : null;
}

/**
 * Which of a fit's recorded forcing fields differ from the settings, or null
 * when there is nothing recorded to compare. `panCoefficient` and `apanMm`
 * count only while the settings' `pe` is `{ kind: 'pan' }`: under
 * `kind: 'monthly'` GR4J never reads them (they still drive demand and dam
 * evaporation, which aren't part of a fit's forcing). `pe` is the PE input
 * itself (engine ≥ 0.31.0; either side without one is `{ kind: 'pan' }`).
 */
function forcingDiff(
	settings: Partial<ProjectSettings>,
	record: FitRecord
): {
	panCoefficient: boolean;
	apanMm: boolean;
	pe: boolean;
	arealRain: boolean;
	chirpsBiasCorrection: boolean;
	zeroRainRuns: boolean;
	chirpsFitPeriod: boolean;
	chirpsQuantileMap: boolean;
	rainSource: boolean;
	rainChecks: boolean;
	unitRain: boolean;
} | null {
	if (!record.forcing) return null;
	const pe = resolvePe(settings.pe, []);
	const panReachesGr4j = pe.kind === 'pan';
	return {
		panCoefficient: panReachesGr4j && !closeArray(settings.panCoefficient, record.forcing.panCoefficient),
		apanMm: panReachesGr4j && !closeArray(settings.apanMm, record.forcing.apanMm),
		// Engine ≥ 0.31.0. A forcing without it ran pan coefficient × A-pan, so a monthly PE now is a change.
		pe: peChanged(pe, resolvePe(record.forcing.pe, [])),
		// Engine ≥ 1.13.0. A forcing without it ran with none, so a correction added since is a change.
		arealRain: arealRainChanged(resolveArealRain(settings.arealRain, []), resolveArealRain(record.forcing.arealRain, [])),
		// Absent on a forcing recorded before this field existed: nothing to compare, so never flagged.
		chirpsBiasCorrection: record.forcing.chirpsBiasCorrection !== undefined && settings.chirpsBiasCorrection !== record.forcing.chirpsBiasCorrection,
		zeroRainRuns:
			record.forcing.zeroRainRuns !== undefined &&
			(!sameJson(zeroRainOf(settings), zeroRainOf({ zeroRainRuns: record.forcing.zeroRainRuns })) ||
				(record.forcing.zeroRainRuns.accumulationMode !== undefined &&
					!sameJson(accumulationOf(settings.zeroRainRuns), accumulationOf(record.forcing.zeroRainRuns)))),
		// Engine ≥ 0.29.0; absent on an older forcing, so never flagged there.
		chirpsFitPeriod: record.forcing.chirpsFitPeriod !== undefined && !sameJson(settings.chirpsFitPeriod ?? 'all', record.forcing.chirpsFitPeriod),
		// Engine ≥ 1.53.0. A forcing without it ran without the gap map, so one turned on since is a change.
		chirpsQuantileMap: !sameJson(gapMapOf(settings), gapMapOf({ chirpsQuantileMap: record.forcing.chirpsQuantileMap, chirpsBiasCorrection: record.forcing.chirpsBiasCorrection })),
		// Engine ≥ 0.30.0. A forcing without it predates rain-source periods, so it ran with none.
		rainSource: !sameJson(settings.rainSource ?? [], record.forcing.rainSource ?? []),
		// Engine ≥ 1.20.0. A forcing without it ran the defaults, so a limit changed since is a change.
		rainChecks: !sameJson(rainChecksOf(settings.dataQuality), rainChecksOf(record.forcing.rainChecks)),
		// Engine ≥ 1.78.0. A forcing without it ran on the catchment rain, so per-unit rain turned on since is a change.
		unitRain: unitRainSettingChanged(settings.unitRain, record.forcing.unitRain ?? null)
	};
}

/**
 * Whether settings.unitRain differs from what a fit recorded of it (engine ≥
 * 1.78.0): on one side only, or another gauge MAP or MAP period. The units'
 * rules and factors depend on the model and its series too, so a run's own
 * fingerprint (FitForcingNow.unitRain) compares those.
 */
function unitRainSettingChanged(now: unknown, then: UnitRainFingerprint | null): boolean {
	const u = resolveUnitRain(now, []);
	const on = u?.mode === 'perUnit';
	if (!on || !then) return on !== !!then;
	const gauge = u.gaugeMapMm ?? null;
	const period = u.mapPeriod ?? DEFAULT_UNIT_MAP_PERIOD;
	// The reference gauge and unit (engine ≥ 1.80.0): another one, or one on a side only.
	const ref = u.reference ?? null;
	const was = then.reference ?? null;
	const refChanged = !ref || !was ? !ref !== !was : ref.gauge !== was.gauge || ref.unitId !== was.unitId;
	return gauge !== then.gaugeMapMm || period.start !== then.mapPeriod.start || period.end !== then.mapPeriod.end || refChanged;
}

/** What the settings don't hold but a fit's forcing depends on: the CHIRPS series' product and version now (omit when not known). */
export interface FitForcingNow {
	chirpsSource?: SeriesProvenance | null;
	/**
	 * The CHIRPS factor sets a run applied (rain.ts chirpsFactorSets of its
	 * summary.chirpsCorrection; null = no monthly correction); omit when not
	 * known (the Settings form, which has no run).
	 */
	chirpsFactors?: ChirpsFactorSet[] | null;
	/** The daily A-pan series a run would read now (null = none); omit when not known. */
	apanDaily?: ApanDailyFingerprint | null;
	/** The fitted record's source and unit now (null = not recorded); omit when not known. */
	observedOrigin?: SeriesOrigin | null;
	/**
	 * The per-unit forcing a run applied (unitRainFingerprintOfSummary of its
	 * summary.unitRain; null = catchment rain); omit when not known (the
	 * Settings form, which has no run: then only settings.unitRain itself is compared).
	 */
	unitRain?: UnitRainFingerprint | null;
}

/** A record's gap-fill spec, copied; null when it isn't filled (or isn't a record a spec fills). */
function fillSpecOf(fill: FlowGapFillSettings | null | undefined, kind: string): FlowGapFillSpec | null {
	const spec = kind === 'flow_observed_m3s' || kind === 'flow_logger_m3s' ? fill?.[kind] : null;
	return spec ? { ...spec } : null;
}

/**
 * Whether the filled days a fit of `kind` scored differ from those a run scores
 * now (engine ≥ 1.23.0): only when infilled days are scored both then and now
 * (settings.qualityFlags.infilled 'include') and the record's fill spec
 * changed. A change of the infilled treatment itself is qualityFlagsChanged,
 * so one change is flagged once.
 */
function flowFillDiffers(record: FitRecord, settings: Partial<ProjectSettings>, kind: string): boolean {
	const scoredThen = record.qualityFlags?.infilled === 'include';
	const scoredNow = resolveQualityFlags(settings.qualityFlags, []).infilled === 'include';
	if (!scoredThen || !scoredNow) return false;
	// A fit at a gauge read no fill (engine ≥ 1.41.0), whatever the outlet records' specs say.
	if (record.siteNodeId) return false;
	return !sameJson(record.flowGapFill?.spec ?? null, fillSpecOf(settings.flowGapFill, kind));
}

/** Quality-flag settings as a fit at the record's site scored with them: a gauge's record has no gauged range. */
function flagsAsScored(q: unknown, record: FitRecord): QualityFlagSettings {
	const r = resolveQualityFlags(q, []);
	return record.siteNodeId ? { ...r, ratings: {} } : r;
}

/** Compare a fit record with the settings (the form, or a run's snapshot), and with the CHIRPS series' version when `now` gives it. */
export function fitRecordStatus(settings: Partial<ProjectSettings>, record: FitRecord, now: FitForcingNow = {}): FitRecordStatus {
	const kind = settings.calibrationFlowKind ?? null;
	const forcing = forcingDiff(settings, record);
	const recorded = record.forcing?.chirpsSource;
	const chirpsSourceChanged = recorded !== undefined && now.chirpsSource !== undefined && !sameProvenance(recorded, now.chirpsSource);
	// The daily A-pan reaches GR4J only through pan coefficient × A-pan, then and now.
	const apanThen = record.forcing?.apanDaily;
	const apanDailyChanged =
		record.model === 'gr4j' &&
		resolvePe(settings.pe, []).kind === 'pan' &&
		resolvePe(record.forcing?.pe, []).kind === 'pan' &&
		apanThen !== undefined &&
		now.apanDaily !== undefined &&
		!sameApanDaily(apanThen, now.apanDaily);
	// The factors drifted with the settings and product the same: a change of those is said already (issue #51).
	const factorsThen = record.forcing?.chirpsFactors;
	const chirpsFactorsChanged =
		factorsThen !== undefined &&
		now.chirpsFactors !== undefined &&
		!chirpsSourceChanged &&
		!forcing?.chirpsBiasCorrection &&
		!forcing?.chirpsFitPeriod &&
		chirpsFactorsDrifted(factorsThen, now.chirpsFactors);
	// The units' rules, records and factors, when a run says what they are now (engine ≥ 1.78.0).
	const unitRainChanged = !forcing?.unitRain && now.unitRain !== undefined && record.forcing !== undefined && unitRainFingerprintChanged(record.forcing.unitRain ?? null, now.unitRain);
	return {
		editedParams: editedParams(settings, record),
		otherModel: (record.model as string) !== 'gr4j',
		windowChanged: (settings.calibrationStart ?? null) !== record.calibrationStart || (settings.calibrationEnd ?? null) !== record.calibrationEnd,
		// Settings that exclude the fit's exclusions and the years its rule left out (§2.10j) are the fit's own days too.
		exclusionsChanged: !sameJson(settings.calibrationExclusions ?? [], record.exclusions ?? []) && !withRuleYears(settings, record),
		...(!withRuleYears(settings, record) && ruleYearsScored(settings.calibrationExclusions ?? [], record.auto?.ruleExclusions ?? []) ? { ruleYearsScored: true } : {}),
		// Compared resolved on both sides, so a stored field left at its default is no change.
		// A fit at a gauge (engine ≥ 1.41.0) read no gauged range, so a change of the outlet records' ratings is none to it.
		qualityFlagsChanged: record.qualityFlags !== undefined && !sameJson(flagsAsScored(settings.qualityFlags, record), flagsAsScored(record.qualityFlags, record)),
		// The record names what was fitted (the default pick resolved), so only an explicit, different choice counts.
		flowKindChanged: kind !== null && kind !== record.flowKind,
		siteChanged: (settings.calibrationSiteNodeId ?? null) !== (record.siteNodeId ?? null),
		forcingChanged:
			chirpsSourceChanged ||
			apanDailyChanged ||
			chirpsFactorsChanged ||
			unitRainChanged ||
			(!!forcing &&
				(forcing.panCoefficient ||
					forcing.apanMm ||
					forcing.pe ||
					forcing.arealRain ||
					forcing.chirpsBiasCorrection ||
					forcing.zeroRainRuns ||
					forcing.chirpsFitPeriod ||
					forcing.chirpsQuantileMap ||
					forcing.rainSource ||
					forcing.rainChecks ||
					forcing.unitRain)),
		chirpsSourceChanged,
		apanDailyChanged,
		chirpsFactorsChanged,
		observedOriginChanged: record.observedOrigin !== undefined && now.observedOrigin !== undefined && !sameOrigin(record.observedOrigin, now.observedOrigin),
		flowFillChanged: flowFillDiffers(record, settings, record.flowKind),
		rulesChanged: !!record.auto && !sameRules(resolveCalibrationRules(settings.calibrationRules, []), resolveCalibrationRules(record.auto.rules, [])),
		draftRules: !!record.auto && !record.auto.rules?.signedOff
	};
}

/**
 * Were these settings' parameters fitted on the days a run scores (issue
 * #45)? Only then are the calibration statistics in-sample. `flowKind` is
 * the record the run scored (the default pick resolved). A change of forcing
 * since the fit doesn't count here, a replaced daily A-pan series included
 * (apanDailyChanged, engine ≥ 0.40.0): the days are still the ones fitted;
 * the fit record's forcingChanged says the fit may no longer hold.
 */
export function calibrationFitStatus(settings: Partial<ProjectSettings>, flowKind: CalibrationFlowKind, siteNodeId: string | null = null): CalibrationFitStatus {
	const record = resolveFitRecord(settings as Partial<ProjectSettings> & Record<string, unknown>);
	if (!record || (record.model as string) !== 'gr4j') return 'notFitted';
	const status = fitRecordStatus(settings, record);
	if (status.editedParams.length) return 'edited';
	// A fit at another site (engine ≥ 1.41.0; the run's statistics are the outlet's) scored another record's days.
	if (
		status.windowChanged ||
		status.exclusionsChanged ||
		status.ruleYearsScored ||
		status.qualityFlagsChanged ||
		record.flowKind !== flowKind ||
		(record.siteNodeId ?? null) !== siteNodeId ||
		status.flowFillChanged
	)
		return 'otherPeriod';
	return 'fitted';
}

/** Plain-language caveats for a fit record in these settings; empty when it describes them exactly. */
export function fitRecordCaveats(status: FitRecordStatus, paramLabel: (key: string) => string = (k) => k): string[] {
	const out: string[] = [];
	if (status.otherModel) out.push('The fit is of the legacy runoff model, removed in engine 1.0.0, so it does not describe the GR4J parameters.');
	if (status.editedParams.length) {
		out.push(`Parameters edited since the fit: ${status.editedParams.map(paramLabel).join(', ')}. The fit and its validation no longer describe them.`);
	}
	if (status.windowChanged) out.push('The calibration window has changed since the fit.');
	if (status.exclusionsChanged) out.push('The calibration exclusions have changed since the fit.');
	if (status.ruleYearsScored) out.push('The automated fit left some water years out by its rules, and the settings don’t exclude them, so the run’s statistics also score days the fit never saw: they are not all in-sample.');
	if (status.qualityFlagsChanged) {
		out.push('The quality-flag settings (a gauged range, or how extrapolated, suspect or infilled days are scored) have changed since the fit, so it was fitted on other days. Refit before relying on the parameters.');
	}
	if (status.flowKindChanged) out.push('The calibration flow series has changed since the fit.');
	if (status.siteChanged) out.push('The calibration site has changed since the fit, so it was fitted to another gauge’s record.');
	if (status.chirpsSourceChanged) {
		out.push(
			'The CHIRPS series holds another product or version than the fit ran on, so the monthly CHIRPS factors and the rain on every day CHIRPS fills have changed. Refit before relying on the parameters.'
		);
	}
	if (status.apanDailyChanged) {
		out.push(
			'The daily A-pan evaporation series has been added, replaced or removed since the fit, so the potential evaporation GR4J runs on changed on the days it covers. GR4J’s parameters trade off against evaporation: refit before relying on them.'
		);
	}
	if (status.chirpsFactorsChanged) {
		out.push(
			`The monthly CHIRPS factors this run applies differ by more than ${CHIRPS_FACTOR_TOLERANCE * 100} % in some month from those the fit ran on: new days shared by the catchment rain and CHIRPS, or preliminary CHIRPS turned final, moved them, and with them the rain on every day CHIRPS fills. Refit, or fit the factors on fixed water years (Settings → CHIRPS fit period).`
		);
	}
	if (status.observedOriginChanged) {
		out.push('The calibration record now comes from another source, or was given in another unit, than the one the fit ran on. Check the record, then refit before relying on the parameters.');
	}
	if (status.flowFillChanged) {
		out.push('The gap filling of the calibration record has changed since the fit, so the filled days the fit read are not the ones a run reads now (Settings → Flow gaps). Refit before relying on the parameters.');
	}
	if (status.draftRules) {
		out.push('Automated calibration picked this fit under draft rules, not yet signed off by the hydrologist, so it is not evidence until they are (Settings → Calibration rules).');
	}
	if (status.rulesChanged) out.push('The calibration rules have changed since automated calibration picked this fit: run it again under the current rules.');
	if (status.forcingChanged && !status.chirpsSourceChanged && !status.apanDailyChanged && !status.chirpsFactorsChanged) {
		out.push(
			'The potential evaporation GR4J runs on (the PE input, or the pan coefficient or A-pan evaporation it is taken from), the areal rainfall correction, CHIRPS bias correction, CHIRPS fit period, CHIRPS quantile map, rain-source periods, zero-rain run handling or the rain each unit runs on (runoff from each unit’s own rain, its records, MAPs and factors) has changed since the fit. GR4J’s parameters trade off against evaporation, and the areal, CHIRPS, rain-source and per-unit rain settings change the rain fed to it, so refit before relying on them.'
		);
	}
	return out;
}
