// Firm yield and storage–yield curves (roadmap WP-3.6, docs/model.md §2.13).
//
// The historical firm yield of a dam is the largest draft it supplies over
// the whole record without a single failure day, the rest of the network
// running as modelled. The search is a bisection on the draft: each probe
// replaces the dam node's demand with draft × pattern and runs the network.
// Natural flow, and everything else the network needs (./run.ts
// buildNetworkPlan), is computed once per problem and reused by every probe,
// as calibration does, so a probe is one simulateNetwork call.
//
// Pure: no I/O, runs in the browser and in Lambda.
import { waterYearIndex, waterYearOf } from '../calendar';
import type { ModelInput } from '../project';
import { buildNetworkPlan, type NaturalFlowInput, type RunContext } from '../run';
import { naturalFlowFor } from '../runoff';
import { simulateNetwork, type NetworkPlan, type PlanNode } from './simulate';
import type { DamCurve } from './dam';
import { resizeCurveRows, resizedFullArea } from './damResize';
import { forecastTail } from '../forecastTail';
import { prepareRun } from '../prepare';

/**
 * A draft shape: flat, a unit's irrigation demand by month (the dam's own
 * unit's, or `patternNodeId`'s, engine ≥ 1.117.0), or 12 factors (water
 * year, Oct–Sep).
 */
export type YieldPattern = 'constant' | 'demand' | readonly number[];

export interface YieldOptions {
	/** Draft shape (default 'constant'). Normalised so the draft is the mean daily draft over the record. */
	pattern?: YieldPattern;
	/**
	 * With pattern 'demand': the hydrological unit whose irrigation demand
	 * shapes the draft (engine ≥ 1.117.0). Absent: the dam's own unit, as
	 * before. A unit with no irrigation demand is refused.
	 */
	patternNodeId?: string;
	/**
	 * Assurance p, 0.5–1 (default 1, the firm yield): the largest draft whose
	 * annual failure rate (water years with at least one failure day ÷ water
	 * years in the record) is at most 1 − p.
	 */
	assurance?: number;
	/** Relative tolerance of the bisection on the draft (default 0.001). */
	tolerance?: number;
	/** Called after every probe with how many have run and the most that can. */
	onProbe?: (done: number, max: number) => void;
}

/** One yield: the draft found, and what the record gives at it. */
export interface YieldPoint {
	/** Dam capacity the yield is for (m³). */
	capacityM3: number;
	/** The yield: mean daily draft over the record (m³/day). A draft passes the criterion at this value. */
	yieldM3Day: number;
	/** The same, per year (× 365.25). */
	yieldM3Year: number;
	/** The smallest draft found to fail (m³/day); yield ≤ this ≤ yield × (1 + tolerance), or null when nothing failed. */
	failsAtM3Day: number | null;
	/** Failure days and failed water years at the yield. */
	failureDays: number;
	failedYears: number;
	/** yield ≤ this: (inflow to the dam + initial storage) ÷ days, the mean-supply bound (m³/day). */
	boundM3Day: number;
	/** Network runs the search took. */
	probes: number;
}

export interface YieldProblem {
	/** The network plan with the project's own demand, built once. */
	plan: NetworkPlan;
	/** Node ids in plan order. */
	nodeIds: string[];
	/** Water year (Oct start) of each day, as an index from 0. */
	yearOfDay: Int32Array;
	years: number;
	/** Water-year month index (0 = Oct) of each day. */
	wyMonth: Uint8Array;
	days: number;
	startDate: string;
	warnings: string[];
}

export const YIELD_DEFAULT_TOLERANCE = 0.001;
/** Most network runs one yield may take (a doubling phase plus the bisection). */
export const YIELD_MAX_PROBES = 60;
/** Storage–yield curve: capacities from 0 to this multiple of the dam's capacity. */
export const STORAGE_YIELD_MAX_MULTIPLE = 2;
export const STORAGE_YIELD_DEFAULT_POINTS = 11;
/**
 * The share of its capacity the dam holds on the record's first day in a
 * yield search and at every point of a storage–yield curve (engine ≥
 * 1.117.0, the operator's decision 2026-11-09), whatever its own initial
 * storage (damInitialPct), which the normal run keeps using. The record's
 * first day shouldn't decide the firm yield: an empty start in a dry first
 * month gave 0 (docs/model.md §2.13).
 */
