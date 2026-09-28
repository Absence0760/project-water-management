import {
	ACCUMULATION_MODES,
	ALLOCATION_MODES,
	CALIBRATION_BOUNDS,
	CALIBRATION_FLOW_KINDS,
	CHIRPS_BIAS_MODES,
	CHIRPS_FIT_PERIOD_MODES,
	defaultProjectSettings,
	EXCLUSION_REASON_MAX,
	exclusionError,
	exclusionKey,
	EXCLUSIONS_MAX,
	EWR_CHARGE_SOURCES,
	EWR_NATURAL_SOURCES,
	EWR_RULE_COMPONENTS,
	EWR_RULE_POINTS_MAX,
	EWR_RULE_SCALE_MAX,
	EWR_RULE_SOURCE_MAX,
	EWR_HIGH_FLOW_DURATION_MAX,
	EWR_HIGH_FLOW_LABEL_MAX,
	EWR_HIGH_FLOW_PER_YEAR_MAX,
	EWR_HIGH_FLOWS_MAX,
	EWR_RULE_TABLES_MAX,
	EWR_RULE_UNITS,
	EWR_RULE_VALUE_MAX,
	ewrRuleListIssues,
	EWR_RULE_SOURCE_KINDS,
	ewrRuleTableIssues,
	GR4J_PARAMS,
	LOW_FLOW_MEASURES,
	MAX_STARTS,
	provenanceError,
	OBJECTIVES,
	PE_SOURCE_MAX,
	AREAL_RAIN_FACTOR_MAX,
	AREAL_RAIN_FACTOR_MIN,
	AREAL_RAIN_METHODS,
	resolveFitRecord,
	RETIRED_CALIBRATION_KEYS,
	RUNOFF_MODELS,
	WR2012_MAX_PENALTY_WEIGHT,
	WR2012_SCALINGS,
	wr2012FlagIssues,
	wr2012PenaltyIssues,
	wr2012ReferenceIssues,
	rainSourceError,
	ZERO_RAIN_MODES,
	type ProjectSettings
} from '@water-management/engine';
import { z } from 'zod';
import { AutoRunPatch } from '../runs/autoRun.js';
import { OutcomesPatch } from './outcomeSettings.js';
import { OutlookPatch } from './outlookSettings.js';

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
	return withoutLegacyRunoff(out) as unknown as ProjectSettings;
}

/**
 * Settings with what the legacy runoff model left behind removed (engine
 * 1.0.0, issue #16; migration 064 does the same to the stored rows): the
 * model is GR4J, the calibration group loses the legacy model's keys, and a
 * fit of the legacy model is dropped. A run's snapshot comes from here
 * (runs/execute.ts), and a snapshot that names any model but 'gr4j' reads as
 * a legacy run, so a project still stored as 'legacy' must not reach one.
 */
function withoutLegacyRunoff(s: Json): Json {
	s.runoffModel = 'gr4j';
	if (isObj(s.calibration)) s.calibration = withoutRetiredCalibration(s.calibration);
	if (isObj(s.fitRecord) && s.fitRecord.model !== 'gr4j') s.fitRecord = null;
	return s;
}

function withoutRetiredCalibration(c: Json): Json {
	const out = { ...c };
	for (const k of RETIRED_CALIBRATION_KEYS) delete out[k];
	return out;
}

/**
 * Stored settings for a copy whose nodes got fresh ids (POST /projects/:id/copy,
 * `ids` old → new): each EWR rule table's site (engine ≥ 0.21.0) and the
 * outcome matrix's site (settings.outcomes.siteNodeId, issue #53 R4) follow
 * their node. A site not in the map (already dangling) is left as it was, so
 * the copy's runs warn about it as the original's do. Anything else is
 * unchanged.
 */
