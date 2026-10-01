// Scenarios (roadmap WP-3.2, docs/scenarios.md): apply an ordered list of
// overrides to a base run's input, and classify each override as the
// applicant's proposal or a change to the baseline assumptions. Pure: the
// backend loads the base input, this transforms plain data, and runModel is
// unchanged. Climate and stochastic transforms (WP-4.11) will sit beside it.
import { toEpochDay } from '../calendar';
import { withMonthlyRates } from '../network/transferRates';
import { DAM_AREA_EXPONENT, DEMAND_PARTS, estimatedDamAreaM2, upgradeLegacyModel, type Borehole, type DailySeries, type LandCoverPatch, type ModelInput, type NetworkNode, type Transfer } from '../project';
import {
	BASELINE_NODE_FIELDS,
	CROP_SET_FIELDS,
	DEMAND_OBJECT_SET_FIELDS,
	LAND_COVER_SET_FIELDS,
	NODE_SET_FIELDS,
	SCALABLE_SERIES_KINDS,
	SERIES_SCALE_MAX,
	SETTINGS_PATHS,
	TRANSFER_SET_FIELDS,
	allocationOpIssues,
	allowed,
	cropFieldError,
	demandObjectFieldError,
	demandObjectOpIssues,
	demandObjectValue,
	demandScaleError,
	ewrRuleTableOpIssues,
	isIsoDate,
	landCoverFieldError,
	nodeAddFieldError,
	nodeFieldError,
	reductions,
	settingsValueError,
	transferFieldError,
	type ScenarioOp
} from './ops';
import { structureIssues } from './structure';
import { resolveDamCurve } from '../network/dam';
import { DAM_CURVE_CAPACITY_TOLERANCE } from '../network/damCurve';
import { resizeDamCurve, resizedFullArea } from '../network/damResize';
import { ewrRuleListIssues, type EwrRuleTable } from '../reserve/rules';
import type { AllocationEntry } from '../allocations/compare';
import { inputFlowShares } from '../network/shares';
import { FARMER_K } from '../views/farmView';

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
	 * network (a second outflow, a loop, a duplicate name…). A group of
	 * `node.set` ops on one node that breaks a network rule is one line naming
	 * each of its ops that applied (`ops 3–5 (node.set, "Upper farm"): …`,
	 * or `ops 3, 5` when op 4 failed its own check). A skipped op changes
	 * nothing; later ops still apply.
	 */
	problems: string[];
	/**
	 * With `mask`: the hidden nodes and crops that got their real name back
	 * with a suffix, because an op gave a visible one that name
	 * (`Kalkoenkrans` → `Kalkoenkrans (2)`). For the assessor only; the applicant
	 * never sees a hidden name.
	 */
	renamed: MaskedRename[];
	/**
	 * With `mask`: the items an op added under the id of a hidden one, given a
	 * fresh id so the hidden one keeps its own (and still lines up with the
	 * base by id). For the assessor only: it says a hidden item has that id.
	 */
	reIds: MaskedReId[];
	/**
	 * `problems` as the assessors read them (162_applicant_visibility, build
	 * item 6): line for line the same, except that a rule the mask reported
	 * as MASKED_RULE (or MASKED_RULE_AGGREGATE) gives its real words, with
	 * every hidden node and item under its real name. For the assessors
	 * only: never in what an applicant reads. Without a mask, `problems`.
	 */
	assessorProblems: string[];
	/**
	 * With `mask`: each problem line a hidden rule broke (`problem`, its index
	 * in `problems`), the ops it names (0-based) and the rules' ids (the
	 * structure issue's kind: `shares`, `area`, `supplyTrigger`…; never an id
	 * or a name). What an applicant's "Ask the assessors why" quotes.
	 */
	maskedRules: MaskedRuleRef[];
}

/** A problem line a hidden rule broke (ScenarioResult.maskedRules). */
export interface MaskedRuleRef {
	problem: number;
	ops: number[];
	rules: string[];
}

/**
 * What an application's ops must not see (roadmap WP-3.3, docs/scenarios.md
 * § Applications): the nodes, crops, transfers, land-cover patches,
 * boreholes, demand objects and registered volumes its applicant can't see. The ops apply to the base with:
 *
 *  - each hidden node under the anonymous name the applicant sees it by
 *    (`nodes`: id → "Farm 3"); node ids stay, the applicant sees them;
 *  - each hidden crop, transfer, land-cover patch, borehole, demand object
 *    and registered volume under an opaque id (and a hidden crop, borehole or
 *    demand object under an opaque name), chosen
 *    so no op mentions it: an op that targets or reuses a hidden item's id
 *    or name meets exactly what it meets for a free one;
 *  - counts of hidden items left out of the notes (`dropped 2 crop area(s)`),
 *    and a rule an op breaks because of hidden data (a hidden item, a hidden
 *    node's hidden values, the catchment's flow shares or area while any
 *    node is hidden) reported only as `doesn't apply to the catchment as
 *    modelled` (MASKED_RULE; the wording is pending the client, issue #90).
 *
 * Afterwards each hidden item gets its real id and name back: a name an op
 * gave a visible item suffixes the hidden one (`renamed`), and an id an op
 * gave a new item moves the new item to a fresh id (`reIds`). A hidden node
 * an op renamed keeps the op's name.
 */
export interface ScenarioMask {
	nodes?: Readonly<Record<string, string>>;
	crops?: readonly string[];
	transfers?: readonly string[];
	landCover?: readonly string[];
	boreholes?: readonly string[];
	/** Registered volumes (engine ≥ 1.35.0, allocation.set): those on units the applicant can't see. */
	allocations?: readonly string[];
	/** Demand objects (engine ≥ 1.45.0, demandObject.*): those on units the applicant can't see. */
	demandObjects?: readonly string[];
	/**
	 * How many farm holders the hidden farms have, the applicant left out
	 * (counted by the server, which knows the farm links; it may cap the count
	 * at FARMER_K). At FARMER_K or more, the catchment-wide rules (flow shares,
	 * area) say the catchment's total and the hidden units' aggregate
	 * (MASKED_RULE_AGGREGATE); below, or absent, only MASKED_RULE.
	 */
	hiddenHolders?: number;
}

/** What a masked rule reads: says nothing of the hidden data that broke it. Pending the client (issue #90). */
export const MASKED_RULE = "doesn't apply to the catchment as modelled";

/** The catchment-wide rules that may give an aggregate over the hidden units (MASKED_RULE_AGGREGATE). */
export type AggregateRule = 'shares' | 'area';

const pct = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)} %`;
const km2 = (x: number) => `${(Math.round(x * 100) / 100).toFixed(2)} km²`;

/**
 * A catchment-wide rule broken because of hidden units, in words that give
 * the catchment's value and the hidden units' aggregate, for an applicant
 * whose hidden units have FARMER_K or more holders: an aggregate over that
 * many holders relates to no one of them (provisional position, pre-counsel
 * research, 2026-10-01; docs/scenarios.md § Applications). `catchmentValue`:
 * the shares' sum (0–1) or the land left (km²); `hiddenValue`: the hidden
 * units' part of it.
 */
export const MASKED_RULE_AGGREGATE = (ruleId: AggregateRule, catchmentValue: number, hiddenValue: number): string =>
	ruleId === 'shares'
		? `flow shares would total ${pct(catchmentValue)}, more than 100 %; the units you can't see hold ${pct(hiddenValue)} of them between them`
		: `the catchment would have ${km2(catchmentValue)} of land; the units you can't see hold ${km2(hiddenValue)} between them`;

