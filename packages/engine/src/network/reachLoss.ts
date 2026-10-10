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

/** A reach's losses as the simulation runs them: the share f (0 < f ≤ 1) and the daily cap (m³/day; Infinity = none). */
export interface PlanReachLoss {
	frac: number;
	maxM3Day: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The bed losses of the reach below node `n` (absent = none): its share
 * clamped to [0, REACH_LOSS_FRAC_MAX] and its cap (null / absent = none;
 * not a size ≥ 0 = none, with a warning). Nothing for the outlet, which has
 * no reach below it in the model (warned when set), for a share of 0 or a
 * cap of 0. A share above REACH_LOSS_FRAC_WARN with no cap runs, with a
 * warning.
 */
export function reachLossOf(n: NetworkNode, warnings: string[]): { reachLoss?: PlanReachLoss } {
	const raw = n.reachLossFrac;
	if (raw === undefined || raw === null || raw === 0) return {};
	const where = `${n.kind === 'farm' ? 'unit' : n.kind} "${n.name}"`;
	if (n.downstreamNodeId === null) {
		warnings.push(`${where}: bed losses below the outlet are ignored (the model has no reach below it)`);
		return {};
	}
	const frac = finite(raw) ? Math.min(Math.max(raw, 0), REACH_LOSS_FRAC_MAX) : 0;
	if (frac !== raw) warnings.push(`${where}: bed losses ${String(raw)} of the flow are not in [0, ${REACH_LOSS_FRAC_MAX}]; using ${frac}`);
	const cap = n.reachLossMaxM3Day;
	let maxM3Day = Infinity;
	if (cap !== null && cap !== undefined) {
		if (finite(cap) && cap >= 0) maxM3Day = cap;
		else warnings.push(`${where}: bed losses cap ${String(cap)} m³/day is not a size ≥ 0; no cap`);
	}
	if (!(frac > 0) || !(maxM3Day > 0)) return {};
	if (frac > REACH_LOSS_FRAC_WARN && maxM3Day === Infinity)
		warnings.push(`${where}: more than half the flow lost in the reach below it; check this is meant (with a cap this is how WRSM's Bedloss is expressed)`);
	return { reachLoss: { frac, maxM3Day } };
}

/** The day's loss in the reach on a flow `q` leaving the node: MIN(cap, f × q, q), 0 for no flow. */
export function reachLossDay(p: PlanReachLoss, q: number): number {
	if (!(q > 0)) return 0;
	const l = p.frac * q;
	return l < p.maxM3Day ? l : p.maxM3Day;
}

/**
 * What must leave the node for `x` to arrive at the bottom of the reach: the
 * inverse of q − reachLossDay(q), MIN(x / (1 − f), x + cap). Since the
 * arriving flow never falls as q rises, a node passing at least this much
 * delivers at least x. A reach that loses all of any flow (f = 1, no cap)
 * delivers nothing whatever is passed, so the claim isn't grossed up (x
 * itself) rather than asking upstream to pass an unbounded flow.
 */
export function reachGross(p: PlanReachLoss, x: number): number {
	if (!(x > 0)) return x;
	if (p.frac >= 1) return p.maxM3Day === Infinity ? x : x + p.maxM3Day;
	const a = x / (1 - p.frac);
	const b = x + p.maxM3Day;
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
 */
export function routeNatural(r: NaturalReaches, own: (i: number, t: number) => number, days: number, at: readonly number[]): Float64Array<ArrayBuffer>[] {
	const q = new Float64Array(r.reach.length);
	const out = at.map(() => new Float64Array(days));
	for (let t = 0; t < days; t++) {
		for (let k = 0; k < r.order.length; k++) {
			const i = r.order[k]!;
			let s = own(i, t);
			const ups = r.upstream[i]!;
			for (let j = 0; j < ups.length; j++) {
				const u = ups[j]!;
				const v = q[u]!;
				const p = r.reach[u];
				s += p ? v - reachLossDay(p, v) : v;
			}
			q[i] = s;
		}
		for (let a = 0; a < at.length; a++) out[a]![t] = q[at[a]!]!;
	}
	return out;
}
