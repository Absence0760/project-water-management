// River bed (channel transmission) losses (engine ≥ 1.75.0, issue #444,
// docs/model.md §2.6b): a share of the flow a node passes downstream is lost
// in the reach between it and the next node, into the river bed and banks,
// up to a daily cap:
//
//   loss_t = MIN(cap, f × Q_t, Q_t),   arriving_t = Q_t − loss_t
//
// with Q_t the node's outflow U. The lost water leaves the system, as the
// Pitman/WRSM2000 channel module's Bedloss does (WR2012 User Manual, TT
// 689/16 §6.2.3.1): it doesn't become groundwater and doesn't come back to
// the network. The loss is never negative, never decreases as the flow
// rises and is never more than the flow (eWater Source practice note on
// losses). f = 1 with cap = Bedloss × 10⁶ ÷ days in the month is WRSM's fixed
// monthly Bedloss, MIN(Bedloss, flow), exactly. f = 0, the default, is no loss and no plan entry, so every model
// without it runs to the bit as before. Pure; the plan (../run.ts), the
// simulation (./simulate.ts) and the self-checks (../verify/checks.ts) read a
// reach through these functions, so a stored setting means the same to each.
import type { NetworkNode } from '../project';
import { baseflowRunoff, type PlanBaseflow } from './baseflow';
import { waterYearIndex } from '../calendar';

/** Water-year month names (Oct–Sep), for the warnings. */
const MONTH_NAMES = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'] as const;

/** The largest share of the flow a reach may lose (docs/model.md §2.6b): all of it, up to the cap (WRSM's Bedloss). */
export const REACH_LOSS_FRAC_MAX = 1;

/** Above this share without a cap the run warns (docs/model.md §2.6b): more than half the flow lost is rarely meant. */
export const REACH_LOSS_FRAC_WARN = 0.5;

/** The run series a node with bed losses in the reach below it leaves (any kind of node but the outlet). */
export const REACH_LOSS_SERIES = {
	key: 'reach_loss',
	label: 'Bed losses in the reach below (leave the catchment)',
	unit: 'm³/day'
} as const;

/**
 * On the same node, when priority users' claims cross the reach: what their
 * gross-up added for its losses (engine ≥ 1.75.0), so the node below receives
 * the priority requirement less this (docs/model.md §2.6b).
 */
export const SENIOR_REACH_LOSS_SERIES = {
	key: 'senior_reach_loss',
	label: 'Priority users’ demand lost in the reach below (their claims were grossed up for it)',
	unit: 'm³/day'
} as const;

/**
 * A reach's losses as the simulation runs them, by calendar month (index
 * 1–12; 0 unused): the share f (0 ≤ f ≤ 1) and the daily cap (m³/day;
 * Infinity = none). Set by month (engine 1.116.0) or the one setting copied
 * into every month; a month with f = 0 or a cap of 0 loses nothing.
 */
