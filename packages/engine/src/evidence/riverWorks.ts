// What a run's model takes from the river, for the evidence report's two
// licensing checks (issue #54, #90 Q15 and Q16; docs/evidence-pack.md § What
// stops issue): every river abstraction a run rests on has a capacity, and the
// application's own new or changed river abstraction keeps a hands-off flow or
// the EWR. Exploring stays unrestricted: nothing here gates a model save or a
// run, only what a pack may be issued on. Pure; reads the runs' stored models.
import { cropRiverShareOf } from '../network/cropSupply';
import type { NetworkNode, ProjectModel, Transfer } from '../project';
import type { OpClass } from '../scenario/overrides';
import type { ScenarioOp } from '../scenario/ops';
import { toEpochDay } from '../calendar';
import { damPresence } from '../network/development';
import { onRiverDam } from '../network/supply';
import { transferRatesM3s } from '../network/transferRates';

/**
 * One river abstraction in a model:
 * - `pump`: a unit's river pump under river first, trigger or run of river (model.md §2.7e);
 * - `divert`: River to dam, filling a unit's dam from the river (§2.7);
 * - `noDam`: a unit without a dam (none entered, or none on some day of the run: not in service yet,
 *   or filled with sediment, §2.7g) under any rule but run of river: what its dam split and River to
 *   dam route "into the dam" is irrigated straight from the river, the upstream and runoff shares with
 *   no limit, past any pump capacity (b023's stand-in for a river pump, §2.7e, §2.7h);
 * - `user`: an other water user, which always takes from the river where it sits (§2.7c);
 * - `offtake`: a river off-take (a transfer rule with source 'river', §2.6a);
 * - `abstraction`: a demand's own river abstraction beside a unit's dam, the crops' or a demand
 *   object's (engine ≥ 1.65.0, §2.7j), with its own pump; it keeps the unit's hands-off flow.
 */
export interface RiverWorks {
	kind: 'pump' | 'divert' | 'noDam' | 'user' | 'offtake' | 'abstraction';
	/** The node's id, or the transfer rule's; an abstraction's is `<node id>/<'crops' or the object's id>`. */
	id: string;
	/** `abstraction` only: its unit's id. */
	nodeId?: string;
	/** The node's name; for an off-take, its source's and destination's ("Upper → Canal head"). */
	name: string;
	/** Its take has a limit: a pump capacity (a size ≥ 0), River to dam's capacity, or an off-take's rate. */
	bounded: boolean;
	/**
	 * It leaves the EWR, or a set flow, in the river before taking anything, in every month it can
	 * take: the EWR kept (`handsOffEwr`), a hands-off flow above 0 in each such month, or, for a
	 * river pump, a pass-inflow dam release (the pump keeps its target, §2.7e). Never for an other
	 * water user, which the engine can't give one.
	 */
	protectsEwr: boolean;
	/** `noDam` only: the unit has a dam on other days of the run (it comes into service, or fills with sediment, inside it). */
	someDays?: boolean;
}

/** The run a model is read for: its first and last day. Without it, a dam counts as there throughout and every unit as abstracting. */
export interface RiverWorksWindow {
	startDate: string;
	endDate: string;
}

const RIVER_PUMP_RULES: ReadonlySet<string> = new Set(['riverFirst', 'trigger', 'runOfRiver']);

const size = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const above0 = (x: unknown): boolean => size(x) && x > 0;
/** A 12-value water-year row (Oct–Sep): the indices with a value above 0 (a value the run reads as 0, not a number, isn't). */
const monthsOn = (v: unknown): boolean[] | null => (Array.isArray(v) ? Array.from({ length: 12 }, (_, i) => above0(v[i])) : null);

/** The farm keeps the EWR, or a hands-off flow above 0 in every month `on` marks (all 12 when null) (§2.7h). */
function handsOffCovers(n: NetworkNode, on: readonly boolean[] | null): boolean {
	if (n.handsOffEwr === true) return true;
	const kept = monthsOn(n.handsOffM3Day);
	return !!kept && kept.every((k, i) => k || (on !== null && !on[i]));
}

