// Scenarios (roadmap WP-3.2, docs/scenarios.md): apply an ordered list of
// overrides to a base run's input, and classify each override as the
// applicant's proposal or a change to the baseline assumptions. Pure: the
// backend loads the base input, this transforms plain data, and runModel is
// unchanged. Climate and stochastic transforms (WP-4.11) will sit beside it.
import { toEpochDay } from '../calendar';
import { upgradeLegacyModel, type Borehole, type DailySeries, type LandCoverPatch, type ModelInput, type NetworkNode, type Transfer } from '../project';
import {
	BASELINE_NODE_FIELDS,
	NODE_SET_FIELDS,
	SCALABLE_SERIES_KINDS,
	SERIES_SCALE_MAX,
	isIsoDate,
	nodeAddFieldError,
	nodeFieldError,
	settingsValueError,
	transferFieldError,
	type ScenarioOp
} from './ops';
import { structureIssues } from './structure';

/** An op that was applied, with what it did besides its own edit (re-links, dropped references, days scaled). */
export interface AppliedOp {
	/** Position in the op list (0-based). */
	index: number;
	op: ScenarioOp;
	notes: string[];
}

export interface ScenarioResult {
	/** The base input with every applicable op applied. Unscaled series are shared with the base: treat as read-only. */
	input: ModelInput;
	applied: AppliedOp[];
	/**
	 * One line per op that was skipped, naming it (`op 3 (node.remove): …`):
	 * a missing target, a value out of range, or an edit that would break the
	 * network (a second outflow, a loop, a duplicate name…). A skipped op
	 * changes nothing; later ops still apply.
	 */
	problems: string[];
	/**
	 * With `maskedNames`: the hidden nodes and crops that got their real name
	 * back with a suffix, because an op gave a visible one that name
	 * (`Kliphuis` → `Kliphuis (2)`). For the assessor only; the applicant
	 * never sees a hidden name.
	 */
	renamed: MaskedRename[];
}

/**
 * Names an application's ops must not meet (roadmap WP-3.3, docs/scenarios.md
 * § Applications): node id → the anonymous name the applicant sees it under
 * ("Farm 3"), crop id → likewise. The ops apply to the base with those names
 * in place of the real ones, so no message quotes a hidden name and no
 * rename collides with one; afterwards each hidden node or crop gets its
 * real name back (with a suffix if an op gave a visible one that name). A
 * hidden node an op renamed keeps the op's name.
 */
export interface MaskedNames {
	nodes?: Readonly<Record<string, string>>;
	crops?: Readonly<Record<string, string>>;
}

export interface MaskedRename {
	kind: 'node' | 'crop';
	id: string;
	/** Its real name in the base. */
	name: string;
	/** The name it has in the scenario's input. */
	as: string;
}

export interface ApplyOptions {
	maskedNames?: MaskedNames;
}

type Named = { id: string; name: string };
type Masked = { model: ModelInput['model']; nodes: Map<string, [real: string, mask: string]>; crops: Map<string, [real: string, mask: string]> };

/** A copy of `model` with the masked nodes and crops under their mask names, and what each was called. */
function maskModel(model: ModelInput['model'], names: MaskedNames): Masked {
	const m = cloneData(model);
	const swap = (xs: Named[], masks: Readonly<Record<string, string>> | undefined) => {
		const real = new Map<string, [string, string]>();
		if (!masks) return real;
		for (const x of xs) {
			if (!Object.hasOwn(masks, x.id)) continue;
			real.set(x.id, [x.name, masks[x.id]!]);
			x.name = masks[x.id]!;
		}
		return real;
	};
	return { model: m, nodes: swap(m.nodes, names.nodes), crops: swap(m.crops, names.crops) };
}

const nameKey = (s: string) => s.trim().toLowerCase();

/** Give masked items still under their mask name their real name back, suffixed where a visible one now has it. */
function unmask(xs: Named[], real: Map<string, [string, string]>, kind: MaskedRename['kind'], out: MaskedRename[]) {
	const hidden = (x: Named) => real.has(x.id) && x.name === real.get(x.id)![1];
	const visible = new Set(xs.filter((x) => !hidden(x)).map((x) => nameKey(x.name)));
	const taken = new Set([...visible, ...xs.filter(hidden).map((x) => nameKey(real.get(x.id)![0]))]);
	for (const x of xs) {
		if (!hidden(x)) continue;
		const name = real.get(x.id)![0];
		if (!visible.has(nameKey(name))) {
			x.name = name;
			continue;
		}
		let k = 2;
		while (taken.has(nameKey(`${name} (${k})`))) k++;
		x.name = `${name} (${k})`;
		taken.add(nameKey(x.name));
		out.push({ kind, id: x.id, name, as: x.name });
	}
}