export const YIELD_START_FULL_SHARE = 0.5;
/** A deficit smaller than this share of the day's draft is float noise, not a failure. */
const FAILURE_NOISE = 1e-9;

/**
 * Build the problem once: settings, aligned inputs, natural flow (the project's
 * runoff model, or `naturalFlow` when given) and the network plan.
 */
export function prepareYield(input: ModelInput, naturalFlow?: (ctx: RunContext) => NaturalFlowInput): YieldProblem {
	const run = prepareRun(input);
	const { settings, days, startDate, aligned, month, warnings, start } = run;
	// The days before a forecast tail, which runModel's record-wide statistics read (engine ≥ 1.28.0).
	const { historyDays } = forecastTail(run);
	const nf = (naturalFlow ?? ((ctx: RunContext) => naturalFlowFor(ctx.settings.runoffModel)(input, ctx)))({ settings, startDate, days, aligned, historyDays, chirpsCorrection: run.chirpsCorrection });
	if (nf.naturalFlowM3Day.length !== days) throw new Error(`natural flow has ${nf.naturalFlowM3Day.length} days, expected ${days}`);
	const natural = Float64Array.from(nf.naturalFlowM3Day, (v) => (Number.isFinite(v) ? v : 0));
	// Each land unit's own runoff under per-unit rain (engine ≥ 1.78.0, docs/model.md §2.4h), as runModel's plan has it.
	// Fragmentation's EWR shares (engine ≥ 1.105.0, §2.5b) likewise.
	const { plan } = buildNetworkPlan(
		input,
		settings,
		days,
		month,
		aligned,
		natural,
		warnings,
		start,
		nf.unitRunoff ? { unitRunoff: nf.unitRunoff } : {},
		historyDays
	);
	const yearOfDay = new Int32Array(days);
	const wyMonth = new Uint8Array(days);
	const y0 = waterYearOf(run.start);
	for (let t = 0; t < days; t++) {
		yearOfDay[t] = waterYearOf(run.start + t) - y0;
		wyMonth[t] = waterYearIndex(month[t]!);
	}
	return {
		plan,
		nodeIds: input.model.nodes.map((n) => n.id),
		yearOfDay,
		years: days ? yearOfDay[days - 1]! + 1 : 0,
		wyMonth,
		days,
		startDate,
		warnings
	};
}

/** The unit whose demand shapes a draft: a unit with land, as the dam is. */
function patternIndex(p: YieldProblem, nodeId: string): number {
	const i = p.nodeIds.indexOf(nodeId);
	if (i < 0 || p.plan.nodes[i]!.kind !== 'farm') throw new Error('the hydrological unit chosen to shape the draft is not a unit with land in this model');
	return i;
}

const isProblem = (x: ModelInput | YieldProblem): x is YieldProblem => 'plan' in x && 'yearOfDay' in x;

function nodeIndex(p: YieldProblem, nodeId: string): number {
	const i = p.nodeIds.indexOf(nodeId);
	if (i < 0) throw new Error(`hydrological unit ${nodeId} not found`);
	if (p.plan.nodes[i]!.kind !== 'farm') throw new Error('a yield is for a hydrological unit with land (a unit or its dam), not a gauge or other water user');
	return i;
}

/**
 * A unit's irrigation demand by water-year month (0 = Oct): its abstraction
 * demand D = F / e, plus its demand objects' (engine ≥ 1.7.0), the mean of
 * each month over the record.
 */
function demandByMonth(p: YieldProblem, i: number): Float64Array<ArrayBuffer> {
	const node = p.plan.nodes[i]!;
	const sum = new Float64Array(12);
	const n = new Float64Array(12);
	for (let t = 0; t < p.days; t++) {
		sum[p.wyMonth[t]!]! += node.objects ? node.demand[t]! / node.irrigationEfficiency + node.objects.total[t]! : node.demand[t]! / node.irrigationEfficiency;
		n[p.wyMonth[t]!]!++;
	}
	const factors = new Float64Array(12);
	for (let m = 0; m < 12; m++) factors[m] = n[m] ? sum[m]! / n[m]! : 0;
	return factors;
}

