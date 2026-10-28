// get_series (issue #610): one stored series of a run, a node's or the
// catchment's, cut down to what fits a prompt: monthly or water-year means
// over the run (or a window of it), or a window of days with a cap. Read
// through runs/read.ts readSeries, which refuses a series worked out from a
// registered volume to a viewer kept from them (#523 I) before looking it up;
// the series a node has are listed from readRun, which leaves those out too.
import { fromEpochDay, isIsoDate, toEpochDay, waterYearOf } from '@water-management/engine';
import { z } from 'zod';
import { readRun, readSeries } from '../../runs/read.js';
import { TOOL_NAMES, type AssistantTool } from '../types.js';
import { fail, findNode, NO_RUN, NodeRef, parseArgs, refusal, round, runFor, specOf } from './common.js';

/** Days a daily window may hold. */
export const MAX_DAYS = 92;
/** Months a monthly answer may hold; a longer one keeps the latest. */
export const MAX_MONTHS = 120;

const IsoDate = z.string().refine((s) => isIsoDate(s), 'a date as YYYY-MM-DD');

const Args = z
	.object({
		node: NodeRef.optional().describe("The node (its id or name); leave it out for the catchment's own series (rain, natural flow, the runoff model's stores)"),
		key: z.string().trim().min(1).max(100).describe('The series key, e.g. outflow, natural_flow, inflow, dam_storage, observed_flow, observed_flow_check, runoff, rain_final'),
		resolution: z.enum(['monthly', 'water_year', 'daily']).default('monthly').describe(`'monthly' means (default; at most ${MAX_MONTHS} months, the latest), 'water_year' means (Oct–Sep), or 'daily' values (at most ${MAX_DAYS} days)`),
		from: IsoDate.optional().describe('First day of the window (YYYY-MM-DD); default the run’s first, or for daily the last days of the run'),
		to: IsoDate.optional().describe('Last day of the window (YYYY-MM-DD); default the run’s last, or for daily from + the day cap')
	})
	.strict();

export type Resolution = z.output<typeof Args>['resolution'];

const valid = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A series downsampled: its window, the mean, smallest and largest value over
 * it, the days without a value, and the points ([period, mean] for monthly and
 * water-year means, [date, value] for days). Pure, for the unit tests.
 */
export function downsample(startDate: string, values: readonly (number | null)[], resolution: Resolution, from?: string, to?: string) {
	const d0 = toEpochDay(startDate);
	const last = values.length - 1;
	let i0 = from ? Math.max(0, toEpochDay(from) - d0) : 0;
	let i1 = to ? Math.min(last, toEpochDay(to) - d0) : last;
	let note: string | undefined;
	if (resolution === 'daily') {
		if (!from && !to) i0 = Math.max(0, i1 - MAX_DAYS + 1);
		else if (!to) i1 = Math.min(last, i0 + MAX_DAYS - 1);
		else if (!from) i0 = Math.max(0, i1 - MAX_DAYS + 1);
		if (i1 - i0 + 1 > MAX_DAYS) {
			note = `only the first ${MAX_DAYS} days of the window; ask again from ${fromEpochDay(d0 + i0 + MAX_DAYS)} for the rest`;
			i1 = i0 + MAX_DAYS - 1;
		}
	}
	if (i0 > i1 || values.length === 0) return { from: from ?? null, to: to ?? null, points: [], note: 'the window is outside the run' };
	let sum = 0;
	let n = 0;
	let min = Infinity;
	let max = -Infinity;
	const groups = new Map<string, { sum: number; n: number }>();
	const points: [string, number | null][] = [];
	for (let i = i0; i <= i1; i++) {
		const v = values[i];
		const day = d0 + i;
		if (resolution === 'daily') points.push([fromEpochDay(day), valid(v) ? round(v) : null]);
		const label = resolution === 'monthly' ? fromEpochDay(day).slice(0, 7) : resolution === 'water_year' ? `${waterYearOf(day)}/${String((waterYearOf(day) + 1) % 100).padStart(2, '0')}` : '';
		const g = resolution === 'daily' ? null : (groups.get(label) ?? groups.set(label, { sum: 0, n: 0 }).get(label)!);
		if (!valid(v)) continue;
		sum += v;
		n++;
		if (v < min) min = v;
		if (v > max) max = v;
		if (g) {
			g.sum += v;
			g.n++;
		}
	}
	let grouped = [...groups].map(([label, g]): [string, number | null] => [label, g.n ? round(g.sum / g.n) : null]);
	if (resolution === 'monthly' && grouped.length > MAX_MONTHS) {
		note = `only the latest ${MAX_MONTHS} of ${grouped.length} months; ask for a window (from, to) or water_year means for the rest`;
		grouped = grouped.slice(-MAX_MONTHS);
	}
	return {
		from: fromEpochDay(d0 + i0),
		to: fromEpochDay(d0 + i1),
		mean: n ? round(sum / n) : null,
		min: n ? round(min) : null,
		max: n ? round(max) : null,
		missingDays: i1 - i0 + 1 - n,
		points: resolution === 'daily' ? points : grouped,
		...(note ? { note } : {})
	};
}

export const seriesTool: AssistantTool = {
	spec: specOf(
		TOOL_NAMES.series,
		"One series the run stored, at a node or for the catchment, downsampled: monthly means (default), water-year means, or a window of days. A node's keys include outflow (what leaves it), inflow, runoff, dam_storage, supplied, demand; a gauge's own flow record is observed_flow_check (observed_flow at the calibration site). Flows are m³/day unless the unit says otherwise. Unknown keys are answered with the node's list.",
		Args
	),
	label: 'Reading a series',
	async run(ctx, args) {
		const a = parseArgs(Args, args);
		if (!a.ok) return a;
		const { node: ref, key, resolution, from, to } = a.value;
		if (from && to && from > to) return fail('from is after to');
		try {
			const { role, runId } = await runFor(ctx);
			if (!runId) return fail(NO_RUN);
			const { run, series, withheldSeries } = await readRun(ctx.db, ctx.projectId, role, runId);
			const node = ref ? findNode(run.model?.nodes ?? [], ref) : null;
			if (ref && !node) return fail(`no node "${ref}" in this run's network (get_network lists them)`);
			const nodeId = node?.id ?? null;
			const meta = series.find((s) => s.nodeId === nodeId && s.key === key);
			if (!meta && !withheldSeries.some((s) => s.nodeId === nodeId && s.key === key)) {
				const keys = series.filter((s) => s.nodeId === nodeId).map((s) => s.key);
				return fail(`${node ? `${node.name} has` : 'the catchment has'} no series "${key}" in this run; it has: ${keys.join(', ') || 'none'}`);
			}
			// A withheld one is refused here, by readSeries, with the route's reason.
			const { startDate, values } = await readSeries(ctx.db, ctx.projectId, role, runId, key, nodeId);
			return {
				ok: true,
				data: {
					runId,
					node: node ? { id: node.id, name: node.name, kind: node.kind } : 'catchment',
					key,
					label: meta?.label ?? key,
					unit: meta?.unit ?? null,
					resolution,
					...downsample(startDate, values, resolution, from, to)
				}
			};
		} catch (e) {
			return refusal(e);
		}
	}
};