class OpError extends Error {}
const fail = (msg: string): never => {
	throw new OpError(msg);
};

/** Deep copy of plain data (settings and the model document are JSON). */
function cloneData<T>(v: T): T {
	if (Array.isArray(v)) return v.map(cloneData) as T;
	if (v && typeof v === 'object') {
		const o: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) o[k] = cloneData(x);
		return o as T;
	}
	return v;
}

/** A calendar-month list as a sorted set (the engine and compare read months as a set). */
const monthSet = (ms: readonly number[]) => [...new Set(ms)].sort((a, b) => a - b);

type Draft = ModelInput;

function findNode(d: Draft, nodeId: string): NetworkNode {
	return d.model.nodes.find((n) => n.id === nodeId) ?? fail(`node ${nodeId} not found`);
}
function findTransfer(d: Draft, transferId: string): Transfer {
	return d.model.transfers.find((t) => t.id === transferId) ?? fail(`transfer ${transferId} not found`);
}

function applyOne(d: Draft, op: ScenarioOp): string[] {
	const notes: string[] = [];
	const m = d.model;
	switch (op.op) {
		case 'node.set': {
			const n = findNode(d, op.nodeId);
			if (!(NODE_SET_FIELDS[n.kind] as readonly string[]).includes(op.field)) fail(`"${op.field}" can't be set on a ${n.kind}`);
			const e = nodeFieldError(op.field, op.value);
			if (e) fail(`${op.field} ${e}`);
			(n as unknown as Record<string, unknown>)[op.field] = op.field === 'name' ? (op.value as string).trim() : cloneData(op.value);
			break;
		}
		case 'node.add': {
			const raw = op.node as unknown as Record<string, unknown>;
			for (const k of ['id', 'name', 'kind', 'downstreamNodeId'] as const) if (typeof raw?.[k] !== 'string') fail(`the new node needs a ${k}`);
			if (m.nodes.some((n) => n.id === op.node.id)) fail(`node id ${op.node.id} is already in use`);
			if (!m.nodes.some((n) => n.id === op.node.downstreamNodeId)) fail(`the new node drains into unknown node ${op.node.downstreamNodeId}`);
			for (const [k, v] of Object.entries(raw)) {
				if (['id', 'name', 'kind', 'downstreamNodeId'].includes(k)) continue;
				if (k === 'sortOrder') {
					if (!Number.isInteger(v)) fail('the new node\'s sortOrder must be a whole number');
					continue;
				}
				const e = nodeAddFieldError(k, v);
				if (e) fail(`the new node's ${k} ${e}`);
			}
			const [node] = upgradeLegacyModel({ nodes: [cloneData(op.node)] }).nodes as NetworkNode[];
			node!.name = node!.name.trim();
			node!.sortOrder ??= m.nodes.length;
			m.nodes.push(node!);
			break;
		}
		case 'node.remove': {
			const n = findNode(d, op.nodeId);
			if (n.downstreamNodeId === null) fail(`"${n.name}" is the outflow node and can't be removed`);
			for (const u of m.nodes) {
				if (u.downstreamNodeId !== n.id) continue;
				u.downstreamNodeId = n.downstreamNodeId;
				notes.push(`"${u.name}" now drains into ${n.downstreamNodeId}`);
			}
			m.nodes = m.nodes.filter((x) => x.id !== n.id);
			const drop = <T>(xs: T[], gone: (x: T) => boolean, what: string): T[] => {
				const kept = xs.filter((x) => !gone(x));
				if (kept.length < xs.length) notes.push(`dropped ${xs.length - kept.length} ${what}`);
				return kept;
			};
			m.cropAreas = drop(m.cropAreas, (a) => a.nodeId === n.id, 'crop area(s)');
			m.transfers = drop(m.transfers, (t) => t.fromNodeId === n.id || t.toNodeId === n.id, 'transfer(s)');
			if (m.landCover) m.landCover = drop(m.landCover, (p) => p.nodeId === n.id, 'land-cover patch(es)');
			if (m.boreholes) m.boreholes = drop(m.boreholes, (b) => b.nodeId === n.id, 'borehole(s)');
			if (Array.isArray(d.settings.ewrRules)) {
				d.settings.ewrRules = drop(d.settings.ewrRules, (t) => t?.siteNodeId === n.id, 'EWR rule table(s) sited there');
			}
			break;
		}
		case 'cropArea.set': {
			const n = findNode(d, op.nodeId);
			if (n.kind !== 'farm') fail(`crops grow on farms; "${n.name}" is a ${n.kind}`);
			if (!m.crops.some((c) => c.id === op.cropId)) fail(`crop ${op.cropId} not found`);
			if (!(Number.isFinite(op.areaM2) && op.areaM2 >= 0)) fail('areaM2 must be a finite number ≥ 0');
			const at = m.cropAreas.findIndex((a) => a.nodeId === op.nodeId && a.cropId === op.cropId);
			const rest = m.cropAreas.filter((a) => !(a.nodeId === op.nodeId && a.cropId === op.cropId));
			if (op.areaM2 > 0) rest.splice(at < 0 ? rest.length : at, 0, { nodeId: op.nodeId, cropId: op.cropId, areaM2: op.areaM2 });
			m.cropAreas = rest;
			break;
		}
		case 'crop.add': {
			const c = op.crop;
			if (typeof c?.id !== 'string' || typeof c.name !== 'string') fail('the new crop needs an id and a name');
			if (m.crops.some((x) => x.id === c.id)) fail(`crop id ${c.id} is already in use`);
			if (!(Array.isArray(c.cropFactor) && c.cropFactor.length === 12 && c.cropFactor.every((v) => Number.isFinite(v) && v >= 0)))
				fail('a crop needs 12 crop factors ≥ 0');
			m.crops.push({ ...cloneData(c), name: c.name.trim() });
			break;
		}
		case 'transfer.add': {
			const t = op.transfer;
			if (typeof t?.id !== 'string') fail('the new transfer needs an id');
			if (m.transfers.some((x) => x.id === t.id)) fail(`transfer id ${t.id} is already in use`);
			for (const k of ['fromNodeId', 'toNodeId'] as const) if (!m.nodes.some((n) => n.id === t[k])) fail(`${k} ${t[k]} not found`);
			for (const k of ['months', 'maxRateM3s', 'dailyCapM3', 'minStoragePct', 'enabled', 'priority'] as const) {
				const e = transferFieldError(k, t[k]);
				if (e) fail(`${k} ${e}`);
			}
			m.transfers.push({ ...cloneData(t), months: monthSet(t.months) });
			break;
		}
		case 'transfer.set': {
			const t = findTransfer(d, op.transferId);
			const e = transferFieldError(op.field, op.value);
			if (e) fail(`${op.field} ${e}`);
			if ((op.field === 'fromNodeId' || op.field === 'toNodeId') && !m.nodes.some((n) => n.id === op.value)) fail(`node ${String(op.value)} not found`);
			(t as unknown as Record<string, unknown>)[op.field] = op.field === 'months' ? monthSet(op.value as number[]) : cloneData(op.value);
			break;
		}
		case 'transfer.remove': {
			findTransfer(d, op.transferId);
			m.transfers = m.transfers.filter((t) => t.id !== op.transferId);
			break;
		}
		case 'landCover.add': {
			const p = op.patch;
			if (typeof p?.id !== 'string') fail('the new patch needs an id');
			if ((m.landCover ?? []).some((x) => x.id === p.id)) fail(`land-cover id ${p.id} is already in use`);
			const n = findNode(d, p.nodeId);
			if (n.kind !== 'farm') fail(`land cover lies on a farm; "${n.name}" is a ${n.kind}`);
			m.landCover = [...(m.landCover ?? []), cloneData(p) as LandCoverPatch];
			break;
		}
		case 'landCover.remove': {
			if (!(m.landCover ?? []).some((p) => p.id === op.patchId)) fail(`land-cover patch ${op.patchId} not found`);
			m.landCover = m.landCover!.filter((p) => p.id !== op.patchId);
			break;
		}
		case 'borehole.add': {
			const b = op.borehole;
			if (typeof b?.id !== 'string') fail('the new borehole needs an id');
			if ((m.boreholes ?? []).some((x) => x.id === b.id)) fail(`borehole id ${b.id} is already in use`);
			const n = findNode(d, b.nodeId);
			if (n.kind === 'gauge') fail(`a borehole supplies a farm or other user; "${n.name}" is a gauge`);
			m.boreholes = [...(m.boreholes ?? []), cloneData(b) as Borehole];
			break;
		}
		case 'borehole.remove': {
			if (!(m.boreholes ?? []).some((b) => b.id === op.boreholeId)) fail(`borehole ${op.boreholeId} not found`);
			m.boreholes = m.boreholes!.filter((b) => b.id !== op.boreholeId);
			break;
		}
		case 'settings.set': {
			const e = settingsValueError(op.path, op.value);
			if (e) fail(`${op.path} ${e}`);
			const value = op.path === 'calibration.summerMonths' ? monthSet(op.value as number[]) : cloneData(op.value);
			const [head, leaf] = op.path.split('.') as [string, string | undefined];
			const s = d.settings as Record<string, unknown>;
			if (leaf === undefined) s[head] = value;
			else {
				const cur = s[head];
				s[head] = { ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}), [leaf]: value };
			}
			break;
		}
		case 'series.scale': {
			if (!(SCALABLE_SERIES_KINDS as readonly string[]).includes(op.kind)) fail(`${op.kind} can't be scaled`);
			if (!(Number.isFinite(op.factor) && op.factor >= 0 && op.factor <= SERIES_SCALE_MAX)) fail(`factor must be 0–${SERIES_SCALE_MAX}`);
			for (const k of ['from', 'to'] as const) if (op[k] !== undefined && !isIsoDate(op[k])) fail(`${k} must be an ISO date`);
			const s = d.series[op.kind] ?? fail(`the base has no ${op.kind} series`);
			const start = toEpochDay(s.startDate);
			const a = op.from === undefined ? 0 : Math.max(0, toEpochDay(op.from) - start);
			const b = op.to === undefined ? s.values.length - 1 : Math.min(s.values.length - 1, toEpochDay(op.to) - start);
			if (a > b) fail(`no day of ${op.kind} falls in ${op.from ?? 'its start'} – ${op.to ?? 'its end'}`);
			const values = s.values.slice();
			let n = 0;
			for (let t = a; t <= b; t++) {
				const v = values[t];
				if (v === null || v === undefined) continue;
				values[t] = v * op.factor;
				n++;
			}
			d.series = { ...d.series, [op.kind]: { startDate: s.startDate, values } satisfies DailySeries };
			notes.push(`${n} day(s) scaled`);
			break;
		}
		default:
			fail(`unknown op ${(op as { op?: unknown }).op as string}`);
	}
	return notes;
}