/** A pass-inflow release keeps its target (the EWR at the node, or the monthly amounts) below the dam, and the river pump leaves it (§2.7e). */
function passInflowCovers(n: NetworkNode): boolean {
	if (n.damReleaseRule !== 'passInflow' || !(n.damCapacityM3 > 0)) return false;
	const m = monthsOn(n.damReleaseM3Day);
	return m === null || m.every(Boolean);
}

/** The unit has demand to take water for: a crop area, or an enabled demand object. */
function hasDemand(model: Pick<ProjectModel, 'cropAreas' | 'demandObjects'>, nodeId: string): boolean {
	return (model.cropAreas ?? []).some((a) => a.nodeId === nodeId && a.areaM2 > 0) || (model.demandObjects ?? []).some((o) => o.nodeId === nodeId && o.enabled !== false);
}

/** The river abstractions of one node (none for a gauge, or for a node that takes nothing from the river in the run). */
export function nodeRiverWorks(n: NetworkNode, model: Pick<ProjectModel, 'cropAreas' | 'demandObjects'>, window?: RiverWorksWindow): RiverWorks[] {
	const out: RiverWorks[] = [];
	// A unit whose abstraction starts after the run (§2.7g) takes nothing in it.
	if (window && typeof n.abstractionFrom === 'string' && toEpochDay(n.abstractionFrom) > toEpochDay(window.endDate)) return out;
	if (n.kind === 'user') {
		// 0 = no river pump: it takes nothing from the river.
		if (monthsOn(n.userDemandM3Day)?.some(Boolean) && n.pumpCapacityM3Day !== 0) out.push({ kind: 'user', id: n.id, name: n.name, bounded: size(n.pumpCapacityM3Day), protectsEwr: false });
		return out;
	}
	if (n.kind !== 'farm') return out;
	const demand = hasDemand(model, n.id);
	const dam = damPresence(n, window ? { start: toEpochDay(window.startDate), end: toEpochDay(window.endDate) } : undefined);
	const rule = n.supplyRule ?? 'damFirst';
	// The run reads null / absent / not a size ≥ 0 as no limit (network/supply.ts supplyOf); 0 = no river pump. It pumps only for demand.
	if (RIVER_PUMP_RULES.has(rule) && n.pumpCapacityM3Day !== 0 && demand)
		out.push({ kind: 'pump', id: n.id, name: n.name, bounded: size(n.pumpCapacityM3Day), protectsEwr: handsOffCovers(n, null) || passInflowCovers(n) });
	const divertOn = Array.isArray(n.divertMonthlyM3Day) ? monthsOn(n.divertMonthlyM3Day) : null;
	// A dam on the river takes no River to dam (engine ≥ 1.68.0, network/supply.ts onRiverDam).
	const divert = !onRiverDam(n) && (divertOn ? divertOn.some(Boolean) : above0(n.divertCapacityM3Day));
	// Run of river zeroes the split and River to dam (simulate.ts); any other rule keeps them.
	const split = rule !== 'runOfRiver';
	if (split && dam.ever && divert) out.push({ kind: 'divert', id: n.id, name: n.name, bounded: true, protectsEwr: handsOffCovers(n, divertOn) });
	// A pass-inflow release doesn't count here: on a day with no dam it releases out of K + M + O only up to its
	// target, a partial keep the check doesn't credit (the conservative side: it stops issue, never passes one).
	const routed = above0(n.pctUpstreamToDam) || above0(n.pctRunoffToDam);
	if (split && !dam.always && (routed || divert) && demand) out.push({ kind: 'noDam', id: n.id, name: n.name, bounded: !routed, protectsEwr: handsOffCovers(n, null), ...(dam.ever ? { someDays: true } : {}) });
	// Each demand's own river abstraction (engine ≥ 1.65.0, §2.7j): only for demand it has; a pump of 0 takes nothing.
	const take = (key: string, label: string, pump: unknown) => {
		if (pump !== 0) out.push({ kind: 'abstraction', id: `${n.id}/${key}`, nodeId: n.id, name: `${n.name}: ${label}`, bounded: size(pump), protectsEwr: handsOffCovers(n, null) });
	};
	// Under a crop supply table (engine ≥ 1.73.0) the crops take from the river when the table gives it a share.
	if (cropRiverShareOf(n) > 0 && (model.cropAreas ?? []).some((a) => a.nodeId === n.id && a.areaM2 > 0)) take('crops', 'crops', n.cropRiverPumpM3Day);
	for (const o of model.demandObjects ?? []) if (o.nodeId === n.id && o.enabled !== false && o.waterSource === 'river') take(o.id, o.name, o.riverPumpM3Day);
	return out;
}

