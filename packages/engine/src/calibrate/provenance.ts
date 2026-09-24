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
import { fromEpochDay, toEpochDay } from '../calendar';
import type { CalibrationFlowKind, ProjectSettings } from '../project';
import { waterYearLabel } from '../quality';
import { GR4J_PARAMS } from '../runoff/gr4j';
import { LEGACY_PARAMS } from '../runoff/legacy';
import type { RunoffModelId } from '../runoff/types';
import type { CalibrationReport, DifferentialTest, IndependentRecordTest, ParamSet, ScoredPeriod, ValidationTest } from './calibrate';
import type { ObjectiveId } from './objective';

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

/** The first problem with a list of exclusions ("Exclusion 2: needs a reason"), or null. */
export function exclusionsError(list: readonly unknown[]): string | null {
	if (list.length > EXCLUSIONS_MAX) return `at most ${EXCLUSIONS_MAX} exclusions`;
	const seen = new Set<string>();
	for (let i = 0; i < list.length; i++) {
		const err = exclusionError(list[i]);
		if (err) return `Exclusion ${i + 1}: ${err}`;
		const key = exclusionKey(list[i] as CalibrationExclusion);
		if (seen.has(key)) return `Exclusion ${i + 1}: ${exclusionLabel(list[i] as CalibrationExclusion)} is listed twice`;
		seen.add(key);
	}
	return null;
}

/**
 * Stored exclusions as the engine uses them: invalid entries are dropped with
 * a warning (the backend rejects them on save; this guards older or imported
 * settings).
 */
export function sanitizeExclusions(raw: unknown, warnings: string[]): CalibrationExclusion[] {
	if (raw == null) return [];
	if (!Array.isArray(raw)) {
		warnings.push('calibration exclusions are not a list; ignored');
		return [];
	}
	const out: CalibrationExclusion[] = [];
	for (const x of raw) {
		const err = exclusionError(x);
		if (err) {
			warnings.push(`calibration exclusion ${JSON.stringify(x).slice(0, 80)} ${err}; ignored`);
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
	seed: number;
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
	simulatedKey: 'natural_flow' | 'simulated_outflow';
	/** The calibration window and exclusions the fit used (the form's, at the time). */
	calibrationStart: string | null;
	calibrationEnd: string | null;
	exclusions: CalibrationExclusion[];
	/** Whether the split-sample and dry → wet tests were asked for, and the independent record. */
	validate: boolean;
	validationRecord: CalibrationFlowKind | null;
	/** The fitted parameters over the whole window: in-sample. */
	fit: ScoredPeriod;
	/** The parameters before the fit, on the same days. */
	before: ScoredPeriod;
	splitSample: ValidationTest | null;
	differential: DifferentialTest | null;
	independentRecord: IndependentRecordTest | null;
	/** The report's notes (limits of the validation, cancellation). */
	notes: string[];
	/**
	 * Fitted parameters whose value in the settings no longer matches the fit
	 * (edited by hand since). Empty = the settings hold the fitted values. Set
	 * by the server on save and by each run; a client can't clear it.
	 */
	editedParams: string[];
}

export interface FitContext {
	/** The Settings form the fit ran on. */
	settings: Pick<ProjectSettings, 'calibrationStart' | 'calibrationEnd'> & { calibrationExclusions?: CalibrationExclusion[] | null };
	validate: boolean;
	validationRecord: CalibrationFlowKind | null;
	engineVersion: string;
	fittedAt: string;
}

/** The fit record for a report, as Apply stores it. */
export function fitRecordFromReport(r: CalibrationReport, ctx: FitContext): FitRecord {
	return {
		fittedAt: ctx.fittedAt,
		engineVersion: ctx.engineVersion,
		model: r.model,
		objective: r.objective,
		seed: r.seed,
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
		validate: ctx.validate,
		validationRecord: ctx.validationRecord,
		fit: r.fit,
		before: r.before,
		splitSample: r.splitSample,
		differential: r.differential,
		independentRecord: r.independentRecord,
		notes: [...r.notes],
		editedParams: []
	};
}

/** Keys of a runoff model's calibratable parameters. */
const PARAM_KEYS: Record<RunoffModelId, readonly string[]> = {
	gr4j: GR4J_PARAMS.map((p) => p.key),
	legacy: LEGACY_PARAMS.map((p) => p.key)
};

/** The settings' current value of a model's parameter. */
function currentParam(settings: Partial<ProjectSettings>, model: RunoffModelId, key: string): unknown {
	const group = model === 'gr4j' ? settings.gr4j : settings.calibration;
	return (group as Record<string, unknown> | undefined)?.[key];
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
	/** The settings select another runoff model: the fit doesn't describe the run's parameters. */
	otherModel: boolean;
	/** The calibration window, exclusions or flow record differ from the fit's. */
	windowChanged: boolean;
	exclusionsChanged: boolean;
	flowKindChanged: boolean;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Compare a fit record with the settings (the form, or a run's snapshot). */
export function fitRecordStatus(settings: Partial<ProjectSettings>, record: FitRecord): FitRecordStatus {
	const kind = settings.calibrationFlowKind ?? null;
	return {
		editedParams: editedParams(settings, record),
		otherModel: (settings.runoffModel ?? 'legacy') !== record.model,
		windowChanged: (settings.calibrationStart ?? null) !== record.calibrationStart || (settings.calibrationEnd ?? null) !== record.calibrationEnd,
		exclusionsChanged: !sameJson(settings.calibrationExclusions ?? [], record.exclusions ?? []),
		// The record names what was fitted (the default pick resolved), so only an explicit, different choice counts.
		flowKindChanged: kind !== null && kind !== record.flowKind
	};
}

/** Plain-language caveats for a fit record in these settings; empty when it describes them exactly. */
export function fitRecordCaveats(status: FitRecordStatus, paramLabel: (key: string) => string = (k) => k): string[] {
	const out: string[] = [];
	if (status.otherModel) out.push('The fit is for the other runoff model, so it does not describe these parameters.');
	if (status.editedParams.length) {
		out.push(`Parameters edited since the fit: ${status.editedParams.map(paramLabel).join(', ')}. The fit and its validation no longer describe them.`);
	}
	if (status.windowChanged) out.push('The calibration window has changed since the fit.');
	if (status.exclusionsChanged) out.push('The calibration exclusions have changed since the fit.');
	if (status.flowKindChanged) out.push('The calibration flow series has changed since the fit.');
	return out;
}
