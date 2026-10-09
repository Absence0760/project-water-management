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
	LOW_VS_CHIRPS_BASELINES,
	LOW_VS_CHIRPS_MINIMUMS,
	MAX_STARTS,
	provenanceError,
	OBJECTIVES,
	PE_SOURCE_MAX,
	AREAL_RAIN_FACTOR_MAX,
	MAP_MM_MAX,
	MAP_MM_MIN,
	UNIT_RAIN_MODES,
	unitRainError,
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
	QM_WET_DAY_MM_MAX,
	QM_WET_DAY_MM_MIN,
	ZERO_RAIN_MODES,
	GAP_FILL_DONORS,
	GAP_FILL_LIMITS,
	sourceError,
	ABOVE_RATING_USES,
	FLAG_USES,
	FLOW_DAY_FLAGS,
	ratingError,
	RATING_SOURCE_MAX,
	ZERO_RUN_RULES,
	calibrationRulesError,
	resolveCalibrationRules,
	type CalibrationRules as CalibrationRulesT,
	RULE_CASES_MAX,
	sameRules,
	sameSignOff,
	canonicalJson,
	SELECTION_TESTS,
	ON_NEW_DATA,
	SIGNED_OFF_BY_MAX,
	declaredRuleError,
	droughtRestrictionIssues,
	ewrDailySourceIssues,
	type ProjectSettings,
	isIsoDate
} from '@water-management/engine';
import { z } from 'zod';
import { AutoRunPatch } from '../runs/autoRun.js';
import { OutcomesPatch } from './outcomeSettings.js';
import { OutlookPatch } from './outlookSettings.js';
import { ResponsibleAuthorityPatch } from './authoritySettings.js';
import { EwrHeadlinePatch } from './ewrHeadlineSettings.js';

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
 * Why the Reserve rule tables name the outlet twice, or null: one keyed null
 * ("the outlet") beside one keyed by the outlet node's own id. The run treats
 * the two as one site and uses neither (engine ≥ 1.69.0, model.md §2.9c), so
 * a save that carries both would drop the outlet's compliance silently.
 */
export function ewrOutletTableError(ewrRules: unknown, outletIds: readonly string[]): string | null {
	const tables = Array.isArray(ewrRules) ? ewrRules.filter(isObj) : [];
	const byNull = tables.some((t) => t.siteNodeId === null || t.siteNodeId === undefined);
	const byId = tables.some((t) => typeof t.siteNodeId === 'string' && outletIds.includes(t.siteNodeId));
	return byNull && byId ? 'ewrRules: two Reserve rule tables for the outlet (one for "the outlet" and one keyed by the outlet hydrological unit): keep one' : null;
}

