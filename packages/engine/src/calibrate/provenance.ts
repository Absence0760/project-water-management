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
import { fromEpochDay, toEpochDay, waterYearLabel } from '../calendar';
import { resolveArealRain, resolvePe, type ArealRain, type CalibrationFitStatus, type CalibrationFlowKind, type ChirpsBiasMode, type ChirpsFitPeriod, type PeInput, type ProjectSettings, type RainSourcePeriod, type ZeroRainSettings } from '../project';
import type { ChirpsFactorSet } from '../rain';
import { GR4J_PARAMS } from '../runoff/params';
import type { RunoffModelId } from '../runoff/types';
import { sameProvenance, type SeriesProvenance } from '../seriesProvenance';
import type { CalibrationReport, DifferentialTest, IndependentRecordTest, MarPenaltyResult, ScoredPeriod, StartResult, ValidationTest } from './calibrate';
import type { CalibrationBounds, ParamSet } from './params';
import { resolveQualityFlags, type DayQuality, type QualityFlagSettings } from './dayFlags';
import type { ObjectiveId } from './objectives';

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
const isIsoDate = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && fromEpochDay(toEpochDay(v)) === v;

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
	simulatedKey: 'simulated_outflow';
	/** The calibration window and exclusions the fit used (the form's, at the time). */
	calibrationStart: string | null;
	calibrationEnd: string | null;
	exclusions: CalibrationExclusion[];
	/**
	 * settings.qualityFlags at the time (engine ≥ 1.20.0, CR-18/19): the gauged
	 * ranges and how flagged days were scored, which decide the days fitted as
	 * the window and exclusions do. Absent on a record made before it.
	 */
	qualityFlags?: QualityFlagSettings;
	/** The report's quality-flag summary (CR-22) and the fit on all days (CR-19); absent before engine 1.20.0. */
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
		/** Where the pan-coefficient row came from (engine ≥ 0.31.1); provenance only, never a forcing change. */
		panCoefficientSource?: string;
		/**
		 * The daily A-pan series the fit ran on (engine ≥ 0.40.0, issue #45,
		 * docs/model.md §2.3a): its start, length and the SHA-256 of its values,
		 * as a run's input snapshot records them; null = the project had none.
		 * Absent on a record made before it was tracked, which is never flagged.
		 */
		apanDaily?: ApanDailyFingerprint | null;
	};
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
	 * Fitted parameters whose value in the settings no longer matches the fit
	 * (edited by hand since). Empty = the settings hold the fitted values. Set
	 * by the server on save and by each run; a client can't clear it.
	 */
	editedParams: string[];
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
		/** Engine ≥ 1.20.0; absent = the defaults. */
		qualityFlags?: QualityFlagSettings | null;
		zeroRainRuns?: ZeroRainSettings;
		chirpsFitPeriod?: ChirpsFitPeriod;
		rainSource?: RainSourcePeriod[];
		/** GR4J's PE input (engine ≥ 0.31.0); absent = `{ kind: 'pan' }`. */
		pe?: PeInput | null;
		/** The areal rainfall correction (engine ≥ 1.13.0); absent = none. */
		arealRain?: ArealRain | null;
		panCoefficientSource?: string;
	};
	validate: boolean;
	validationRecord: CalibrationFlowKind | null;
	engineVersion: string;
	fittedAt: string;
	/** The CHIRPS series' product and version when the fit ran (null = not recorded); omit when not known. */
	chirpsSource?: SeriesProvenance | null;
	/** The daily A-pan series the fit ran on (null = none); omit when not known. */
	apanDaily?: ApanDailyFingerprint | null;
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
			...(ctx.settings.panCoefficientSource ? { panCoefficientSource: ctx.settings.panCoefficientSource } : {}),
			...(ctx.apanDaily !== undefined ? { apanDaily: ctx.apanDaily ? { ...ctx.apanDaily } : null } : {})
		},
		splitSample: r.splitSample,
		differential: r.differential,
		independentRecord: r.independentRecord,
		marPenalty: r.marPenalty ?? null,
		notes: [...r.notes],
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
	 * The quality-flag settings (a gauged range, or how extrapolated, suspect
	 * or infilled days are scored; engine ≥ 1.20.0) differ from the fit's, so
	 * other days would be fitted. False on a record made before them.
	 */
	qualityFlagsChanged: boolean;
	flowKindChanged: boolean;
	/**
	 * The potential-evaporation input (`settings.pe`: its kind, or its
	 * monthly row; not its source note), the pan coefficient and A-pan
	 * evaporation (only while `pe` is `{ kind: 'pan' }`, the only time GR4J
	 * reads them), CHIRPS bias correction, CHIRPS fit period, rain-source
	 * periods or zero-rain run settings (the forcing GR4J runs under) have
	 * changed since the fit. False for records made before `forcing` was recorded, and a
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
): { panCoefficient: boolean; apanMm: boolean; pe: boolean; arealRain: boolean; chirpsBiasCorrection: boolean; zeroRainRuns: boolean; chirpsFitPeriod: boolean; rainSource: boolean } | null {
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
		// Engine ≥ 0.30.0. A forcing without it predates rain-source periods, so it ran with none.
		rainSource: !sameJson(settings.rainSource ?? [], record.forcing.rainSource ?? [])
	};
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
	return {
		editedParams: editedParams(settings, record),
		otherModel: (record.model as string) !== 'gr4j',
		windowChanged: (settings.calibrationStart ?? null) !== record.calibrationStart || (settings.calibrationEnd ?? null) !== record.calibrationEnd,
		exclusionsChanged: !sameJson(settings.calibrationExclusions ?? [], record.exclusions ?? []),
		// Compared resolved on both sides, so a stored field left at its default is no change.
		qualityFlagsChanged: record.qualityFlags !== undefined && !sameJson(resolveQualityFlags(settings.qualityFlags, []), resolveQualityFlags(record.qualityFlags, [])),
		// The record names what was fitted (the default pick resolved), so only an explicit, different choice counts.
		flowKindChanged: kind !== null && kind !== record.flowKind,
		forcingChanged:
			chirpsSourceChanged ||
			apanDailyChanged ||
			chirpsFactorsChanged ||
			(!!forcing && (forcing.panCoefficient || forcing.apanMm || forcing.pe || forcing.arealRain || forcing.chirpsBiasCorrection || forcing.zeroRainRuns || forcing.chirpsFitPeriod || forcing.rainSource)),
		chirpsSourceChanged,
		apanDailyChanged,
		chirpsFactorsChanged
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
export function calibrationFitStatus(settings: Partial<ProjectSettings>, flowKind: CalibrationFlowKind): CalibrationFitStatus {
	const record = resolveFitRecord(settings as Partial<ProjectSettings> & Record<string, unknown>);
	if (!record || (record.model as string) !== 'gr4j') return 'notFitted';
	const status = fitRecordStatus(settings, record);
	if (status.editedParams.length) return 'edited';
	if (status.windowChanged || status.exclusionsChanged || status.qualityFlagsChanged || record.flowKind !== flowKind) return 'otherPeriod';
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
	if (status.qualityFlagsChanged) {
		out.push('The quality-flag settings (a gauged range, or how extrapolated, suspect or infilled days are scored) have changed since the fit, so it was fitted on other days. Refit before relying on the parameters.');
	}
	if (status.flowKindChanged) out.push('The calibration flow series has changed since the fit.');
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
	if (status.forcingChanged && !status.chirpsSourceChanged && !status.apanDailyChanged && !status.chirpsFactorsChanged) {
		out.push(
			'The potential evaporation GR4J runs on (the PE input, or the pan coefficient or A-pan evaporation it is taken from), the areal rainfall correction, CHIRPS bias correction, CHIRPS fit period, rain-source periods or zero-rain run handling has changed since the fit. GR4J’s parameters trade off against evaporation, and the areal, CHIRPS and rain-source settings change the rain fed to it, so refit before relying on them.'
		);
	}
	return out;
}