export interface MaskedRename {
	kind: 'node' | 'crop';
	id: string;
	/** Its real name in the base. */
	name: string;
	/** The name it has in the scenario's input. */
	as: string;
}

export interface MaskedReId {
	kind: IdKind;
	/** The id the op gave it: a hidden item's. */
	id: string;
	/** The id it has in the scenario's input. */
	as: string;
}

export interface ApplyOptions {
	mask?: ScenarioMask;
}

type IdKind = 'crop' | 'transfer' | 'landCover' | 'borehole' | 'allocation' | 'demandObject';
type Named = { id: string; name: string };
type Identified = { id: string; name?: string };
interface Masked {
	model: ModelInput['model'];
	/** node id → [real name, mask name]; crop id → the same (by real id, read after the ids are restored). */
	nodes: Map<string, [real: string, mask: string]>;
	crops: Map<string, [real: string, mask: string]>;
	/** opaque id → the hidden item's real id and name, per kind. */
	ids: Record<IdKind, Map<string, { id: string; name?: string }>>;
	/** Every opaque id, for spotting a rule issue about a hidden item. */
	tokens: Set<string>;
	/** The hidden farms have FARMER_K or more holders: a catchment-wide rule may say its aggregate (MASKED_RULE_AGGREGATE). */
	aggregates: boolean;
}

const nameKey = (s: string) => s.trim().toLowerCase();

/** Every string anywhere in `v` (an op list): what an opaque id must not be. */
function strings(v: unknown, out: Set<string>): Set<string> {
	if (typeof v === 'string') out.add(v).add(nameKey(v));
	else if (Array.isArray(v)) for (const x of v) strings(x, out);
	else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, out.add(k));
	return out;
}

const ID_LISTS = {
	crop: (m: ModelInput['model']) => m.crops as Identified[],
	transfer: (m: ModelInput['model']) => m.transfers as Identified[],
	landCover: (m: ModelInput['model']) => (m.landCover ?? []) as Identified[],
	borehole: (m: ModelInput['model']) => (m.boreholes ?? []) as Identified[],
	allocation: (m: ModelInput['model']) => (m.allocations ?? []) as Identified[],
	demandObject: (m: ModelInput['model']) => (m.demandObjects ?? []) as Identified[]
} as const;
const MASK_KEY = { crop: 'crops', transfer: 'transfers', landCover: 'landCover', borehole: 'boreholes', allocation: 'allocations', demandObject: 'demandObjects' } as const;

/**
 * A copy of `model` with the masked nodes under their mask names and the
 * hidden items under opaque ids (and names), none of which any of `ops`
 * mentions, and what each really was.
 */
function maskModel(model: ModelInput['model'], mask: ScenarioMask, ops: readonly unknown[]): Masked {
	const m = cloneData(model);
	const nodes = new Map<string, [string, string]>();
	for (const n of m.nodes) {
		if (!mask.nodes || !Object.hasOwn(mask.nodes, n.id)) continue;
		nodes.set(n.id, [n.name, mask.nodes[n.id]!]);
		n.name = mask.nodes[n.id]!;
	}
	// Never a string an op holds, nor an id or name the model already has.
	const used = strings(ops, new Set());
	for (const k of Object.keys(ID_LISTS) as IdKind[]) for (const x of ID_LISTS[k](m)) strings([x.id, x.name ?? ''], used);
	const tokens = new Set<string>();
	let i = 0;
	const opaque = (kind: IdKind) => {
		let t: string;
		do t = `#${kind}${++i}#`;
		while (used.has(t));
		tokens.add(t);
		return t;
	};
	const crops = new Map<string, [string, string]>();
	const ids = { crop: new Map(), transfer: new Map(), landCover: new Map(), borehole: new Map(), allocation: new Map(), demandObject: new Map() } as Masked['ids'];
	for (const kind of Object.keys(ID_LISTS) as IdKind[]) {
		const hidden = new Set(mask[MASK_KEY[kind]] ?? []);
		if (!hidden.size) continue;
		const swapped = new Map<string, string>();
		for (const x of ID_LISTS[kind](m)) {
			if (!hidden.has(x.id)) continue;
			const t = opaque(kind);
			ids[kind].set(t, { id: x.id, name: x.name });
			swapped.set(x.id, t);
			if (kind === 'crop') crops.set(x.id, [x.name!, t]);
			x.id = t;
			if (x.name !== undefined) x.name = t;
		}
		if (kind === 'crop') for (const a of m.cropAreas) a.cropId = swapped.get(a.cropId) ?? a.cropId;
	}
	return { model: m, nodes, crops, ids, tokens, aggregates: (mask.hiddenHolders ?? 0) >= FARMER_K };
}

/**
 * Hidden items back under their real ids (and a hidden borehole or demand
 * object under its real name): an item an op added under a hidden one's id first moves to a
 * fresh id (`${id}-2`, …), so the hidden one keeps the id the base knows it by.
 */
function restoreIds(m: ModelInput['model'], masked: Masked, out: MaskedReId[]) {
	for (const kind of Object.keys(ID_LISTS) as IdKind[]) {
		const hidden = masked.ids[kind];
		if (!hidden.size) continue;
		const list = ID_LISTS[kind](m);
		const realIds = new Set([...hidden.values()].map((h) => h.id));
		const taken = new Set([...list.map((x) => x.id), ...realIds]);
		for (const x of list) {
			if (hidden.has(x.id) || !realIds.has(x.id)) continue;
			let k = 2;
			while (taken.has(`${x.id}-${k}`)) k++;
			const as = `${x.id}-${k}`;
			taken.add(as);
			if (kind === 'crop') for (const a of m.cropAreas) if (a.cropId === x.id) a.cropId = as;
			out.push({ kind, id: x.id, as });
			x.id = as;
		}
		for (const x of list) {
			const h = hidden.get(x.id);
			if (!h) continue;
			x.id = h.id;
			// A crop's name comes back through unmask (suffixed if an op took it); a borehole's or demand object's name is not unique.
			if (kind === 'borehole' || kind === 'demandObject') x.name = h.name!;
		}
		if (kind === 'crop') for (const a of m.cropAreas) a.cropId = hidden.get(a.cropId)?.id ?? a.cropId;
	}
}

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

/**
 * Does a rule issue (structureIssues' key) turn on data the applicant can't
 * see? A hidden item (its opaque id is in the key), a hidden node's hidden
 * borehole rule or supply rule (both read its hidden dam), or the catchment-wide value rules while any node is hidden
 * (flow shares over 100 %, no area left: the op's own values are
 * range-checked, so these trip only with other nodes' values in play). The
 * network's shape (outflows, loops, what drains where) and names are the
 * applicant's to see, so those rules keep their words.
 */
function hiddenRule(key: string, masked: Masked): boolean {
	if (key === 'area' || key === 'shares') return masked.nodes.size > 0;
	// A hidden node's dam, and its supply rule's levels, are hidden values: the rules that read them say nothing of them.
	for (const p of ['bhDrought:', 'supplyTrigger:', 'supplyRor:', 'supplyStop:']) if (key.startsWith(p)) return masked.nodes.has(key.slice(p.length));
	for (const t of masked.tokens) if (key.includes(t)) return true;
	return false;
}