/**
 * Apply `ops` to `base` in order. Never mutates `base` (settings and the
 * model are deep-copied; a series is copied only when an op scales it). An
 * op whose target is missing, whose value is out of range, or which would
 * leave the network invalid is skipped and reported in `problems`, never
 * thrown; the ops after it still apply. docs/scenarios.md has the rules.
 */
export function applyScenario(base: ModelInput, ops: readonly ScenarioOp[], options: ApplyOptions = {}): ScenarioResult {
	const masked = options.maskedNames ? maskModel(base.model, options.maskedNames) : null;
	let cur: ModelInput = { settings: cloneData(base.settings), model: masked?.model ?? cloneData(base.model), series: { ...base.series } };
	let issues = structureIssues(cur);
	const applied: AppliedOp[] = [];
	const problems: string[] = [];
	ops.forEach((op, index) => {
		const label = `op ${index + 1} (${typeof op?.op === 'string' ? op.op : 'unknown'})`;
		const draft: ModelInput = { settings: cloneData(cur.settings), model: cloneData(cur.model), series: cur.series };
		let notes: string[];
		try {
			notes = applyOne(draft, op);
		} catch (e) {
			if (!(e instanceof OpError)) throw e;
			problems.push(`${label}: ${e.message}`);
			return;
		}
		const after = structureIssues(draft);
		const introduced = [...after].filter(([k]) => !issues.has(k)).map(([, text]) => text);
		if (introduced.length) {
			problems.push(`${label}: ${introduced.join('; ')}`);
			return;
		}
		cur = draft;
		issues = after;
		applied.push({ index, op, notes });
	});
	const renamed: MaskedRename[] = [];
	if (masked) {
		unmask(cur.model.nodes, masked.nodes, 'node', renamed);
		unmask(cur.model.crops, masked.crops, 'crop', renamed);
	}
	return { input: cur, applied, problems, renamed };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type OpClass = 'proposal' | 'baseline';

/** A gauge (an EWR site), or a node with land or a manual flow share: part of how the catchment's runoff is split. */
const sharesRunoff = (n: NetworkNode) => n.kind === 'gauge' || n.areaKm2 > 0 || n.areaHiKm2 > 0 || n.areaLoKm2 > 0 || n.flowShareManual != null;

/**
 * Is this op the applicant's proposal, or a change to the baseline
 * assumptions an assessor must see called out? docs/scenarios.md
 * § Classification has the rules. Conservative: anything it can't place is
 * 'baseline'.
 *
 * `ownedNodeIds` are the applicant's own nodes, plus any the scenario added
 * (classifyScenario adds those for you). `input` is the input the op applies
 * to; ops that target a transfer or land-cover patch by id, or remove a node,
 * need it to see which nodes they touch, and are 'baseline' without it.
 */
export function classifyOp(op: ScenarioOp, ownedNodeIds: Iterable<string>, input?: ModelInput): OpClass {
	const owned = ownedNodeIds instanceof Set ? (ownedNodeIds as Set<string>) : new Set(ownedNodeIds);
	const mine = (id: string | undefined | null) => typeof id === 'string' && owned.has(id);
	const ok = (x: boolean): OpClass => (x ? 'proposal' : 'baseline');
	switch (op.op) {
		case 'settings.set':
		case 'series.scale':
			return 'baseline';
		case 'node.set':
			return ok(mine(op.nodeId) && !BASELINE_NODE_FIELDS.includes(op.field));
		case 'node.add':
			// A new gauge moves an EWR site; a new node with land or a manual flow share re-partitions the catchment's runoff.
			return ok(!sharesRunoff(op.node));
		case 'node.remove': {
			const n = input?.model.nodes.find((x) => x.id === op.nodeId);
			// Removing a node also drops any EWR rule table sited at it.
			const ewrSite = Array.isArray(input?.settings.ewrRules) && input.settings.ewrRules.some((t) => t?.siteNodeId === op.nodeId);
			return ok(mine(op.nodeId) && !!n && !sharesRunoff(n) && !ewrSite);
		}
		case 'cropArea.set':
			return ok(mine(op.nodeId));
		case 'crop.add':
			return 'proposal';
		case 'transfer.add':
			return ok(mine(op.transfer.fromNodeId) && mine(op.transfer.toNodeId));
		case 'transfer.set': {
			const t = input?.model.transfers.find((x) => x.id === op.transferId);
			const newEnd = op.field === 'fromNodeId' || op.field === 'toNodeId' ? mine(op.value as string) : true;
			return ok(!!t && mine(t.fromNodeId) && mine(t.toNodeId) && newEnd);
		}
		case 'transfer.remove': {
			const t = input?.model.transfers.find((x) => x.id === op.transferId);
			return ok(!!t && mine(t.fromNodeId) && mine(t.toNodeId));
		}
		case 'landCover.add':
			return ok(mine(op.patch.nodeId));
		case 'landCover.remove': {
			const p = input?.model.landCover?.find((x) => x.id === op.patchId);
			return ok(!!p && mine(p.nodeId));
		}
		case 'borehole.add':
			return ok(mine(op.borehole.nodeId));
		case 'borehole.remove': {
			const b = input?.model.boreholes?.find((x) => x.id === op.boreholeId);
			return ok(!!b && mine(b.nodeId));
		}
		default:
			return 'baseline';
	}
}

/**
 * Classify every op of a scenario against the input each one meets: the base
 * with the earlier ops applied, and nodes the scenario added counted as
 * owned. A skipped op (see applyScenario) is classified against the input it
 * would have met.
 */
export function classifyScenario(base: ModelInput, ops: readonly ScenarioOp[], ownedNodeIds: Iterable<string>, options: ApplyOptions = {}): OpClass[] {
	const owned = new Set(ownedNodeIds);
	// Masked once up front: each op below meets the names applyScenario's would.
	let cur = options.maskedNames ? { ...base, model: maskModel(base.model, options.maskedNames).model } : base;
	return ops.map((op) => {
		const c = classifyOp(op, owned, cur);
		const r = applyScenario(cur, [op]);
		if (r.applied.length && op.op === 'node.add') owned.add(op.node.id);
		cur = r.input;
		return c;
	});
}
