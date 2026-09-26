// The curtailment table (farms, other water users, EWR sites) over a window
// the reader picks (issue #44), recomputed in the browser from the run's
// stored daily series with the engine's own computeCurtailment. Nothing is
// re-run and nothing is saved: the project setting and the stored summary
// stay as they are. Pure; the component fetches the series (reportWindow.ts
// resolves the window).
//
// Two things are mirrored here rather than imported, because the engine does
// not export them (both belong in the engine: docs/followups.md § UI,
// "Reporting window picker"): the other water users' rows (network/curtailment.ts
// otherUserCurtailment) and each node's consumptive share k (run.ts
// consumptivePerSupplied, clamped as views/farmProjection.ts consumptiveShare
// clamps it). windowedCurtailment.test.ts checks the whole table against
// runModel's own over the run's window, so a drift fails there.
//
// One column can't be recomputed: the EWR site that set a farm's charge,
// which needs the engine's per-day binding site (not stored). Over any window
// other than the run's own it is left out (null) and `bindingKnown` says so.
import {
	computeCurtailment,
	M3_PER_DAY_PER_LS,
	type CurtailmentInput,
	type CurtailmentSummary,
	type CurtailmentUser,
	type ReportWindow
} from '@water-management/engine';

/** One EWR site's daily series (the engine's CurtailmentSiteInput, not exported by name). */
type CurtailmentSiteInput = NonNullable<Parameters<typeof computeCurtailment>[2]>[number];

/** One stored run series, as `GET …/runs/:runId/series` names it. */
export interface SeriesKey {
	nodeId: string | null;
	key: string;
}

/** Stored daily values (run_series.values: a non-finite day is null). */
export type Stored = ArrayLike<number | null>;

/** The node parameters k needs, from the run's model snapshot. */
export interface NodeParams {
	id: string;
	kind?: string;
	irrigationEfficiency?: number;
	lossReturnFraction?: number;
	userReturnPct?: number | null;
}

const FARM_KEYS = ['demand', 'supplied', 'ewr_charge', 'ewr_charge_irrigation'] as const;
const USER_KEYS = ['demand', 'supplied', 'return_flow', 'ewr_charge'] as const;
const SITE_KEYS = ['ewr_shortfall', 'ewr_charged', 'ewr_natural'] as const;

/** The outlet's series are the catchment's (node null); a gauge's are its own. */
const siteNode = (s: { nodeId: string; isOutlet: boolean }) => (s.isOutlet ? null : s.nodeId);

/**
 * Every series the recompute reads, from the run's stored table: four per
 * farm and per other user, three per EWR site. null when the run predates the
 * EWR charge (engine 0.17.0), which a window can't be recomputed without.
 */
export function curtailmentSeriesKeys(stored: CurtailmentSummary): SeriesKey[] | null {
	if (!stored.ewrAttribution || !stored.ewrSites) return null;
	return [
		...stored.farms.flatMap((f) => FARM_KEYS.map((key) => ({ nodeId: f.nodeId, key }))),
		...(stored.otherUsers ?? []).flatMap((u) => USER_KEYS.map((key) => ({ nodeId: u.nodeId, key }))),
		...stored.ewrSites.flatMap((s) => SITE_KEYS.map((key) => ({ nodeId: siteNode(s), key })))
	];
}

/** The keys the run has no stored series for (a run saved before one of them existed). */
export function missingSeries(keys: SeriesKey[], refs: readonly SeriesKey[]): SeriesKey[] {
	const have = new Set(refs.map((r) => `${r.nodeId ?? ''}|${r.key}`));
	return keys.filter((k) => !have.has(`${k.nodeId ?? ''}|${k.key}`));
}

/** k = 1 − β(1 − e) for a farm, 1 − r for another water user, clamped as runModel clamps them. */
export function consumptiveShare(n: NodeParams | undefined): number {
	if (!n) return 1;
	if (n.kind === 'user') {
		const r = n.userReturnPct ?? 0;
		return 1 - (Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0);
	}
	const e = n.irrigationEfficiency !== undefined && n.irrigationEfficiency > 0 && n.irrigationEfficiency <= 1 ? n.irrigationEfficiency : 1;
	const b = n.lossReturnFraction !== undefined && Number.isFinite(n.lossReturnFraction) ? Math.min(Math.max(n.lossReturnFraction, 0), 1) : 0;
	return 1 - b * (1 - e);
}