/** A river off-take, when the rule is one that can take anything (enabled, a rate above 0 in some month); else null. */
export function offtakeRiverWorks(t: Transfer, nodes: readonly Pick<NetworkNode, 'id' | 'name'>[]): RiverWorks | null {
	if (t.source !== 'river' || t.enabled === false) return null;
	const rates = transferRatesM3s(t);
	if (rates.every((r) => r <= 0)) return null;
	const nameOf = (id: string) => nodes.find((x) => x.id === id)?.name ?? id;
	return {
		kind: 'offtake',
		id: t.id,
		name: `${nameOf(t.fromNodeId)} → ${nameOf(t.toNodeId)}`,
		// Its capacity is the month's rate × 86 400, capped by the daily cap (§2.6a): always a limit unless a rate isn't a number.
		bounded: size(t.dailyCapM3) || rates.every(size),
		// One hands-off flow for every month (§2.6a); one the run reads as none (not a number ≥ 0) isn't one.
		protectsEwr: t.handsOffEwr === true || above0(t.handsOffM3Day)
	};
}

/** Every river abstraction in a model, nodes in model order, then off-takes. */
export function riverWorks(model: Pick<ProjectModel, 'nodes' | 'cropAreas' | 'demandObjects' | 'transfers'>, window?: RiverWorksWindow): RiverWorks[] {
	const nodes = model.nodes ?? [];
	return [...nodes.flatMap((n) => nodeRiverWorks(n, model, window)), ...(model.transfers ?? []).flatMap((t) => offtakeRiverWorks(t, nodes) ?? [])];
}

/** The river abstractions with no limit but the river's flow. */
export function unboundedRiverWorks(model: Pick<ProjectModel, 'nodes' | 'cropAreas' | 'demandObjects' | 'transfers'>, window?: RiverWorksWindow): RiverWorks[] {
	return riverWorks(model, window).filter((w) => !w.bounded);
}

/** What `riverWorksTouched` reads to find the unit an op works on by id: the model the op met, and the application's. */
export type RiverWorksLookup = Pick<ProjectModel, 'demandObjects' | 'boreholes' | 'transfers' | 'allocations' | 'cropAreas'>;

/**
 * The nodes and off-takes whose river abstraction a proposal op adds or may
 * raise. Nodes: a new one, any field of one but its name (its supply rule,
 * pump, River to dam, dam, hands-off flow or efficiency), its crop areas, a
 * crop the scenario added (on every unit growing it), its demand objects
 * (any field but a label: name, note, source), demand raised on it, its
 * abstraction point moved, a borehole removed from it (the river covers
 * what the borehole did), a dam transfer into it removed, its registered
 * volume set or removed (a cap lifted). Off-takes: one added or changed.
 * Not counted: a borehole added (its own pump and capacity; its stream
 * depletion is a lagged share of what it pumps, §2.7d, not a take a
 * hands-off flow binds), an off-take or a unit removed (less is taken),
 * and a rule from a dam added (not the river).
 */
