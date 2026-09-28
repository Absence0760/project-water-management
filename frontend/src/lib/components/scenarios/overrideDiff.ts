// Override mode's pure side (docs/scenarios.md § UI, docs/ui.md § Scenarios):
// the Network, Crops and Transfers editors edit a copy of the scenario's model
// (its base run's snapshot with the scenario's ops applied), and this turns
// the edited copy back into ScenarioOps: node fields → node.set, a crop area →
// cropArea.set, a new node → node.add, a borehole → borehole.add, and so on. Each op is checked with the
// "Add a change" form's own check (ops.ts checkOp: the engine's
// validateScenarioOps), and the whole list is then applied to the model it
// was diffed from (the engine's applyScenario): it must apply cleanly and give
// back the edited model, so an edit is never recorded as something else, and
// an edit no op can express is named rather than dropped. No Svelte, no API.
import {
	NODE_SET_FIELDS,
	TRANSFER_SET_FIELDS,
	applyScenario,
	type CropArea,
	type ModelInput,
	type NetworkNode,
	type NodeSetField,
	type ProjectModel,
	type ScenarioOp,
	type TransferSetField
} from '@water-management/engine';
import { NODE_FIELD_SPECS, TRANSFER_FIELD_SPECS } from './fields';
import { checkOp, nameIds, namesOf } from './ops';

export interface OverrideDiff {
	/** The edits as ops, in an order that applies (new crops and nodes before what refers to them). */
	ops: ScenarioOp[];
	/** Edits no op can express (a node moved, a crop's factors…), in words. Nothing is recorded while there are any. */
	unsupported: string[];
	/** An op the engine refuses, or a list that doesn't apply or doesn't give back the edited model. */
	problems: string[];
}

/** Keys a node carries that no op sets, and aren't its shape: display order only. */
const IGNORED_NODE_KEYS = new Set(['id', 'sortOrder']);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sortedMonths = (ms: readonly number[]) => [...new Set(ms)].sort((a, b) => a - b);
const label = (n: { name: string }) => `“${n.name || 'unnamed node'}”`;
const cropLabel = (c: { name: string }) => `“${c.name || 'unnamed crop'}”`;

/** Crop areas summed per farm and crop (the editor keeps one row each; an old document may have duplicates). */
function areaMap(rows: readonly CropArea[], keep: (a: CropArea) => boolean = () => true): Map<string, number> {
	const m = new Map<string, number>();
	for (const a of rows) if (keep(a)) m.set(`${a.nodeId} ${a.cropId}`, (m.get(`${a.nodeId} ${a.cropId}`) ?? 0) + a.areaM2);
	return m;
}

/**
 * The edits from `before` (the model the editor was loaded with, as a
 * ModelInput with its settings) to `after` (the editor's model), as ops.
 */
