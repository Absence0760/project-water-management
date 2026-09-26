// The farmer projection of a published run (roadmap WP-2.3, design
// docs/design/farmer-view.md §2–§4, asks E1, E4, E5, E7): everything a
// farmer's page shows about their farm, computed once from a saved run's daily
// series when the run is published and stored as publication_farm.view.
// Pure: the caller hands in the run's series; nothing here reads a database.
//
// Every figure is over the *season*, 1 October (the water year's start) to
// the run's last day (`dataUntil`), or over the 30 days to it. That includes
// the curtailment row: computeCurtailment runs over the season itself (E5),
// never over the modeller's settings.reportStart … reportEnd, which can be
// any period, even last year (design §11 F2).
//
// One thing a run doesn't store is which EWR site bound a farm's charge each
// day (attribution.ts `binding`), which the season's "binding site" needs. It
// is recomputed here with the engine's own attributeEwrShortfall on the
// run's stored flows (see reattribute below): exact, except that a transfer
// network with a loop is cut to a tree first (documented there). The charges
// themselves always come from the stored series, never from the recompute.
//
// The same recompute over any window, other water users included, is
// curtailmentOverWindow (below): the Runs tab's reporting-window picker
// (issue #44) and the season here share it.
import { fromEpochDay, monthOfEpochDay, toEpochDay } from '../calendar';
import { attributeEwrShortfall, bindingSite, type AttributionResult } from '../network/attribution';
import {
	computeCurtailment,
	DEMAND_PCT_FLOOR_M3_DAY,
	otherUserCurtailment,
	type CurtailmentInput,
	type CurtailmentSiteInput,
	type CurtailmentUserInput,
	type ReportWindow
} from '../network/curtailment';
import { buildTopology, canonicalOrder } from '../network/topology';
import type { CropArea, CurtailmentFarm, CurtailmentSummary, NetworkNode, Transfer } from '../project';
import { modelFarmEfficiency, type CropEfficiencyInput } from '../demand';
import { modelBand, type DamState, type FarmProjection, type MonthTotals, type RiverSite, type SeasonTotals, type WindowTotals } from './farmView';

/** A stored daily series: run_series.values, where a missing (non-finite) day is null. */
export type StoredValues = ArrayLike<number | null>;

/**
 * Days older than this count as stale on the farm page (the same 7 days as
 * the workspace's series/freshness.ts STALE_DAYS). FarmView.stale.
 */
export const FARM_VIEW_STALE_DAYS = 7;

/**
 * The daily series a farmer may read of their own farm in the published run
 * (design §10.3): no flow series (inflow_upstream is the upstream
 * neighbour's outflow when there is one farm above), no catchment series.
 * The run_series farmer policy (022_publication.sql) holds the same list.
 */
export const FARMER_SERIES_KEYS = ['demand', 'supplied', 'deficit', 'dam_storage', 'spill', 'transfer'] as const;

/** A deficit or spill below this (m³/day, under a millilitre) is float noise, not a short or a spilling day. */
const NOISE_M3 = 1e-6;

/** The run's series a projection reads, by node kind (null node = catchment). */
export const PROJECTION_SERIES = {
	farm: ['demand', 'supplied', 'deficit', 'dam_storage', 'spill', 'transfer', 'inflow_upstream', 'runoff', 'outflow', 'ewr_charge', 'ewr_charge_irrigation'],
	user: ['supplied', 'inflow_upstream', 'outflow'],
	gauge: ['inflow_upstream', 'outflow', 'ewr_shortfall', 'ewr_charged', 'ewr_natural'],
	catchment: ['ewr_shortfall', 'ewr_charged', 'ewr_natural']
} as const;