const hasDemand = (factors: Float64Array) => factors.some((f) => f > 0);

/**
 * The hydrological units whose irrigation demand can shape a draft (pattern
 * 'demand', `patternNodeId`): the units with land whose demand by month is
 * above 0 in some month, in the model's node order (engine ≥ 1.117.0).
 */
export function irrigationDemandUnits(p: YieldProblem): string[] {
	return p.nodeIds.filter((_, i) => p.plan.nodes[i]!.kind === 'farm' && hasDemand(demandByMonth(p, i)));
}

/**
 * The draft shape per day, normalised to a mean of 1 over the record, so a
 * draft of x m³/day draws x × days in total whatever the shape. Pattern
 * 'demand' takes `patternNodeId`'s irrigation demand (engine ≥ 1.117.0),
 * absent the dam's own.
 */
export function yieldPatternDaily(p: YieldProblem, nodeId: string, pattern: YieldPattern = 'constant', patternNodeId?: string): Float64Array {
	const i = nodeIndex(p, nodeId);
	if (patternNodeId !== undefined && pattern !== 'demand') throw new Error("a unit to shape the draft goes with the 'demand' pattern only");
	let factors = new Float64Array(12);
	if (pattern === 'constant') factors.fill(1);
	else if (pattern === 'demand') {
		const from = patternNodeId === undefined ? i : patternIndex(p, patternNodeId);
		factors = demandByMonth(p, from);
		if (from !== i && !hasDemand(factors)) throw new Error('the hydrological unit chosen to shape the draft has no irrigation demand; choose another unit or a constant pattern');
	} else {
		if (pattern.length !== 12) throw new Error('a yield pattern has 12 monthly factors (Oct–Sep)');
		for (let m = 0; m < 12; m++) {
			const f = pattern[m]!;
			if (!(Number.isFinite(f) && f >= 0)) throw new Error('yield pattern factors are finite and ≥ 0');
			factors[m] = f;
		}
	}
	const daily = new Float64Array(p.days);
	let total = 0;
	for (let t = 0; t < p.days; t++) total += daily[t] = factors[p.wyMonth[t]!]!;
	if (!(total > 0)) {
		throw new Error(pattern === 'demand' ? 'this hydrological unit has no irrigation demand to shape the draft; use a constant pattern' : 'the yield pattern is zero in every month of the record');
	}
	const scale = p.days / total;
	for (let t = 0; t < p.days; t++) daily[t]! *= scale;
	return daily;
}

/**
 * The part of the network a dam's supply depends on: the dam and every node
 * upstream of it. What runs below it can't change what reaches it, and nothing
 * upstream depends on its draft, unless a transfer links the two; then the
 * whole network runs. Returns the plan and the dam's index in it.
 */
function supplyNetwork(plan: NetworkPlan, i: number): { plan: NetworkPlan; at: number } {
	const keep = new Set<number>([i]);
	const stack = [i];
	while (stack.length) {
		for (const u of plan.upstream[stack.pop()!]!) {
			if (keep.has(u)) continue;
			keep.add(u);
			stack.push(u);
		}
	}
	// A crop supply table's remote share (engine ≥ 1.73.0) links two units as a transfer does.
	const remoteTouches = plan.nodes.some((n, k) => n.remote && (keep.has(k) || keep.has(n.remote.from)));
	if (keep.size === plan.nodes.length || remoteTouches || plan.transfers.some((tr) => keep.has(tr.from) || keep.has(tr.to)) || plan.offtakes?.some((o) => keep.has(o.from) || keep.has(o.to))) return { plan, at: i };
	const old = [...keep].sort((a, b) => a - b);
	const idx = new Map(old.map((o, k) => [o, k]));
	return {
		plan: {
			...plan,
			nodes: old.map((o) => plan.nodes[o]!),
			order: Int32Array.from([...plan.order].filter((o) => keep.has(o)).map((o) => idx.get(o)!)),
			upstream: old.map((o) => Int32Array.from(plan.upstream[o]!, (u) => idx.get(u)!)),
			// None of them touches the kept nodes (checked above).
			transfers: [],
			offtakes: []
		},
		at: idx.get(i)!
	};
}