export function remapSettingNodeIds(stored: unknown, ids: ReadonlyMap<string, string>): Json {
	const s: Json = isObj(stored) ? { ...stored } : {};
	if (Array.isArray(s.ewrRules)) {
		s.ewrRules = s.ewrRules.map((t: unknown) =>
			isObj(t) && typeof t.siteNodeId === 'string' && ids.has(t.siteNodeId) ? { ...t, siteNodeId: ids.get(t.siteNodeId) } : t
		);
	}
	if (isObj(s.outcomes) && typeof s.outcomes.siteNodeId === 'string' && ids.has(s.outcomes.siteNodeId)) {
		s.outcomes = { ...s.outcomes, siteNodeId: ids.get(s.outcomes.siteNodeId) };
	}
	return s;
}

/**
 * Settings replaced whole by a patch, never merged: a fit record describes
 * one fit, and a PE input is one kind or the other (merging `{ kind: 'pan' }`
 * over a stored monthly row would keep a stale `mm` and `source`), and an
 * areal rainfall correction (engine ≥ 1.13.0) is one set of factors with its
 * own source.
 */
const REPLACED_WHOLE = new Set(['fitRecord', 'pe', 'arealRain']);

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
/**
 * A Reserve rule table for one EWR site (engine reserve/rules.ts, model.md
 * §2.9c): the shape here, then the engine's own checks (rising % points, 12
 * rows × points, natural flows when they are the source), so the form, the
 * API and the run agree on what is usable. siteNodeId null = the outlet; that
 * it names a gauge is checked by the run, which knows the network.
 */
const ruleGrid = z.array(z.array(z.number().finite().min(0).max(EWR_RULE_VALUE_MAX)).max(EWR_RULE_POINTS_MAX)).length(12);
/**
 * A freshet or flood component (engine ≥ 0.33.0, model.md §2.9d); the ranges
 * and the "fits in a year" check are the engine's (ewrRuleTableIssues).
 */
const EwrHighFlow = z
	.object({
		label: z.string().trim().min(1).max(EWR_HIGH_FLOW_LABEL_MAX),
		months: z.array(z.number().int().min(1).max(12)).min(1).max(12),
		peakM3s: z.number().finite().gt(0).max(EWR_RULE_VALUE_MAX),
		durationDays: z.number().int().min(1).max(EWR_HIGH_FLOW_DURATION_MAX),
		perYear: z.number().int().min(1).max(EWR_HIGH_FLOW_PER_YEAR_MAX)
	})
	.strict();
const EwrRuleTable = z
	.object({
		siteNodeId: z.string().min(1).max(100).nullable(),
		source: z.string().trim().min(1).max(EWR_RULE_SOURCE_MAX),
		// Engine ≥ 1.5.0 (WP-3.7), optional so a table saved before stays valid: gazetted, desktop or other.
		sourceKind: z.enum(EWR_RULE_SOURCE_KINDS).nullable().optional(),
		component: z.enum(EWR_RULE_COMPONENTS),
		unit: z.enum(EWR_RULE_UNITS),
		points: z.array(z.number().finite()).max(EWR_RULE_POINTS_MAX),
		ewr: ruleGrid,
		naturalSource: z.enum(EWR_NATURAL_SOURCES),
		natural: ruleGrid.nullable(),
		scale: z.number().finite().gt(0).max(EWR_RULE_SCALE_MAX),
		// Engine ≥ 0.33.0, both optional so a table saved before stays valid: the low-flow grid of a total table, and the high-flow components.
		lowFlow: ruleGrid.nullable().optional(),
		highFlows: z.array(EwrHighFlow).max(EWR_HIGH_FLOWS_MAX).optional(),
		// Engine ≥ 1.11.0 (issue #46), optional: the determination's natural MAR at the site, Mm³/a, for the run's nMAR check.
		naturalMarMcm: z.number().finite().gt(0).max(EWR_RULE_VALUE_MAX).nullable().optional()
	})
	.strict()
	.superRefine((t, ctx) => {
		for (const i of ewrRuleTableIssues(t)) ctx.addIssue({ code: 'custom', path: [i.field], message: i.message });
	});
