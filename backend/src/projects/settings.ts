import {
	CALIBRATION_BOUNDS,
	CALIBRATION_FLOW_KINDS,
	CHIRPS_BIAS_MODES,
	defaultProjectSettings,
	EXCLUSION_REASON_MAX,
	exclusionError,
	exclusionKey,
	EXCLUSIONS_MAX,
	GR4J_PARAMS,
	MAX_STARTS,
	OBJECTIVES,
	resolveFitRecord,
	RUNOFF_MODELS,
	WR2012_MAX_PENALTY_WEIGHT,
	WR2012_SCALINGS,
	wr2012FlagIssues,
	wr2012PenaltyIssues,
	wr2012ReferenceIssues,
	ZERO_RAIN_MODES,
	type ProjectSettings
} from '@water-management/engine';
import { z } from 'zod';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Stored settings merged over the defaults (one level deep for nested
 * objects), so clients always see every field even after the engine adds new
 * ones. Unknown stored keys are kept.
 */
export function mergeSettings(stored: unknown): ProjectSettings {
	const base = defaultProjectSettings() as unknown as Json;
	const raw = isObj(stored) ? stored : {};
	const out: Json = { ...base, ...raw };
	for (const [k, v] of Object.entries(base)) {
		if (isObj(v) && isObj(raw[k])) out[k] = { ...v, ...(raw[k] as Json) };
	}
	return out as unknown as ProjectSettings;
}

/** Settings replaced whole by a patch, never merged: a fit record describes one fit. */
const REPLACED_WHOLE = new Set(['fitRecord']);

/**
 * A settings patch applied over the stored settings: top-level keys replace,
 * and nested objects (gr4j, dataQuality, wr2012, …) merge one level deep, so
 * patching one field of a group never resets the group's other stored fields.
 * The fit record is replaced whole, and its `editedParams` recomputed from the
 * resulting parameters (a client can neither hide an edit nor invent one).
 */
export function patchSettings(stored: unknown, patch: Json): ProjectSettings {
	const current = mergeSettings(stored) as unknown as Json;
	const out: Json = { ...current, ...patch };
	for (const [k, v] of Object.entries(patch)) {
		if (!REPLACED_WHOLE.has(k) && isObj(v) && isObj(current[k])) out[k] = { ...(current[k] as Json), ...v };
	}
	out.fitRecord = resolveFitRecord(out as Partial<ProjectSettings> & Json);
	return out as unknown as ProjectSettings;
}

const monthly = z.array(z.number().finite()).length(12);

/**
 * WR2012 reference data (engine reference/wr2012.ts), entered by the user:
 * every field required (the MAP may be null), plus the engine's plausibility
 * checks — the MAR within the rain on the quaternary when its MAP is given,
 * and the 12 monthly means (Mm³ per month) adding up to the MAR within 5 %.
 */
const Wr2012Reference = z
	.object({
		quaternary: z.string().trim().min(1).max(16),
		areaKm2: z.number().positive().max(1e6),
		marMm3: z.number().min(0).max(1e6),
		monthlyMm3: z.array(z.number().min(0).max(1e6)).length(12),
		periodStart: z.number().int().min(1800).max(2200),
		periodEnd: z.number().int().min(1800).max(2200),
		mapMm: z.number().positive().max(20_000).nullable(),
		source: z.string().trim().min(1).max(500)
	})
	.strict()
	.superRefine((r, ctx) => {
		for (const i of wr2012ReferenceIssues(r)) ctx.addIssue({ code: 'custom', path: [i.field], message: i.message });
	});
const pct = z.number().gt(0).max(1000);
const Wr2012Flags = z
	.object({ notePct: pct, queryPct: pct, queryWetterPct: pct, unusablePct: pct })
	.strict()
	.superRefine((f, ctx) => {
		for (const i of wr2012FlagIssues(f)) ctx.addIssue({ code: 'custom', path: [i.field], message: i.message });
	});
/**
 * The calibration penalty group: a weight, plus an optional MAR band
 * (marLowMm3 / marHighMm3, engine reference/wr2012.ts) — both or neither, low
 * ≤ high — used instead of the single scaled WR2012 MAR when two published
 * estimates disagree (issue #4 phase 6).
 */
const Wr2012CalibrationPenalty = z
	.object({
		enabled: z.boolean(),
		weight: z.number().min(0).max(WR2012_MAX_PENALTY_WEIGHT),
		marLowMm3: z.number().min(0).max(1e6).nullable(),
		marHighMm3: z.number().min(0).max(1e6).nullable()
	})
	.strict()
	.superRefine((p, ctx) => {
		for (const i of wr2012PenaltyIssues(p)) ctx.addIssue({ code: 'custom', path: [i.field], message: i.message });
	});
