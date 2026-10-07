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
// losses). f = 0, the default, is no loss and no plan entry, so every model
// without it runs to the bit as before. Pure; the plan (../run.ts), the
// simulation (./simulate.ts) and the self-checks (../verify/checks.ts) read a
// reach through these functions, so a stored setting means the same to each.
import type { NetworkNode } from '../project';

/** The largest share of the flow a reach may lose (docs/model.md §2.6b): a reach never runs dry from bed losses alone. */
export const REACH_LOSS_FRAC_MAX = 0.5;

/** The run series a node with bed losses in the reach below it leaves (any kind of node but the outlet). */
export const REACH_LOSS_SERIES = {
	key: 'reach_loss',
	label: 'Bed losses in the reach below (leave the catchment)',
	unit: 'm³/day'
} as const;

/**
 * On the same node, when senior users' claims cross the reach: what their
 * gross-up added for its losses (engine ≥ 1.75.0), so the node below receives
 * the senior requirement less this (docs/model.md §2.6b).
 */
export const SENIOR_REACH_LOSS_SERIES = {
	key: 'senior_reach_loss',
	label: 'Senior users’ demand lost in the reach below (their claims were grossed up for it)',
	unit: 'm³/day'
} as const;

/** A reach's losses as the simulation runs them: the share f (0 < f ≤ 0.5) and the daily cap (m³/day; Infinity = none). */
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
 * cap of 0.
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
 * delivers at least x.
 */
export function reachGross(p: PlanReachLoss, x: number): number {
	if (!(x > 0)) return x;
	const a = x / (1 - p.frac);
	const b = x + p.maxM3Day;
	return a < b ? a : b;
}