/** The plan with node i as a dam of capacity `cap` drawing `draft` × pattern, and its index in that plan. */
function probePlan(p: YieldProblem, i: number, cap: number): { plan: NetworkPlan; at: number; setDraft: (draft: number, pattern: Float64Array) => void } {
	const base = p.plan.nodes[i]!;
	const baseCap = base.damCapacityM3;
	// A resized dam keeps its initial and dead storage as fractions of capacity
	// (pending the hydrologist), and its surface follows the dam's own
	// area–volume relation (engine ≥ 1.10.0, ./damResize.ts, model.md §2.13):
	// the power law's A_full × ratio^b, a survey curve (WP-3.5) cut at the new
	// top or carried beyond it by a power law through its top rows. The curve's
	// new top is its own top × the ratio, so the dam's own capacity keeps its
	// curve as it is.
	const ratio = baseCap > 0 ? cap / baseCap : 0;
	const curve = base.damCurve && ratio > 0 ? resizedPlanCurve(base.damCurve, ratio, base.damAreaExponent) : undefined;
	const demand = new Float64Array(p.days);
	// The dam's own yield: its boreholes (WP-1.34), including those that pump
	// into the dam (WP-3.9), don't count towards it (pending the hydrologist).
	// The draft is the node's whole demand, so its demand objects (engine ≥ 1.7.0) go too. An allocation
	// cap on it goes as well (engine ≥ 1.18.0): a yield is what the dam can give, not what is registered;
	// the other units keep theirs, so a capped farm upstream leaves the dam more.
	// Its river abstractions (engine ≥ 1.65.0) go with the demands they serve: the draft is on the dam. So does a crop
	// supply table (engine ≥ 1.73.0): the whole draft is asked of the dam, none of the river or another unit's dam.
	const { borehole: _borehole, damCurve: _curve, objects: _objects, allocationCap: _cap, river: _river, initialPoolM3: _pools, cropDamShare: _share, remote: _remote, ...rest } = base;
	const node: PlanNode = {
		...rest,
		damCapacityM3: cap,
		// Half full on the first day (YIELD_START_FULL_SHARE), not the dam's own initial storage; a dam that comes into
		// service later (§2.7i) keeps its first day's capacity share, as the run's initial storage does.
		initialStorageM3: YIELD_START_FULL_SHARE * cap * (base.capacityScale && p.days ? base.capacityScale[0]! : 1),
		deadStorageM3: base.deadStorageM3 * ratio,
		damAreaFullM2: resizedFullArea(base.damAreaFullM2, baseCap, cap, base.damAreaExponent),
		...(curve ? { damCurve: curve } : {}),
		demand
	};
	const nodes = p.plan.nodes.slice();
	nodes[i] = node;
	const transfers = p.plan.transfers.map((tr) => (tr.from === i ? { ...tr, reserveM3: tr.reserveM3 * ratio } : tr));
	const e = node.irrigationEfficiency;
	// Without the drought restriction rule (engine ≥ 1.54.0): a yield is what the dam can give, not what a
	// restriction policy asks of it (docs/model.md §2.7i), as the caps and boreholes above.
	const { restriction: _restriction, ...plan } = p.plan;
	const sub = supplyNetwork({ ...plan, nodes, transfers }, i);
	return {
		...sub,
		// F = draft × pattern × e, so the abstraction demand D = F / e is the draft.
		setDraft: (draft, pattern) => {
			for (let t = 0; t < p.days; t++) demand[t] = draft * pattern[t]! * e;
		}
	};
}

/** A plan's survey curve (anchored at an empty dam) resized to its top × `ratio` along its own relation (./damResize.ts). */
function resizedPlanCurve(c: DamCurve, ratio: number, exponent: number): DamCurve {
	if (ratio === 1) return c;
	const r = resizeCurveRows(c.volume, c.area, null, c.volume[c.volume.length - 1]! * ratio, exponent, (v, a) => [v, a] as const);
	return { volume: Float64Array.from(r.rows, (x) => x[0]), area: Float64Array.from(r.rows, (x) => x[1]) };
}

interface ProbeResult {
	failureDays: number;
	failedYears: number;
}