const EwrRuleList = z
	.array(EwrRuleTable)
	.max(EWR_RULE_TABLES_MAX)
	.superRefine((list, ctx) => {
		const err = ewrRuleListIssues(list);
		if (err) ctx.addIssue({ code: 'custom', message: err });
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

/**
 * settings.chirpsFitPeriod (engine ≥ 0.29.0, issue #40): 'all', or water-year
 * ranges, each with a reason, none overlapping. The double-mass breaks only
 * propose ranges (the Settings form); there is no automatic mode. The engine
 * resolves the same rules (rain.ts resolveChirpsFitPeriod), so a stored value
 * never runs differently from what was validated.
 */
const waterYear = z.number().int().min(1800).max(2200);
const ChirpsFitPeriod = z.union([
	z.enum(CHIRPS_FIT_PERIOD_MODES),
	z
		.array(
			z
				.object({
					fromWaterYear: waterYear,
					toWaterYear: waterYear,
					reason: z.string().trim().min(1, 'a CHIRPS fit range needs a reason').max(EXCLUSION_REASON_MAX)
				})
				.strict()
				.refine((r) => r.fromWaterYear <= r.toWaterYear, 'a CHIRPS fit range must end at or after the water year it starts')
		)
		.min(1, 'list at least one CHIRPS fit range')
		.max(EXCLUSIONS_MAX)
		.refine(
			(list) => list.every((r, i) => list.every((x, j) => j === i || r.fromWaterYear > x.toWaterYear || r.toWaterYear < x.fromWaterYear)),
			'CHIRPS fit ranges must not overlap'
		)
]);
const ExclusionList = periodList('calibration exclusion');

/**
 * settings.rainSource (engine ≥ 0.30.0, issue #40 (b)): periods whose
 * catchment rain comes from another series × monthly factors. Checked by the
 * engine's own rainSourceError, the rule its resolver (rainSourcePeriods.ts
 * resolveRainSource) drops a period by, so the two can't disagree: fixed
 * factors need their provenance, 'fit' needs a reference that isn't CHIRPS
 * when the period says CHIRPS ingests its gauge, no two periods overlap.
 */
const RainSource = z
	.array(z.unknown())
	.max(EXCLUSIONS_MAX)
	.superRefine((list, ctx) => {
		const err = rainSourceError(list);
		if (err) ctx.addIssue({ code: 'custom', message: err });
	});

/**
 * settings.pe (engine ≥ 0.31.0, issue #39): where GR4J's potential
 * evaporation comes from. `{ kind: 'pan' }` = pan coefficient × A-pan (the
 * default); `{ kind: 'monthly' }` = 12 water-year monthly totals (mm, 0 to
 * 10 000, as `apanMm` is bounded in practice) with a required source note.
 * Replaced whole on a patch. A monthly row of zeros is accepted: the engine
 * refuses GR4J on it (GR4J_NO_PET, naming Settings → Demand), the same as an
 * A-pan row of zeros under 'pan' is saved and then refused; the workbook
 * runoff model doesn't read PE at all, so a zero row isn't wrong in itself.
 */
const PeInput = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('pan') }).strict(),
	z
		.object({
			kind: z.literal('monthly'),
			mm: z.array(z.number().finite().min(0).max(10_000)).length(12),
			source: z.string().trim().min(1, 'a monthly PE needs its source').max(PE_SOURCE_MAX)
		})
		.strict()
]);

/**
 * settings.arealRain (engine ≥ 1.13.0, docs/model.md §2.4g): the rain GR4J
 * runs on × 12 water-year monthly factors (each within the CHIRPS clamp,
 * 0.25–4), with how they were derived and a required source note; null =
 * none. Replaced whole on a patch. The engine's arealRainError applies the
 * same rules to a stored value.
 */
