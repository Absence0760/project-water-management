// River off-takes (engine ≥ 1.14.0, issue #54, docs/model.md §2.6a): a
// transfer rule with `source: 'river'` takes water from the river's flow as it
// leaves the source unit today (after that unit's own use, returns and spill),
// not from the source's dam, and carries it to the destination unit. There it
// meets the unit's demand first, then (with `topUpDam`) fills its dam, and the
// rest flows on down the destination's river. It is limited by its capacity
// (MIN(max rate × 86 400, daily cap), and the month's own capacity when one is
// set), by the flow there, and by what must stay in the river: the senior
// users' requirement passing the source, a hands-off flow and, when asked,
// the EWR at the source. A share of what it takes (conveyance losses) never
// arrives. Pure; the plan (../run.ts), the simulation (./simulate.ts) and the
// self-checks (../verify/checks.ts) read a rule through these functions, so a
// stored rule means the same thing to each.
import { cmpStr } from '../order';
import type { NetworkNode, Transfer } from '../project';
import { transferDailyLimit } from './transferRates';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The run series a river off-take leaves (engine ≥ 1.14.0): on the source,
 * what the off-takes took from the flow leaving it (and each rule's own
 * volume under `transfer_rule@<rule id>`, ./transferSeries.ts); on the
 * destination, what arrived, and of it what met the demand directly and what
 * went into the dam (the rest flowed on).
 */
export const OFFTAKE_SERIES = {
	out: { key: 'offtake_out', label: 'Taken by river off-takes from the flow leaving this unit (before conveyance losses)' },
	in: { key: 'offtake_in', label: 'Delivered by river off-takes into this unit (after conveyance losses)' },
	used: { key: 'offtake_used', label: 'River off-take water that met the demand directly (part of supplied)' },
	toDam: { key: 'offtake_to_dam', label: 'River off-take water that went into the dam' },
	rule: (toName: string) => `Taken from the river for ${toName} by one off-take (before conveyance losses)`
} as const;

/** A river off-take as the simulation runs it. */
export interface PlanOfftake {
	/** The rule's id. */
	id: string;
	/** The run series key of the volume it takes (`transfer_rule@<rule id>`, ./transferSeries.ts); absent for a rule that can never take water. */
	seriesKey?: string;
	/** Source and destination node indices (both farms). */
	from: number;
	to: number;
	/** Capacity today by calendar month (index 1–12, m³/day); 0 in a month the rule doesn't run. */
	capM3Day: Float64Array;
	/** Hands-off flow left below the source (m³/day), 0 = none. */
	handsOffM3Day: number;
	/** Also leave the EWR at the source (its cumulative requirement Z). */
	handsOffEwr: boolean;
	/** Conveyance loss share, 0 ≤ l < 1. */
	loss: number;
	/** 0 = sized to the destination's need, 1 = up to capacity. */
	sizing: 0 | 1;
	topUpDam: boolean;
	/** Lower takes first at its source; equal priorities share the flow pro rata to their limits. */
	priority: number;
}

/** Is this rule a river off-take? */
export const isRiverOfftake = (tr: Pick<Transfer, 'source'>): boolean => tr.source === 'river';

/**
 * The river off-take a rule runs as, or why it can't run. Its ends must be two
 * different farms (checked by the caller, as for a dam transfer). Values out
 * of range run clamped with a warning: a loss outside [0, 1) as 0, a hands-off
 * flow that isn't a number ≥ 0 as none.
 */
export function offtakeOf(tr: Transfer, from: number, to: number, fromName: string, toName: string, warnings: string[]): Omit<PlanOfftake, 'seriesKey' | 'id'> {
	const who = `river off-take ${fromName} → ${toName}`;
	let loss = tr.lossPct ?? 0;
	if (!(finite(loss) && loss >= 0 && loss < 1)) {
		warnings.push(`${who}: conveyance loss ${String(loss)} is outside [0, 1); using 0`);
		loss = 0;
	}
	let handsOff = tr.handsOffM3Day ?? 0;
	if (!(finite(handsOff) && handsOff >= 0)) {
		warnings.push(`${who}: hands-off flow ${String(handsOff)} m³/day is not a size ≥ 0; none`);
		handsOff = 0;
	}
	const sizing = tr.sizing === 'capacity' ? 1 : 0;
	if (tr.sizing !== undefined && tr.sizing !== 'capacity' && tr.sizing !== 'demand') warnings.push(`${who}: unknown sizing "${String(tr.sizing)}"; sized to the destination's need`);
	return {
		from,
		to,
		capM3Day: transferDailyLimit(tr),
		handsOffM3Day: handsOff,
		handsOffEwr: tr.handsOffEwr === true,
		loss,
		sizing,
		topUpDam: tr.topUpDam === true,
		priority: Number.isFinite(tr.priority) ? tr.priority : 0
	};
}