export function diffModel(before: ModelInput, after: ProjectModel): OverrideDiff {
	const b = before.model;
	const ops: ScenarioOp[] = [];
	const unsupported: string[] = [];
	const bNodes = new Map(b.nodes.map((n) => [n.id, n]));
	const aNodes = new Map(after.nodes.map((n) => [n.id, n]));
	const bCrops = new Map(b.crops.map((c) => [c.id, c]));
	const aCrops = new Map(after.crops.map((c) => [c.id, c]));

	// --- crops: new ones are crop.add; an existing crop can't be edited or removed by an op yet
	const removedCrops = new Set(b.crops.filter((c) => !aCrops.has(c.id)).map((c) => c.id));
	for (const c of b.crops) {
		const now = aCrops.get(c.id);
		if (!now) unsupported.push(`Removing the crop ${cropLabel(c)}: a scenario can't remove a crop yet. Set its areas to 0 instead.`);
		else if (now.name !== c.name || !same(now.cropFactor, c.cropFactor))
			unsupported.push(`Editing the crop ${cropLabel(c)} (its name or crop factors): a scenario can't change a crop yet. Add a new crop and move the areas to it.`);
	}
	for (const c of after.crops) if (!bCrops.has(c.id)) ops.push({ op: 'crop.add', crop: { id: c.id, name: c.name, cropFactor: [...c.cropFactor] } });

	// --- nodes removed: node.remove (the engine re-links what drained into them, as the editor does)
	const removed = new Set(b.nodes.filter((n) => !aNodes.has(n.id)).map((n) => n.id));
	for (const id of removed) ops.push({ op: 'node.remove', nodeId: id });
	/** Where a kept node drains once the removed nodes are gone: past each removed one to its own downstream node. */
	const relinked = (id: string | null): string | null => {
		let cur = id;
		const seen = new Set<string>();
		while (cur !== null && removed.has(cur) && !seen.has(cur)) {
			seen.add(cur);
			cur = bNodes.get(cur)?.downstreamNodeId ?? null;
		}
		return cur;
	};

	// --- kept nodes: each field a scenario may set is node.set (before any node.add, so a rename frees
	// its old name for a new node), a node's next to each other in its own key order: consecutive node.set
	// ops on one node are one edit group, checked against the save rules once after the last (so a trigger
	// farm can go straight to run of river, its dam emptied, in either order); the network's shape can't change
	for (const n of after.nodes) {
		const was = bNodes.get(n.id);
		if (!was) continue;
		if (n.kind !== was.kind) {
			unsupported.push(`Changing ${label(was)} from a ${was.kind} to a ${n.kind}: a scenario can't change a node's kind. Remove it and add a new node.`);
			continue;
		}
		if (n.downstreamNodeId !== relinked(was.downstreamNodeId))
			unsupported.push(`Moving ${label(n)} (what it drains into): a scenario can't move a node yet. Remove it and add a new one where it should drain.`);
		const settable = new Set<string>(NODE_SET_FIELDS[n.kind]);
		const keys = new Set([...Object.keys(was), ...Object.keys(n)]);
		// A damCapacityM3 op resizes an existing dam's area (or survey curve) along its own relation (engine
		// ≥ 1.10.0, model.md §2.13). The table records what it shows, so the area as shown follows the capacity
		// op; a curve dam's resized curve can't be shown, so its capacity is changed through "Add a change".
		const resized = n.kind === 'farm' && was.damCapacityM3 > 0 && n.damCapacityM3 > 0 && n.damCapacityM3 !== was.damCapacityM3;
		if (resized && was.damCurve?.length)
			unsupported.push(`The capacity of ${label(n)}'s dam, which has a survey curve: a scenario resizes the curve along the dam's own relation, which the table can't show. Add it as a change instead.`);
		for (const k of keys) {
			if (resized && k === 'damAreaFullM2') continue;
			if (IGNORED_NODE_KEYS.has(k) || k === 'kind' || k === 'downstreamNodeId') continue;
			const before = (was as unknown as Record<string, unknown>)[k];
			const now = (n as unknown as Record<string, unknown>)[k];
			if (same(before, now)) continue;
			if (settable.has(k)) ops.push({ op: 'node.set', nodeId: n.id, field: k, value: plain(now ?? null) } as ScenarioOp);
			else if (k === 'damCurve') unsupported.push(`The dam survey curve of ${label(n)}: a scenario can't change a survey curve yet.`);
			else unsupported.push(`${NODE_FIELD_SPECS[k as NodeSetField]?.label ?? k} on ${label(n)}: a scenario can't set that on a ${n.kind}.`);
		}
		if (resized) ops.push({ op: 'node.set', nodeId: n.id, field: 'damAreaFullM2', value: n.damAreaFullM2 ?? null });
	}

	// --- nodes added: node.add, each after the node it drains into
	const pending = after.nodes.filter((n) => !bNodes.has(n.id));
	const placed = new Set(b.nodes.filter((n) => !removed.has(n.id)).map((n) => n.id));
	for (let progress = true; pending.length && progress; ) {
		progress = false;
		for (let i = 0; i < pending.length; i++) {
			const n = pending[i]!;
			if (n.downstreamNodeId !== null && placed.has(n.downstreamNodeId)) {
				ops.push({ op: 'node.add', node: (plain(n)) });
				placed.add(n.id);
				pending.splice(i--, 1);
				progress = true;
			}
		}
	}
	for (const n of pending)
		unsupported.push(
			n.downstreamNodeId === null
				? `The new node ${label(n)} drains nowhere: a scenario's new node drains into an existing one (the catchment keeps its outflow gauge).`
				: `The new node ${label(n)} drains into a node that isn't in the network.`
		);

	// --- crop areas: cropArea.set with the farm's new total of that crop
	const gone = (a: CropArea) => removed.has(a.nodeId) || removedCrops.has(a.cropId);
	const wasArea = areaMap(b.cropAreas, (a) => !gone(a));
	const nowArea = areaMap(after.cropAreas, (a) => !removedCrops.has(a.cropId));
	for (const key of new Set([...wasArea.keys(), ...nowArea.keys()])) {
		const areaM2 = nowArea.get(key) ?? 0;
		if (areaM2 === (wasArea.get(key) ?? 0)) continue;
		const [nodeId, cropId] = key.split(' ') as [string, string];
		ops.push({ op: 'cropArea.set', nodeId, cropId, areaM2 });
	}

	// --- transfers: remove, add, then each changed field
	const bTransfers = new Map(b.transfers.filter((t) => !removed.has(t.fromNodeId) && !removed.has(t.toNodeId)).map((t) => [t.id, t]));
	const aTransfers = new Map(after.transfers.map((t) => [t.id, t]));
	for (const id of bTransfers.keys()) if (!aTransfers.has(id)) ops.push({ op: 'transfer.remove', transferId: id });
	for (const t of after.transfers)
		if (!b.transfers.some((x) => x.id === t.id)) ops.push({ op: 'transfer.add', transfer: { ...plain(t), months: sortedMonths(t.months) } });
	for (const t of after.transfers) {
		const was = bTransfers.get(t.id);
		if (!was) continue;
		// Monthly rates (engine ≥ 1.14.0): one op, which sets the months and max rate kept beside them too,
		// so none of the three is set alone against the others (the save rules refuse the mismatch). Clearing
		// them goes first, then any months or max rate change.
		const nowRates = t.monthlyRateM3s ?? null;
		const ratesChanged = !same(was.monthlyRateM3s ?? null, nowRates);
		if (ratesChanged) ops.push({ op: 'transfer.set', transferId: t.id, field: 'monthlyRateM3s', value: plain(nowRates) } as ScenarioOp);
		for (const f of TRANSFER_SET_FIELDS) {
			if (f === 'monthlyRateM3s' || (ratesChanged && nowRates && (f === 'months' || f === 'maxRateM3s'))) continue;
			const nowV = f === 'months' ? sortedMonths(t.months) : t[f];
			const wasV = f === 'months' ? sortedMonths(was.months) : was[f];
			if (!same(wasV, nowV)) ops.push({ op: 'transfer.set', transferId: t.id, field: f, value: plain(nowV) } as ScenarioOp);
		}
	}

	// --- land cover: remove, add; a patch changed in place is removed and added again
	const bCover = new Map((b.landCover ?? []).filter((p) => !removed.has(p.nodeId)).map((p) => [p.id, p]));
	const aCover = new Map((after.landCover ?? []).map((p) => [p.id, p]));
	const changedCover = [...aCover.values()].filter((p) => bCover.has(p.id) && !same(bCover.get(p.id), p));
	for (const id of bCover.keys()) if (!aCover.has(id) || changedCover.some((p) => p.id === id)) ops.push({ op: 'landCover.remove', patchId: id });
	for (const p of aCover.values()) if (!bCover.has(p.id) || changedCover.includes(p)) ops.push({ op: 'landCover.add', patch: (plain(p)) });

	// --- individual boreholes (WP-3.9): as land cover, a borehole edited in place is removed and added again
	const bBores = new Map((b.boreholes ?? []).filter((x) => !removed.has(x.nodeId)).map((x) => [x.id, x]));
	const aBores = new Map((after.boreholes ?? []).map((x) => [x.id, x]));
	const changedBores = [...aBores.values()].filter((x) => bBores.has(x.id) && !same(bBores.get(x.id), x));
	for (const id of bBores.keys()) if (!aBores.has(id) || changedBores.some((x) => x.id === id)) ops.push({ op: 'borehole.remove', boreholeId: id });
	for (const x of aBores.values()) if (!bBores.has(x.id) || changedBores.includes(x)) ops.push({ op: 'borehole.add', borehole: plain(x) });

	// --- demand objects (engine ≥ 1.7.0): no scenario op adds, changes or removes one yet (a follow-up), so an edit can't be recorded
	{
		const key = (xs: readonly { nodeId: string }[] | undefined) => JSON.stringify((xs ?? []).filter((x) => !removed.has(x.nodeId)).map((x) => plain(x)).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)));
		if (key(b.demandObjects) !== key(after.demandObjects)) unsupported.push("Adding, changing or removing a demand object: a scenario can't change demand objects yet. Change them on the catchment.");
	}

	// --- each op through the form's check, then the whole list against the model it came from
	const problems: string[] = [];
	// The name before the edit wins (an edit may be the name being cleared).
	const names = namesOf([after, b]);
	for (const op of ops) {
		const spec = op.op === 'node.set' ? NODE_FIELD_SPECS[op.field as NodeSetField]?.spec : op.op === 'transfer.set' ? TRANSFER_FIELD_SPECS[op.field as TransferSetField]?.spec : null;
		const c = checkOp(op, spec ?? null);
		if (!c.ok) problems.push(`${whereOf(op, names)}: ${c.error}`);
	}
	if (!problems.length && !unsupported.length && ops.length) {
		const applied = applyScenario(before, ops);
		for (const p of applied.problems) problems.push(nameIds(p, names));
		if (!applied.problems.length && !sameModel(applied.input.model, after))
			problems.push("These edits don't come out the same when recorded as changes, so they can't be recorded. Discard them and make them one at a time.");
	}
	return { ops, unsupported, problems };
}