/**
 * Stored settings for a copy whose nodes got fresh ids (POST /projects/:id/copy,
 * `ids` old → new): each EWR rule table's site (engine ≥ 0.21.0) and the
 * outcome matrix's site (settings.outcomes.siteNodeId, issue #53 R4) follow
 * their node, as do the calibration site (settings.calibrationSiteNodeId,
 * engine ≥ 1.41.0) and the site its fit record was scored at. A site not in the map (already dangling) is left as it was, so
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
	// The site the results are judged by (settings.ewrHeadline, issue #444) follows its node too.
	if (isObj(s.ewrHeadline) && typeof s.ewrHeadline.siteNodeId === 'string' && ids.has(s.ewrHeadline.siteNodeId)) {
		s.ewrHeadline = { ...s.ewrHeadline, siteNodeId: ids.get(s.ewrHeadline.siteNodeId) };
	}
	// The drought restriction rule's dams, units and EWR site (engine ≥ 1.54.0) follow their nodes too.
	if (isObj(s.droughtRestriction)) {
		const r = { ...s.droughtRestriction };
		const map = (list: unknown) => (Array.isArray(list) ? list.map((id) => (typeof id === 'string' && ids.has(id) ? ids.get(id) : id)) : list);
		if (r.damNodeIds !== undefined) r.damNodeIds = map(r.damNodeIds);
		if (r.nodeIds !== undefined) r.nodeIds = map(r.nodeIds);
		if (isObj(r.ewrTrigger) && typeof r.ewrTrigger.siteNodeId === 'string' && ids.has(r.ewrTrigger.siteNodeId)) r.ewrTrigger = { ...r.ewrTrigger, siteNodeId: ids.get(r.ewrTrigger.siteNodeId) };
		s.droughtRestriction = r;
	}
	if (typeof s.calibrationSiteNodeId === 'string' && ids.has(s.calibrationSiteNodeId)) s.calibrationSiteNodeId = ids.get(s.calibrationSiteNodeId);
	if (isObj(s.fitRecord) && typeof s.fitRecord.siteNodeId === 'string' && ids.has(s.fitRecord.siteNodeId)) {
		s.fitRecord = { ...s.fitRecord, siteNodeId: ids.get(s.fitRecord.siteNodeId) };
	}
	return s;
}

/**
 * Settings replaced whole by a patch, never merged: a fit record describes
 * one fit, and a PE input is one kind or the other (merging `{ kind: 'pan' }`
 * over a stored monthly row would keep a stale `mm` and `source`), and an
 * areal rainfall correction (engine ≥ 1.13.0) is one set of factors with its
 * own source. The declared uncertainty rule (issue #71) is one rule: a patch
 * that changed one threshold must not keep another from an older one. So is
 * the drought restriction rule (engine ≥ 1.54.0): a level left out is gone.
 * And the EWR headline choice (issue #444): a site kept from a rule-table
 * choice under `{ source: 'pragmatic' }` would be a field no choice has. So
 * is the daily outlet EWR's source (engine ≥ 1.77.0, issue #455): its tables
 * are one set, entered together.
 */
const REPLACED_WHOLE = new Set(['fitRecord', 'pe', 'arealRain', 'chirpsQuantileMap', 'calibrationRules', 'evidenceUncertaintyRule', 'droughtRestriction', 'ewrHeadline', 'ewrDailySource', 'unitRain']);

/**
 * settings.calibrationRules after a save (engine ≥ 1.25.0, issue #153): the
 * revision is the server's, whatever the client sent. A save that changes a
 * rule adds 1 to it and clears the sign-off, which covered the rules as they
 * were, unless the same save records a new sign-off (one that differs from
 * the stored one). A save that only signs off, or changes nothing, keeps the
 * revision.
 */
export function nextCalibrationRules(stored: unknown, sent: unknown): CalibrationRulesT {
	const before = resolveCalibrationRules(stored, []);
	const next = resolveCalibrationRules({ ...(isObj(sent) ? sent : {}), revision: before.revision }, []);
	if (sameRules(before, next)) return next;
	const newSignOff = !sameSignOff(next.signedOff, before.signedOff);
	return { ...next, revision: before.revision + 1, signedOff: newSignOff ? next.signedOff : null };
}

/**
 * What a save does to the rules' sign-off: records a new one (its rules
 * carry one that isn't the stored one; the route stamps today's date and
 * audits it with the signed-in account), withdraws it (the stored one is
 * gone and no rule changed; audited too), or neither (a rule change that
 * clears it is in the settings history already).
 */
export function signOffChange(stored: unknown, next: ProjectSettings): 'signed' | 'withdrawn' | null {
	const was = resolveCalibrationRules(stored && typeof stored === 'object' ? (stored as Record<string, unknown>).calibrationRules : undefined, []);
	const now = next.calibrationRules;
	if (now?.signedOff && !sameSignOff(now.signedOff, was.signedOff)) return 'signed';
	if (was.signedOff && !now?.signedOff && now && sameRules(was, now)) return 'withdrawn';
	return null;
}

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
	if ('calibrationRules' in patch) out.calibrationRules = nextCalibrationRules(current.calibrationRules, patch.calibrationRules);
	out.fitRecord = resolveFitRecord(out as Partial<ProjectSettings> & Json);
	return out as unknown as ProjectSettings;
}

/**
 * Why a save can't store this automated fit (FitRecord.auto), or null. The
 * server computes automated fits and writes their records itself
 * (calibration/store.ts applyCalibration), so a save may only carry the
 * stored record back as it was; any new or altered `auto` is refused (issue
 * #153). `stored` is the project's settings before the save, `next` what the
 * save produces.
 */
