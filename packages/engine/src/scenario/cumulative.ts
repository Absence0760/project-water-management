// Cumulative impact (roadmap WP-3.11, docs/scenarios.md § Cumulative impact):
// the baseline, each scenario alone and all of them together, read from the
// runs' summaries into one table. The **interaction** is the combined change
// less the sum of the single changes: what the applications do together that
// adding up their separate effects misses (two abstractions that each leave
// the Reserve just met can fail it together). Pure: no I/O, no model run.
import type { RunSummary } from '../project';

/** The measures the table compares (docs/scenarios.md § Cumulative impact). */
export type CumulativeMetric =
	/** Days the EWR site's flow is below its requirement over the reporting window (curtailment.ewrSites). */
	| 'ewr_days_not_met'
	/** The site's mean EWR shortfall over the reporting window, m³/day, as a positive volume. */
	| 'ewr_shortfall'
	/** Months the site's Reserve rule table is met (ewrAssurance.overall.met). */
	| 'reserve_months_met'
	/** The Reserve's deficit over the months not met, m³ (ewrAssurance.overall.deficitM3). */
	| 'reserve_deficit'
	/** Mean simulated flow at the outlet, m³/day: the water left downstream. */
	| 'outlet_flow'
	/** Mean supplied to the baseline's farms and other water users together, m³/day. */
	| 'existing_supplied'
	/** Σ supplied ÷ Σ demand over the baseline's farms and other water users (0–1). */
	| 'existing_reliability';

export const CUMULATIVE_METRIC_LABEL: Record<CumulativeMetric, string> = {
	ewr_days_not_met: 'Days the EWR is not met',
	ewr_shortfall: 'Mean EWR shortfall',
	reserve_months_met: 'Reserve months met',
	reserve_deficit: 'Reserve deficit',
	outlet_flow: 'Mean flow at the outlet',
	existing_supplied: 'Supplied to existing users',
	existing_reliability: 'Existing users’ share of demand met'
};

export const CUMULATIVE_METRIC_UNIT: Record<CumulativeMetric, string> = {
	ewr_days_not_met: 'days',
	ewr_shortfall: 'm³/day',
	reserve_months_met: 'months',
	reserve_deficit: 'm³',
	outlet_flow: 'm³/day',
	existing_supplied: 'm³/day',
	existing_reliability: 'fraction'
};

/** Whether a rise in the measure is worse for the river or its users. */
export const CUMULATIVE_HIGHER_IS_WORSE: Record<CumulativeMetric, boolean> = {
	ewr_days_not_met: true,
	ewr_shortfall: true,
	reserve_months_met: false,
	reserve_deficit: true,
	outlet_flow: false,
	existing_supplied: false,
	existing_reliability: false
};

/** One run's summary and window. */
export interface CumulativeRun {
	summary: RunSummary;
	startDate: string;
	endDate: string;
}

export interface CumulativeSingle extends CumulativeRun {
	id: string;
	name: string;
}

/** One measure at one site (or of the catchment), across the baseline, each scenario alone and all together. */
export interface CumulativeRow {
	metric: CumulativeMetric;
	/** The EWR site: null = the outlet, or a catchment-wide measure (`site` null too). */
	siteNodeId: string | null;
	/** The site's name; null for a catchment-wide measure. */
	site: string | null;
	isOutlet: boolean;
	unit: string;
	higherIsWorse: boolean;
	baseline: number | null;
	/** Each scenario alone, in the order given. */
	singles: (number | null)[];
	combined: number | null;
	/** Each single − baseline. */
	singleChanges: (number | null)[];
	/** Σ of the single changes; null when any is null. */
	sumOfSingles: number | null;
	/** combined − baseline. */
	combinedChange: number | null;
	/** combinedChange − sumOfSingles: what the scenarios do together beyond the sum of their separate effects. */
	interaction: number | null;
}

export interface CumulativeReport {
	scenarios: { id: string; name: string }[];
	rows: CumulativeRow[];
	/**
	 * What limits the comparison: a run over a different window than the
	 * baseline's (a scenario that moved the simulation dates), whose day
	 * counts then don't line up.
	 */
	warnings: string[];
}

type Getter = (s: RunSummary) => number | null;
interface Measure {
	metric: CumulativeMetric;
	siteNodeId: string | null;
	site: string | null;
	isOutlet: boolean;
	get: Getter;
}

const fin = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The EWR sites across every run (the outlet first, then gauges in id order), keyed outlet / node id. */
function ewrMeasures(runs: readonly RunSummary[]): Measure[] {
	const sites = new Map<string, { name: string; isOutlet: boolean }>();
	for (const r of runs) for (const s of r.curtailment?.ewrSites ?? []) if (!sites.has(s.isOutlet ? 'outlet' : s.nodeId)) sites.set(s.isOutlet ? 'outlet' : s.nodeId, { name: s.name, isOutlet: s.isOutlet });
	const keys = [...sites.keys()].sort((a, b) => (a === 'outlet' ? -1 : b === 'outlet' ? 1 : a.localeCompare(b)));
	const find = (s: RunSummary, key: string) => s.curtailment?.ewrSites?.find((x) => (x.isOutlet ? 'outlet' : x.nodeId) === key);
	return keys.flatMap((key) => {
		const { name, isOutlet } = sites.get(key)!;
		const siteNodeId = key === 'outlet' ? null : key;
		return [
			{ metric: 'ewr_days_not_met' as const, siteNodeId, site: name, isOutlet, get: (s: RunSummary) => fin(find(s, key)?.daysNotMet) },
			// Stored ≤ 0; read as a positive volume so "higher is worse" holds.
			{ metric: 'ewr_shortfall' as const, siteNodeId, site: name, isOutlet, get: (s: RunSummary) => { const v = fin(find(s, key)?.shortfallM3Day); return v === null ? null : Math.abs(v); } }
		];
	});
}