/** A plain deep copy (JSON: what the API stores anyway). */
function plain<T>(v: T): T {
	return JSON.parse(JSON.stringify(v)) as T;
}

function whereOf(op: ScenarioOp, names: ReadonlyMap<string, string>): string {
	const nm = (id: string) => `“${names.get(id) || 'unnamed'}”`;
	switch (op.op) {
		case 'node.set':
			return `${nm(op.nodeId)}, ${NODE_FIELD_SPECS[op.field as NodeSetField]?.label ?? op.field}`;
		case 'node.add':
			return `The new node ${nm(op.node.id)}`;
		case 'cropArea.set':
			return `${nm(op.nodeId)}, ${nm(op.cropId)}`;
		case 'crop.add':
			return `The new crop ${nm(op.crop.id)}`;
		case 'transfer.add':
		case 'transfer.set':
			return `A transfer${op.op === 'transfer.set' ? `, ${TRANSFER_FIELD_SPECS[op.field as TransferSetField]?.label ?? op.field}` : ''}`;
		case 'landCover.add':
			return `Land cover on ${nm(op.patch.nodeId)}`;
		case 'borehole.add':
			return `The borehole “${op.borehole.name || 'unnamed'}” on ${nm(op.borehole.nodeId)}`;
		default:
			return 'A change';
	}
}

