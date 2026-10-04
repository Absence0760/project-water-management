// Cumulative impact (roadmap WP-3.11, docs/scenarios.md § Cumulative impact):
// several scenarios' ops on one base input, together. Two scenarios that
// write the same thing, or where one removes what the other uses, conflict:
// the combination is refused with each conflict named, never silently merged
// by letting whichever applies last win. Pure: no I/O, and the base is never
// mutated (applyScenario's own guarantee).
import type { ModelInput, ProjectModel } from '../project';
import type { ScenarioOp } from './ops';
import { applyScenario, type MaskedReId, type MaskedRename, type ScenarioMask } from './overrides';

/** One scenario to combine: its ops and, for an application, the mask its ops are judged under (applyScenario's). */
export interface CombineScenario {
	id: string;
	/** For the messages ("App A" op 3 …); defaults to `scenario N`. */
	name?: string;
	ops: readonly ScenarioOp[];
	mask?: ScenarioMask;
}

/** One side of a conflict: which scenario, which of its ops. */
export interface ConflictSide {
	/** Position in the list given to combineScenarios. */
	scenario: number;
	scenarioId: string;
	/** Position in that scenario's op list (0-based). */
	opIndex: number;
	op: ScenarioOp;
}

export type ConflictReason = 'same_target' | 'removed_in_use';

/**
 * Two scenarios touching one thing in a way the order would decide:
 *  - `same_target`: both write the same field of the same element (or one
 *    adds or replaces an element whole, under an id the other writes);
 *  - `removed_in_use`: `a` removes an element `b` changes or names (a node
 *    another scenario adds a farm below, a crop it plants, a transfer it
 *    resizes).
 */
export interface ScenarioConflict {
	reason: ConflictReason;
	/** The element and field, readable: `node "Upper farm": damCapacityM3`, `settings: gr4j.x1`. */
	target: string;
	a: ConflictSide;
	b: ConflictSide;
	/** One line for the assessor: both ops named and what they collide on. */
	message: string;
}

export interface CombineResult {
	/**
	 * The base with every scenario's ops applied in the order given; null when
	 * the combination is refused (any conflict, or any op that doesn't apply
	 * once the others have).
	 */
	input: ModelInput | null;
	conflicts: ScenarioConflict[];
	/**
	 * Ops that didn't apply in the combination, each line prefixed by its
	 * scenario (`"App B": op 2 (node.add): duplicate node name …`): an op that
	 * applies alone but not on top of the others (two new dams given one
	 * name, flow shares that add up past 100 % together), or one that never
	 * applied. Any line refuses the combination: a result with an op skipped
	 * would not be the scenarios it names.
	 */
	problems: string[];
	/** The masks' renamed and re-identified items, per scenario (applyScenario's), for the assessor only. */
	renamed: MaskedRename[][];
	reIds: MaskedReId[][];
}

/** What one op writes, removes and names. Keys are `<kind>:<id>`; a write may name one field, or none (the whole element). */
interface Touch {
	writes: { entity: string; field: string | null }[];
	removes: string[];
	uses: string[];
}

const node = (id: string) => `node:${id}`;

/** The item's own node(s), in the base or added by an earlier op of the same scenario: what an op on the item depends on. */
function itemNodes(model: ProjectModel, earlier: readonly ScenarioOp[], kind: string, id: string): string[] {
	type Ends = { nodeId?: string | null; fromNodeId?: string; toNodeId?: string; lossReturnNodeId?: string | null };
	const fromModel = (): Ends | undefined => {
		switch (kind) {
			case 'transfer':
				return model.transfers.find((t) => t.id === id);
			case 'landCover':
				return model.landCover?.find((p) => p.id === id);
			case 'borehole':
				return model.boreholes?.find((b) => b.id === id);
			case 'demandObject':
				return model.demandObjects?.find((o) => o.id === id);
			case 'allocation':
				return model.allocations?.find((a) => a.id === id);
		}
		return undefined;
	};
	const fromOps = (): Ends | undefined => {
		for (let i = earlier.length - 1; i >= 0; i--) {
			const op = earlier[i]!;
			if (kind === 'transfer' && op.op === 'transfer.add' && op.transfer.id === id) return op.transfer;
			if (kind === 'landCover' && op.op === 'landCover.add' && op.patch.id === id) return op.patch;
			if (kind === 'borehole' && op.op === 'borehole.add' && op.borehole.id === id) return op.borehole;
			if (kind === 'demandObject' && op.op === 'demandObject.add' && op.demandObject.id === id) return op.demandObject;
			if (kind === 'allocation' && op.op === 'allocation.set' && op.allocation.id === id) return op.allocation;
		}
		return undefined;
	};
	const x: Ends | undefined = fromModel() ?? fromOps();
	if (!x) return [];
	return [x.nodeId, x.fromNodeId, x.toNodeId, x.lossReturnNodeId].filter((v): v is string => typeof v === 'string' && v.length > 0).map(node);
}