const nz = (x: number) => (x === 0 ? 0 : x);
const val = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function mean(a: Stored, from: number, to: number): number {
	let s = 0;
	for (let t = from; t <= to; t++) s += val(a[t]);
	return s / (to - from + 1);
}

/** Mirror of the engine's otherUserCurtailment (network/curtailment.ts, WP-1.33). */
function userRow(u: { nodeId: string; name: string; senior: boolean }, get: (key: string) => Stored, k: number, from: number, to: number): CurtailmentUser {
	const H = nz(mean(get('demand'), from, to));
	const I = nz(mean(get('supplied'), from, to));
	const R = nz(mean(get('ewr_charge'), from, to));
	const cut = u.senior || !(k > 0) ? 0 : nz(Math.max(R / k, -I));
	return {
		nodeId: u.nodeId,
		name: u.name,
		priority: u.senior ? 'senior' : 'junior',
		demandM3Day: H,
		suppliedM3Day: I,
		deficitM3Day: nz(I - H),
		fractionSupplied: H === 0 ? null : I / H,
		returnedM3Day: nz(mean(get('return_flow'), from, to)),
		ewrChargeM3Day: R,
		curtailed: !u.senior,
		supplyCutM3Day: cut,
		supplyCutLs: nz(cut / M3_PER_DAY_PER_LS),
		uncurtailedChargeM3Day: nz(Math.min(0, R - cut * k))
	};
}

export interface WindowedCurtailment {
	curtailment: CurtailmentSummary;
	/** False when the EWR site setting each farm's charge could not be worked out for this window (left null). */
	bindingKnown: boolean;
}

/**
 * The run's curtailment table over `window`: farms, other users and EWR
 * sites in the stored table's order, names as stored. `get` returns a stored
 * series (every key curtailmentSeriesKeys lists must be there); `nodes` is the
 * run's model snapshot, for k. Over the run's own window the stored binding
 * sites are kept.
 */
export function recomputeCurtailment(
	stored: CurtailmentSummary,
	get: (nodeId: string | null, key: string) => Stored,
	nodes: readonly NodeParams[],
	window: ReportWindow
): WindowedCurtailment {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const own = stored.reportStart === window.reportStart && stored.reportEnd === window.reportEnd;
	const dense = (nodeId: string | null, key: string): number[] => Array.from(get(nodeId, key), val);
	const farms: CurtailmentInput[] = stored.farms.map((f) => ({
		nodeId: f.nodeId,
		name: f.name,
		demand: dense(f.nodeId, 'demand'),
		supplied: dense(f.nodeId, 'supplied'),
		ewrCharge: dense(f.nodeId, 'ewr_charge'),
		ewrChargeIrrigation: dense(f.nodeId, 'ewr_charge_irrigation'),
		consumptivePerSupplied: consumptiveShare(byId.get(f.nodeId)),
		ewrBindingSiteId: own ? (f.ewrBindingSiteId ?? null) : null
	}));
	const sites: CurtailmentSiteInput[] = (stored.ewrSites ?? []).map((s) => ({
		nodeId: s.nodeId,
		name: s.name,
		isOutlet: s.isOutlet,
		farmCount: s.farmCount,
		shortfall: dense(siteNode(s), 'ewr_shortfall'),
		charged: dense(siteNode(s), 'ewr_charged'),
		natural: dense(siteNode(s), 'ewr_natural')
	}));
	const curtailment = computeCurtailment(farms, window, sites);
	if (stored.otherUsers) {
		curtailment.otherUsers = stored.otherUsers.map((u) =>
			userRow({ nodeId: u.nodeId, name: u.name, senior: u.priority === 'senior' }, (key) => get(u.nodeId, key), consumptiveShare(byId.get(u.nodeId) ?? { id: u.nodeId, kind: 'user' }), window.from, window.to)
		);
	}
	return { curtailment, bindingKnown: own || !curtailment.farms.some((f) => f.ewrShortfallM3Day < 0) };
}