const bounded = (key: string) => {
	const p = GR4J_PARAMS.find((x) => x.key === key)!;
	return z.number().min(p.min).max(p.max);
};
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * A dated period with a reason: a whole water year, or a date range (engine
 * calibrate/provenance.ts). Calibration exclusions and the zero-rain run
 * periods share it. The engine's own check (real dates, start ≤ end) runs
 * too, so the two can't disagree.
 */
const datedPeriod = (noun: string) => {
	const reason = z.string().trim().min(1, `a ${noun} needs a reason`).max(EXCLUSION_REASON_MAX);
	return z
		.union([
			z.object({ waterYear: z.number().int().min(1800).max(2200), reason }).strict(),
			z.object({ start: isoDate, end: isoDate, reason }).strict()
		])
		.superRefine((x, ctx) => {
			const err = exclusionError(x);
			if (err) ctx.addIssue({ code: 'custom', message: `${noun} ${err}` });
		});
};

/** At most EXCLUSIONS_MAX, and no period listed twice. */
const periodList = (noun: string) =>
	z
		.array(datedPeriod(noun))
		.max(EXCLUSIONS_MAX)
		.refine((list) => new Set(list.map(exclusionKey)).size === list.length, `a ${noun} period is listed twice`);

export const CalibrationExclusion = datedPeriod('calibration exclusion');
const ExclusionList = periodList('calibration exclusion');

const scoreValue = z.number().finite().nullable();
const ScoredPeriod = z
	.object({
		start: isoDate,
		end: isoDate,
		waterYears: z.array(z.number().int()).max(500),
		scores: z.record(z.string().max(40), scoreValue).refine((o) => Object.keys(o).length <= 30, 'too many scores')
	})
	.strict();
const params = z.record(z.string().max(40), z.number().finite()).refine((o) => Object.keys(o).length <= 30, 'too many parameters');
const ValidationTest = z.object({ params, calibration: ScoredPeriod, validation: ScoredPeriod });
const flowKind = z.enum(CALIBRATION_FLOW_KINDS);

/**
 * The record of the fit whose parameters Apply wrote (engine FitRecord). The
 * browser runs the fit, so this is what the client reports; `editedParams`
 * is recomputed by the server on every save (routes.ts), whatever is sent,
 * and the seed and engine version let anyone reproduce the fit.
 */
export const FitRecord = z
	.object({
		fittedAt: z.iso.datetime({ offset: true }),
		engineVersion: z.string().max(40),
		model: z.enum(RUNOFF_MODELS),
		objective: z.enum(OBJECTIVES),
		bounds: z.enum(CALIBRATION_BOUNDS),
		seed: z.number().int().min(0).max(2 ** 31 - 1),
		// Records made before multi-start fits (CR-2) have neither: one start.
		starts: z.number().int().min(1).max(MAX_STARTS).optional(),
		startResults: z
			.array(z.object({ seed: z.number().int().min(0).max(2 ** 31 - 1), params, score: z.number().finite().nullable(), best: z.boolean() }).strict())
			.max(MAX_STARTS)
			.optional(),
		budget: z.number().int().min(1).max(1_000_000),
		evaluations: z.number().int().min(0),
		cancelled: z.boolean(),
		free: z.array(z.string().max(40)).min(1).max(30),
		params,
		startParams: params,
		flowKind,
		simulatedKey: z.literal('simulated_outflow'),
		calibrationStart: isoDate.nullable(),
		calibrationEnd: isoDate.nullable(),
		exclusions: ExclusionList,
		validate: z.boolean(),
		validationRecord: flowKind.nullable(),
		fit: ScoredPeriod,
		before: ScoredPeriod,
		splitSample: ValidationTest.strict().nullable(),
		differential: ValidationTest.extend({
			dryYears: z.array(z.number().int()).max(500),
			wetYears: z.array(z.number().int()).max(500),
			wetDryRatio: z.number().finite()
		})
			.strict()
			.nullable(),
		independentRecord: ValidationTest.extend({
			flowKind,
			simulatedKey: z.literal('simulated_outflow'),
			overlapDays: z.number().int().min(0)
		})
			.strict()
			.nullable(),
		marPenalty: z
			.object({
				weight: z.number().min(0).max(WR2012_MAX_PENALTY_WEIGHT),
				targetMarMm3: z.number().finite().min(0),
				marLowMm3: z.number().finite().min(0).nullable(),
				marHighMm3: z.number().finite().min(0).nullable(),
				basis: z.enum(['overlap', 'whole']),
				marRatio: z.number().finite(),
				unpenalised: z.object({ params, fit: ScoredPeriod, marRatio: z.number().finite() }).strict().nullable()
			})
			.strict()
			.nullable()
			.default(null),
		notes: z.array(z.string().max(2000)).max(50),
		editedParams: z.array(z.string().max(40)).max(30).default([]),
		// The forcing the fit ran under (issue #4 pan-coefficient provenance):
		// GR4J's parameters trade off against the evaporation forcing, so the
		// pan coefficient is held fixed and recorded, never fitted; CHIRPS bias
		// correction changes the rain fed to the model on the days CHIRPS fills
		// a gap, so it's recorded too. Absent on records made before `forcing`;
		// `chirpsBiasCorrection` optional so a `forcing` made before it was
		// added still validates.
		forcing: z
			.object({
				panCoefficient: z.array(z.number().min(0).max(2)).length(12),
				apanMm: monthly,
				chirpsBiasCorrection: z.enum(CHIRPS_BIAS_MODES).optional(),
				// Engine ≥ 0.15.0 (CR-20): which zero-rain days CHIRPS fills. Optional, as above.
				zeroRainRuns: z
					.object({ mode: z.enum(ZERO_RAIN_MODES), keepDry: periodList('keep-dry period'), missing: periodList('missing-rain period') })
					.strict()
					.optional()
			})
			.strict()
			.optional()
	})
	.strict();