/** The farms (or other users) a demand.scale op reaches: its own list, else every node of its category in the base. */
function demandNodes(model: ProjectModel, op: Extract<ScenarioOp, { op: 'demand.scale' }>): string[] {
	if (op.nodeIds?.length) return op.nodeIds;
	const kind = op.category === 'user' ? 'user' : 'farm';
	return model.nodes.filter((n) => n.kind === kind).map((n) => n.id);
}

/**
 * What `op` (the `index`th of its scenario) writes, removes and names. Read
 * against the base model: a node.remove re-links the nodes draining into it
 * there, so it writes their downstream link too, and an op on a transfer,
 * patch, borehole, demand object or registered volume depends on the
 * item's node(s). Conservative by design: what can't be told apart is a
 * conflict, which the assessor sees, rather than an order that silently wins.
 */
function touches(model: ProjectModel, ops: readonly ScenarioOp[], index: number): Touch {
	const op = ops[index]!;
	const earlier = ops.slice(0, index);
	const t: Touch = { writes: [], removes: [], uses: [] };
	const w = (entity: string, field: string | null = null) => t.writes.push({ entity, field });
	const u = (...entities: (string | null | undefined)[]) => {
		for (const e of entities) if (e) t.uses.push(e);
	};
	const nodeUse = (id: string | null | undefined) => (id ? node(id) : null);
	switch (op.op) {
		case 'node.set':
			w(node(op.nodeId), op.field);
			// Engine ≥ 1.72.0: a unit's efficiency puts every planting on the unit on that system, a planting another
			// scenario adds there included (or not, in the other order): every planting on the unit.
			if (op.field === 'irrigationEfficiency') w(`cropArea:${op.nodeId}|*`);
			break;
		case 'node.add':
			w(node(op.node.id));
			u(nodeUse(op.node.downstreamNodeId));
			break;
		case 'node.remove':
			t.removes.push(node(op.nodeId));
			// Its upstream nodes drain into its downstream node instead.
			for (const n of model.nodes) if (n.downstreamNodeId === op.nodeId) w(node(n.id), 'downstreamNodeId');
			break;
		case 'node.move':
			w(node(op.nodeId), 'downstreamNodeId');
			u(node(op.downstreamNodeId));
			break;
		case 'node.insert':
			w(node(op.node.id));
			u(nodeUse(op.node.downstreamNodeId));
			for (const up of op.upstreamNodeIds) w(node(up), 'downstreamNodeId');
			break;
		case 'cropArea.set':
			w(`cropArea:${op.nodeId}|${op.cropId}`);
			u(node(op.nodeId), `crop:${op.cropId}`);
			break;
		case 'crop.add':
			w(`crop:${op.crop.id}`);
			break;
		case 'crop.set':
			w(`crop:${op.cropId}`, op.field);
			// Engine ≥ 1.72.0: a crop's efficiency or system clears each of its plantings' own system: every planting of it.
			if (op.field === 'irrigationEfficiency' || op.field === 'irrigationSystemId') w(`cropArea:*|${op.cropId}`);
			break;
		case 'crop.remove':
			t.removes.push(`crop:${op.cropId}`);
			break;
		case 'transfer.add':
			w(`transfer:${op.transfer.id}`);
			u(nodeUse(op.transfer.fromNodeId), nodeUse(op.transfer.toNodeId), nodeUse(op.transfer.lossReturnNodeId));
			break;
		case 'transfer.set':
			w(`transfer:${op.transferId}`, op.field);
			u(...itemNodes(model, earlier, 'transfer', op.transferId));
			if ((op.field === 'fromNodeId' || op.field === 'toNodeId' || op.field === 'lossReturnNodeId') && typeof op.value === 'string') u(node(op.value));
			break;
		case 'transfer.remove':
			t.removes.push(`transfer:${op.transferId}`);
			u(...itemNodes(model, earlier, 'transfer', op.transferId));
			break;
		case 'landCover.add':
			w(`landCover:${op.patch.id}`);
			u(node(op.patch.nodeId));
			break;
		case 'landCover.set':
			w(`landCover:${op.patchId}`, op.field);
			u(...itemNodes(model, earlier, 'landCover', op.patchId));
			break;
		case 'landCover.remove':
			t.removes.push(`landCover:${op.patchId}`);
			u(...itemNodes(model, earlier, 'landCover', op.patchId));
			break;
		case 'borehole.add':
			w(`borehole:${op.borehole.id}`);
			u(node(op.borehole.nodeId));
			break;
		case 'borehole.remove':
			t.removes.push(`borehole:${op.boreholeId}`);
			u(...itemNodes(model, earlier, 'borehole', op.boreholeId));
			break;
		case 'demandObject.add':
			w(`demandObject:${op.demandObject.id}`);
			u(node(op.demandObject.nodeId));
			break;
		case 'demandObject.set':
			w(`demandObject:${op.demandObjectId}`, op.field);
			u(...itemNodes(model, earlier, 'demandObject', op.demandObjectId));
			break;
		case 'demandObject.remove':
			t.removes.push(`demandObject:${op.demandObjectId}`);
			u(...itemNodes(model, earlier, 'demandObject', op.demandObjectId));
			break;
		case 'settings.set':
			w(`settings:${op.path}`);
			break;
		case 'series.scale':
			// Two scalings of one series stack; whose assumption the climate is, is not for either to settle.
			w(`series:${op.kind}`);
			break;
		case 'demand.scale':
			// Factors stack, but two scenarios cutting one unit's demand would each count the other's cut.
			for (const id of demandNodes(model, op)) {
				w(`demand:${id}`);
				u(node(id));
			}
			break;
		case 'ewrRule.set':
			w(`ewrRule:${op.table.siteNodeId ?? 'outlet'}`);
			u(nodeUse(op.table.siteNodeId));
			break;
		case 'ewrRule.remove':
			t.removes.push(`ewrRule:${op.siteNodeId ?? 'outlet'}`);
			u(nodeUse(op.siteNodeId));
			break;
		case 'allocation.set':
			w(`allocation:${op.allocation.id}`);
			u(nodeUse(op.allocation.nodeId));
			break;
		case 'allocation.remove':
			t.removes.push(`allocation:${op.allocationId}`);
			u(...itemNodes(model, earlier, 'allocation', op.allocationId));
			break;
	}
	return t;
}