/** A saved run, as the projection sees it. */
export interface ProjectionRun {
	/** The run's first and last day (ISO). */
	startDate: string;
	endDate: string;
	/**
	 * The last day with observed input data (ISO), when the run goes on past it
	 * on forecast rain (rain_forecast_mm): every window ends here, so forecast
	 * days never count as water received (WP-2.12 adds them as their own block).
	 * Clamped to the run; absent = endDate.
	 */
	dataUntil?: string;
	/** The run's own model snapshot (model_run.inputs.model), not the project's current model. */
	nodes: readonly NetworkNode[];
	transfers: readonly Transfer[];
	/**
	 * The snapshot's crops and crop areas and the run's monthly A-pan
	 * (settings.apanMm): a farm whose crops carry their own irrigation
	 * efficiency runs on a combined one (engine ≥ 0.43.0, ../demand.ts
	 * farmIrrigationEfficiency), which its consumptive share follows. Absent
	 * = each farm's own irrigationEfficiency, right for any run whose crops
	 * carry none.
	 */
	crops?: readonly CropEfficiencyInput[];
	cropAreas?: readonly CropArea[];
	apanMm?: ArrayLike<unknown>;
	/** A stored series of the run (null node = catchment); undefined when the run has none. */
	series(nodeId: string | null, key: string): StoredValues | undefined;
}

/** The run lacks a series the projection needs (a run from before engine 0.17.0, say). */
export class ProjectionInputError extends Error {}

/** Sum, mean and last value of a daily series over a window. */
export interface WindowSummary {
	/** The window actually summarised, clamped to the series (ISO, inclusive). */
	from: string;
	to: string;
	days: number;
	sum: number;
	mean: number;
	/** The value on `to`; null for a missing day. */
	last: number | null;
}

const val = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * A daily series (index 0 = startDate) over from … to (ISO, inclusive),
 * clamped to the days the series covers; null when the window misses it
 * entirely. Missing days count as 0 in the sum and the mean (a run stores
 * none for the volumes summarised here).
 */
export function windowSummary(values: StoredValues, startDate: string, from: string, to: string): WindowSummary | null {
	const d0 = toEpochDay(startDate);
	const lo = Math.max(0, toEpochDay(from) - d0);
	const hi = Math.min(values.length - 1, toEpochDay(to) - d0);
	if (hi < lo) return null;
	let sum = 0;
	for (let t = lo; t <= hi; t++) sum += val(values[t]);
	const last = values[hi];
	return {
		from: fromEpochDay(d0 + lo),
		to: fromEpochDay(d0 + hi),
		days: hi - lo + 1,
		sum,
		mean: sum / (hi - lo + 1),
		last: typeof last === 'number' && Number.isFinite(last) ? last : null
	};
}

/** 1 October of the water year `iso` falls in. */
export function seasonStart(iso: string): string {
	const year = Number(iso.slice(0, 4));
	return `${Number(iso.slice(5, 7)) >= 10 ? year : year - 1}-10-01`;
}

/** The same calendar day a year earlier; 29 February becomes 28 February. */
export function yearBefore(iso: string): string {
	const y = Number(iso.slice(0, 4)) - 1;
	const md = iso.slice(5);
	return md === '02-29' ? `${y}-02-28` : `${y}-${md}`;
}

// ---------------------------------------------------------------------------
// The season's curtailment (E5)
// ---------------------------------------------------------------------------

/** One EWR site over the run, in the engine's order (the outlet first, then gauges by id). */
export interface SeasonSite {
	nodeId: string;
	name: string;
	isOutlet: boolean;
	/** Farms (and other users) whose outflow reaches the site. */
	upstream: ReadonlySet<string>;
	shortfall: Float64Array;
	charged: Float64Array;
	natural: Float64Array;
}

/** A run cut to the season, with the season's curtailment table. Shared by every farm's projection. */
export interface SeasonAnalysis {
	startDate: string;
	dataUntil: string;
	/** Day indices into the run (inclusive) and their dates. */
	season: { from: number; to: number; fromDate: string; toDate: string };
	last30: { from: number; to: number; fromDate: string; toDate: string };
	curtailment: CurtailmentSummary;
	sites: SeasonSite[];
	/** True when a loop in the transfer rules made the binding-site recompute approximate (reattribute). */
	bindingApproximate: boolean;
}

function need(run: ProjectionRun, nodeId: string | null, key: string, days: number): Float64Array {
	const v = run.series(nodeId, key);
	if (!v) throw new ProjectionInputError(`the run has no ${key} series${nodeId ? ` for node ${nodeId}` : ''}: run the model again to publish it`);
	if (v.length !== days) throw new ProjectionInputError(`the run's ${key} series has ${v.length} days, expected ${days}`);
	return Float64Array.from({ length: days }, (_, t) => val(v[t]));
}

