import {
	CALIBRATION_FLOW_KINDS,
	CHIRPS_BIAS_MODES,
	defaultProjectSettings,
	EXCLUSION_REASON_MAX,
	exclusionError,
	EXCLUSIONS_MAX,
	GR4J_PARAMS,
	OBJECTIVES,
	resolveFitRecord,
	RUNOFF_MODELS,
	WR2012_MAX_PENALTY_WEIGHT,
	WR2012_SCALINGS,
	wr2012FlagIssues,
	wr2012ReferenceIssues,
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
const bounded = (key: string) => {
	const p = GR4J_PARAMS.find((x) => x.key === key)!;
	return z.number().min(p.min).max(p.max);
};
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const reason = z.string().trim().min(1, 'an exclusion needs a reason').max(EXCLUSION_REASON_MAX);

/**
 * A calibration exclusion: a whole water year, or a date range, each with a
 * reason (engine calibrate/provenance.ts). The engine's own check (real
 * dates, start ≤ end) runs too, so the two can't disagree.
 */
export const CalibrationExclusion = z
	.union([
		z.object({ waterYear: z.number().int().min(1800).max(2200), reason }).strict(),
		z.object({ start: isoDate, end: isoDate, reason }).strict()
	])
	.superRefine((x, ctx) => {
		const err = exclusionError(x);
		if (err) ctx.addIssue({ code: 'custom', message: `calibration exclusion ${err}` });
	});

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
		seed: z.number().int().min(0).max(2 ** 31 - 1),
		budget: z.number().int().min(1).max(1_000_000),
		evaluations: z.number().int().min(0),
		cancelled: z.boolean(),
		free: z.array(z.string().max(40)).min(1).max(30),
		params,
		startParams: params,
		flowKind,
		simulatedKey: z.enum(['natural_flow', 'simulated_outflow']),
		calibrationStart: isoDate.nullable(),
		calibrationEnd: isoDate.nullable(),
		exclusions: z.array(CalibrationExclusion).max(EXCLUSIONS_MAX),
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
			simulatedKey: z.enum(['natural_flow', 'simulated_outflow']),
			overlapDays: z.number().int().min(0)
		})
			.strict()
			.nullable(),
		notes: z.array(z.string().max(2000)).max(50),
		editedParams: z.array(z.string().max(40)).max(30).default([])
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
		calibration: z.record(z.string(), z.unknown()),
		ewrPragmaticM3PerDay: monthly,
		simulationStart: isoDate.nullable(),
		simulationEnd: isoDate.nullable(),
		reportStart: isoDate.nullable(),
		reportEnd: isoDate.nullable(),
		calibrationStart: isoDate.nullable(),
		calibrationEnd: isoDate.nullable(),
		calibrationFlowKind: z.enum(CALIBRATION_FLOW_KINDS).nullable(),
		calibrationExclusions: z.array(CalibrationExclusion).max(EXCLUSIONS_MAX),
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
				calibrationPenalty: z.object({ enabled: z.boolean(), weight: z.number().min(0).max(WR2012_MAX_PENALTY_WEIGHT) }).strict()
			})
			.partial()
			.strict()
	})
	.partial()
	.passthrough()
	.refine((s) => JSON.stringify(s).length <= 64_000, 'settings too large');