/** An element as the assessor reads it: a node or crop by its name in the base (or the op that adds it), anything else by kind and id. */
function label(model: ProjectModel, scenarios: readonly CombineScenario[], entity: string): string {
	const sep = entity.indexOf(':');
	const kind = entity.slice(0, sep);
	const id = entity.slice(sep + 1);
	// An element only the scenarios add goes by the names they give it, sorted, so the label doesn't depend on their order.
	const added = (names: string[], fallback: string) => (names.length ? [...new Set(names)].sort().join('" / "') : fallback);
	const nodeName = (nid: string) => {
		const n = model.nodes.find((x) => x.id === nid);
		if (n) return n.name;
		return added(
			scenarios.flatMap((s) => s.ops.flatMap((op) => ((op.op === 'node.add' || op.op === 'node.insert') && op.node.id === nid ? [op.node.name] : []))),
			nid
		);
	};
	const cropName = (cid: string) => {
		const c = model.crops.find((x) => x.id === cid);
		if (c) return c.name;
		return added(
			scenarios.flatMap((s) => s.ops.flatMap((op) => (op.op === 'crop.add' && op.crop.id === cid ? [op.crop.name] : []))),
			cid
		);
	};
	switch (kind) {
		case 'node':
			return `node "${nodeName(id)}"`;
		case 'crop':
			return `crop "${cropName(id)}"`;
		case 'cropArea': {
			const [n, c] = id.split('|');
			// The patterns (sameEntity) named when two of them meet.
			if (c === '*') return `the plantings on "${nodeName(n ?? '')}"`;
			if (n === '*') return `the plantings of "${cropName(c ?? '')}"`;
			return `crop area of "${cropName(c ?? '')}" on "${nodeName(n ?? '')}"`;
		}
		case 'demand':
			return `demand of "${nodeName(id)}"`;
		case 'settings':
			return 'settings';
		case 'series':
			return `series ${id}`;
		case 'ewrRule':
			return id === 'outlet' ? 'Reserve rule table at the outlet' : `Reserve rule table at "${nodeName(id)}"`;
		case 'landCover':
			return `land-cover patch ${id}`;
		case 'demandObject':
			return `demand object ${id}`;
		case 'allocation':
			return `registered volume ${id}`;
		default:
			return `${kind} ${id}`;
	}
}

/**
 * Do two written entities meet? Equal, or a crop-area pattern (`cropArea:<node>|*`, every planting on a unit;
 * `cropArea:*|<crop>`, every planting of a crop) that covers the other: an op that rewrites all of a unit's or a
 * crop's plantings meets any op on one of them.
 */