/**
 * Per-rule transfer volumes from the stored per-farm net transfer series
 * (in + / out −). Rules between the same two farms are merged (attribution
 * only ever sums them). When the rules form a forest the volumes are exact:
 * peel a leaf farm, its one rule carries exactly the leaf's net. A loop
 * (A → B → C → A) can't be solved from the nets, so its closing rule is
 * dropped and its volume carried round the rest of the loop; that is exact
 * for every EWR site except one whose catchment cuts the loop. Such networks
 * are rare; `approximate` says when it happened.
 */
function transferVolumes(
	run: ProjectionRun,
	index: Map<string, number>,
	days: number
): { rules: { from: number; to: number; volume: Float64Array }[]; approximate: boolean } {
	const pairs = new Map<string, [number, number]>();
	for (const tr of run.transfers) {
		if (!tr.enabled) continue;
		const a = index.get(tr.fromNodeId);
		const b = index.get(tr.toNodeId);
		if (a === undefined || b === undefined || a === b) continue;
		if (run.nodes[a]!.kind !== 'farm' || run.nodes[b]!.kind !== 'farm') continue;
		const [lo, hi] = a < b ? [a, b] : [b, a];
		pairs.set(`${lo}:${hi}`, [lo, hi]);
	}
	if (!pairs.size) return { rules: [], approximate: false };
	// Union-find: keep a spanning forest.
	const parent = new Map<number, number>();
	const find = (x: number): number => {
		while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!;
		return x;
	};
	const edges: [number, number][] = [];
	let approximate = false;
	for (const [a, b] of [...pairs.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1])) {
		const ra = find(a);
		const rb = find(b);
		if (ra === rb) {
			approximate = true;
			continue;
		}
		parent.set(ra, rb);
		edges.push([a, b]);
	}
	const net = new Map<number, Float64Array>();
	const adj = new Map<number, Set<number>>();
	for (const [a, b] of edges) {
		for (const x of [a, b]) {
			if (!net.has(x)) net.set(x, need(run, run.nodes[x]!.id, 'transfer', days));
			if (!adj.has(x)) adj.set(x, new Set());
		}
		adj.get(a)!.add(b);
		adj.get(b)!.add(a);
	}
	const rules: { from: number; to: number; volume: Float64Array }[] = [];
	const leaves = [...adj.entries()].filter(([, s]) => s.size === 1).map(([x]) => x);
	while (leaves.length) {
		const v = leaves.pop()!;
		const nbrs = adj.get(v)!;
		if (nbrs.size !== 1) continue;
		const u = [...nbrs][0]!;
		// The rule u → v carries the leaf's net inflow; u gives it up.
		const volume = Float64Array.from(net.get(v)!);
		const nu = net.get(u)!;
		for (let t = 0; t < days; t++) nu[t]! += volume[t]!;
		rules.push({ from: u, to: v, volume });
		nbrs.delete(u);
		const un = adj.get(u)!;
		un.delete(v);
		if (un.size === 1) leaves.push(u);
	}
	return { rules, approximate };
}

/**
 * The engine's attribution, recomputed on the run's stored flows, for the
 * one thing a run doesn't store: which site bound each farm's charge each
 * day. Inputs mirror runModel's (run.ts): the canonical node order, each
 * node's consumptive share k, the sites outlet first then gauges by id.
 */
function reattribute(run: ProjectionRun, days: number): { res: AttributionResult; pos: Int32Array; siteNodes: number[]; approximate: boolean } {
	const nodes = run.nodes;
	const topo = buildTopology(nodes);
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const zeros = () => new Float64Array(days);
	const inflow = nodes.map((n) => need(run, n.id, 'inflow_upstream', days));
	const outflow = nodes.map((n) => need(run, n.id, 'outflow', days));
	const runoff = nodes.map((n) => (n.kind === 'farm' ? need(run, n.id, 'runoff', days) : zeros()));
	const supplied = nodes.map((n) => (n.kind === 'gauge' ? zeros() : need(run, n.id, 'supplied', days)));
	const storage = nodes.map((n) => (n.kind === 'farm' ? need(run, n.id, 'dam_storage', days) : zeros()));
	const { rules, approximate } = transferVolumes(run, index, days);
	const gauges = nodes.flatMap((n, i) => (n.kind === 'gauge' && i !== topo.outflow ? [i] : [])).sort((a, b) => (nodes[a]!.id < nodes[b]!.id ? -1 : nodes[a]!.id > nodes[b]!.id ? 1 : 0));
	const siteNodes = [...(topo.outflow >= 0 ? [topo.outflow] : []), ...gauges];
	const order = canonicalOrder(nodes, topo);
	const res = attributeEwrShortfall({
		days,
		kind: nodes.map((n) => n.kind),
		upstream: topo.upstream,
		order,
		inflow,
		runoff,
		outflow,
		supplied,
		storage,
		consumptivePerSupplied: nodes.map((n) => consumptiveShare(n, run)),
		transfers: rules,
		sites: siteNodes.map((node, si) => ({
			node,
			shortfall: si === 0 && topo.outflow >= 0 ? need(run, null, 'ewr_shortfall', days) : need(run, nodes[node]!.id, 'ewr_shortfall', days)
		}))
	});
	const pos = new Int32Array(nodes.length);
	order.forEach((node, k) => (pos[node] = k));
	return { res, pos, siteNodes, approximate };
}