/**
 * Firm yield (assurance 1) or the yield at assurance p of a dam node, at its
 * own capacity or `capacityM3`. Bisection: a first bracket from the
 * mean-supply bound (doubled until it fails, for an assurance below 1), then
 * halving until the bracket is within `tolerance` of the draft.
 */
export function firmYield(source: ModelInput | YieldProblem, nodeId: string, opts: YieldOptions & { capacityM3?: number } = {}): YieldPoint {
	const p = isProblem(source) ? source : prepareYield(source);
	const i = nodeIndex(p, nodeId);
	const assurance = opts.assurance ?? 1;
	if (!(assurance >= 0.5 && assurance <= 1)) throw new Error('assurance is between 0.5 and 1');
	const tol = opts.tolerance ?? YIELD_DEFAULT_TOLERANCE;
	if (!(tol > 0 && tol < 0.5)) throw new Error('tolerance is between 0 and 0.5');
	const base = p.plan.nodes[i]!;
	const cap = opts.capacityM3 ?? base.damCapacityM3;
	if (!(Number.isFinite(cap) && cap >= 0)) throw new Error('capacity is a finite number ≥ 0');
	const pattern = yieldPatternDaily(p, nodeId, opts.pattern, opts.patternNodeId);
	const { plan, at, setDraft } = probePlan(p, i, cap);
	const days = p.days;
	const allowedYears = Math.floor((1 - assurance) * p.years + 1e-9);

	let probes = 0;
	const probe = (draft: number): ProbeResult => {
		setDraft(draft, pattern);
		const r = simulateNetwork(plan).nodes[at]!;
		probes++;
		opts.onProbe?.(probes, YIELD_MAX_PROBES);
		let failureDays = 0;
		let failedYears = 0;
		let lastYear = -1;
		for (let t = 0; t < days; t++) {
			const want = r.demand[t]!;
			if (r.deficit[t]! > FAILURE_NOISE * want && want > 0) {
				failureDays++;
				if (p.yearOfDay[t] !== lastYear) {
					failedYears++;
					lastYear = p.yearOfDay[t]!;
				}
			}
		}
		return { failureDays, failedYears };
	};
	const passes = (r: ProbeResult) => (assurance === 1 ? r.failureDays === 0 : r.failedYears <= allowedYears);

	// The mean-supply bound from a run with no draft: everything that reaches
	// the dam (upstream inflow, own runoff, transfers and off-takes in, rain on it when full)
	// plus its initial storage, spread over the record.
	const zero = (() => {
		setDraft(0, pattern);
		const r = simulateNetwork(plan).nodes[at]!;
		probes++;
		opts.onProbe?.(probes, YIELD_MAX_PROBES);
		return r;
	})();
	let inflow = 0;
	// River off-take water delivered to it (engine ≥ 1.14.0) comes in too.
	for (let t = 0; t < days; t++) inflow += zero.inflowUpstream[t]! + zero.runoff[t]! + Math.max(zero.transfer[t]!, 0) + (zero.offtakeIn?.[t] ?? 0);
	// A unit's base-flow gain and loss (engine 1.86.0) change what its runoff brings: the gain can fill the dam too.
	if (zero.baseflowGain || zero.baseflowLoss) for (let t = 0; t < days; t++) inflow += (zero.baseflowGain?.[t] ?? 0) - (zero.baseflowLoss?.[t] ?? 0);
	let rainOnFull = 0;
	// The full surface: the survey curve's top row when the dam has one (WP-3.5), else the power law's.
	const fullArea = plan.nodes[at]!.damCurve ? Math.max(...plan.nodes[at]!.damCurve!.area) : plan.nodes[at]!.damAreaFullM2;
	if (plan.damRainMm && cap > 0) for (let t = 0; t < days; t++) rainOnFull += (plan.damRainMm[t]! * fullArea) / 1000;
	const bound = days ? (inflow + rainOnFull + plan.nodes[at]!.initialStorageM3) / days : 0;

	const point = (y: number, failsAt: number | null, r: ProbeResult): YieldPoint => ({
		capacityM3: cap,
		yieldM3Day: y,
		yieldM3Year: y * 365.25,
		failsAtM3Day: failsAt,
		failureDays: r.failureDays,
		failedYears: r.failedYears,
		boundM3Day: bound,
		probes
	});
	const none: ProbeResult = { failureDays: 0, failedYears: 0 };
	if (!(bound > 0) || days === 0) return point(0, null, none);

	let lo = 0;
	let loResult = none;
	let hi = bound * (1 + tol);
	let hiResult = probe(hi);
	// Firm yield can't pass above the bound (it would draw more than there is);
	// with failures allowed it can, so widen the bracket until it fails.
	while (passes(hiResult) && probes < YIELD_MAX_PROBES) {
		lo = hi;
		loResult = hiResult;
		hi *= 2;
		hiResult = probe(hi);
	}
	if (passes(hiResult)) return point(hi, null, hiResult);
	const absTol = 1e-6;
	while (hi - lo > tol * hi && hi - lo > absTol && probes < YIELD_MAX_PROBES) {
		const mid = (lo + hi) / 2;
		const r = probe(mid);
		if (passes(r)) {
			lo = mid;
			loResult = r;
		} else {
			hi = mid;
		}
	}
	return point(lo, hi, loResult);
}