function sameEntity(a: string, b: string): boolean {
	if (a === b) return true;
	const p = 'cropArea:';
	if (!a.startsWith(p) || !b.startsWith(p)) return false;
	const [an, ac] = a.slice(p.length).split('|');
	const [bn, bc] = b.slice(p.length).split('|');
	return (an === '*' || bn === '*' || an === bn) && (ac === '*' || bc === '*' || ac === bc);
}

/** Of two meeting entities, the one to name: a concrete planting over a pattern. */
const concrete = (a: string, b: string): string => (a.includes('*') ? b : a);

/**
 * The conflicts between `scenarios` on `base` (module comment): every pair
 * of scenarios, every op of one against every op of the other. One entry per
 * pair of scenarios and target (the first ops that meet there), so a long
 * list of edits to one dam reads once. Ops within one scenario never
 * conflict with each other: they apply in their own order, as they do alone.
 */
export function scenarioConflicts(base: ModelInput, scenarios: readonly CombineScenario[]): ScenarioConflict[] {
	const model = base.model;
	const names = scenarios.map((s, i) => s.name?.trim() || `scenario ${i + 1}`);
	const all = scenarios.map((s) => s.ops.map((_, i) => touches(model, s.ops, i)));
	const out: ScenarioConflict[] = [];
	const seen = new Set<string>();
	const side = (si: number, oi: number): ConflictSide => ({ scenario: si, scenarioId: scenarios[si]!.id, opIndex: oi, op: scenarios[si]!.ops[oi]! });
	const opName = (si: number, oi: number) => `"${names[si]}" op ${oi + 1} (${scenarios[si]!.ops[oi]!.op})`;
	const add = (reason: ConflictReason, entity: string, field: string | null, a: [number, number], b: [number, number], verb = 'change') => {
		const key = `${a[0]}|${b[0]}|${reason}|${entity}|${field ?? ''}`;
		if (seen.has(key)) return;
		seen.add(key);
		const target = entity.startsWith('settings:') ? `settings: ${entity.slice('settings:'.length)}` : `${label(model, scenarios, entity)}${field ? `: ${field}` : ''}`;
		const message =
			reason === 'same_target'
				? `${opName(...a)} and ${opName(...b)} both ${verb} ${target}`
				: `${opName(...a)} removes ${label(model, scenarios, entity)}, which ${opName(...b)} changes or uses`;
		out.push({ reason, target, a: side(...a), b: side(...b), message });
	};
	for (let i = 0; i < scenarios.length; i++) {
		for (let j = i + 1; j < scenarios.length; j++) {
			for (const [oi, ti] of all[i]!.entries()) {
				for (const [oj, tj] of all[j]!.entries()) {
					for (const x of ti.writes)
						for (const y of tj.writes)
							if (sameEntity(x.entity, y.entity) && (x.field === null || y.field === null || x.field === y.field)) add('same_target', concrete(x.entity, y.entity), x.field ?? y.field, [i, oi], [j, oj]);
					const removedInUse = (r: readonly string[], t: Touch, a: [number, number], b: [number, number]) => {
						for (const e of r) {
							if (t.removes.includes(e)) add('same_target', e, null, a, b, 'remove');
							else if (t.uses.includes(e) || t.writes.some((x) => x.entity === e)) add('removed_in_use', e, null, a, b);
						}
					};
					removedInUse(ti.removes, tj, [i, oi], [j, oj]);
					removedInUse(tj.removes, ti, [j, oj], [i, oi]);
				}
			}
		}
	}
	return out;
}

/**
 * Apply several scenarios' ops to one base, in the order given (roadmap
 * WP-3.11). Refused (input null) when any two conflict (scenarioConflicts),
 * or when any op doesn't apply on top of the ones before it (`problems`):
 * never a silent merge. Without conflicts the order doesn't matter to the
 * run (scenario.invariants.test.ts: disjoint scenarios in either order give
 * the same output), and one scenario combined is that scenario alone.
 */
export function combineScenarios(base: ModelInput, scenarios: readonly CombineScenario[]): CombineResult {
	const conflicts = scenarioConflicts(base, scenarios);
	const renamed: MaskedRename[][] = [];
	const reIds: MaskedReId[][] = [];
	if (conflicts.length) return { input: null, conflicts, problems: [], renamed, reIds };
	let cur = base;
	const problems: string[] = [];
	scenarios.forEach((s, i) => {
		const r = applyScenario(cur, s.ops, s.mask ? { mask: s.mask } : {});
		const name = s.name?.trim() || `scenario ${i + 1}`;
		for (const p of r.problems) problems.push(`"${name}": ${p}`);
		renamed.push(r.renamed);
		reIds.push(r.reIds);
		cur = r.input;
	});
	return { input: problems.length ? null : cur, conflicts, problems, renamed, reIds };
}