/** The farm's irrigation efficiency as runModel ran it: its own (1 outside (0, 1]), combined with its crops' own (engine ≥ 0.43.0). */
function runEfficiency(n: NetworkNode, run: Pick<ProjectionRun, 'crops' | 'cropAreas' | 'apanMm'>): number {
	const e = n.irrigationEfficiency > 0 && n.irrigationEfficiency <= 1 ? n.irrigationEfficiency : 1;
	return run.crops && run.cropAreas ? modelFarmEfficiency(e, n.id, run.crops, run.cropAreas, run.apanMm ?? []) : e;
}

/** k = 1 − β(1 − e) for a farm, 1 − r for another water user, 1 for a gauge; clamped as runModel clamps them (run.ts irrigation, otherUsers). */
function consumptiveShare(n: NetworkNode, run: Pick<ProjectionRun, 'crops' | 'cropAreas' | 'apanMm'>): number {
	if (n.kind === 'user') {
		const r = n.userReturnPct ?? 0;
		return 1 - (Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0);
	}
	if (n.kind !== 'farm') return 1;
	const e = runEfficiency(n, run);
	const b = Number.isFinite(n.lossReturnFraction) ? Math.min(Math.max(n.lossReturnFraction, 0), 1) : 0;
	return 1 - b * (1 - e);
}

/**
 * The season (1 Oct to the run's last day, from the run's first day when it
 * starts later) and its curtailment table over every farm, as runModel would
 * compute it with the season as its report window (curtailmentOverWindow,
 * without the other water users' rows, so a publication reads no user series
 * beyond PROJECTION_SERIES.user).
 */
export function analyseSeason(run: ProjectionRun): SeasonAnalysis {
	const d0 = toEpochDay(run.startDate);
	const days = toEpochDay(run.endDate) - d0 + 1;
	if (!(days > 0)) throw new ProjectionInputError('the run has no days');
	const to = Math.min(days - 1, Math.max(0, run.dataUntil ? toEpochDay(run.dataUntil) - d0 : days - 1));
	const dataUntil = fromEpochDay(d0 + to);
	const from = Math.max(0, toEpochDay(seasonStart(dataUntil)) - d0);
	const from30 = Math.max(0, to - 29);
	const window = { from, to, reportStart: fromEpochDay(d0 + from), reportEnd: fromEpochDay(d0 + to) };
	const { curtailment, sites, bindingApproximate } = curtailmentOverWindow(run, window, { otherUsers: false });
	return {
		startDate: run.startDate,
		dataUntil,
		season: { from, to, fromDate: window.reportStart, toDate: window.reportEnd },
		last30: { from: from30, to, fromDate: fromEpochDay(d0 + from30), toDate: window.reportEnd },
		curtailment,
		sites,
		bindingApproximate
	};
}

// ---------------------------------------------------------------------------
// The curtailment table over any window (issue #44)
// ---------------------------------------------------------------------------

/** A saved run, as the curtailment recompute sees it (no dataUntil: the window is the caller's). */
export type CurtailmentRun = Omit<ProjectionRun, 'dataUntil'>;

/** The curtailment table over one window, recomputed from a run's stored series. */
export interface WindowCurtailment {
	/** Farms, other water users and EWR sites, as runModel reports them with this window as the report window. */
	curtailment: CurtailmentSummary;
	/** The EWR sites in the engine's order, with their daily series over the whole run. */
	sites: SeasonSite[];
	/** True when a loop in the transfer rules made the binding sites approximate (transferVolumes). */
	bindingApproximate: boolean;
}

