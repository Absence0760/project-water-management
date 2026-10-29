// get_settings (issue #610): the model settings a run used, as its snapshot
// holds them (merged when it ran; merging again would add fields the run's
// engine didn't have, and read a legacy run as GR4J), or the project's as
// they stand, merged over the engine's defaults (projects/settings.ts
// mergeSettings, as GET /projects/:id answers them) so every field is there.
// Only model inputs, picked by name (MODEL_INPUT, as get_network picks its
// fields), so a setting added later reaches the model only once it is listed:
// who decides the project's applications, how it re-runs itself and the
// outlook and outcome set-ups are left out (they are no model input, and the
// authority's office is not the assistant's business), and the calibration
// rules' sign-off keeps its date but not the name typed to sign it.
import { z } from 'zod';
import { mergeSettings } from '../../projects/settings.js';
import { SETTING_KINDS, type SettingKind } from '../settingKinds.js';
import { readRun } from '../../runs/read.js';
import { TOOL_NAMES, type AssistantTool } from '../types.js';
import { compact, fail, parseArgs, refusal, runFor, specOf } from './common.js';

/**
 * The settings the model reads, by name: every key of the engine's settings
 * (projects/settings.ts mergeSettings). A new key is sent only once it is added
 * here; settings.test.ts fails until each key is here or in NOT_MODEL_INPUT.
 */
export const MODEL_INPUT = [
	'februaryDays',
	'effectiveRainFraction',
	'effectiveRainFractionMonthly',
	'effectiveRainStoreMm',
	'lakeEvapFactor',
	'assuranceAnnualThreshold',
	'allocationMode',
	'allocationTolerance',
	'lakeEvapFactorMonthly',
	'lakeEvapFactorSource',
	'apanMm',
	'runoffModel',
	'gr4j',
	'panCoefficient',
	'panCoefficientSource',
	'pe',
	'arealRain',
	'chirpsBiasCorrection',
	'chirpsFitPeriod',
	'chirpsQuantileMap',
	'gapRain',
	'rainSource',
	'zeroRainRuns',
	'calibration',
	'ewrPragmaticM3PerDay',
	'ewrRules',
	'ewrChargeSource',
	'lowFlowMeasure',
	'ewrDailySource',
	'simulationStart',
	'simulationEnd',
	'reportStart',
	'reportEnd',
	'calibrationStart',
	'calibrationEnd',
	'calibrationFlowKind',
	'calibrationSiteNodeId',
	'calibrationExclusions',
	'flowMissing',
	'flowGapFill',
	'qualityFlags',
	'calibrationRules',
	'fitRecord',
	'dataQuality',
	'wr2012',
	// Optional in the stored settings (absent = off or none), so mergeSettings doesn't add them: sent when set.
	'droughtRestriction',
	'unitRain',
	'rainStations',
	'flowMissing',
	'calibrationZones'
] as const;

/** Stored settings that are no model input (projects/routes.ts withoutRunPolicy): never sent. */
export const NOT_MODEL_INPUT = ['autoRun', 'outcomes', 'outlook', 'responsibleAuthority', 'ewrHeadline'] as const;

const SENT: ReadonlySet<string> = new Set(MODEL_INPUT);

/** The calibration rules without the name typed to sign them off: whether they are signed, and on which day. */
function rulesView(rules: unknown): unknown {
	if (!rules || typeof rules !== 'object') return rules;
	const { signedOff, ...rest } = rules as { signedOff?: { on?: unknown } | null } & Record<string, unknown>;
	return { ...rest, signedOff: signedOff ? { signed: true, on: signedOff.on ?? null } : { signed: false } };
}

const Args = z
	.object({
		source: z
			.enum(['run', 'project'])
			.optional()
			.describe("'run': the settings the run used (default when the project has a run); 'project': the settings as saved now, which the next run uses"),
		keys: z
			.array(z.string().trim().min(1).max(64))
			.max(40)
			.optional()
			.describe('Only these top-level settings (e.g. gr4j, calibrationStart, ewrPragmaticM3PerDay); default every one')
	})
	.strict();

/** The settings as the tool answers them. Pure, for the unit tests. */
export function settingsView(
	stored: unknown,
	keys: readonly string[] | undefined,
	merge: boolean
): { settings: Record<string, unknown>; kinds: Record<string, SettingKind>; unknownKeys?: string[] } {
	const all = merge ? (mergeSettings(stored) as unknown as Record<string, unknown>) : stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
	const merged = Object.fromEntries(Object.entries(all).filter(([k]) => SENT.has(k)));
	if ('calibrationRules' in merged) merged.calibrationRules = rulesView(merged.calibrationRules);
	const pickKeys = keys?.length ? keys : Object.keys(merged);
	const settings = Object.fromEntries(pickKeys.filter((k) => k in merged).map((k) => [k, compact(merged[k], { digits: 0, maxItems: 40, maxDepth: 5 })]));
	const unknownKeys = pickKeys.filter((k) => !(k in merged));
	// Each setting's kind (settingKinds.ts), so what a goal may change is data the model reads beside the values.
	const kinds = Object.fromEntries(Object.keys(settings).flatMap((k) => (SETTING_KINDS[k] ? [[k, SETTING_KINDS[k]]] : []))) as Record<string, SettingKind>;
	return { settings, kinds, ...(unknownKeys.length ? { unknownKeys } : {}) };
}

export const settingsTool: AssistantTool = {
	spec: specOf(
		TOOL_NAMES.settings,
		"The model settings: the runoff model and its parameters (gr4j), the simulation, report and calibration windows, the calibration site and record, the calibration zones (gauges inside the network fitted on their own records, each with its own X1–X4), rain gap filling, evaporation, the EWR and the drought restriction. The run's own by default (as it ran), or the project's as saved now (merged over the engine's defaults). `kinds` says what each setting is: 'calibrated' (fitted to observed flow, or forcing that trades off against the fit: changed only to improve the fit, never an outcome), 'input' (the catchment and its data), 'assessment' (what results are judged against) or 'management' (how water is managed). The network's operating rules (get_network) are management too.",
		Args
	),
	label: 'Reading the settings',
	async run(ctx, args) {
		const a = parseArgs(Args, args);
		if (!a.ok) return a;
		try {
			const { role, runId } = await runFor(ctx);
			const source = a.value.source ?? (runId ? 'run' : 'project');
			if (source === 'run') {
				if (!runId) return fail("this project has no run yet: ask for source 'project'");
				const { run } = await readRun(ctx.db, ctx.projectId, role, runId);
				return { ok: true, data: { source, runId, ...settingsView(run.settings, a.value.keys, false) } };
			}
			const { rows } = await ctx.db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [ctx.projectId]);
			return { ok: true, data: { source, ...settingsView(rows[0]?.settings, a.value.keys, true) } };
		} catch (e) {
			return refusal(e);
		}
	}
};