/**
 * Can `target` be reached from `start` going downstream along the river or
 * along an accepted off-take (from → to)? An off-take whose destination
 * reaches its own source this way would need the destination's flow before
 * the source's, which a same-day off-take can't have.
 */
function reaches(start: number, target: number, downstream: Int32Array, extra: readonly (readonly number[])[]): boolean {
	const seen = new Uint8Array(downstream.length);
	const stack = [start];
	while (stack.length) {
		const i = stack.pop()!;
		if (i === target) return true;
		if (seen[i]) continue;
		seen[i] = 1;
		if (downstream[i]! >= 0) stack.push(downstream[i]!);
		for (const j of extra[i]!) stack.push(j);
	}
	return false;
}

/**
 * The river off-takes a model runs, from its enabled `source: 'river'` rules
 * in id order. Skipped with a warning: an end that doesn't exist or isn't a
 * farm, a rule from a unit to itself, and one whose destination drains into
 * its source (directly, or through the river off-takes accepted before it),
 * since the destination is simulated after its source each day.
 */
export function planOfftakes(
	transfers: readonly Transfer[],
	nodes: readonly Pick<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId'>[],
	warnings: string[],
	seriesKey: (tr: Transfer) => string | undefined
): PlanOfftake[] {
	const rules = transfers.filter((tr) => tr.enabled && isRiverOfftake(tr)).sort((a, b) => cmpStr(a.id, b.id));
	if (!rules.length) return [];
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const downstream = Int32Array.from(nodes, (n) => (n.downstreamNodeId === null ? -1 : (index.get(n.downstreamNodeId) ?? -1)));
	const extra: number[][] = nodes.map(() => []);
	const out: PlanOfftake[] = [];
	for (const tr of rules) {
		const from = index.get(tr.fromNodeId);
		const to = index.get(tr.toNodeId);
		if (from === undefined || to === undefined) {
			warnings.push(`river off-take ${tr.id} references a node that does not exist; skipped`);
			continue;
		}
		const a = nodes[from]!;
		const b = nodes[to]!;
		if (a.kind !== 'farm' || b.kind !== 'farm' || from === to) {
			warnings.push(`river off-take ${a.name} → ${b.name}: an off-take runs from one unit to another; skipped`);
			continue;
		}
		if (reaches(to, from, downstream, extra)) {
			warnings.push(`river off-take ${a.name} → ${b.name}: its destination drains into its source, so the water would be taken before it arrives; skipped`);
			continue;
		}
		extra[from]!.push(to);
		const key = seriesKey(tr);
		out.push({ id: tr.id, ...(key ? { seriesKey: key } : {}), ...offtakeOf(tr, from, to, a.name, b.name, warnings) });
	}
	return out;
}

/**
 * The calculation order with every off-take's destination after its source:
 * `order` (every node after its upstream nodes) with the off-take links added,
 * keeping `order`'s own sequence wherever the links allow (a node is placed as
 * soon as all its upstream nodes and off-take sources are). Without off-takes
 * it is `order` itself. planOfftakes has already dropped any off-take that
 * would close a loop.
 */
export function offtakeOrder(order: Int32Array, upstream: readonly ArrayLike<number>[], offtakes: readonly PlanOfftake[]): Int32Array {
	if (!offtakes.length) return order;
	const n = order.length;
	const waits = new Int32Array(n);
	const after: number[][] = Array.from({ length: n }, () => []);
	for (let i = 0; i < n; i++) {
		const ups = upstream[i]!;
		for (let k = 0; k < ups.length; k++) {
			waits[i]!++;
			after[ups[k]!]!.push(i);
		}
	}
	for (const o of offtakes) {
		waits[o.to]!++;
		after[o.from]!.push(o.to);
	}
	const pos = new Int32Array(n);
	order.forEach((node, k) => (pos[node] = k));
	const ready: number[] = [];
	for (let i = 0; i < n; i++) if (waits[i] === 0) ready.push(i);
	const out: number[] = [];
	while (ready.length) {
		// The ready node earliest in `order` (networks are small; a linear scan is enough).
		let best = 0;
		for (let k = 1; k < ready.length; k++) if (pos[ready[k]!]! < pos[ready[best]!]!) best = k;
		const i = ready.splice(best, 1)[0]!;
		out.push(i);
		for (const j of after[i]!) if (--waits[j]! === 0) ready.push(j);
	}
	if (out.length !== n) throw new Error('river off-takes form a loop with the network (planOfftakes should have dropped it)');
	return Int32Array.from(out);
}