export function autoFitRecordError(stored: ProjectSettings, next: ProjectSettings): string | null {
	const rec = next.fitRecord;
	if (!rec?.auto) return null;
	const was = stored.fitRecord;
	if (was && was.fittedAt === rec.fittedAt && was.seed === rec.seed && canonicalJson(was.auto ?? null) === canonicalJson(rec.auto)) return null;
	return 'an automated fit is applied by the server from its own run of the calibration rules (POST /projects/:id/auto-calibrations/:calibrationId/apply), never written directly';
}

/**
 * Why an automated fit record doesn't belong with these rules, or null: it
 * ran under another revision, or rules whose content or sign-off differ, or
 * its parameters aren't the kept case's (a client can't claim one case and
 * store another). The fit itself runs in the browser, so the scores it
 * reports can't be re-checked here; the rules they were chosen by can.
 */
function autoRecordMismatch(rec: NonNullable<ProjectSettings['fitRecord']>, rules: ReturnType<typeof resolveCalibrationRules>, which: 'saved' | 'file’s'): string | null {
	const auto = rec.auto!;
	const ran = auto.rules;
	if (ran.revision !== rules.revision)
		return `this automated fit ran under calibration rules revision ${ran.revision}, but the ${which} rules are revision ${rules.revision}: run it again under the ${which} rules`;
	if (!sameRules(ran, rules) || !sameSignOff(ran.signedOff, rules.signedOff))
		return `this automated fit ran under other calibration rules than the ${which} revision ${rules.revision} (their content or sign-off differs): run it again under the ${which} rules`;
	const kept = auto.cases[auto.chosen];
	if (!kept?.params || rec.free.some((k) => kept.params![k] !== rec.params[k]))
		return 'the fit record’s parameters are not those of the case the calibration rules kept';
	return null;
}

/** Why an imported project's automated fit record doesn't match the file's own calibration rules, or null. */
export function importedAutoFitError(settings: Record<string, unknown>): string | null {
	const rec = settings.fitRecord as ProjectSettings['fitRecord'] | undefined;
	if (!rec?.auto) return null;
	return autoRecordMismatch(rec, resolveCalibrationRules(settings.calibrationRules, []), 'file’s');
}

const monthly = z.array(z.number().finite()).length(12);
/** 12 monthly values ≥ 0: a negative A-pan or pragmatic EWR month is refused (engine ≥ 1.69.0, ER-17); migration 187 clamped stored rows. */
const monthlyNonNeg = z.array(z.number().finite().min(0)).length(12);

const dqDays = (min: number) => z.number().int().min(min).max(366);
/** The zero-run and low-vs-CHIRPS limits (engine RAIN_CHECK_KEYS): also recorded in a fit's forcing. */
const RainChecks = z.object({
	zeroRunRule: z.enum(ZERO_RUN_RULES),
	zeroRunMinWetDays: dqDays(1),
	zeroRunUsualShare: z.number().gt(0).max(1),
	zeroRunMinDays: dqDays(1),
	zeroRunChirpsCheck: z.boolean(),
	lowVsChirpsRatio: z.number().gt(0).lt(1),
	lowVsChirpsBaseline: z.enum(LOW_VS_CHIRPS_BASELINES),
	lowVsChirpsMinimum: z.enum(LOW_VS_CHIRPS_MINIMUMS)
});
/** settings.dataQuality, any subset (the engine's resolveDataQuality ranges). */
const DataQualityPatch = z
	.object({
		agreementMinRatio: z.number().gt(0).max(1),
		agreementMaxRatio: z.number().min(1).max(100),
		agreementMinDays: dqDays(1),
		outlierFactorRain: z.number().gt(1).max(1000),
		outlierFactorFlow: z.number().gt(1).max(1000),
		flatlineRainDays: dqDays(2),
		flatlineEvapDays: dqDays(2),
		flatlineFlowMinDays: dqDays(2),
		flatlineFlowMaxDays: dqDays(2),
		...RainChecks.shape
	})
	.partial()
	.strict();