/** A rule issue's id for an applicant: the structure key's kind (`supplyTrigger:<node>` → `supplyTrigger`), never an id or a name. */
const ruleId = (key: string) => {
	const kind = key.split(':')[0] ?? '';
	return /^[A-Za-z]+$/.test(kind) ? kind : 'rule';
};

/** How a hidden rule reads to the applicant: the aggregate past FARMER_K holders for the catchment-wide rules, else MASKED_RULE. */
function maskedText(key: string, input: ModelInput, masked: Masked): string {
	if (!masked.aggregates || (key !== 'shares' && key !== 'area')) return MASKED_RULE;
	const nodes = input.model.nodes;
	if (key === 'shares') {
		const { share, sum } = inputFlowShares(input);
		let hidden = 0;
		nodes.forEach((n, i) => {
			if (masked.nodes.has(n.id)) hidden += share[i]!;
		});
		return MASKED_RULE_AGGREGATE('shares', sum, hidden);
	}
	let all = 0;
	let hidden = 0;
	for (const n of nodes) {
		all += n.areaKm2;
		if (masked.nodes.has(n.id)) hidden += n.areaKm2;
	}
	return MASKED_RULE_AGGREGATE('area', all, hidden);
}

/** A problem line with every hidden node and item under its real name: for the assessors (ScenarioResult.assessorProblems). */
function unmaskText(line: string, masked: Masked | null): string {
	if (!masked) return line;
	let out = line;
	for (const [real, mask] of masked.nodes.values()) out = out.replaceAll(`"${mask}"`, `"${real}"`);
	for (const kind of Object.keys(masked.ids) as IdKind[]) for (const [token, item] of masked.ids[kind]) out = out.replaceAll(token, item.name ?? item.id);
	return out;
}

/** What node.remove may count of what it drops: in masked mode, only what the applicant sees. */
interface Visibility {
	node: (id: string) => boolean;
	item: (id: string) => boolean;
}
const SEE_ALL: Visibility = { node: () => true, item: () => true };

class OpError extends Error {}
const fail = (msg: string): never => {
	throw new OpError(msg);
};

/**
 * Deep copy of plain data (settings and the model document are JSON). A
 * `__proto__` (or `constructor` / `prototype`) key, which JSON.parse keeps
 * as an own property, is dropped rather than written, so input posted from
 * a page or worker can't swap the copy's prototype.
 */
