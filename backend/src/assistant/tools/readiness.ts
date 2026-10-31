// get_run_readiness (issue #610): what the project still needs before the model
// can run, and what only warns, from the same code the Run model button and
// Runs & results' status line use (the engine's runReady.ts: runBlockers,
// unitsOnCatchmentRain, hasForecastRain), so the assistant can't guess what a
// run needs. Read as the project stands now (its saved model, settings and
// series), on the orchestrator's read-only transaction as the caller, so RLS
// decides what it sees. It reads only the series' kinds, units and station
// MAPs, never their values or names, and names only land units, as the
// network does.
import { hasForecastRain, runBlockers, unitsOnCatchmentRain, type NetworkNode } from '@water-management/engine';
import { z } from 'zod';
import { loadSettingsAndModel } from '../../model/store.js';
import { rank } from '../../projects/access.js';
import { stationSql } from '../../series/merge.js';
import { TOOL_NAMES, type AssistantTool } from '../types.js';
import { parseArgs, refusal, runFor, specOf } from './common.js';

const Args = z.object({}).strict();

/** Units on the catchment rain named; the rest counted. */
export const MAX_NAMED_UNITS = 20;

/**
 * What a run doesn't need: said with every answer, so "what's needed before a run" is never answered with the
 * optional parts. Each is true of the engine: the calibration site defaults to the outlet and only scores the fit,
 * and the A-pan and pragmatic EWR default to zero (mergeSettings), which the run's warnings say.
 */
export const NOT_REQUIRED =
	'Nothing else stops a run from starting. These are optional for the run, though its results depend on them: observed flow and a calibration site (the outlet by default; they score the fit, and calibrating needs them), the EWR (zero until it is set, so EWR results mean little before), A-pan evaporation (zero until it is set or uploaded), dams, crops, transfers and other water users. A run’s warnings say what it fell back on.';

type SeriesRow = { kind: string; siteNodeId: string | null; station: { mapMm?: number | null } | null };

/** The readiness as the tool answers it. Pure, for the unit tests. */
export function readinessView(
	model: { nodes: NetworkNode[] },
	settings: unknown,
	series: readonly SeriesRow[],
	opts: { canRun: boolean; hasRun: boolean }
) {
	const { missing } = runBlockers(model, series);
	const s = settings && typeof settings === 'object' ? (settings as Parameters<typeof unitsOnCatchmentRain>[1]) : null;
	const onCatchmentRain = unitsOnCatchmentRain(model.nodes, s, series);
	const notes: string[] = [];
	if (onCatchmentRain.length) {
		const named = onCatchmentRain.slice(0, MAX_NAMED_UNITS).map((n) => n.name || 'unnamed');
		const more = onCatchmentRain.length - named.length;
		const one = onCatchmentRain.length === 1;
		notes.push(
			`${one ? '1 unit has' : `${onCatchmentRain.length} units have`} no rain of ${one ? 'its' : 'their'} own, so ${one ? 'its' : 'their'} share of the flow and of the EWR follows ${one ? 'its' : 'their'} area: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}. Their rain is set up in Model settings → Flow generation. A note, not a blocker.`
		);
	}
	return {
		canStart: missing.length === 0,
		// The Run model button's own words: "A run needs a network and a rainfall series."
		blockers: missing.map((what) => `A run needs ${what}.`),
		notes,
		forecastRun: hasForecastRain(series) ? 'available (there is forecast rain): Run forecast' : 'not available (no forecast rain)',
		youCanStartIt: opts.canRun
			? 'yes: Run model, in the section header'
			: 'no: starting a run needs an editor or owner of the project; you can read its runs',
		hasRun: opts.hasRun,
		notRequired: NOT_REQUIRED
	};
}

export const readinessTool: AssistantTool = {
	spec: specOf(
		TOOL_NAMES.runReadiness,
		"Whether the model can run now, from the same check the Run model button makes: `blockers` (what stops a run; empty when it can start), `notes` (things that only warn), whether a forecast run is available, whether the person asking may start a run, and `notRequired` (what a run does not need). Read the project as saved now. Use it for any question about running the model, what is missing or needed, or minimum requirements: answer from it, never from what you'd expect a model to need.",
		Args
	),
	label: 'Checking what a run needs',
	async run(ctx, args) {
		const a = parseArgs(Args, args);
		if (!a.ok) return a;
		try {
			const { role, runId } = await runFor(ctx);
			const { settings, model } = await loadSettingsAndModel(ctx.db, ctx.projectId);
			const { rows } = await ctx.db.query<SeriesRow>(
				`SELECT kind, site_node_id AS "siteNodeId", ${stationSql('time_series')} AS station FROM time_series WHERE project_id = $1`,
				[ctx.projectId]
			);
			return { ok: true, data: readinessView(model, settings, rows, { canRun: rank[role] >= rank.editor, hasRun: runId !== null }) };
		} catch (e) {
			return refusal(e);
		}
	}
};