/**
 * The cross-field rule of settings.dataQuality, on the settings a patch
 * produces: the flow flat-line cap can't be below its floor. null when fine.
 */
export function dataQualityPatchError(settings: Pick<ProjectSettings, 'dataQuality'>): string | null {
	const dq = settings.dataQuality;
	return dq.flatlineFlowMaxDays < dq.flatlineFlowMinDays
		? `settings.dataQuality: the flow flat-line cap (${dq.flatlineFlowMaxDays} days) can't be below its floor (${dq.flatlineFlowMinDays} days)`
		: null;
}

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
		// ER9 (issue #71), optional: the recommended ecological category, "A" … "F" or a band like "B/C" (ewrRuleTableIssues checks the form).
		category: z.string().max(3).nullable().optional(),
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
// A date that exists (engine ≥ 1.69.0: 2001-02-29 no longer runs as 1 March).
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => isIsoDate(s), 'not a calendar date');

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

/**
 * settings.unitRain (issue #482, docs/model.md §2.4h): whether each land unit
 * runs GR4J on its own rain (`perUnit`) or the catchment's (`catchment`,
 * like absent or null), the catchment gauge's own MAP with its source, and the
 * period a unit's CHIRPS MAP factor is computed over (null/absent = 1991–2020).
 * Replaced whole on a patch. The engine's unitRainError applies the same rules
 * to a stored value, and here too, so the form, the save and the run agree.
 */
export const UnitRain = z
	.object({
		mode: z.enum(UNIT_RAIN_MODES),
		gaugeMapMm: z.number().finite().min(MAP_MM_MIN).max(MAP_MM_MAX).nullable().optional(),
		gaugeMapSource: z.string().trim().max(PE_SOURCE_MAX).nullable().optional(),
		mapPeriod: z.object({ start: isoDate, end: isoDate }).strict().nullable().optional()
	})
	.strict()
	.superRefine((v, ctx) => {
		const err = unitRainError(v);
		if (err) ctx.addIssue({ code: 'custom', message: `unit rain: ${err}` });
	});

/**
 * settings.chirpsQuantileMap (engine ≥ 1.53.0, CR-23, docs/model.md §2.4b
 * *Quantile map*): the CHIRPS gap fill's wet-day threshold; null = off.
 * Replaced whole on a patch. The engine's chirpsQuantileMapError applies the
 * same rules to a stored value (a table test holds the two together).
 */
export const ChirpsQuantileMap = z
	.object({ wetDayMm: z.number().finite().min(QM_WET_DAY_MM_MIN).max(QM_WET_DAY_MM_MAX) })
	.strict();

const scoreValue = z.number().finite().nullable();
const scoreSet = z.record(z.string().max(40), scoreValue).refine((o) => Object.keys(o).length <= 30, 'too many scores');
const scoreInterval = z.object({ lo: z.number().finite(), hi: z.number().finite() }).strict().nullable();
const ScoredPeriod = z
	.object({
		start: isoDate,
		end: isoDate,
		waterYears: z.array(z.number().int()).max(500),
		scores: scoreSet,
		// Engine ≥ 1.19.0 (CR-5): bootstrap intervals and benchmark scores. Optional: a record made before them has neither.
		intervals: z
			.object({
				level: z.number().gt(0).lt(1),
				resamples: z.number().int().min(1).max(100_000),
				seed: z.number().int().min(0).max(2 ** 32 - 1),
				years: z.number().int().min(0).max(500),
				kgePrime: scoreInterval,
				nse: scoreInterval,
				kgeLowHigh: scoreInterval
			})
			.strict()
			.nullable()
			.optional(),
		benchmarks: z
			.object({ meanFlow: scoreSet, climatology: scoreSet, halfWindowDays: z.number().int().min(0).max(183), builtFrom: z.enum(['period', 'calibration']).optional() })
			.strict()
			.nullable()
			.optional(),
		// Engine ≥ 1.19.0 (CR-28): the WR2012 five-statistic table on these days. Optional: absent on a record made before it.
		wr2012Fit: z
			.object({
				waterYears: z.array(z.number().int()).max(500),
				logYears: z.number().int().min(0).max(500),
				stats: z
					.array(
						z
							.object({
								key: z.enum(['mar', 'meanLog', 'sd', 'logSd', 'seasonalIndex']),
								observed: z.number().finite().nullable(),
								simulated: z.number().finite().nullable(),
								diffPct: z.number().finite().nullable(),
								bandPct: z.number().finite().min(0),
								withinBand: z.boolean().nullable()
							})
							.strict()
					)
					.max(5),
				bandsConfirmed: z.boolean()
			})
			.strict()
			.nullable()
			.optional()
	})
	.strict();