export interface StorageYieldCurve {
	nodeId: string;
	/** The dam's own capacity the curve is scaled from (m³). */
	baseCapacityM3: number;
	assurance: number;
	points: YieldPoint[];
	/** Yield never falls as capacity rises. False can be real (a large shallow dam evaporating more than it stores) and is reported, not hidden. */
	monotone: boolean;
}

/**
 * Capacities for a storage–yield curve: `n` points evenly from 0 to 2 × the
 * dam's capacity, or to `maxCapacityM3` when given (engine ≥ 1.117.0: sizing
 * a proposed dam, which a unit with no dam yet can do).
 */
export function storageYieldCapacities(capacityM3: number, n = STORAGE_YIELD_DEFAULT_POINTS, maxCapacityM3?: number): number[] {
	if (maxCapacityM3 !== undefined) {
		if (!(Number.isFinite(maxCapacityM3) && maxCapacityM3 > 0)) throw new Error('the largest capacity of a storage–yield curve is a finite number above 0');
	} else if (!(capacityM3 > 0)) throw new Error('a storage–yield curve needs a dam with a capacity above 0, or the largest capacity to size it to');
	if (!(Number.isInteger(n) && n >= 2 && n <= 20)) throw new Error('a storage–yield curve has 2–20 points');
	const top = maxCapacityM3 ?? STORAGE_YIELD_MAX_MULTIPLE * capacityM3;
	return Array.from({ length: n }, (_, k) => (top * k) / (n - 1));
}

/**
 * Yield at each capacity from 0 to 2 × the dam's own, or to `maxCapacityM3`
 * (`points` of them). A unit with no dam sizes a proposed one: its dams start
 * empty, with no dead storage and, having no area–volume relation to scale,
 * no surface to evaporate from or catch rain on (docs/model.md §2.13).
 */
export function storageYieldCurve(
	source: ModelInput | YieldProblem,
	nodeId: string,
	opts: YieldOptions & { points?: number; maxCapacityM3?: number; onPoint?: (done: number, total: number) => void } = {}
): StorageYieldCurve {
	const p = isProblem(source) ? source : prepareYield(source);
	const i = nodeIndex(p, nodeId);
	const baseCap = p.plan.nodes[i]!.damCapacityM3;
	const caps = storageYieldCapacities(baseCap, opts.points, opts.maxCapacityM3);
	const points: YieldPoint[] = [];
	for (const c of caps) {
		points.push(firmYield(p, nodeId, { ...opts, capacityM3: c }));
		opts.onPoint?.(points.length, caps.length);
	}
	return { nodeId, baseCapacityM3: baseCap, assurance: opts.assurance ?? 1, points, monotone: isMonotone(points) };
}

/** Non-decreasing yield in capacity, within the bisection's own resolution. */
export function isMonotone(points: readonly YieldPoint[], tolerance = YIELD_DEFAULT_TOLERANCE): boolean {
	for (let k = 1; k < points.length; k++) {
		const a = points[k - 1]!;
		const b = points[k]!;
		if (b.yieldM3Day < a.yieldM3Day - 2 * tolerance * Math.max(a.yieldM3Day, b.yieldM3Day) - 1e-6) return false;
	}
	return true;
}