/** A run read once, whose curtailment table can then be worked out over any window. */
export interface PreparedCurtailment {
	/** The run's days (index 0 = startDate). */
	days: number;
	/** The table over `window` (day indices into the run, inclusive). Throws on an empty window or one outside the run. */
	over(window: ReportWindow): WindowCurtailment;
}

export interface CurtailmentOptions {
	/** Include the other water users' rows (reads their demand, return_flow and ewr_charge). Default true. */
	otherUsers?: boolean;
}

/**
 * Every stored series prepareCurtailment reads for this model (null node =
 * catchment), so a caller that fetches series one at a time (the Runs tab's
 * reporting-window picker) knows what to fetch.
 */
export function curtailmentSeriesKeys(nodes: readonly NetworkNode[], transfers: readonly Transfer[], options: CurtailmentOptions = {}): { nodeId: string | null; key: string }[] {
	const out: { nodeId: string | null; key: string }[] = [];
	const add = (nodeId: string | null, ...keys: string[]) => keys.forEach((key) => out.push({ nodeId, key }));
	const topo = buildTopology(nodes);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	// The farms whose net transfer series transferVolumes reads.
	const inRule = new Set<string>();
	for (const tr of transfers) {
		const a = byId.get(tr.fromNodeId);
		const b = byId.get(tr.toNodeId);
		if (tr.enabled && a && b && a !== b && a.kind === 'farm' && b.kind === 'farm') inRule.add(a.id).add(b.id);
	}
	nodes.forEach((n, i) => {
		add(n.id, 'inflow_upstream', 'outflow');
		if (n.kind === 'farm') {
			add(n.id, 'runoff', 'supplied', 'dam_storage', 'demand', 'ewr_charge', 'ewr_charge_irrigation');
			if (inRule.has(n.id)) add(n.id, 'transfer');
		} else if (n.kind === 'user') {
			add(n.id, 'supplied');
			if (options.otherUsers !== false) add(n.id, 'demand', 'return_flow', 'ewr_charge');
		} else if (n.kind === 'gauge' && i !== topo.outflow) {
			add(n.id, 'ewr_shortfall', 'ewr_charged', 'ewr_natural');
		}
	});
	if (topo.outflow >= 0) add(null, 'ewr_shortfall', 'ewr_charged', 'ewr_natural');
	return out;
}

/**
 * Reads a saved run once for curtailmentOverWindow: its farm, other-user and
 * EWR-site series, and each day's binding site, recomputed with the engine's
 * attribution on the stored flows (reattribute). `over` is cheap, so a caller
 * showing several windows of one run prepares once.
 */