const ArealRain = z
	.object({
		factors: z.array(z.number().finite().min(AREAL_RAIN_FACTOR_MIN).max(AREAL_RAIN_FACTOR_MAX)).length(12),
		method: z.enum(AREAL_RAIN_METHODS),
		source: z.string().trim().min(1, 'an areal rainfall correction needs its source').max(PE_SOURCE_MAX)
	})
	.strict();

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
				// Engine ≥ 0.29.0 (issue #40): the CHIRPS fit period, and the factors per fit segment. Optional, as above.
				chirpsFitPeriod: ChirpsFitPeriod.optional(),
				chirpsFactors: z
					.array(
						z
							.object({ label: z.string().max(600), fittedOn: z.string().max(100).optional(), factors: z.array(z.number().finite().nullable()).length(12) })
							.strict()
					)
					.max(EXCLUSIONS_MAX + 3)
					.nullable()
					.optional(),
				// Engine ≥ 0.30.0 (issue #40 (b)): the rain-source periods. Optional, as above.
				rainSource: RainSource.optional(),
				// Engine ≥ 0.31.0 (issue #39): GR4J's PE input. Optional, as above; absent = ran as 'pan'.
				pe: PeInput.optional(),
				// Engine ≥ 1.13.0: the areal rainfall correction (null = none). Optional, as above; absent = ran with none.
				arealRain: ArealRain.nullable().optional(),
				// Engine ≥ 0.31.1: where the pan-coefficient row came from (provenance only). Optional, as above.
				panCoefficientSource: z.string().max(PE_SOURCE_MAX).optional(),
				// Engine ≥ 0.15.0 (CR-20): which zero-rain days CHIRPS fills. Optional, as above.
				zeroRainRuns: z
					.object({
						mode: z.enum(ZERO_RAIN_MODES),
						keepDry: periodList('keep-dry period'),
						missing: periodList('missing-rain period'),
						// Engine ≥ 0.20.0 (audit B4): multi-day accumulations. Optional, so a record made before them still validates.
						accumulationMode: z.enum(ACCUMULATION_MODES).optional(),
						keepReadings: periodList('keep-reading period').optional(),
						addAccumulations: periodList('listed accumulation').optional()
					})
					.strict()
					.optional(),
				// Issue #40 part c: the CHIRPS series' product and version the fit
				// ran on (null = not recorded). Optional, as above.
				chirpsSource: z
					.object({ product: z.string(), version: z.string() })
					.strict()
					.refine((p) => provenanceError(p) === null, 'not a valid product and version')
					.nullable()
					.optional(),
				// Engine ≥ 0.40.0 (issue #45): the daily A-pan series the fit ran on,
				// as a run's input snapshot records it (null = none). Optional, as above.
				apanDaily: z
					.object({ startDate: isoDate, length: z.number().int().min(0).max(60_000), valuesSha256: z.string().regex(/^[0-9a-f]{64}$/) })
					.strict()
					.nullable()
					.optional()
			})
			.strict()
			.optional()
	})
	.strict();

/**
 * Validates the known fields and drops any other key (zod's default strip),
 * so a body can't store what the schema doesn't name: an unknown key used to
 * pass through into project.settings and from there into every revision,
 * copy and run input (http/mass-assignment.security.db.test.ts). Stripped
 * rather than refused so a project file from another version still imports;
 * a setting the engine adds is added here too. The whole object is size-capped.
 */