export function cloneData<T>(v: T): T {
	if (Array.isArray(v)) return v.map(cloneData) as T;
	if (v && typeof v === 'object') {
		// Object.fromEntries defines own properties (never an assignment that
		// could reach a prototype), and keys that would name one are dropped as
		// never being data.
		return Object.fromEntries(
			Object.entries(v)
				.filter(([k]) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype')
				.map(([k, x]) => [k, cloneData(x)])
		) as T;
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

/** node.add's and node.insert's new node, checked and pushed (never a new outflow: it drains into an existing node). */
function addNode(d: Draft, raw0: NetworkNode): NetworkNode {
	const m = d.model;
	const raw = raw0 as unknown as Record<string, unknown>;
	for (const k of ['id', 'name', 'kind', 'downstreamNodeId'] as const) if (typeof raw?.[k] !== 'string') fail(`the new node needs a ${k}`);
	if (m.nodes.some((n) => n.id === raw0.id)) fail(`node id ${raw0.id} is already in use`);
	if (!m.nodes.some((n) => n.id === raw0.downstreamNodeId)) fail(`the new node drains into unknown node ${raw0.downstreamNodeId}`);
	for (const [k, v] of Object.entries(raw)) {
		if (['id', 'name', 'kind', 'downstreamNodeId'].includes(k)) continue;
		if (k === 'sortOrder') {
			if (!Number.isInteger(v)) fail("the new node's sortOrder must be a whole number");
			continue;
		}
		const e = nodeAddFieldError(k, v);
		if (e) fail(`the new node's ${k} ${e}`);
	}
	const [node] = upgradeLegacyModel({ nodes: [cloneData(raw0)] }).nodes as NetworkNode[];
	node!.name = node!.name.trim();
	node!.sortOrder ??= m.nodes.length;
	m.nodes.push(node!);
	return node!;
}

/** The outlet is one EWR site whether a table names it null (as Settings saves it) or by the outlet node's id (as the run reads both). */
function ewrSiteKey(d: Draft): (id: string | null | undefined) => string | null {
	const outflowId = d.model.nodes.find((n) => n.downstreamNodeId === null)?.id;
	return (id) => (id === undefined || id === null || id === outflowId ? null : id);
}

/**
 * A farm dam whose capacity an op changed keeps its geometry along its own
 * area–volume relation (engine ≥ 1.10.0, docs/model.md §2.13, ../network/damResize.ts):
 * a survey curve is cut at, or extrapolated to, its top × the capacity ratio;
 * a power-law dam's area when full (as entered, or the 7.2 × capacity^0.77
 * estimate) becomes A_full × ratio^b. A later `damAreaFullM2` op on the node
 * sets the new dam's own area; one before this op described the old dam and
 * is resized with it. Likewise a `damCurve` op after it sets the new dam's own
 * surveyed curve. From engine 1.20.0 a survey curve whose top is already
 * within 1 % of the new capacity (DAM_CURVE_CAPACITY_TOLERANCE, the tolerance
 * a run allows between the two) is left as it is: one a `damCurve` op before
 * this one set describes the new dam, so the two ops mean the same in either
 * order, and the base's own curve needs no redrawing for a change that small.
 * Nothing happens for a new dam (from capacity 0), a dam removed (to 0) or an
 * unchanged capacity. Returns the op's note.
 */
function resizeDamGeometry(n: NetworkNode, oldCap: number): string | null {
	const cap = n.damCapacityM3;
	if (!(oldCap > 0) || !(cap > 0) || cap === oldCap) return null;
	const ratio = cap / oldCap;
	const b = n.damAreaExponent > 0 && n.damAreaExponent <= 3 ? n.damAreaExponent : DAM_AREA_EXPONENT;
	const survey = resolveDamCurve(n);
	if (survey && n.damCurve) {
		if (Math.abs(survey.volume[survey.volume.length - 1]! - cap) <= DAM_CURVE_CAPACITY_TOLERANCE * cap)
			return `dam survey curve left as it is: its top is within ${DAM_CURVE_CAPACITY_TOLERANCE * 100} % of the new capacity`;
		const top = survey.volume[survey.volume.length - 1]! * ratio;
		const r = resizeDamCurve(n.damCurve, top, b);
		if (r.rows.length >= 2) {
			n.damCurve = r.rows;
			return r.extrapolated
				? `dam survey curve extrapolated beyond the survey to ${Math.round(top)} m³ (area ∝ volume^${r.exponent!.toFixed(2)} from its top rows): enter a surveyed curve for the enlarged dam if there is one`
				: `dam survey curve cut at ${Math.round(top)} m³`;
		}
		// Cut below its lowest surveyed row: too little curve left, so the power law takes the area there.
		n.damCurve = null;
		n.damAreaFullM2 = r.rows.at(-1)!.areaM2;
		return `dam survey curve cut below its lowest row; area when full ${Math.round(n.damAreaFullM2)} m² from it, on the power law`;
	}
	const estimated = n.damAreaFullM2 === null || n.damAreaFullM2 === undefined || !(n.damAreaFullM2 >= 0);
	const from = estimated ? estimatedDamAreaM2(oldCap) : n.damAreaFullM2!;
	n.damAreaFullM2 = resizedFullArea(from, oldCap, cap, b);
	return `dam area when full ${Math.round(from)} → ${Math.round(n.damAreaFullM2)} m² along the dam's own area–volume relation (× ${ratio.toFixed(3)}^${b})${estimated ? ', from the 7.2 × capacity^0.77 estimate' : ''}`;
}

function applyOne(d: Draft, op: ScenarioOp, see: Visibility = SEE_ALL): string[] {
	const notes: string[] = [];
	const m = d.model;
	switch (op.op) {
		case 'node.set': {
			const n = findNode(d, op.nodeId);
			// The field written is the allowlist's own name for it, never the op's text (so never `__proto__`).
			const settable: readonly string[] = Object.hasOwn(NODE_SET_FIELDS, n.kind) ? NODE_SET_FIELDS[n.kind] : [];
			const field = allowed(settable, op.field) ?? fail(`"${String(op.field)}" can't be set on a ${n.kind}`);
			const e = nodeFieldError(field, op.value);
			if (e) fail(`${field} ${e}`);
			const oldCap = n.damCapacityM3;
			(n as unknown as Record<string, unknown>)[field] = field === 'name' ? (op.value as string).trim() : cloneData(op.value);
			if (field === 'damCapacityM3' && n.kind === 'farm') {
				const note = resizeDamGeometry(n, oldCap);
				if (note && see.node(n.id)) notes.push(note);
			}
			break;
		}
		case 'node.add':
			addNode(d, op.node);
			break;
		case 'node.insert': {
			// The nodes re-pointed first, against the network as it stands: each must drain into the new node's downstream node.
			const ups = Array.isArray(op.upstreamNodeIds) ? op.upstreamNodeIds : fail('upstreamNodeIds must be a list of node ids');
			if (!ups.length) fail('upstreamNodeIds names no node: with none, add the node instead');
			if (new Set(ups).size !== ups.length) fail('upstreamNodeIds names a node more than once');
			const down = typeof op.node?.downstreamNodeId === 'string' ? op.node.downstreamNodeId : null;
			const upstream = ups.map((id) => findNode(d, id));
			const node = addNode(d, op.node);
			for (const u of upstream) {
				if (u.downstreamNodeId !== down) fail(`"${u.name}" doesn't drain into the node the new one drains into, so the new node can't sit between them`);
				u.downstreamNodeId = node.id;
				notes.push(`"${u.name}" now drains into "${node.name}"`);
			}
			break;
		}
		case 'node.move': {
			const n = findNode(d, op.nodeId);
			if (n.downstreamNodeId === null) fail(`"${n.name}" is the outflow node and can't be moved`);
			const to = findNode(d, op.downstreamNodeId);
			if (to.id === n.id) fail(`"${n.name}" can't drain into itself`);
			// A loop (the new downstream node drains into this one) is a model rule, checked after the op.
			n.downstreamNodeId = to.id;
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
			// Counts only what the caller sees: in masked mode a hidden node's crops, transfers… are not theirs to count.
			const drop = <T>(xs: T[], gone: (x: T) => boolean, what: string, seen: (x: T) => boolean): T[] => {
				const kept = xs.filter((x) => !gone(x));
				const counted = xs.filter((x) => gone(x) && seen(x)).length;
				if (counted) notes.push(`dropped ${counted} ${what}`);
				return kept;
			};
			m.cropAreas = drop(m.cropAreas, (a) => a.nodeId === n.id, 'crop area(s)', (a) => see.node(a.nodeId) && see.item(a.cropId));
			m.transfers = drop(m.transfers, (t) => t.fromNodeId === n.id || t.toNodeId === n.id, 'transfer(s)', (t) => see.item(t.id));
			// An off-take whose seepage rejoined below it (engine ≥ 1.42.0) returns none now: the conservative side, said in a note.
			for (const t of m.transfers) {
				if (t.lossReturnNodeId !== n.id) continue;
				t.lossReturnNodeId = null;
				t.lossReturnPct = 0;
				if (see.item(t.id)) notes.push(`a river off-take's seepage no longer returns to the river (it rejoined below "${n.name}")`);
			}
			if (m.landCover) m.landCover = drop(m.landCover, (p) => p.nodeId === n.id, 'land-cover patch(es)', (p) => see.item(p.id));
			if (m.boreholes) m.boreholes = drop(m.boreholes, (b) => b.nodeId === n.id, 'borehole(s)', (b) => see.item(b.id));
			// Demand objects (engine ≥ 1.7.0) go with their unit; counted only on a unit the caller sees.
			if (m.demandObjects) m.demandObjects = drop(m.demandObjects, (o) => o.nodeId === n.id, 'demand object(s)', (o) => see.node(o.nodeId) && see.item(o.id));
			// Registered volumes (engine ≥ 1.35.0) stay, as the file keeps them: the run lists them as on no unit
			// (notInRunAllocationIds). Said here so the change isn't silent; counted only where the caller sees them.
			const orphaned = (m.allocations ?? []).filter((a) => a.nodeId === n.id && see.item(a.id)).length;
			if (orphaned) notes.push(`its ${orphaned} registered volume(s) are no longer on a unit in the run`);
			if (Array.isArray(d.settings.ewrRules)) {
				// Settings are catchment-wide and the applicant sees them in full.
				d.settings.ewrRules = drop(d.settings.ewrRules, (t) => t?.siteNodeId === n.id, 'EWR rule table(s) sited there', () => true);
			}
			break;
		}
		case 'cropArea.set': {
			const n = findNode(d, op.nodeId);
			if (n.kind !== 'farm') fail(`crops grow on units; "${n.name}" is a ${n.kind}`);
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
		case 'crop.set': {
			const c = m.crops.find((x) => x.id === op.cropId) ?? fail(`crop ${op.cropId} not found`);
			// Written by the allowlist's own name for the field, never the op's text.
			const field = allowed(CROP_SET_FIELDS, op.field) ?? fail(`"${String(op.field)}" is not a crop field a scenario can set`);
			const e = cropFieldError(field, op.value);
			if (e) fail(`${field} ${e}`);
			(c as unknown as Record<string, unknown>)[field] = field === 'name' ? (op.value as string).trim() : cloneData(op.value);
			break;
		}
		case 'crop.remove': {
			if (!m.crops.some((x) => x.id === op.cropId)) fail(`crop ${op.cropId} not found`);
			m.crops = m.crops.filter((x) => x.id !== op.cropId);
			// Counts only the areas on nodes the caller sees: in masked mode a hidden farm growing it is not theirs to count.
			const counted = m.cropAreas.filter((a) => a.cropId === op.cropId && see.node(a.nodeId)).length;
			m.cropAreas = m.cropAreas.filter((a) => a.cropId !== op.cropId);
			if (counted) notes.push(`dropped ${counted} crop area(s)`);
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
			// Engine ≥ 1.14.0 fields, when given: monthly rates and a river off-take's.
			for (const k of ['monthlyRateM3s', 'source', 'handsOffM3Day', 'handsOffEwr', 'lossPct', 'sizing', 'topUpDam', 'lossReturnPct', 'lossReturnNodeId'] as const) {
				if (t[k] === undefined) continue;
				const e = transferFieldError(k, t[k]);
				if (e) fail(`${k} ${e}`);
			}
			if (t.lossReturnNodeId && !m.nodes.some((n) => n.id === t.lossReturnNodeId)) fail(`lossReturnNodeId ${t.lossReturnNodeId} not found`);
			// Monthly rates (engine ≥ 1.14.0) set the months and max rate kept beside them.
			const added: Transfer = { ...cloneData(t), months: monthSet(t.months), monthlyRateM3s: t.monthlyRateM3s ?? null };
			if (t.monthlyRateM3s) Object.assign(added, withMonthlyRates(t.monthlyRateM3s));
			m.transfers.push(added);
			break;
		}
		case 'transfer.set': {
			const t = findTransfer(d, op.transferId);
			const field = allowed(TRANSFER_SET_FIELDS, op.field) ?? fail(`"${String(op.field)}" is not a transfer field a scenario can set`);
			const e = transferFieldError(field, op.value);
			if (e) fail(`${field} ${e}`);
			if ((field === 'fromNodeId' || field === 'toNodeId' || (field === 'lossReturnNodeId' && op.value !== null)) && !m.nodes.some((n) => n.id === op.value)) fail(`node ${String(op.value)} not found`);
			// Monthly rates (engine ≥ 1.14.0) also set the months and max rate kept beside them; months or a max rate
			// on a rule with monthly rates would disagree with them, which the save rules (modelRuleIssues) refuse.
			if (field === 'monthlyRateM3s' && Array.isArray(op.value)) Object.assign(t, withMonthlyRates(op.value));
			else (t as unknown as Record<string, unknown>)[field] = field === 'months' ? monthSet(op.value as number[]) : cloneData(op.value);
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
			if (n.kind !== 'farm') fail(`land cover lies on a unit; "${n.name}" is a ${n.kind}`);
			m.landCover = [...(m.landCover ?? []), cloneData(p) as LandCoverPatch];
			break;
		}
		case 'landCover.remove': {
			if (!(m.landCover ?? []).some((p) => p.id === op.patchId)) fail(`land-cover patch ${op.patchId} not found`);
			m.landCover = m.landCover!.filter((p) => p.id !== op.patchId);
			break;
		}
		case 'landCover.set': {
			const p = (m.landCover ?? []).find((x) => x.id === op.patchId) ?? fail(`land-cover patch ${op.patchId} not found`);
			const field = allowed(LAND_COVER_SET_FIELDS, op.field) ?? fail(`"${String(op.field)}" is not a land-cover field a scenario can set`);
			const e = landCoverFieldError(field, op.value);
			if (e) fail(`${field} ${e}`);
			(p as unknown as Record<string, unknown>)[field] = field === 'factors' ? reductions(op.value) : cloneData(op.value);
			break;
		}
		case 'borehole.add': {
			const b = op.borehole;
			if (typeof b?.id !== 'string') fail('the new borehole needs an id');
			if ((m.boreholes ?? []).some((x) => x.id === b.id)) fail(`borehole id ${b.id} is already in use`);
			const n = findNode(d, b.nodeId);
			if (n.kind === 'gauge') fail(`a borehole supplies a unit or other water user; "${n.name}" is a gauge`);
			m.boreholes = [...(m.boreholes ?? []), cloneData(b) as Borehole];
			break;
		}
		case 'borehole.remove': {
			if (!(m.boreholes ?? []).some((b) => b.id === op.boreholeId)) fail(`borehole ${op.boreholeId} not found`);
			m.boreholes = m.boreholes!.filter((b) => b.id !== op.boreholeId);
			break;
		}
		case 'demandObject.add': {
			const { demandObject: o, issues } = demandObjectOpIssues(op.demandObject);
			if (!o) fail(`the demand object isn't usable: ${issues.map(([k, msg]) => (k ? `${k} ${msg}` : msg)).join('; ')}`);
			if ((m.demandObjects ?? []).some((x) => x.id === o!.id)) fail(`demand object id ${o!.id} is already in use`);
			const n = findNode(d, o!.nodeId);
			if (n.kind !== 'farm') fail(`a demand object is on a hydrological unit; "${n.name}" is ${n.kind === 'user' ? 'an other water user' : 'a gauge'}`);
			// How its fields fit together (sizing, destination, schedule) is a model rule, checked after the op.
			// Name and note trimmed, as a save trims them (and as run comparison reads a note).
			m.demandObjects = [...(m.demandObjects ?? []), { ...o!, name: o!.name.trim(), ...(typeof o!.note === 'string' ? { note: o!.note.trim() } : {}) }];
			break;
		}
		case 'demandObject.set': {
			const o = (m.demandObjects ?? []).find((x) => x.id === op.demandObjectId) ?? fail(`demand object ${op.demandObjectId} not found`);
			// Written by the allowlist's own name for the field, never the op's text.
			const field = allowed(DEMAND_OBJECT_SET_FIELDS, op.field) ?? fail(`"${String(op.field)}" is not a demand-object field a scenario can set`);
			const e = demandObjectFieldError(field, op.value);
			if (e) fail(`${field} ${e}`);
			// No schedule, null and an empty one run the same (engine ≥ 1.17.0): clearing a schedule the object hasn't got leaves it as it is.
			const noSchedule = (v: unknown) => v === undefined || v === null || (Array.isArray(v) && v.length === 0);
			if (field === 'schedule' && noSchedule(op.value) && noSchedule(o.schedule)) break;
			// Likewise no population and null (its count, engine ≥ 1.44.0).
			if (field === 'population' && op.value === null && (o.population === null || o.population === undefined)) break;
			// Likewise no source and null (not recorded, engine ≥ 1.56.0).
			if (field === 'source' && op.value === null && (o.source === null || o.source === undefined)) break;
			(o as unknown as Record<string, unknown>)[field] = demandObjectValue(field, op.value);
			break;
		}
		case 'demandObject.remove': {
			if (!(m.demandObjects ?? []).some((x) => x.id === op.demandObjectId)) fail(`demand object ${op.demandObjectId} not found`);
			m.demandObjects = m.demandObjects!.filter((x) => x.id !== op.demandObjectId);
			break;
		}
		case 'settings.set': {
			const e = settingsValueError(op.path, op.value);
			if (e) fail(`${op.path} ${e}`);
			// Written by the allowlist's own path, never the op's text.
			const path = allowed(SETTINGS_PATHS, op.path) ?? fail(`"${String(op.path)}" is not a setting a scenario can change`);
			const value = cloneData(op.value);
			const [head, leaf] = path.split('.') as [string, string | undefined];
			const s = d.settings as Record<string, unknown>;
			// No drought restriction rule and null run the same (engine ≥ 1.54.0): turning off a rule that isn't there leaves it as it is.
			if (path === 'droughtRestriction' && value === null && (s.droughtRestriction === null || s.droughtRestriction === undefined)) break;
			if (leaf === undefined) s[head] = value;
			else {
				const cur = s[head];
				s[head] = { ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}), [leaf]: value };
			}
			break;
		}
		case 'series.scale': {
			const kind = allowed(SCALABLE_SERIES_KINDS, op.kind) ?? fail(`${String(op.kind)} can't be scaled`);
			if (!(Number.isFinite(op.factor) && op.factor >= 0 && op.factor <= SERIES_SCALE_MAX)) fail(`factor must be 0–${SERIES_SCALE_MAX}`);
			for (const k of ['from', 'to'] as const) if (op[k] !== undefined && !isIsoDate(op[k])) fail(`${k} must be an ISO date`);
			const s = d.series[kind] ?? fail(`the base has no ${kind} series`);
			const start = toEpochDay(s.startDate);
			const a = op.from === undefined ? 0 : Math.max(0, toEpochDay(op.from) - start);
			const b = op.to === undefined ? s.values.length - 1 : Math.min(s.values.length - 1, toEpochDay(op.to) - start);
			if (a > b) fail(`no day of ${kind} falls in ${op.from ?? 'its start'} – ${op.to ?? 'its end'}`);
			const values = s.values.slice();
			let n = 0;
			for (let t = a; t <= b; t++) {
				const v = values[t];
				if (v === null || v === undefined) continue;
				values[t] = v * op.factor;
				n++;
			}
			d.series = { ...d.series, [kind]: { startDate: s.startDate, values } satisfies DailySeries };
			notes.push(`${n} day(s) scaled`);
			break;
		}
		case 'demand.scale': {
			const e = demandScaleError(op);
			if (e) fail(e);
			const category = op.category ?? 'farm';
			const word = category === 'farm' ? 'farm' : 'other water user';
			const aKind = (k: string) => (k === 'user' ? 'an other water user' : `a ${k}`);
			let targets: NetworkNode[];
			if (op.nodeIds) {
				targets = op.nodeIds.map((id) => findNode(d, id));
				const wrong = targets.find((n) => n.kind !== category);
				if (wrong) fail(`"${wrong.name}" is ${aKind(wrong.kind)}, not ${aKind(category)}`);
			} else {
				targets = m.nodes.filter((n) => n.kind === category);
				if (!targets.length) fail(`the model has no ${word} to scale`);
			}
			// Water-year index (Oct = 0) of each calendar month the op scales.
			const wy = new Set((op.months ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).map((c) => (c + 2) % 12));
			for (const n of targets) {
				if (op.part !== undefined) {
					// One part of the unit's demand (engine ≥ 1.45.0): its own factor, on top of the unit's.
					const part = allowed(DEMAND_PARTS, op.part) ?? fail(`"${String(op.part)}" is not a part of a unit's demand`);
					const all = { ...(n.partDemandFactor && typeof n.partDemandFactor === 'object' ? n.partDemandFactor : {}) };
					const was = Object.hasOwn(all, part) ? all[part] : undefined;
					const cur = Array.isArray(was) && was.length === 12 ? was : new Array<number>(12).fill(1);
					all[part] = cur.map((v, i) => (wy.has(i) ? v * op.factor : v));
					n.partDemandFactor = all;
					continue;
				}
				const cur = Array.isArray(n.demandFactor) && n.demandFactor.length === 12 ? n.demandFactor : new Array<number>(12).fill(1);
				n.demandFactor = cur.map((v, i) => (wy.has(i) ? v * op.factor : v));
			}
			if (!op.nodeIds) notes.push(`${targets.length} ${word}(s) scaled`);
			break;
		}
		case 'ewrRule.set': {
			const { table, issues } = ewrRuleTableOpIssues(op.table);
			if (!table) fail(`the rule table isn't usable: ${issues.map(([k, msg]) => (k ? `${k} ${msg}` : msg)).join('; ')}`);
			// As the run reads it (resolveEwrRules): the source trimmed, no natural grid unless it is the source, a kind, a REC and a natural MAR only when stated.
			const { sourceKind, category, naturalMarMcm, ...rest } = table!;
			const t: EwrRuleTable = { ...rest, ...(sourceKind != null ? { sourceKind } : {}), ...(category != null ? { category } : {}), ...(naturalMarMcm != null ? { naturalMarMcm } : {}), source: rest.source.trim(), natural: rest.naturalSource === 'table' ? rest.natural : null };
			const site = ewrSiteKey(d);
			if (site(t.siteNodeId) !== null) {
				const n = findNode(d, t.siteNodeId!);
				if (n.kind !== 'gauge') fail(`an EWR site is the outlet or a gauge; "${n.name}" is ${n.kind === 'user' ? 'an other water user' : `a ${n.kind}`}`);
				if (n.ewrSite === false) fail(`"${n.name}" is not marked as an EWR site: set its EWR site flag first`);
			}
			const list: EwrRuleTable[] = Array.isArray(d.settings.ewrRules) ? d.settings.ewrRules : [];
			const at = list.findIndex((x) => x && typeof x === 'object' && site(x.siteNodeId) === site(t.siteNodeId));
			// A replaced table keeps the key its site had, so run comparison sees the same site's table changed.
			const next = at < 0 ? [...list, t] : list.map((x, i) => (i === at ? { ...t, siteNodeId: x.siteNodeId ?? null } : x));
			const e = ewrRuleListIssues(next);
			if (e) fail(e);
			// No note: what it replaced is the op's "was", which the editor describes (like node.set's).
			d.settings.ewrRules = next;
			break;
		}
		case 'ewrRule.remove': {
			if (op.siteNodeId !== null && typeof op.siteNodeId !== 'string') fail('siteNodeId must be a node id, or null for the outlet');
			const site = ewrSiteKey(d);
			const list: EwrRuleTable[] = Array.isArray(d.settings.ewrRules) ? d.settings.ewrRules : [];
			const key = site(op.siteNodeId);
			// Named by id, never by a node's name: a table can only be sited at the outlet or a gauge, which every caller sees.
			if (!list.some((x) => x && typeof x === 'object' && site(x.siteNodeId) === key)) fail(`there is no EWR rule table at ${key === null ? 'the outlet' : `node ${key}`}`);
			d.settings.ewrRules = list.filter((x) => !(x && typeof x === 'object' && site(x.siteNodeId) === key));
			break;
		}
		case 'allocation.set': {
			const { allocation, issues } = allocationOpIssues(op.allocation);
			if (!allocation) fail(`the registered volume isn't usable: ${issues.map(([k, msg]) => (k ? `${k} ${msg}` : msg)).join('; ')}`);
			const a = allocation!;
			const n = findNode(d, a.nodeId!);
			if (n.kind === 'gauge') fail(`a registered volume is held for a unit or other water user; "${n.name}" is a gauge`);
			// Months as a sorted set, as the backend stores them.
			const entry: AllocationEntry = { ...a, ...(Array.isArray(a.months) ? { months: monthSet(a.months) } : {}) };
			const list = m.allocations ?? [];
			const at = list.findIndex((x) => x.id === a.id);
			// A replaced volume keeps its place, so the list's order (the run's) is the base's.
			m.allocations = at < 0 ? [...list, entry] : list.map((x, i) => (i === at ? entry : x));
			break;
		}
		case 'allocation.remove': {
			if (!(m.allocations ?? []).some((x) => x.id === op.allocationId)) fail(`registered volume ${op.allocationId} not found`);
			m.allocations = m.allocations!.filter((x) => x.id !== op.allocationId);
			break;
		}
		default:
			fail(`unknown op ${(op as { op?: unknown }).op as string}`);
	}
	return notes;
}

/**
 * Do ops `a` and `b` (in that order) belong to one edit? Consecutive
 * `node.set` ops on the same node do, and (engine ≥ 1.45.0) consecutive
 * `demandObject.set` ops on the same demand object: the network rules are
 * checked once, after the last of them (docs/scenarios.md § Edit groups).
 */
const sameGroup = (a: ScenarioOp | undefined, b: ScenarioOp | undefined): boolean =>
	(a?.op === 'node.set' && b?.op === 'node.set' && typeof a.nodeId === 'string' && a.nodeId === b.nodeId) ||
	(a?.op === 'demandObject.set' && b?.op === 'demandObject.set' && typeof a.demandObjectId === 'string' && a.demandObjectId === b.demandObjectId);

/** The ops that form edit groups (sameGroup): a last group of them that breaks a rule stays open for a next op. */
const groupable = (op: ScenarioOp) => op.op === 'node.set' || op.op === 'demandObject.set';

/** 1-based op numbers in words: `3`, `3–5` for a run, `3, 5` otherwise. */
function opNumbers(indices: readonly number[]): string {
	const n = indices.map((i) => i + 1);
	const run = n.every((x, k) => k === 0 || x === n[k - 1]! + 1);
	return run && n.length > 1 ? `${n[0]}–${n[n.length - 1]}` : n.join(', ');
}

interface Stepped extends Omit<ScenarioResult, 'renamed' | 'reIds'> {
	/** The input each op meets: the committed input plus the earlier ops of its own group (not yet rule-checked). */
	before: ModelInput[];
	/** The input with every op applied, a last group included even if it breaks a rule (what a next op would meet). */
	pending: ModelInput;
}

/**
 * applyScenario's loop. The ops apply in order, each to a fresh copy. A
 * group (consecutive `node.set` ops on one node; any other op is a group of
 * its own) is checked against the network rules once, after its last op: a
 * group that adds a rule issue is skipped whole and reported once, against
 * the ops of it that applied, so the scenario never keeps half an edit. An
 * op that fails its own check (a missing target, a value out of range) is
 * refused on its own, and the rest of its group still counts.
 */
function step(base: ModelInput, ops: readonly ScenarioOp[], masked: Masked | null): Stepped {
	const see: Visibility = masked ? { node: (id) => !masked.nodes.has(id), item: (id) => !masked.tokens.has(id) } : SEE_ALL;
	let cur: ModelInput = { settings: cloneData(base.settings), model: masked?.model ?? cloneData(base.model), series: { ...base.series } };
	let issues = structureIssues(cur);
	const applied: AppliedOp[] = [];
	const problems: string[] = [];
	const assessorProblems: string[] = [];
	const maskedRules: MaskedRuleRef[] = [];
	const before: ModelInput[] = [];
	// The open group: the input with its ops so far applied, and those ops.
	let draft = cur;
	let group: AppliedOp[] = [];
	// A last node.set group that breaks a rule stays open for a next op on the node to complete.
	let pending: ModelInput | null = null;
	ops.forEach((op, index) => {
		const kind = typeof op?.op === 'string' ? op.op : 'unknown';
		before.push(draft);
		const next: ModelInput = { settings: cloneData(draft.settings), model: cloneData(draft.model), series: draft.series };
		try {
			group.push({ index, op, notes: applyOne(next, op, see) });
			draft = next;
		} catch (e) {
			if (!(e instanceof OpError)) throw e;
			problems.push(`op ${index + 1} (${kind}): ${e.message}`);
			assessorProblems.push(unmaskText(problems[problems.length - 1]!, masked));
		}
		if (sameGroup(op, ops[index + 1]) || !group.length) return;
		const after = structureIssues(draft);
		const fresh = [...after].filter(([k]) => !issues.has(k));
		const hidden = fresh.filter(([k]) => masked && hiddenRule(k, masked));
		const introduced = [...new Set(fresh.map(([k, text]) => (masked && hiddenRule(k, masked) ? maskedText(k, draft, masked) : text)))];
		if (introduced.length) {
			// One op: `op 3 (node.set)`, as always. Several: `ops 3–5 (node.set, "Upper farm")`, the node (or demand object) named as it stood before them.
			const targetName = () =>
				op.op === 'demandObject.set'
					? ((cur.model.demandObjects ?? []).find((o) => o.id === op.demandObjectId)?.name ?? '')
					: (cur.model.nodes.find((n) => n.id === (op as { nodeId?: unknown }).nodeId)?.name ?? '');
			const label = group.length === 1 ? `op ${group[0]!.index + 1} (${kind})` : `ops ${opNumbers(group.map((g) => g.index))} (${kind}, "${targetName()}")`;
			if (hidden.length) maskedRules.push({ problem: problems.length, ops: group.map((g) => g.index), rules: [...new Set(hidden.map(([k]) => ruleId(k)))] });
			problems.push(`${label}: ${introduced.join('; ')}`);
			// The assessors' line: the real words of every rule, hidden names restored.
			assessorProblems.push(unmaskText(`${label}: ${[...new Set(fresh.map(([, text]) => text))].join('; ')}`, masked));
			if (index === ops.length - 1 && groupable(op)) pending = draft;
			draft = cur;
		} else {
			cur = draft;
			issues = after;
			applied.push(...group);
		}
		group = [];
	});
	return { input: cur, applied, problems, assessorProblems, maskedRules, before, pending: pending ?? draft };
}

/**
 * Apply `ops` to `base` in order. Never mutates `base` (settings and the
 * model are deep-copied; a series is copied only when an op scales it). An
 * op whose target is missing or whose value is out of range is skipped and
 * reported in `problems`, never thrown; the ops after it still apply. The
 * network rules (a second outflow, a loop, a duplicate name, the model's
 * save rules…) are checked after each group of ops: consecutive `node.set`
 * ops on one node form a group, checked once after its last op and skipped
 * whole if it breaks one, so a farm can go from `trigger` to `runOfRiver`
 * (rule and dam together) in either order. docs/scenarios.md has the rules.
 */
export function applyScenario(base: ModelInput, ops: readonly ScenarioOp[], options: ApplyOptions = {}): ScenarioResult {
	const masked = options.mask ? maskModel(base.model, options.mask, ops) : null;
	const { input, applied, problems, assessorProblems, maskedRules } = step(base, ops, masked);
	const renamed: MaskedRename[] = [];
	const reIds: MaskedReId[] = [];
	if (masked) {
		// input.model is this call's own copy (every op works on a fresh draft), so restoring in place touches nothing shared.
		restoreIds(input.model, masked, reIds);
		unmask(input.model.nodes, masked.nodes, 'node', renamed);
		unmask(input.model.crops, masked.crops, 'crop', renamed);
	}
	return { input, applied, problems, renamed, reIds, assessorProblems, maskedRules };
}

/**
 * The input each op of `ops` meets under applyScenario's rules (`before[i]`:
 * the base with the ops before it applied, the earlier ops of its own group
 * included though not yet checked against the rules), and `after`, what a
 * next op would meet: every op applied, a last group included even while it
 * still breaks a rule, so a form adding one op at a time builds on the
 * group's edit so far. For describing ops and building the next one;
 * applyScenario says which apply. The inputs share structure: read-only.
 */
export function scenarioSteps(base: ModelInput, ops: readonly ScenarioOp[]): { before: ModelInput[]; after: ModelInput } {
	const { before, pending } = step(base, ops, null);
	return { before, after: pending };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type OpClass = 'proposal' | 'baseline';

/** A gauge (an EWR site), or a node with land or a manual flow share: part of how the catchment's runoff is split. */
const sharesRunoff = (n: NetworkNode) => n.kind === 'gauge' || n.areaKm2 > 0 || n.areaHiKm2 > 0 || n.areaLoKm2 > 0 || n.flowShareManual != null;

/** A senior other water user (the default priority, USER_DEFAULTS): farms upstream of it pass its demand (model.md §2.7c). */
const seniorUser = (n: NetworkNode) => n.kind === 'user' && (n.userPriority ?? 'senior') === 'senior';

/**
 * Is this op the applicant's proposal, or a change to the baseline
 * assumptions an assessor must see called out? docs/scenarios.md
 * § Classification has the rules. Conservative: anything it can't place is
 * 'baseline'.
 *
 * `ownedNodeIds` are the applicant's own nodes, plus any the scenario added
 * (classifyScenario adds those for you). `input` is the input the op applies
 * to; ops that target a transfer, land-cover patch, borehole, demand object or registered volume by
 * id, or remove or move a node, need it to see which nodes they touch, and
 * are 'baseline' without it. `addedCropIds` are the crops the scenario itself
 * added (classifyScenario passes them): changing or removing one of those is
 * the proposal's, any other crop is catchment-wide data.
 */
export function classifyOp(op: ScenarioOp, ownedNodeIds: Iterable<string>, input?: ModelInput, addedCropIds: Iterable<string> = []): OpClass {
	const owned = ownedNodeIds instanceof Set ? (ownedNodeIds as Set<string>) : new Set(ownedNodeIds);
	const mine = (id: string | undefined | null) => typeof id === 'string' && owned.has(id);
	const ok = (x: boolean): OpClass => (x ? 'proposal' : 'baseline');
	switch (op.op) {
		case 'settings.set':
		case 'series.scale':
		// The Reserve's rule table: never the applicant's to propose, whoever's node the site is.
		case 'ewrRule.set':
		case 'ewrRule.remove':
			return 'baseline';
		case 'node.set':
			// Any other field of the applicant's own node is theirs to propose: its dam, irrigation,
			// boreholes, and how it takes water (the supply rule and river pump, WP-3.8), which is
			// what a licence to abstract from the river asks for, like a new pump. Land and flow
			// share split the catchment's natural runoff, so they stay baseline.
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
		case 'node.insert':
			// As node.add: a new structure on the reach. The nodes it re-points keep their values and their order along the river.
			// A senior other water user (the default priority) is the exception: farms upstream of it must pass its demand
			// (model.md §2.7c), so inserting one above others' farms curtails them, which is not the proposal's to decide.
			return ok(!sharesRunoff(op.node) && !seniorUser(op.node));
		case 'node.move': {
			// Moving the applicant's own abstraction point (a leaf with no land) is where they propose to take water;
			// moving anything else, or a node others drain into, redraws the river as modelled.
			const n = input?.model.nodes.find((x) => x.id === op.nodeId);
			const leaf = !!input && !input.model.nodes.some((x) => x.downstreamNodeId === op.nodeId);
			const ewrSite = Array.isArray(input?.settings.ewrRules) && input.settings.ewrRules.some((t) => t?.siteNodeId === op.nodeId);
			return ok(mine(op.nodeId) && !!n && !sharesRunoff(n) && !seniorUser(n) && leaf && !ewrSite);
		}
		case 'cropArea.set':
			return ok(mine(op.nodeId));
		case 'crop.add':
			return 'proposal';
		case 'crop.set':
		case 'crop.remove':
			// A crop's factors and efficiency apply on every farm that grows it, farms the applicant may not
			// see among them: only a crop the scenario itself added is the proposal's to change.
			return ok(new Set(addedCropIds).has(op.cropId));
		case 'transfer.add':
			// The unit its seepage rejoins below (engine ≥ 1.42.0) is credited that water, so it must be the proposal's too.
			return ok(mine(op.transfer.fromNodeId) && mine(op.transfer.toNodeId) && (!op.transfer.lossReturnNodeId || mine(op.transfer.lossReturnNodeId)));
		case 'transfer.set': {
			const t = input?.model.transfers.find((x) => x.id === op.transferId);
			const newEnd = op.field === 'fromNodeId' || op.field === 'toNodeId' || (op.field === 'lossReturnNodeId' && op.value !== null) ? mine(op.value as string) : true;
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
		case 'landCover.set': {
			const p = input?.model.landCover?.find((x) => x.id === op.patchId);
			return ok(!!p && mine(p.nodeId));
		}
		case 'allocation.set': {
			// The volume the applicant asks for on their own unit is the proposal; one on another's unit, or
			// replacing another's volume, is a baseline assumption.
			const was = input?.model.allocations?.find((x) => x.id === op.allocation.id);
			return ok(!!input && mine(op.allocation.nodeId) && (!was || mine(was.nodeId)));
		}
		case 'allocation.remove': {
			const was = input?.model.allocations?.find((x) => x.id === op.allocationId);
			return ok(!!was && mine(was.nodeId));
		}
		case 'borehole.add':
			return ok(mine(op.borehole.nodeId));
		case 'borehole.remove': {
			const b = input?.model.boreholes?.find((x) => x.id === op.boreholeId);
			return ok(!!b && mine(b.nodeId));
		}
		// A demand object is supplied from its unit's own dam, river pump and boreholes (model.md §2.7f):
		// one on the applicant's unit is theirs to propose, like a borehole; one on another's unit is baseline.
		case 'demandObject.add':
			return ok(mine(op.demandObject?.nodeId));
		case 'demandObject.set':
		case 'demandObject.remove': {
			const o = input?.model.demandObjects?.find((x) => x.id === op.demandObjectId);
			return ok(!!o && mine(o.nodeId));
		}
		case 'demand.scale':
			// Only the author's own nodes, named: without nodeIds it scales every farm (or user) of the catchment.
			return ok(!!op.nodeIds?.length && op.nodeIds.every(mine));
		default:
			return 'baseline';
	}
}

/**
 * Classify every op of a scenario against the input each one meets: the base
 * with the earlier ops applied, and nodes the scenario added counted as
 * owned. A skipped op (see applyScenario) is classified against the input it
 * would have met (scenarioSteps' `before`: its group's earlier ops applied).
 */
export function classifyScenario(base: ModelInput, ops: readonly ScenarioOp[], ownedNodeIds: Iterable<string>, options: ApplyOptions = {}): OpClass[] {
	const owned = new Set(ownedNodeIds);
	// Masked once up front: each op below meets the names and ids applyScenario's would.
	const cur = options.mask ? { ...base, model: maskModel(base.model, options.mask, ops).model } : base;
	const { before, applied } = step(cur, ops, null);
	const added = new Set(applied.map((a) => a.index));
	const crops = new Set<string>();
	return ops.map((op, i) => {
		const c = classifyOp(op, owned, before[i], crops);
		if (added.has(i) && (op.op === 'node.add' || op.op === 'node.insert')) owned.add(op.node.id);
		if (added.has(i) && op.op === 'crop.add') crops.add(op.crop.id);
		return c;
	});
}