export function prepareCurtailment(run: CurtailmentRun, options: CurtailmentOptions = {}): PreparedCurtailment {
	const d0 = toEpochDay(run.startDate);
	const days = toEpochDay(run.endDate) - d0 + 1;
	if (!(days > 0)) throw new ProjectionInputError('the run has no days');
	const { res, pos, siteNodes, approximate } = reattribute(run, days);
	const nodes = run.nodes;
	const farms = nodes.flatMap((n, i) => {
		if (n.kind !== 'farm') return [];
		const input: CurtailmentInput = {
			nodeId: n.id,
			name: n.name,
			demand: need(run, n.id, 'demand', days),
			supplied: need(run, n.id, 'supplied', days),
			ewrCharge: need(run, n.id, 'ewr_charge', days),
			ewrChargeIrrigation: need(run, n.id, 'ewr_charge_irrigation', days),
			consumptivePerSupplied: consumptiveShare(n, run)
		};
		return [{ i, input }];
	});
	const users: CurtailmentUserInput[] = [];
	if (options.otherUsers !== false) {
		for (const n of nodes) {
			if (n.kind !== 'user') continue;
			users.push({
				nodeId: n.id,
				name: n.name,
				// As runModel reads it (run.ts otherUsers): senior unless marked junior.
				senior: (n.userPriority ?? 'senior') !== 'junior',
				demand: need(run, n.id, 'demand', days),
				supplied: need(run, n.id, 'supplied', days),
				returned: need(run, n.id, 'return_flow', days),
				ewrCharge: need(run, n.id, 'ewr_charge', days),
				consumptivePerSupplied: consumptiveShare(n, run)
			});
		}
	}
	const sites: SeasonSite[] = siteNodes.map((node, si) => {
		const isOutlet = si === 0 && nodes[node]!.downstreamNodeId === null;
		const id = isOutlet ? null : nodes[node]!.id;
		return {
			nodeId: nodes[node]!.id,
			name: nodes[node]!.name,
			isOutlet,
			upstream: new Set(Array.from(res.sites[si]!.farms, (f) => nodes[f]!.id)),
			shortfall: need(run, id, 'ewr_shortfall', days),
			charged: need(run, id, 'ewr_charged', days),
			natural: need(run, id, 'ewr_natural', days)
		};
	});
	const siteInputs: CurtailmentSiteInput[] = sites.map((s) => ({
		nodeId: s.nodeId,
		name: s.name,
		isOutlet: s.isOutlet,
		farmCount: s.upstream.size,
		shortfall: s.shortfall,
		charged: s.charged,
		natural: s.natural
	}));
	return {
		days,
		over(window) {
			if (!(window.from >= 0 && window.to < days)) throw new ProjectionInputError(`the window ${window.reportStart} … ${window.reportEnd} is outside the run`);
			const farmInputs = farms.map(({ i, input }) => {
				const bind = bindingSite(res, i, window.from, window.to, (node) => pos[node]!);
				return { ...input, ewrBindingSiteId: bind < 0 ? null : nodes[siteNodes[bind]!]!.id };
			});
			const curtailment = computeCurtailment(farmInputs, window, siteInputs);
			// runModel adds the rows only when the network has other water users.
			if (users.length) curtailment.otherUsers = otherUserCurtailment(users, window);
			return { curtailment, sites, bindingApproximate: approximate };
		}
	};
}

/**
 * The curtailment table (farms, other water users, EWR sites) over any
 * window of a saved run, from its stored daily series: what runModel reports
 * with that window as the project's report window, the EWR site that bound
 * each farm's charge included (exact, except after a transfer loop:
 * `bindingApproximate`). Over the run's own window it is the stored table.
 * Pure. For several windows of one run, prepareCurtailment once.
 */
export function curtailmentOverWindow(run: CurtailmentRun, window: ReportWindow, options: CurtailmentOptions = {}): WindowCurtailment {
	return prepareCurtailment(run, options).over(window);
}

// ---------------------------------------------------------------------------
// One farm (E1, E4, E7)
// ---------------------------------------------------------------------------

function totals(demand: StoredValues, supplied: StoredValues, startDate: string, from: string, to: string): WindowTotals {
	const d = windowSummary(demand, startDate, from, to);
	const s = windowSummary(supplied, startDate, from, to);
	const demandM3 = d?.sum ?? 0;
	const suppliedM3 = s?.sum ?? 0;
	const days = d?.days ?? 0;
	return {
		from: d?.from ?? from,
		to: d?.to ?? to,
		demandM3,
		suppliedM3,
		fraction: days > 0 && demandM3 >= DEMAND_PCT_FLOOR_M3_DAY * days ? suppliedM3 / demandM3 : null
	};
}

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

/**
 * The FarmProjection of one farm (farmView.ts): the season, the last 30 days,
 * the dam, the same dates last season, the 12 months to dataUntil and the
 * river's share. Pass the SeasonAnalysis when projecting several farms of one
 * run, so the season's curtailment is computed once. equitableFraction and
 * aboveBelowShareM3Day are stored as computed: the API hides them from a
 * viewer below the aggregate rule (FARMER_K).
 */