export const SettingsPatch = z
	.object({
		februaryDays: z.number().min(28).max(29),
		effectiveRainFraction: z.number().min(0).max(1),
		// Monthly effective-rain fractions (engine ≥ 0.43.0, issue #54), water-year
		// months, each 0–1; null = effectiveRainFraction every month.
		effectiveRainFractionMonthly: z.array(z.number().finite().min(0).max(1)).length(12).nullable(),
		// Soil-water store, mm over the cropped area (engine N3). 500 mm is well
		// past the readily available water of deep roots in a heavy soil.
		effectiveRainStoreMm: z.number().finite().min(0).max(500),
		// Open-water evaporation ÷ A-pan for the farm dams (engine N2); 2 is
		// far above any open-water factor, 0 turns dam evaporation off.
		lakeEvapFactor: z.number().finite().min(0).max(2),
		// Annual assurance of supply (engine ≥ 0.32.0, WP-3.4): a water year is
		// met when supplied ÷ demand reaches it. A fraction in (0, 1].
		assuranceAnnualThreshold: z.number().finite().gt(0).max(1),
		// Registered volumes (engine ≥ 1.16.0, issue #72): what they do to a run, and the comparison's band, a fraction in [0, 1).
		allocationMode: z.enum(ALLOCATION_MODES),
		allocationTolerance: z.number().finite().min(0).lt(1),
		// Monthly lake factors (WP-3.5), water-year months; null = lakeEvapFactor every month.
		lakeEvapFactorMonthly: z.array(z.number().finite().min(0).max(2)).length(12).nullable(),
		apanMm: monthly,
		flowShareMethod: z.enum(['area', 'hiLo', 'manual']),
		hiLoSplit: z.object({ hi: z.number().min(0).max(1), lo: z.number().min(0).max(1) }),
		// GR4J is the only model since engine 1.0.0 (issue #16); the setting records it.
		runoffModel: z.enum(RUNOFF_MODELS, { error: 'the legacy runoff model was removed in engine 1.0.0: GR4J is the only runoff model' }),
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
		// GR4J's PE input (engine project.ts PeInput, issue #39); replaced whole.
		pe: PeInput,
		// The areal rainfall correction on GR4J's rain (engine ≥ 1.13.0, project.ts ArealRain); replaced whole, null = none.
		arealRain: ArealRain.nullable(),
		// Where the pan-coefficient row came from (engine ≥ 0.31.1): free text, provenance only; '' = none.
		panCoefficientSource: z.string().trim().max(PE_SOURCE_MAX),
		chirpsBiasCorrection: z.enum(CHIRPS_BIAS_MODES),
		// Which part of the record the CHIRPS factors are fitted on (engine rain.ts, issue #40); replaced whole.
		chirpsFitPeriod: ChirpsFitPeriod,
		// Periods whose catchment rain comes from another series (engine rainSourcePeriods.ts, issue #40 (b)); replaced whole.
		rainSource: RainSource,
		// Flagged zero-rain runs (engine rain.ts, CR-20): any subset may be
		// patched; each list is replaced whole.
		zeroRainRuns: z
			.object({
				mode: z.enum(ZERO_RAIN_MODES),
				keepDry: periodList('keep-dry period'),
				missing: periodList('missing-rain period'),
				// Multi-day accumulations (engine accumulation.ts, audit B4).
				accumulationMode: z.enum(ACCUMULATION_MODES),
				keepReadings: periodList('keep-reading period'),
				addAccumulations: periodList('listed accumulation')
			})
			.partial()
			.strict(),
		// The rain threshold and catchment area (engine CalibrationParams). The legacy runoff
		// model's keys (engine RETIRED_CALIBRATION_KEYS, e.g. in an older export) are dropped.
		calibration: z.preprocess(
			(v) => (isObj(v) ? withoutRetiredCalibration(v) : v),
			z.object({ rainThresholdMm: z.number().finite().min(0).max(1000), catchmentAreaKm2: z.number().finite().min(0).max(1e6).nullable() }).partial().strict()
		),
		ewrPragmaticM3PerDay: monthly,
		// Reserve rule tables per EWR site (engine ≥ 0.21.0); the list is replaced whole.
		ewrRules: EwrRuleList,
		// What the EWR charge follows and what low flows are judged on (engine ≥ 1.3.0, issue #64); pending the hydrologist.
		ewrChargeSource: z.enum(EWR_CHARGE_SOURCES),
		lowFlowMeasure: z.enum(LOW_FLOW_MEASURES),
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
			.strict(),
		// When the project re-runs itself after new data (runs/autoRun.ts, WP-2.11): any subset. Not a model input.
		autoRun: AutoRunPatch,
		// How the outcome matrix reads a sweep (outcomeSettings.ts, issue #53 R4): either field. Not a model input.
		outcomes: OutcomesPatch,
		// How a seasonal outlook is set up (outlookSettings.ts, issue #53 R5): either field. Not a model input.
		outlook: OutlookPatch
	})
	.partial()
	.refine((s) => JSON.stringify(s).length <= 64_000, 'settings too large');
