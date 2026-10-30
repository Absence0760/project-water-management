// get_gauge_fit (issue #610): how well the run's simulated flow matches the
// record at one gauge. A run scores every ticked calibration location (engine
// 1.110.0, issue #659): the headline's statistics are summary.calibration, every
// other location's (the outlet's when it is ticked and not the headline) one of
// summary.calibrationZones, and those are answered from the summary. At any
// other gauge with a record of its own the run stores the record
// (observed_flow_check, m³/day, NaN on a day without a reading, engine ≥
// 1.90.0) beside the node's outflow but no statistics, so they are worked out
// here with the engine's calibrationStats over that gauge's own window and
// exclusions when it has a row (an unticked location), else the headline
// location's, as the run scores a location. Both series are read through
// runs/read.ts readSeries, so the withholding applies.
import {
	calibrationStats,
	CHECK_GAUGE_FLOW_KEY,
	exclusionRanges,
	headlineCalibrationSettings,
	resolveRunSettings,
	type CalibrationStats,
	type CalibrationWindow,
	type ModelInput
} from '@water-management/engine';
import { z } from 'zod';
import { readRun, readSeries } from '../../runs/read.js';
import { beforeForecastDays } from './series.js';
import { TOOL_NAMES, type AssistantTool } from '../types.js';
import { compact, fail, findNode, NO_RUN, NodeRef, parseArgs, refusal, runFor, specOf } from './common.js';

const SEC_PER_DAY = 86_400;

const Args = z.object({ node: NodeRef.describe('The gauge: its id or its name') }).strict();

/**
 * The statistics at a gauge from the run's outflow there (m³/day) and its
 * record (m³/day, NaN or null = no reading): calibrationStats with the record
 * in m³/s, as the engine scores its calibration site. Pure, for the unit tests.
 */
export function gaugeFitStats(outflowM3Day: readonly number[], recordM3Day: readonly (number | null)[], window: CalibrationWindow): CalibrationStats {
	const observedM3s = recordM3Day.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v / SEC_PER_DAY : null));
	return calibrationStats(outflowM3Day, observedM3s, window);
}

/** The scores a model reads, the annual volumes as the first few years. */
const trimStats = (s: CalibrationStats) => compact(s, { maxItems: 8, maxDepth: 3 });

export const gaugeFitTool: AssistantTool = {
	spec: specOf(
		TOOL_NAMES.gaugeFit,
		"The fit of the run's simulated flow to the observed record at one gauge: NSE, KGE (with r, α, β), PBIAS, R², log-NSE, RMSE, means and annual volumes, over that calibration location's window and exclusions. A ticked calibration location's come from the run's summary (the headline location's are the run's calibration statistics); another gauge's are computed from its outflow and its own record, over its own window when it has one, else the headline location's.",
		Args
	),
	label: "Checking a gauge's fit",
	async run(ctx, args) {
		const a = parseArgs(Args, args);
		if (!a.ok) return a;
		try {
			const { role, runId } = await runFor(ctx);
			if (!runId) return fail(NO_RUN);
			const { run } = await readRun(ctx.db, ctx.projectId, role, runId);
			const node = findNode(run.model?.nodes ?? [], a.value.node);
			if (!node) return fail(`no node "${a.value.node}" in this run's network (get_network lists them)`);
			if (node.kind !== 'gauge') return fail(`${node.name} is not a gauge`);
			const cal = run.summary?.calibration ?? null;
			const isOutlet = node.downstreamNodeId === null;
			// The headline location: the gauge its statistics name, else the outlet.
			if (cal && (cal.siteNodeId ? cal.siteNodeId === node.id : isOutlet)) {
				return { ok: true, data: { runId, gauge: { id: node.id, name: node.name }, source: 'the run’s calibration statistics (the headline location)', stats: trimStats(cal) } };
			}
			// Every other ticked location the run scored (engine 1.110.0; the outlet's under its node's id).
			const other = (run.summary?.calibrationZones ?? []).find((z) => z.siteNodeId === node.id);
			if (other) return { ok: true, data: { runId, gauge: { id: node.id, name: node.name }, source: 'the run’s statistics at this calibration location', stats: trimStats(other) } };
			if (isOutlet) return fail('the run computed no calibration statistics at the outlet: it has no observed flow record there (see the run summary’s warnings)');
			let record: (number | null)[];
			try {
				record = (await readSeries(ctx.db, ctx.projectId, role, runId, CHECK_GAUGE_FLOW_KEY, node.id)).values;
			} catch (e) {
				if ((e as { status?: number }).status === 404)
					return fail(`${node.name} has no flow record of its own in this run (a gauge's record is stored from engine 1.90.0 on; attach one under Data, then run again)`);
				throw e;
			}
			const outflow = await readSeries(ctx.db, ctx.projectId, role, runId, 'outflow', node.id);
			// The gauge's own window and exclusions when it has a row (an unticked location), else the headline location's; a run's
			// settings from before engine 1.110.0 read in the locations' shape.
			const nodes = (run.model?.nodes ?? []) as ModelInput['model']['nodes'];
			const located = resolveRunSettings((run.settings ?? {}) as ModelInput['settings'], [], nodes);
			const row = (located.calibrationZones ?? []).find((z) => z.nodeId === node.id);
			const settings = row ?? headlineCalibrationSettings(located, nodes);
			// A forecast run's forecast days are no fit: only the days before them count.
			const stats = gaugeFitStats(beforeForecastDays(outflow.startDate, outflow.values, run.summary.forecast?.from), record, {
				startDate: outflow.startDate,
				windowStart: settings.calibrationStart ?? null,
				windowEnd: settings.calibrationEnd ?? null,
				exclusions: exclusionRanges(settings.calibrationExclusions)
			});
			return { ok: true, data: { runId, gauge: { id: node.id, name: node.name }, source: 'computed from the gauge’s outflow and its own record', stats: trimStats(stats) } };
		} catch (e) {
			return refusal(e);
		}
	}
};