/**
 * The same model for a scenario's purposes: the same nodes, crops, transfers
 * and land cover by id with the same values, crop areas summed per farm and
 * crop, months as sets. Array order and sortOrder (display only) are ignored.
 */
function sameModel(x: ProjectModel, y: ProjectModel): boolean {
	const norm = (m: ProjectModel) => {
		const byId = <T extends { id: string }>(xs: readonly T[], f: (t: T) => unknown) =>
			[...xs].sort((a, b) => (a.id < b.id ? -1 : 1)).map(f);
		const node = (n: NetworkNode) => {
			const o = Object.fromEntries(Object.entries(plain(n)).filter(([k, v]) => v !== undefined && v !== null && k !== 'sortOrder'));
			return Object.keys(o)
				.sort()
				.map((k) => [k, o[k]]);
		};
		return JSON.stringify({
			nodes: byId(m.nodes, node),
			crops: byId(m.crops, (c) => [c.id, c.name, c.cropFactor]),
			areas: [...areaMap(m.cropAreas)].filter(([, v]) => v !== 0).sort(),
			transfers: byId(m.transfers, (t) => [t.id, t.fromNodeId, t.toNodeId, sortedMonths(t.months), t.maxRateM3s, t.dailyCapM3, t.minStoragePct, t.enabled, t.priority, t.monthlyRateM3s ?? null, t.source ?? 'dam', t.handsOffM3Day ?? null, !!t.handsOffEwr, t.lossPct ?? 0, t.sizing ?? 'demand', !!t.topUpDam]),
			cover: byId(m.landCover ?? [], (p) => [p.id, p.nodeId, p.coverClass, p.areaKm2, p.densityPct, p.factors]),
			boreholes: byId(m.boreholes ?? [], (x) => Object.entries(plain(x)).sort(([k], [l]) => (k < l ? -1 : 1)))
		});
	};
	return norm(x) === norm(y);
}