export function farmProjection(run: ProjectionRun, nodeId: string, analysis: SeasonAnalysis = analyseSeason(run)): FarmProjection {
	const node = run.nodes.find((n) => n.id === nodeId);
	if (!node || node.kind !== 'farm') throw new ProjectionInputError(`node ${nodeId} is not a farm of the run`);
	const cf: CurtailmentFarm | undefined = analysis.curtailment.farms.find((f) => f.nodeId === nodeId);
	if (!cf) throw new ProjectionInputError(`no curtailment row for farm ${nodeId}`);
	const d0 = toEpochDay(run.startDate);
	const days = toEpochDay(run.endDate) - d0 + 1;
	const demand = need(run, nodeId, 'demand', days);
	const supplied = need(run, nodeId, 'supplied', days);
	const deficit = need(run, nodeId, 'deficit', days);
	const storage = need(run, nodeId, 'dam_storage', days);
	const spill = need(run, nodeId, 'spill', days);
	const charge = need(run, nodeId, 'ewr_charge', days);
	const { season: sw, last30: lw } = analysis;
	const cap = node.damCapacityM3;
	const hasDam = cap > 0;
	const stop = cap * node.damMinPct;
	const pctAt = (t: number) => storage[t]! / cap;

	// The season's short days, and how many had the dam at its stop level (the
	// engine only lets irrigation draw above it, so a dam farm is short only there).
	const shortMonths = new Set<string>();
	let shortDays = 0;
	let atStop = 0;
	for (let t = sw.from; t <= sw.to; t++) {
		if (!(deficit[t]! > NOISE_M3)) continue;
		shortDays++;
		shortMonths.add(fromEpochDay(d0 + t).slice(0, 7));
		if (hasDam && storage[t]! <= stop + 1e-3) atStop++;
	}
	const seasonTotals = totals(demand, supplied, run.startDate, sw.fromDate, sw.toDate);
	const season: SeasonTotals = { ...seasonTotals, shortDays, shortMonths: [...shortMonths].sort(), shortDaysAtStopLevel: atStop };
	const last30 = totals(demand, supplied, run.startDate, lw.fromDate, lw.toDate);

	let dam: DamState | null = null;
	if (hasDam) {
		const e = sw.to;
		const usableM3 = node.damMinPct > 0 ? Math.max(storage[e]! - stop, 0) : null;
		const use14 = windowSummary(supplied, run.startDate, fromEpochDay(d0 + Math.max(0, e - 13)), analysis.dataUntil)!.mean;
		let lastSpill: string | null = null;
		for (let t = e; t >= 0; t--) {
			if (spill[t]! > NOISE_M3) {
				lastSpill = fromEpochDay(d0 + t);
				break;
			}
		}
		dam = {
			pct: pctAt(e),
			storageM3: storage[e]!,
			usableM3,
			pct30dAgo: pctAt(Math.max(0, e - 30)),
			lastSpill,
			use14M3Day: use14,
			usableDays: usableM3 !== null && use14 > 0 ? usableM3 / use14 : null
		};
	}

	// The same dates a year earlier, from this run (E4): comparing publications would mix model changes with weather.
	const lsFrom = yearBefore(sw.fromDate);
	const lsTo = yearBefore(sw.toDate);
	const lastSeason =
		toEpochDay(lsFrom) < d0
			? null
			: {
					from: lsFrom,
					to: lsTo,
					fraction: totals(demand, supplied, run.startDate, lsFrom, lsTo).fraction,
					damPct: hasDam ? pctAt(toEpochDay(lsTo) - d0) : null
				};

	// The 12 calendar months to dataUntil, oldest first; the last may be partial.
	const monthly: MonthTotals[] = [];
	const endY = Number(analysis.dataUntil.slice(0, 4));
	const endM = monthOfEpochDay(d0 + sw.to);
	for (let k = 11; k >= 0; k--) {
		const mi = endY * 12 + (endM - 1) - k;
		const y = Math.floor(mi / 12);
		const m = (mi % 12) + 1;
		const month = `${y}-${String(m).padStart(2, '0')}`;
		const first = toEpochDay(`${month}-01`);
		const nextFirst = toEpochDay(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`);
		const lo = Math.max(0, first - d0);
		const hi = Math.min(sw.to, nextFirst - 1 - d0);
		let dm = 0;
		let sm = 0;
		for (let t = lo; t <= hi; t++) {
			dm += demand[t]!;
			sm += supplied[t]!;
		}
		monthly.push({ month, demandM3: dm, suppliedM3: sm, damPctEnd: hasDam && hi >= lo ? pctAt(hi) : null });
	}

	// The river's share over the season (design §3 Q2, §5, §6.2). Magnitudes positive.
	let chargedDays = 0;
	for (let t = sw.from; t <= sw.to; t++) if (charge[t]! < 0) chargedDays++;
	const windowDays = sw.to - sw.from + 1;
	const supplyCutM3Day = Math.max(0, -(cf.ewrSupplyCutM3Day ?? 0));
	const storageM3Day = Math.max(0, -(cf.ewrChargeStorageM3Day ?? 0));
	const headline = cf.demandM3Day >= DEMAND_PCT_FLOOR_M3_DAY ? clamp01((cf.suppliedM3Day - supplyCutM3Day) / cf.demandM3Day) : null;
	const sites: RiverSite[] = analysis.sites
		.filter((s) => s.upstream.has(nodeId))
		.map((s) => {
			let notMet = 0;
			let onlyNatural = 0;
			for (let t = sw.from; t <= sw.to; t++) {
				if (!(s.shortfall[t]! < 0)) continue;
				notMet++;
				if (!(s.charged[t]! < 0)) onlyNatural++;
			}
			return { name: s.name, daysNotMet: notMet, daysOnlyNatural: onlyNatural };
		});
	const binding = cf.ewrBindingSiteId ? (analysis.sites.find((s) => s.nodeId === cf.ewrBindingSiteId)?.name ?? null) : null;

	return {
		nodeId,
		name: node.name,
		damCapacityM3: cap,
		damMinPct: node.damMinPct,
		irrigationEfficiency: runEfficiency(node, run),
		dataUntil: analysis.dataUntil,
		season,
		last30,
		dam,
		lastSeason,
		monthly,
		river: {
			demandM3Day: cf.demandM3Day,
			suppliedM3Day: cf.suppliedM3Day,
			supplyCutM3Day,
			storageM3Day,
			chargedDays,
			windowDays,
			perChargedDaySupplyCutM3: chargedDays > 0 ? (supplyCutM3Day * windowDays) / chargedDays : null,
			perChargedDayStorageM3: chargedDays > 0 ? (storageM3Day * windowDays) / chargedDays : null,
			headline,
			band: modelBand(headline, storageM3Day, DEMAND_PCT_FLOOR_M3_DAY),
			equitableFraction: analysis.curtailment.equitableFraction,
			aboveBelowShareM3Day: analysis.curtailment.equitableFraction === null ? null : cf.reduceGainM3Day,
			cutBeyondShare: (cf.ewrCutBeyondShareM3Day ?? 0) > 0,
			sites,
			bindingSite: binding
		}
	};
}

// ---------------------------------------------------------------------------
// The catchment (run_publication.catchment_view)
// ---------------------------------------------------------------------------

/** Days not met at one EWR site, to dataUntil: counts, never volumes (design §10.3). */
export interface CatchmentSite {
	name: string;
	isOutlet: boolean;
	daysNotMet: { run: number; season: number; last30: number };
}

/**
 * What every member of the project, farmers included, may read about the
 * catchment in a publication (run_publication.catchment_view). Counts and
 * dates only: no flow volume (natural flow minus outflow minus your own use
 * is your neighbours' use in a small catchment) and no total of farm
 * quantities (a total below the aggregate rule's k holders reveals a
 * neighbour; the rule depends on the viewer, and this is stored once).
 */
export interface CatchmentView {
	runStart: string;
	dataUntil: string;
	season: { from: string; to: string; days: number };
	last30: { from: string; to: string; days: number };
	/** Days from the run's start to dataUntil (the span `daysNotMet.run` counts over). */
	runDays: number;
	farmCount: number;
	sites: CatchmentSite[];
}

export function catchmentView(run: ProjectionRun, analysis: SeasonAnalysis = analyseSeason(run)): CatchmentView {
	const count = (a: Float64Array, from: number, to: number) => {
		let n = 0;
		for (let t = from; t <= to; t++) if (a[t]! < 0) n++;
		return n;
	};
	const { season: sw, last30: lw } = analysis;
	const runDays = sw.to + 1;
	return {
		runStart: run.startDate,
		dataUntil: analysis.dataUntil,
		season: { from: sw.fromDate, to: sw.toDate, days: sw.to - sw.from + 1 },
		last30: { from: lw.fromDate, to: lw.toDate, days: lw.to - lw.from + 1 },
		runDays,
		farmCount: run.nodes.filter((n) => n.kind === 'farm').length,
		sites: analysis.sites.map((s) => ({
			name: s.name,
			isOutlet: s.isOutlet,
			daysNotMet: { run: count(s.shortfall, 0, sw.to), season: count(s.shortfall, sw.from, sw.to), last30: count(s.shortfall, lw.from, lw.to) }
		}))
	};
}
