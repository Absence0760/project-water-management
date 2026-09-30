// River & reserve → the flow vs reserve chart (FlowVsReserve.svelte): the days the outflow was below the
// reserve, as date ranges to shade, and the chart's time windows.
import { fromEpochDay, toEpochDay } from '@water-management/engine';

/** The chart's time windows (LineChart `windows`); `days: null` is the whole run. It opens on a year. */
export const FLOW_WINDOWS = [
	{ label: '30 days', days: 30 },
	{ label: '1 year', days: 365 },
	{ label: 'All', days: null }
] as const;
export const FLOW_OPEN_DAYS = 365;

/**
 * The runs of consecutive days the reserve wasn't met, from the run's
 * `ewr_shortfall` series (negative on a day the outflow fell short of the
 * pragmatic EWR, 0 otherwise: the engine's own test, so the shading matches
 * the "EWR not met" count). Inclusive date ranges; a gap (null) ends a run.
 */
export function belowReserve(shortfall: { startDate: string; values: readonly (number | null)[] }): { start: string; end: string }[] {
	const out: { start: string; end: string }[] = [];
	const day0 = toEpochDay(shortfall.startDate);
	let from = -1;
	const v = shortfall.values;
	for (let i = 0; i <= v.length; i++) {
		const x = i < v.length ? v[i] : null;
		const below = x != null && Number.isFinite(x) && x < 0;
		if (below && from < 0) from = i;
		else if (!below && from >= 0) {
			out.push({ start: fromEpochDay(day0 + from), end: fromEpochDay(day0 + i - 1) });
			from = -1;
		}
	}
	return out;
}

/**
 * The run stored the outlet's Reserve rule requirement (`ewr_rule`, node
 * null), so the flow chart draws it beside the pragmatic EWR (flowSeries.ts
 * ewrChartSeries). Only the outlet's table has that series.
 */
export function hasRuleLine(refs: readonly { key: string; nodeId: string | null }[]): boolean {
	return refs.some((r) => r.key === 'ewr_rule' && r.nodeId === null);
}

/**
 * The flow chart's heading (and River & reserve's menu entry for it). It is
 * "Flow vs reserve" when the reserve it names is on the chart: the pragmatic
 * EWR without a rule table, or the rule requirement line when the outlet has
 * the table. With rule tables only at other sites (`ruleTable` without
 * `ruleLine`), the Reserve is judged there and the chart draws only the
 * pragmatic EWR, so it says so (issue #177). The shading is always the
 * pragmatic EWR's, and its caption says that.
 */
export function flowHeading(ruleTable: boolean, ruleLine: boolean): string {
	return ruleTable && !ruleLine ? 'Flow vs pragmatic EWR' : 'Flow vs reserve';
}