/**
 * One observed record's gap filling (engine flowGapFill.ts, engine ≥ 1.23.0),
 * replaced whole; null = not filled. The donor must be another record: the
 * patch schema checks it against the key it sits under.
 */
const GapFillSpec = z
	.object({
		interpolateMaxDays: z.number().int().min(0).max(GAP_FILL_LIMITS.interpolateMaxDays),
		donor: z.enum(GAP_FILL_DONORS).nullable(),
		donorMaxDays: z.number().int().min(1).max(GAP_FILL_LIMITS.donorMaxDays),
		donorMinOverlapDays: z.number().int().min(GAP_FILL_LIMITS.donorMinOverlapDaysMin).max(GAP_FILL_LIMITS.donorMinOverlapDaysMax)
	})
	.strict();
const notOwnDonor = (kind: string) => (s: z.infer<typeof GapFillSpec> | null) => s === null || s.donor !== kind;
const FlowGapFill = z
	.object({
		flow_observed_m3s: GapFillSpec.nullable().refine(notOwnDonor('flow_observed_m3s'), 'a record cannot fill its own gaps: pick another record as the donor'),
		flow_logger_m3s: GapFillSpec.nullable().refine(notOwnDonor('flow_logger_m3s'), 'a record cannot fill its own gaps: pick another record as the donor')
		// Whether filled days are scored is qualityFlags.infilled (engine ≥ 1.23.0); the retired `useFilledDays` is refused.
	})
	.partial()
	.strict();

const params = z.record(z.string().max(40), z.number().finite()).refine((o) => Object.keys(o).length <= 30, 'too many parameters');

/**
 * One record's gauged range (engine dayFlags.ts GaugeRating, CR-18): the
 * highest and lowest field gaugings in m³/s (null = not known) and a source,
 * required once either is set. The engine's ratingError is the rule.
 */
const GaugeRating = z
	.object({
		gaugedMaxM3s: z.number().finite().gt(0).nullable(),
		gaugedMinM3s: z.number().finite().min(0).nullable(),
		source: z.string().max(RATING_SOURCE_MAX)
	})
	.strict()
	.superRefine((r, ctx) => {
		const err = ratingError(r);
		if (err) ctx.addIssue({ code: 'custom', message: err });
	});
/** settings.qualityFlags (engine ≥ 1.22.0, CR-18/19): the gauged ranges and how the fit scores flagged days. */
const QualityFlags = z
	.object({
		ratings: z.object({ flow_observed_m3s: GaugeRating.optional(), flow_logger_m3s: GaugeRating.optional() }).strict(),
		aboveRating: z.enum(ABOVE_RATING_USES),
		belowRating: z.enum(FLAG_USES),
		suspect: z.enum(FLAG_USES),
		infilled: z.enum(FLAG_USES)
	})
	.strict();
const dayCount = z.number().int().min(0).max(1_000_000);
/** A fit's quality-flag summary (engine DayQuality, CR-22), as the browser reports it. */
const DayQuality = z
	.object({
		flowKind: z.enum(CALIBRATION_FLOW_KINDS),
		rating: z.object({ gaugedMaxM3s: z.number().finite().nullable(), gaugedMinM3s: z.number().finite().nullable(), source: z.string().max(RATING_SOURCE_MAX) }).strict().nullable(),
		use: QualityFlags.omit({ ratings: true }),
		windowDays: dayCount,
		flow: z.object(Object.fromEntries(FLOW_DAY_FLAGS.map((f) => [f, dayCount])) as Record<(typeof FLOW_DAY_FLAGS)[number], typeof dayCount>).strict(),
		scoredDays: dayCount,
		censoredDays: dayCount,
		leftOutDays: dayCount,
		suspectZeroDays: dayCount,
		// Engine ≥ 1.62.0 (QF-3): zero flow held for a long stretch, scored. Absent on an older record.
		longZeroDays: dayCount.optional(),
		rain: z.object({ observed: dayCount, infilled: dayCount, missing: dayCount, zeroRunDays: dayCount }).strict().nullable(),
		notes: z.array(z.string().max(2000)).max(20)
	})
	.strict();