/**
 * Validates the known fields; extra keys (e.g. calibration parameters the
 * engine adds later) pass through but the whole object is size-capped.
 */
export const SettingsPatch = z
	.object({
		februaryDays: z.number().min(28).max(29),
		effectiveRainFraction: z.number().min(0).max(1),
		// Soil-water store, mm over the cropped area (engine N3). 500 mm is well
		// past the readily available water of deep roots in a heavy soil.
		effectiveRainStoreMm: z.number().finite().min(0).max(500),
		apanMm: monthly,
		flowShareMethod: z.enum(['area', 'hiLo', 'manual']),
		hiLoSplit: z.object({ hi: z.number().min(0).max(1), lo: z.number().min(0).max(1) }),
		runoffModel: z.enum(RUNOFF_MODELS),
		// GR4J parameters inside the bounds calibration searches (engine
		// GR4J_PARAMS); any subset may be patched.
		gr4j: z
			.object({
				x1: bounded('x1'),
				x2: bounded('x2'),
				x3: bounded('x3'),
				x4: bounded('x4'),
				warmupDays: z.number().int().min(0).max(3650)
			})
			.partial()
			.strict(),
		panCoefficient: z.array(z.number().min(0).max(2)).length(12),
		chirpsBiasCorrection: z.enum(CHIRPS_BIAS_MODES),
		// Flagged zero-rain runs (engine rain.ts, CR-20): any subset may be
		// patched; each list is replaced whole.
		zeroRainRuns: z
			.object({
				mode: z.enum(ZERO_RAIN_MODES),
				keepDry: periodList('keep-dry period'),
				missing: periodList('missing-rain period')
			})
			.partial()
			.strict(),
		calibration: z.record(z.string(), z.unknown()),
		ewrPragmaticM3PerDay: monthly,
		simulationStart: isoDate.nullable(),
		simulationEnd: isoDate.nullable(),
		reportStart: isoDate.nullable(),
		reportEnd: isoDate.nullable(),
		calibrationStart: isoDate.nullable(),
		calibrationEnd: isoDate.nullable(),
		calibrationFlowKind: z.enum(CALIBRATION_FLOW_KINDS).nullable(),
		calibrationExclusions: ExclusionList,
		fitRecord: FitRecord.nullable(),
		// Gauge-vs-logger thresholds (engine resolveDataQuality). Each bound is
		// checked on its own (min ≤ 1 ≤ max), so any subset can be patched.
		dataQuality: z
			.object({
				agreementMinRatio: z.number().gt(0).max(1),
				agreementMaxRatio: z.number().min(1).max(100),
				agreementMinDays: z.number().int().min(1).max(366)
			})
			.partial()
			.strict(),
		// The WR2012 check: any subset of its groups may be patched; each group is whole.
		wr2012: z
			.object({
				reference: Wr2012Reference.nullable(),
				scaling: z.enum(WR2012_SCALINGS),
				lowFlowMonths: z.array(z.number().int().min(1).max(12)).min(1).max(12).nullable(),
				flags: Wr2012Flags,
				calibrationPenalty: Wr2012CalibrationPenalty
			})
			.partial()
			.strict()
	})
	.partial()
	.passthrough()
	.refine((s) => JSON.stringify(s).length <= 64_000, 'settings too large');
