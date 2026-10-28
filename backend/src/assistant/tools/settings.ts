// get_settings (issue #610): the model settings a run used, as its snapshot
// holds them (merged when it ran; merging again would add fields the run's
// engine didn't have, and read a legacy run as GR4J), or the project's as
// they stand, merged over the engine's defaults (projects/settings.ts
// mergeSettings, as GET /projects/:id answers them) so every field is there.
// Only model inputs: who decides the project's applications, how it re-runs
// itself and the outlook and outcome set-ups are left out (they are no model
// input, and the authority's office is not the assistant's business).
import { z } from 'zod';
import { mergeSettings } from '../../projects/settings.js';
import { readRun } from '../../runs/read.js';
import { TOOL_NAMES, type AssistantTool } from '../types.js';
import { compact, fail, parseArgs, refusal, runFor, specOf } from './common.js';

/** Stored settings that are no model input (projects/routes.ts withoutRunPolicy). */
const NOT_MODEL_INPUT = ['autoRun', 'outcomes', 'outlook', 'responsibleAuthority', 'ewrHeadline'] as const;

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
export function settingsView(stored: unknown, keys: readonly string[] | undefined, merge: boolean): { settings: Record<string, unknown>; unknownKeys?: string[] } {
	const merged = merge ? (mergeSettings(stored) as unknown as Record<string, unknown>) : { ...(stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {}) };
	for (const k of NOT_MODEL_INPUT) delete merged[k];
	const pickKeys = keys?.length ? keys : Object.keys(merged);
	const settings = Object.fromEntries(pickKeys.filter((k) => k in merged).map((k) => [k, compact(merged[k], { digits: 0, maxItems: 40, maxDepth: 5 })]));
	const unknownKeys = pickKeys.filter((k) => !(k in merged));
	return { settings, ...(unknownKeys.length ? { unknownKeys } : {}) };
}

export const settingsTool: AssistantTool = {
	spec: specOf(
		TOOL_NAMES.settings,
		"The model settings: the runoff model and its parameters (gr4j), the simulation, report and calibration windows, the calibration site and record, rain gap filling, evaporation and the EWR. The run's own by default (as it ran), or the project's as saved now (merged over the engine's defaults).",
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