export interface PlanReachLoss {
	frac: Float64Array;
	maxM3Day: Float64Array;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const MONTHS = 12;

/**
 * The bed losses of the reach below node `n` (absent = none): its share by
 * month (`reachLossFracMonthly`, else `reachLossFrac` all year) clamped to
 * [0, REACH_LOSS_FRAC_MAX], and its cap by month (`reachLossMaxMonthlyM3Day`,
 * else `reachLossMaxM3Day` all year; null / absent = none; not a size ≥ 0 =
 * none, with a warning). Nothing for the outlet, which has no reach below it
 * in the model (warned when set), or when no month loses anything. A month's
 * share above REACH_LOSS_FRAC_WARN with no cap runs, with a warning.
 */
export function reachLossOf(n: NetworkNode, warnings: string[]): { reachLoss?: PlanReachLoss } {
	const fracRow = Array.isArray(n.reachLossFracMonthly) ? n.reachLossFracMonthly : null;
	const capRow = Array.isArray(n.reachLossMaxMonthlyM3Day) ? n.reachLossMaxMonthlyM3Day : null;
	const raw = n.reachLossFrac;
	const anyFrac = fracRow ? fracRow.some((v) => v !== 0 && v !== null && v !== undefined) : raw !== undefined && raw !== null && raw !== 0;
	if (!anyFrac) return {};
	const where = `${n.kind === 'farm' ? 'unit' : n.kind} "${n.name}"`;
	if (n.downstreamNodeId === null) {
		warnings.push(`${where}: bed losses below the outlet are ignored (the model has no reach below it)`);
		return {};
	}
	const clampFrac = (v: unknown, what: string): number => {
		if (v === undefined || v === null || v === 0) return 0;
		const f = finite(v) ? Math.min(Math.max(v, 0), REACH_LOSS_FRAC_MAX) : 0;
		if (f !== v) warnings.push(`${where}: bed losses ${String(v)} of the flow${what} are not in [0, ${REACH_LOSS_FRAC_MAX}]; using ${f}`);
		return f;
	};
	const capOf = (v: unknown, what: string): number => {
		if (v === null || v === undefined) return Infinity;
		if (finite(v) && v >= 0) return v;
		warnings.push(`${where}: bed losses cap ${String(v)} m³/day${what} is not a size ≥ 0; no cap`);
		return Infinity;
	};
	if (fracRow && fracRow.length !== MONTHS) warnings.push(`${where}: bed losses by month should have 12 monthly shares, has ${fracRow.length}; missing months are 0`);
	if (capRow && capRow.length !== MONTHS) warnings.push(`${where}: bed losses cap by month should have 12 monthly caps, has ${capRow.length}; missing months have no cap`);
	const frac = new Float64Array(MONTHS + 1);
	const maxM3Day = new Float64Array(MONTHS + 1);
	const one = fracRow ? 0 : clampFrac(raw, '');
	const oneCap = capRow ? Infinity : capOf(n.reachLossMaxM3Day, '');
	let any = false;
	let wide = false;
	for (let m = 1; m <= MONTHS; m++) {
		const wy = waterYearIndex(m);
		frac[m] = fracRow ? clampFrac(fracRow[wy], ` in ${MONTH_NAMES[wy]}`) : one;
		maxM3Day[m] = capRow ? capOf(capRow[wy], ` in ${MONTH_NAMES[wy]}`) : oneCap;
		if (frac[m]! > 0 && maxM3Day[m]! > 0) any = true;
		if (frac[m]! > REACH_LOSS_FRAC_WARN && maxM3Day[m] === Infinity) wide = true;
	}
	if (!any) return {};
	if (wide) warnings.push(`${where}: more than half the flow lost in the reach below it; check this is meant (with a cap this is how WRSM's Bedloss is expressed)`);
	return { reachLoss: { frac, maxM3Day } };
}

/** The day's loss in the reach on a flow `q` leaving the node in calendar month `m` (1–12): MIN(cap, f × q, q), 0 for no flow. */
export function reachLossDay(p: PlanReachLoss, q: number, m: number): number {
	if (!(q > 0)) return 0;
	const l = p.frac[m]! * q;
	const cap = p.maxM3Day[m]!;
	return l < cap ? l : cap;
}

/**
 * What must leave the node in calendar month `m` for `x` to arrive at the
 * bottom of the reach: the inverse of q − reachLossDay(q), MIN(x / (1 − f),
 * x + cap). Since the arriving flow never falls as q rises, a node passing at
 * least this much delivers at least x. A reach that loses all of any flow
 * (f = 1, no cap) delivers nothing whatever is passed, so the claim isn't
 * grossed up (x itself) rather than asking upstream to pass an unbounded
 * flow.
 */
export function reachGross(p: PlanReachLoss, x: number, m: number): number {
	if (!(x > 0)) return x;
	const f = p.frac[m]!;
	const cap = p.maxM3Day[m]!;
	if (f >= 1) return cap === Infinity ? x : x + cap;
	const a = x / (1 - f);
	const b = x + cap;
	return a < b ? a : b;
}

/**
 * Does any reach of the model lose flow (engine ≥ 1.76.0)? reachLossOf's own
 * test, without its warnings: for the parts of a run decided before the plan
 * is built (the WR2012 check waits for it when a reach loses).
 */
export function hasReachLosses(nodes: readonly NetworkNode[]): boolean {
	const quiet: string[] = [];
	return nodes.some((n) => reachLossOf(n, quiet).reachLoss !== undefined);
}

/** A network as the natural flow crosses it: no dam and no use, only each reach's bed losses. */
export interface NaturalReaches {
	/** Every node after the nodes draining into it. */
	order: ArrayLike<number>;
	/** upstream[i] = the nodes draining directly into node i, in a fixed order (node id), so the sums don't depend on the listing. */
	upstream: readonly ArrayLike<number>[];
	/** The bed losses of the reach below each node (absent = none). */
	reach: readonly (PlanReachLoss | undefined)[];
	/** Calendar month (1–12) of each day, for losses set by month (engine 1.116.0). */
	month: ArrayLike<number>;
	/**
	 * Each unit's base-flow loss and gain (engine 1.86.0, ./baseflow.ts),
	 * absent = none: its own runoff is taken through baseflowRunoff before it
	 * joins the river, as in the simulation. Absent on a model without them.
	 */
	baseflow?: readonly (PlanBaseflow | undefined)[];
}

/**
 * The natural flow at each node of `at`, net of the natural bed losses of the
 * reaches above it (engine ≥ 1.76.0, docs/model.md §2.6b): each node passes
 * its own natural runoff `own(i, t)` and what arrives from the nodes above,
 * and each reach loses reachLossDay of the natural flow entering it, as the
 * river would with nothing built or taken. A node's own reach, below it, is
 * not taken off its flow. This is the flow a Reserve rule table's natural
 * curve and the WR2012 comparison read when bed losses are on: WRSM's
 * naturalised flows are net of its Bedloss, so a site's natural flow has to
 * be too, or a site below a losing reach falls short with nothing built.
 * A unit's base-flow loss and gain (engine 1.86.0) are the land's too, so
 * its own runoff crosses them first (`r.baseflow`).
 */
export function routeNatural(r: NaturalReaches, own: (i: number, t: number) => number, days: number, at: readonly number[]): Float64Array<ArrayBuffer>[] {
	const q = new Float64Array(r.reach.length);
	const out = at.map(() => new Float64Array(days));
	for (let t = 0; t < days; t++) {
		const m = r.month[t]!;
		for (let k = 0; k < r.order.length; k++) {
			const i = r.order[k]!;
			let s = own(i, t);
			const bf = r.baseflow?.[i];
			if (bf) s = baseflowRunoff(bf, s, m);
			const ups = r.upstream[i]!;
			for (let j = 0; j < ups.length; j++) {
				const u = ups[j]!;
				const v = q[u]!;
				const p = r.reach[u];
				s += p ? v - reachLossDay(p, v, m) : v;
			}
			q[i] = s;
		}
		for (let a = 0; a < at.length; a++) out[a]![t] = q[at[a]!]!;
	}
	return out;
}
