// River off-takes (engine ≥ 1.14.0, issue #54, docs/model.md §2.6a): a
// transfer rule with `source: 'river'` takes water from the river's flow as it
// leaves the source unit today (after that unit's own use, returns and spill),
// not from the source's dam, and carries it to the destination unit. There it
// meets the unit's demand first, then (with `topUpDam`) fills its dam, and the
// rest flows on down the destination's river. It is limited by its capacity
// (MIN(max rate × 86 400, daily cap), and the month's own capacity when one is
// set), by the flow there, and by what must stay in the river: the senior
// users' requirement passing the source, the target of a pass-inflow
// release on the source's dam (engine ≥ 1.70.0), a hands-off flow and, when
// asked, the EWR at the source. A share of what it takes (conveyance losses) never
// arrives; a share of those losses may seep back to the river the same day
// below the source or a farm downstream of it (engine ≥ 1.42.0). Pure; the plan (../run.ts), the simulation (./simulate.ts) and the
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
	/** On the unit the returned seepage rejoins below (engine ≥ 1.42.0): part of its outflow. */
	returned: { key: 'offtake_loss_return', label: 'River off-takes’ conveyance losses seeping back to the river below this unit (part of the outflow)' },
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
	/** Share of the losses that seeps back to the river the same day, 0 ≤ r ≤ 1 (engine ≥ 1.42.0); 0 = all lost. */
	lossReturn: number;
	/** Node index of the farm whose outflow the returned seepage joins: the source or one downstream of it along the river. */
	returnAt: number;
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
	let lossReturn = tr.lossReturnPct ?? 0;
	if (!(finite(lossReturn) && lossReturn >= 0 && lossReturn <= 1)) {
		warnings.push(`${who}: share of the conveyance losses returning ${String(lossReturn)} is outside [0, 1]; none returns`);
		lossReturn = 0;
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
		lossReturn: loss > 0 ? lossReturn : 0,
		returnAt: from,
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
export function reaches(start: number, target: number, downstream: Int32Array, extra: readonly (readonly number[])[]): boolean {
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
 * Where a river off-take's returned seepage rejoins the river (engine ≥
 * 1.42.0): the node index of `tr.lossReturnNodeId`, or `from` when it is
 * null / absent. Only the source or a farm downstream of it along the river
 * qualifies: the seepage reaches the river below the off-take, and a unit
 * below the source is simulated after it, so the day's losses are known when
 * the return joins its outflow. Otherwise undefined (the caller returns none).
 */
export function offtakeReturnAt(
	tr: Pick<Transfer, 'lossReturnNodeId'>,
	from: number,
	nodes: readonly Pick<NetworkNode, 'id' | 'kind' | 'downstreamNodeId'>[],
	index: ReadonlyMap<string, number> = new Map(nodes.map((n, i) => [n.id, i]))
): number | undefined {
	const id = tr.lossReturnNodeId;
	if (id === null || id === undefined) return from;
	const at = index.get(id);
	if (at === undefined || nodes[at]!.kind !== 'farm') return undefined;
	const seen = new Set<number>();
	for (let i: number | undefined = from; i !== undefined && !seen.has(i); ) {
		if (i === at) return at;
		seen.add(i);
		const down: string | null = nodes[i]!.downstreamNodeId;
		i = down === null ? undefined : index.get(down);
	}
	return undefined;
}

/**
 * The river off-takes a model runs, from its enabled `source: 'river'` rules
 * in id order. Skipped with a warning: an end that doesn't exist or isn't a
 * farm, a rule from a unit to itself, and one whose destination drains into
 * its source (directly, or through the river off-takes accepted before it),
 * since the destination is simulated after its source each day. A return
 * unit that isn't the source or a farm below it returns nothing, with a
 * warning (engine ≥ 1.42.0).
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
		const o = offtakeOf(tr, from, to, a.name, b.name, warnings);
		if (o.lossReturn > 0) {
			const at = offtakeReturnAt(tr, from, nodes, index);
			if (at === undefined) {
				warnings.push(`river off-take ${a.name} → ${b.name}: its seepage return unit is not ${a.name} or a unit below it on the river; no seepage returns`);
				o.lossReturn = 0;
			} else o.returnAt = at;
		}
		out.push({ id: tr.id, ...(key ? { seriesKey: key } : {}), ...o });
	}
	splitLicenceWarnings(out, nodes, warnings);
	return out;
}

/**
 * Warn about rules that may be one licence entered more than once (engine ≥
 * 1.70.0, issue #90 Q25): two or more planned river off-takes with the same
 * source, the same destination and the same priority, of which at least two
 * run in a common calendar month (capacity above 0 in it). Rules of one
 * priority share a short river in proportion to what each asks, MIN(its
 * capacity, its share of the need), so a licence split into several rules
 * gets what it would as one rule; but one licence entered twice at its full
 * size asks, and takes, twice its licence, and the run can't tell that from
 * two licences on one canal. One warning per group, its rules in id order
 * (the order planOfftakes accepted them in). Pure; `offtakes` as
 * planOfftakes returns them.
 */
export function splitLicenceWarnings(offtakes: readonly PlanOfftake[], nodes: readonly Pick<NetworkNode, 'name'>[], warnings: string[]): void {
	const groups = new Map<string, PlanOfftake[]>();
	for (const o of offtakes) {
		const key = `${o.from}|${o.to}|${o.priority}`;
		const g = groups.get(key);
		if (g) g.push(o);
		else groups.set(key, [o]);
	}
	for (const g of groups.values()) {
		if (g.length < 2) continue;
		// The rules that share a month with another of the group: only they can meet on one day.
		const meet = g.filter((a) => g.some((b) => b !== a && sharesMonth(a.capM3Day, b.capM3Day)));
		if (meet.length < 2) continue;
		const o = meet[0]!;
		warnings.push(
			`river off-take ${nodes[o.from]!.name} → ${nodes[o.to]!.name}: ${meet.length} rules of priority ${o.priority} (${meet.map((x) => x.id).join(', ')}) take from the same river for the same unit. ` +
				'If they are one licence entered more than once at its full size, it takes that many times its licence: enter each licence once (a licence split into parts runs the same as one rule)'
		);
	}
}

const sharesMonth = (a: Float64Array, b: Float64Array): boolean => {
	for (let m = 1; m <= 12; m++) if (a[m]! > 0 && b[m]! > 0) return true;
	return false;
};

/** A river off-take's returned seepage as the EWR attribution counts it (engine ≥ 1.42.0, ./attribution.ts). */
export interface OfftakeReturnLeg {
	/** The off-take's source and destination, and the farm whose outflow the seepage joins. */
	source: number;
	destination: number;
	at: number;
	/** What seeped back each day, v × l × r (m³). */
	volume: Float64Array;
}

/** Each off-take that returns seepage, with what it returned each day, from what it took (`volumes`, in `offtakes` order). */
export function offtakeReturns(offtakes: readonly PlanOfftake[], volumes: readonly ArrayLike<number>[]): OfftakeReturnLeg[] {
	const out: OfftakeReturnLeg[] = [];
	offtakes.forEach((o, k) => {
		if (!(o.lossReturn > 0)) return;
		const v = volumes[k]!;
		out.push({ source: o.from, destination: o.to, at: o.returnAt, volume: Float64Array.from(v, (x) => x * o.loss * o.lossReturn) });
	});
	return out;
}

/**
 * The calculation order with every off-take's destination after its source:
 * `order` (every node after its upstream nodes) with the off-take links added,
 * keeping `order`'s own sequence wherever the links allow (a node is placed as
 * soon as all its upstream nodes and off-take sources are). Without off-takes
 * it is `order` itself. planOfftakes has already dropped any off-take that
 * would close a loop. A crop supply table's remote share (engine ≥ 1.73.0,
 * ./cropSupply.ts) is passed in as a link too, from the supplying dam's unit
 * to the receiving unit; planRemoteSupply drops one that would close a loop.
 */
export function offtakeOrder(order: Int32Array, upstream: readonly ArrayLike<number>[], offtakes: readonly Pick<PlanOfftake, 'from' | 'to'>[]): Int32Array {
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