export function riverWorksTouched(op: ScenarioOp, model: RiverWorksLookup): { nodeIds: string[]; transferIds: string[] } {
	const none = { nodeIds: [] as string[], transferIds: [] as string[] };
	const nodes = (...ids: (string | null | undefined)[]) => ({ nodeIds: ids.filter((x): x is string => typeof x === 'string'), transferIds: [] as string[] });
	switch (op.op) {
		case 'node.set':
			return op.field === 'name' ? none : nodes(op.nodeId);
		case 'node.add':
		case 'node.insert':
			return nodes(op.node.id);
		case 'node.move':
			return nodes(op.nodeId);
		case 'cropArea.set':
			return nodes(op.nodeId);
		case 'crop.set':
			return op.field === 'name' ? none : nodes(...(model.cropAreas ?? []).filter((a) => a.cropId === op.cropId).map((a) => a.nodeId));
		case 'demandObject.add':
			return nodes(op.demandObject.nodeId);
		case 'demandObject.set': {
			if (op.field === 'name' || op.field === 'note' || op.field === 'source') return none;
			return nodes((model.demandObjects ?? []).find((x) => x.id === op.demandObjectId)?.nodeId);
		}
		case 'demand.scale':
			return op.factor > 1 && op.nodeIds ? nodes(...op.nodeIds) : none;
		case 'borehole.remove':
			return nodes((model.boreholes ?? []).find((x) => x.id === op.boreholeId)?.nodeId);
		case 'transfer.remove': {
			const t = (model.transfers ?? []).find((x) => x.id === op.transferId);
			return t && t.source !== 'river' ? nodes(t.toNodeId) : none;
		}
		case 'allocation.set':
			return nodes(op.allocation.nodeId, (model.allocations ?? []).find((x) => x.id === op.allocation.id)?.nodeId);
		case 'allocation.remove':
			return nodes((model.allocations ?? []).find((x) => x.id === op.allocationId)?.nodeId);
		case 'transfer.add':
			return { nodeIds: [], transferIds: [op.transfer.id] };
		case 'transfer.set':
			return { nodeIds: [], transferIds: [op.transferId] };
		default:
			return none;
	}
}

/**
 * The river abstractions the application's proposals add or change, as the
 * application ran them: each listed once, with whether it keeps a hands-off
 * flow or the EWR. Only ops classified as proposals count: a baseline
 * assumption already stops issue (the `assumptions` check), and the
 * baseline's own users are current use, which the check leaves as modelled.
 * `before` is the model the ops met (the baseline's), to find what an op
 * names by id; `after` the application's.
 */
export function proposedRiverWorks(
	ops: readonly ScenarioOp[],
	classified: readonly OpClass[],
	before: RiverWorksLookup,
	after: Pick<ProjectModel, 'nodes' | 'cropAreas' | 'demandObjects' | 'transfers'> & RiverWorksLookup,
	window?: RiverWorksWindow
): RiverWorks[] {
	const nodeIds = new Set<string>();
	const transferIds = new Set<string>();
	// What an op finds by id: the model it met (an item it removes), then the application's (one an earlier op added).
	const both = <T>(x: readonly T[] | undefined | null, y: readonly T[] | undefined | null): T[] => [...(x ?? []), ...(y ?? [])];
	const known: RiverWorksLookup = {
		demandObjects: both(before.demandObjects, after.demandObjects),
		boreholes: both(before.boreholes, after.boreholes),
		transfers: both(before.transfers, after.transfers),
		allocations: both(before.allocations, after.allocations),
		cropAreas: after.cropAreas
	};
	ops.forEach((op, i) => {
		if (classified[i] !== 'proposal') return;
		const t = riverWorksTouched(op, known);
		for (const id of t.nodeIds) nodeIds.add(id);
		for (const id of t.transferIds) transferIds.add(id);
	});
	return riverWorks(after, window).filter((w) => (w.kind === 'offtake' ? transferIds.has(w.id) : nodeIds.has(w.nodeId ?? w.id)));
}

/** A river abstraction in words: "Upper's river pump", "the off-take Upper → Canal". */
export function riverWorksName(w: RiverWorks): string {
	switch (w.kind) {
		case 'pump':
			return `${w.name}’s river pump`;
		case 'divert':
			return `${w.name}’s River to dam`;
		case 'noDam':
			return `${w.name} (no dam${w.someDays ? ' on some days of the run' : ''}: irrigated straight from the river)`;
		case 'user':
			return `${w.name} (other water user)`;
		case 'offtake':
			return `the off-take ${w.name}`;
		case 'abstraction':
			return `the river abstraction ${w.name}`;
	}
}