/**
 * settings.calibrationRules (engine ≥ 1.25.0, issue #153, engine
 * calibrate/rulesSettings.ts): replaced whole on a save. `revision` is
 * optional in a patch and ignored (patchSettings sets it); in a fit record
 * it is the revision the fit ran under.
 */
const calibrationRulesShape = {
	revision: z.number().int().min(1).max(1_000_000),
	exclusions: z.object({ maxFlaggedShare: z.number().gt(0).lt(1).nullable() }).strict(),
	forcing: z.object({ pan: z.array(z.string().min(1).max(40)).min(1).max(RULE_CASES_MAX) }).strict(),
	cases: z
		.object({
			bounds: z.array(z.enum(CALIBRATION_BOUNDS)).min(1).max(CALIBRATION_BOUNDS.length),
			objectives: z.array(z.enum(OBJECTIVES)).min(1).max(OBJECTIVES.length)
		})
		.strict(),
	selection: z.object({ test: z.enum(SELECTION_TESTS), score: z.enum(OBJECTIVES) }).strict(),
	// The seed, starts and model runs per fit: bounds checked by calibrationRulesError.
	run: z.object({ seed: z.number().int(), starts: z.number().int(), budget: z.number().int() }).strict(),
	after: z.object({ onNewData: z.enum(ON_NEW_DATA), ensemble: z.boolean() }).strict(),
	filters: z.object({ wr2012Mar: z.boolean(), typicalParams: z.boolean() }).strict(),
	// The signer's typed name (a signature) and the date, which the server replaces with today's on a new sign-off (routes.ts).
	signedOff: z.object({ by: z.string().trim().min(1).max(SIGNED_OFF_BY_MAX), on: isoDate }).strict().nullable()
};
const rulesChecked = (r: Parameters<typeof calibrationRulesError>[0], ctx: z.RefinementCtx) => {
	const err = calibrationRulesError(r);
	if (err) ctx.addIssue({ code: 'custom', message: err });
};
const CalibrationRulesPatch = z
	.object({ ...calibrationRulesShape, revision: calibrationRulesShape.revision.optional() })
	.strict()
	.superRefine((r, ctx) => rulesChecked({ ...r, revision: r.revision ?? 1 }, ctx));