/** The Reserve rule-table sites across every run, outlet first. */
function reserveMeasures(runs: readonly RunSummary[]): Measure[] {
	const sites = new Map<string, { name: string; isOutlet: boolean }>();
	const keyOf = (s: { isOutlet: boolean; nodeId: string | null }) => (s.isOutlet || s.nodeId === null ? 'outlet' : s.nodeId);
	for (const r of runs) for (const s of r.ewrAssurance ?? []) if (!sites.has(keyOf(s))) sites.set(keyOf(s), { name: s.name, isOutlet: s.isOutlet || s.nodeId === null });
	const keys = [...sites.keys()].sort((a, b) => (a === 'outlet' ? -1 : b === 'outlet' ? 1 : a.localeCompare(b)));
	const find = (s: RunSummary, key: string) => s.ewrAssurance?.find((x) => keyOf(x) === key);
	return keys.flatMap((key) => {
		const { name, isOutlet } = sites.get(key)!;
		const siteNodeId = key === 'outlet' ? null : key;
		return [
			{ metric: 'reserve_months_met' as const, siteNodeId, site: name, isOutlet, get: (s: RunSummary) => fin(find(s, key)?.overall.met) },
			{ metric: 'reserve_deficit' as const, siteNodeId, site: name, isOutlet, get: (s: RunSummary) => fin(find(s, key)?.overall.deficitM3) }
		];
	});
}

/** The baseline's farms and other users, supplied and demanded, summed in id order (so the sum doesn't depend on list order). */
function existing(s: RunSummary, ids: readonly string[]): { supplied: number; demand: number } | null {
	const byId = new Map<string, { avgSuppliedM3Day: number; avgDemandM3Day: number }>();
	for (const f of s.farms) byId.set(f.nodeId, f);
	for (const u of s.users ?? []) byId.set(u.nodeId, u);
	let supplied = 0;
	let demand = 0;
	for (const id of ids) {
		const x = byId.get(id);
		// A unit a scenario removed supplies nothing: its use is gone from the river, not missing data.
		if (!x) continue;
		supplied += x.avgSuppliedM3Day;
		demand += x.avgDemandM3Day;
	}
	return Number.isFinite(supplied) && Number.isFinite(demand) ? { supplied, demand } : null;
}

/**
 * The cumulative table for `baseline`, each of `singles` alone and
 * `combined` (every single's ops together, combineScenarios). Each row is
 * one measure at one site or of the catchment; changes are against the
 * baseline, and the interaction is the combined change less the sum of the
 * single changes (0 when the effects simply add up).
 *
 * Existing users are the baseline's farms and other water users: a unit a
 * scenario adds is its own proposal, not an existing user, and is left out
 * of every column so the columns compare like with like.
 */
export function cumulativeImpact(baseline: CumulativeRun, singles: readonly CumulativeSingle[], combined: CumulativeRun): CumulativeReport {
	const all = [baseline, ...singles, combined];
	const summaries = all.map((r) => r.summary);
	const existingIds = [...baseline.summary.farms.map((f) => f.nodeId), ...(baseline.summary.users ?? []).map((u) => u.nodeId)].sort();
	const measures: Measure[] = [
		...ewrMeasures(summaries),
		...reserveMeasures(summaries),
		{ metric: 'outlet_flow', siteNodeId: null, site: null, isOutlet: false, get: (s) => fin(s.catchment.meanSimulatedOutflowM3Day) },
		{ metric: 'existing_supplied', siteNodeId: null, site: null, isOutlet: false, get: (s) => existing(s, existingIds)?.supplied ?? null },
		{
			metric: 'existing_reliability',
			siteNodeId: null,
			site: null,
			isOutlet: false,
			get: (s) => {
				const e = existing(s, existingIds);
				return e && e.demand > 0 ? e.supplied / e.demand : null;
			}
		}
	];
	const rows = measures.map((m): CumulativeRow => {
		const b = m.get(baseline.summary);
		const one = singles.map((x) => m.get(x.summary));
		const c = m.get(combined.summary);
		const change = (v: number | null) => (v === null || b === null ? null : v - b);
		const singleChanges = one.map(change);
		const sumOfSingles = singleChanges.some((v) => v === null) ? null : singleChanges.reduce<number>((t, v) => t + v!, 0);
		const combinedChange = change(c);
		return {
			metric: m.metric,
			siteNodeId: m.siteNodeId,
			site: m.site,
			isOutlet: m.isOutlet,
			unit: CUMULATIVE_METRIC_UNIT[m.metric],
			higherIsWorse: CUMULATIVE_HIGHER_IS_WORSE[m.metric],
			baseline: b,
			singles: one,
			combined: c,
			singleChanges,
			sumOfSingles,
			combinedChange,
			interaction: combinedChange === null || sumOfSingles === null ? null : combinedChange - sumOfSingles
		};
	});
	const warnings: string[] = [];
	const window = (r: CumulativeRun) => `${r.startDate} to ${r.endDate}`;
	singles.forEach((s) => {
		if (s.startDate !== baseline.startDate || s.endDate !== baseline.endDate) warnings.push(`"${s.name}" ran over ${window(s)}, the baseline over ${window(baseline)}: its day and month counts don't line up with the baseline's.`);
	});
	if (combined.startDate !== baseline.startDate || combined.endDate !== baseline.endDate)
		warnings.push(`The combined run ran over ${window(combined)}, the baseline over ${window(baseline)}: its day and month counts don't line up with the baseline's.`);
	return { scenarios: singles.map((s) => ({ id: s.id, name: s.name })), rows, warnings };
}
