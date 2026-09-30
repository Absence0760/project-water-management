// Two river measures of the licensing evidence report (issue #71, engine ≥
// 1.33.0, docs/model.md §2.9e): days the river stops at the outlet, and days
// a farm or water user is served in full while an EWR site below it fails.
// New outputs only: both are read off the run's own daily series, so no
// result the engine had before changes.
import { demandMet } from '../network/reliability';

/**
 * A day counts as a no-flow day when the simulated outflow at the outlet is
 * below 1 L/s (0.001 m³/s = 86.4 m³/day). DWS publishes gauged flow to three
 * decimals of m³/s, so this is the flow a gauge would record as 0.000: the
 * zero-flow reading of a benchmark report, not a model-resolution artefact.
 */
export const NO_FLOW_M3_DAY = 86.4;

/** No-flow days at the outlet over the run (RunSummary.catchment.noFlow). */
export interface NoFlowSummary {
	/** The threshold: a day below it is a no-flow day, m³/day. */
	thresholdM3Day: number;
	/** Days of the run below the threshold. */
	days: number;
	/** Most consecutive no-flow days. */
	longestRun: number;
}

/** No-flow days in `flow` (m³/day) over its first `days` days. */
export function noFlowDays(flow: ArrayLike<number>, days: number = flow.length): NoFlowSummary {
	let n = 0;
	let run = 0;
	let longest = 0;
	for (let t = 0; t < days; t++) {
		const q = flow[t] ?? 0;
		if (q < NO_FLOW_M3_DAY) {
			n++;
			run++;
			if (run > longest) longest = run;
		} else run = 0;
	}
	return { thresholdM3Day: NO_FLOW_M3_DAY, days: n, longestRun: longest };
}

/** One farm or water user upstream of an EWR site. */
export interface ServedUnit {
	nodeId: string;
	name: string;
	kind: 'farm' | 'user';
	/** Days its demand (> 0) was fully met while the site's EWR was not. */
	days: number;
}

/** One EWR site (outlet first, then gauges by node id, as the EWR charge lists them). */
export interface ServedWhileEwrFailsSite {
	/** null = the outlet. */
	nodeId: string | null;
	name: string;
	/** What the site's daily EWR is: the pragmatic EWR, or the Reserve rule table's day (settings.ewrChargeSource). */
	basis: 'pragmatic' | 'ruleTable';
	/** Days of the run the site's EWR was not met. */
	daysNotMet: number;
	/** Every farm and water user upstream of the site with demand, canonical order. */
	units: ServedUnit[];
}

/**
 * Per EWR site, the days each farm or water user upstream got its whole
 * demand while the site's EWR (the daily requirement its EWR charge follows)
 * was not met: the environmentalist's "the river fails while users are served
 * in full". A unit without demand on a day is neither served nor not.
 */
export function servedWhileEwrFails(r: {
	days: number;
	sites: readonly { nodeId: string | null; name: string; ruleTable: boolean; shortfall: ArrayLike<number>; units: ArrayLike<number> }[];
	nodes: readonly { id: string; name: string; kind: string }[];
	demand: readonly ArrayLike<number>[];
	supplied: readonly ArrayLike<number>[];
}): ServedWhileEwrFailsSite[] {
	return r.sites.map((site) => {
		const failing: number[] = [];
		for (let t = 0; t < r.days; t++) if (site.shortfall[t]! < 0) failing.push(t);
		const units: ServedUnit[] = [];
		for (let k = 0; k < site.units.length; k++) {
			const i = site.units[k]!;
			const node = r.nodes[i]!;
			if (node.kind !== 'farm' && node.kind !== 'user') continue;
			const d = r.demand[i]!;
			const g = r.supplied[i]!;
			let any = false;
			for (let t = 0; t < r.days && !any; t++) any = d[t]! > 0;
			if (!any) continue;
			let n = 0;
			for (const t of failing) if (d[t]! > 0 && demandMet(d[t]!, g[t]!)) n++;
			units.push({ nodeId: node.id, name: node.name, kind: node.kind, days: n });
		}
		return { nodeId: site.nodeId, name: site.name, basis: site.ruleTable ? 'ruleTable' : 'pragmatic', daysNotMet: failing.length, units };
	});
}