const CalibrationRules = z.object(calibrationRulesShape).strict().superRefine(rulesChecked);
/** FitRecord.auto (engine AutoFitRecord): how automated calibration chose the fit. */
const AutoFitRecord = z
	.object({
		rules: CalibrationRules,
		ruleExclusions: ExclusionList,
		chosen: z.number().int().min(0).max(RULE_CASES_MAX - 1),
		cases: z
			.array(
				z
					.object({
						label: z.string().max(300),
						pan: z.string().max(40),
						bounds: z.enum(CALIBRATION_BOUNDS),
						objective: z.enum(OBJECTIVES),
						score: z.number().finite().nullable(),
						eligible: z.boolean(),
						reasons: z.array(z.string().max(2000)).max(20),
						params: params.nullable()
					})
					.strict()
			)
			.min(1)
			.max(RULE_CASES_MAX)
	})
	.strict()
	.refine((a) => a.chosen < a.cases.length && a.cases[a.chosen]!.eligible, 'the kept case must be one of the cases, and eligible');
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
		// Engine ≥ 1.41.0: the gauge the fit was scored at (null = the outlet); absent on a record made before it.
		siteNodeId: z.string().min(1).max(100).nullable().optional(),
		simulatedKey: z.literal('simulated_outflow'),
		calibrationStart: isoDate.nullable(),
		calibrationEnd: isoDate.nullable(),
		exclusions: ExclusionList,
		// Engine ≥ 1.22.0 (CR-18/19/22): the quality-flag settings, their summary and the fit on all days. Optional: absent on a record made before them.
		qualityFlags: QualityFlags.optional(),
		dayQuality: DayQuality.nullable().optional(),
		fitAllDays: ScoredPeriod.nullable().optional(),
		validate: z.boolean(),
		validationRecord: flowKind.nullable(),
		fit: ScoredPeriod,
		before: ScoredPeriod,
		splitSample: ValidationTest.strict().nullable(),
		differential: ValidationTest.extend({
			dryYears: z.array(z.number().int()).max(500),
			wetYears: z.array(z.number().int()).max(500),
			wetDryRatio: z.number().finite(),
			// Engine ≥ 1.19.0: what ranked the years (the reference gauge, or the fitted record). Optional: absent = 'observed'.
			rankedBy: z.enum(['observed', 'reference']).optional()
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
				// Engine ≥ 1.53.0 (CR-23): the CHIRPS gap map, recorded only when on. Optional, as above; absent = off.
				chirpsQuantileMap: ChirpsQuantileMap.nullable().optional(),
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
					.optional(),
				// Engine ≥ 1.20.0 (issue #66): the data-quality rain-check limits the fit ran under. Optional, as above; absent = the defaults.
				rainChecks: RainChecks.strict().optional()
			})
			.strict()
			.optional(),
		// Engine ≥ 1.23.0 (issue #66): the fitted record's source and given unit (107_series_source.sql; null = not recorded),
		// and its gap filling. Optional: a record made before them has neither.
		observedOrigin: z
			.object({
				source: z.string().refine((v) => sourceError(v) === null, 'not a valid source').nullable(),
				unit: z.string().min(1).max(20).nullable(),
				factor: z.number().finite().positive().nullable()
			})
			.strict()
			.nullable()
			.optional(),
		// `useFilledDays` only on a record made on the branch before the quality flags (never deployed); never read.
		flowGapFill: z.object({ spec: GapFillSpec.nullable(), useFilledDays: z.boolean().optional() }).strict().optional(),
		// Engine ≥ 1.25.0 (issue #153): set when automated calibration picked the fit. Optional: absent on a fit a person chose.
		auto: AutoFitRecord.optional()
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
		// Registered volumes (engine ≥ 1.18.0, issue #72): what they do to a run, and the comparison's band, a fraction in [0, 1).
		allocationMode: z.enum(ALLOCATION_MODES),
		allocationTolerance: z.number().finite().min(0).lt(1),
		// Monthly lake factors (WP-3.5), water-year months; null = lakeEvapFactor every month.
		lakeEvapFactorMonthly: z.array(z.number().finite().min(0).max(2)).length(12).nullable(),
		// Where the dam evaporation factors came from (engine ≥ 1.49.0): free text, e.g. a lake-factor preset's note; provenance only; '' = none.
		lakeEvapFactorSource: z.string().trim().max(PE_SOURCE_MAX),
		apanMm: monthlyNonNeg,
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
		// Rain for each land unit (issue #482, project.ts UnitRainSettings); replaced whole, null = the catchment's rain.
		unitRain: UnitRain.nullable(),
		// Where the pan-coefficient row came from (engine ≥ 0.31.1): free text, provenance only; '' = none.
		panCoefficientSource: z.string().trim().max(PE_SOURCE_MAX),
		chirpsBiasCorrection: z.enum(CHIRPS_BIAS_MODES),
		// Which part of the record the CHIRPS factors are fitted on (engine rain.ts, issue #40); replaced whole.
		chirpsFitPeriod: ChirpsFitPeriod,
		// The CHIRPS gap map (engine ≥ 1.53.0, CR-23); replaced whole, null = off.
		chirpsQuantileMap: ChirpsQuantileMap.nullable(),
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
		ewrPragmaticM3PerDay: monthlyNonNeg,
		// Reserve rule tables per EWR site (engine ≥ 0.21.0); the list is replaced whole.
		ewrRules: EwrRuleList,
		// What the EWR charge follows and what low flows are judged on (engine ≥ 1.3.0, issue #64); pending the hydrologist.
		ewrChargeSource: z.enum(EWR_CHARGE_SOURCES),
		lowFlowMeasure: z.enum(LOW_FLOW_MEASURES),
		// Where the daily outlet EWR comes from (engine ≥ 1.77.0, issue #455, reserve/dailySource.ts): the pragmatic EWR,
		// the DRM TAB file or the DRM percentile tables; replaced whole, null = the pragmatic EWR. The engine's own checks
		// (ewrDailySourceIssues), so the form, the save and the run agree.
		ewrDailySource: z
			.unknown()
			.superRefine((v, ctx) => {
				if (v === null) return;
				for (const i of ewrDailySourceIssues(v)) ctx.addIssue({ code: 'custom', message: `daily EWR source: ${i.field ? `${i.field}: ` : ''}${i.message}` });
			}),
		// The drought restriction rule (engine ≥ 1.54.0, WP-3.8, network/restriction.ts): replaced whole, null = off.
		// The engine's own checks (droughtRestrictionIssues), so the form, the save and the run agree.
		droughtRestriction: z
			.unknown()
			.superRefine((v, ctx) => {
				if (v === null) return;
				for (const i of droughtRestrictionIssues(v)) ctx.addIssue({ code: 'custom', message: `drought restriction rule: ${i.field ? `${i.field} ` : ''}${i.message}` });
			}),
		simulationStart: isoDate.nullable(),
		simulationEnd: isoDate.nullable(),
		reportStart: isoDate.nullable(),
		reportEnd: isoDate.nullable(),
		calibrationStart: isoDate.nullable(),
		calibrationEnd: isoDate.nullable(),
		calibrationFlowKind: z.enum(CALIBRATION_FLOW_KINDS).nullable(),
		// Where calibration scores (engine ≥ 1.41.0): null = the outlet, else an inner gauge with a record (checked by the route).
		calibrationSiteNodeId: z.string().uuid().nullable(),
		calibrationExclusions: ExclusionList,
		// Gap filling of the observed flow records (engine flowGapFill.ts, issue #66): either record's spec (replaced whole) or the switch.
		flowGapFill: FlowGapFill,
		// Per-day quality flags (engine calibrate/dayFlags.ts, CR-18/19): any subset of the group; `ratings` is replaced whole.
		qualityFlags: QualityFlags.partial(),
		// Automated calibration's rules (engine calibrate/rulesSettings.ts, issue #153): replaced whole; the server sets the revision.
		calibrationRules: CalibrationRulesPatch,
		// The uncertainty rule an evidence report's cited ensemble must follow (engine uncertainty/options.ts, issue #71 ER3):
		// replaced whole, or null to withdraw it. Not a model input: the settings history records who declared it and when.
		evidenceUncertaintyRule: z.unknown().superRefine((v, ctx) => {
			const err = declaredRuleError(v);
			if (err) ctx.addIssue({ code: 'custom', message: `evidence uncertainty rule: ${err}` });
		}),
		fitRecord: FitRecord.nullable(),
		// Data-quality limits (engine resolveDataQuality): gauge vs logger, and
		// (engine ≥ 1.20.0, issue #66) outliers, flat-lines, zero-rain runs and
		// low vs CHIRPS. Each field is checked on its own, so any subset can be
		// patched; the one cross-field rule (flow flat-line cap ≥ floor) is
		// checked on the merged result (dataQualityPatchError).
		dataQuality: DataQualityPatch,
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
		outlook: OutlookPatch,
		// Who decides the project's applications (authoritySettings.ts, 163): the whole authority, or null. Not a model input.
		responsibleAuthority: ResponsibleAuthorityPatch,
		// Which EWR test the results are judged by (ewrHeadlineSettings.ts, issue #444): one whole choice. Not a model input.
		ewrHeadline: EwrHeadlinePatch
	})
	.partial()
	.refine((s) => JSON.stringify(s).length <= 64_000, 'settings too large');
