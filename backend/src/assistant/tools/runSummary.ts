// get_run_summary (issue #610): a run's headline figures, warnings,
// calibration statistics, plausibility checks and data-quality checks, cut to
// what the model needs to reason about. Read through runs/read.ts readRun,
// so a viewer kept from each registered volume gets the redacted summary
// (redactRunAllocations: verdicts only on a cap or full-allocation run).
// Neither the run's label, its notes nor who made it are sent: free text and
// names can be personal information.
import type { RunSummary } from '@water-management/engine';
import { z } from 'zod';
import { readRun } from '../../runs/read.js';
import { TOOL_NAMES, type AssistantTool } from '../types.js';
import { compact, fail, NO_RUN, parseArgs, refusal, runFor, specOf } from './common.js';

export const SUMMARY_SECTIONS = ['catchment', 'warnings', 'calibration', 'plausibility', 'dataQuality', 'allocations', 'waterBalance'] as const;
type Section = (typeof SUMMARY_SECTIONS)[number];
const DEFAULT_SECTIONS: readonly Section[] = ['catchment', 'warnings', 'calibration', 'plausibility', 'dataQuality'];

const Args = z
	.object({
		sections: z
			.array(z.enum(SUMMARY_SECTIONS))
			.max(SUMMARY_SECTIONS.length)
			.optional()
			.describe(`Which parts of the summary to return (default: ${DEFAULT_SECTIONS.join(', ')})`)
	})
	.strict();

/** Warnings kept; a run can carry hundreds of near-identical ones. */
export const MAX_WARNINGS = 30;

/** The summary's parts, cut down. Pure, for the unit tests. */
export function trimSummary(summary: RunSummary, sections: readonly Section[]): Record<string, unknown> {
	const s = summary as RunSummary & Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const part of sections) {
		switch (part) {
			case 'catchment':
				out.catchment = compact(s.catchment, { maxDepth: 3, maxItems: 10 });
				break;
			case 'warnings': {
				const w = s.warnings ?? [];
				out.warnings = w.slice(0, MAX_WARNINGS).map((x) => compact(x));
				if (w.length > MAX_WARNINGS) out.warningsNotShown = w.length - MAX_WARNINGS;
				break;
			}
			case 'calibration':
				// The scores and their window; the annual volumes as the first few years, the WR2012 table in full (five rows).
				out.calibration = s.calibration ? compact(s.calibration, { maxItems: 8, maxDepth: 3 }) : null;
				break;
			case 'plausibility':
				out.plausibility = s.plausibility ? compact(s.plausibility, { maxItems: 6, maxDepth: 4 }) : null;
				break;
			case 'dataQuality':
				out.dataQuality = s.dataQuality ? compact(s.dataQuality, { maxItems: 15, maxDepth: 4 }) : null;
				break;
			case 'allocations':
				out.allocations = s.allocations ? compact(s.allocations, { maxItems: 10, maxDepth: 4 }) : null;
				break;
			case 'waterBalance':
				out.waterBalance = s.waterBalance ? compact(s.waterBalance, { maxItems: 6, maxDepth: 4 }) : null;
				break;
		}
	}
	// The summary fields the API left out for this caller (#523 I).
	if (s.withheld?.length) out.withheld = s.withheld;
	return out;
}

export const runSummaryTool: AssistantTool = {
	spec: specOf(
		TOOL_NAMES.runSummary,
		"The run's summary: the catchment's headline flows and EWR days, the run's warnings, the calibration statistics (NSE, KGE, PBIAS … at the outlet or the calibration site), the plausibility checks (including checks 1 and 4 at inner gauges) and the input data-quality checks. Uses the conversation's run, else the latest.",
		Args
	),
	label: 'Reading the run summary',
	async run(ctx, args) {
		const a = parseArgs(Args, args);
		if (!a.ok) return a;
		try {
			const { role, runId } = await runFor(ctx);
			if (!runId) return fail(NO_RUN);
			const { run, withheldSeries } = await readRun(ctx.db, ctx.projectId, role, runId);
			return {
				ok: true,
				data: {
					run: {
						id: run.id,
						startDate: run.startDate,
						endDate: run.endDate,
						engineVersion: run.engineVersion,
						runoffModel: run.runoffModel,
						trigger: run.trigger,
						fromScenario: run.fromScenario,
						createdAt: run.createdAt
					},
					...trimSummary(run.summary, a.value.sections ?? DEFAULT_SECTIONS),
					...(withheldSeries.length ? { withheldSeries: withheldSeries.length } : {})
				}
			};
		} catch (e) {
			return refusal(e);
		}
	}
};
