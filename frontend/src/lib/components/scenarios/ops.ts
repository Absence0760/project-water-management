// The override editor's pure side (docs/scenarios.md, docs/ui.md § Scenarios):
// the input each op meets, each op in words, the server's problems matched to
// their ops, and the "Add a change" form's draft turned into a ScenarioOp.
// The engine owns the rules (applyScenario, validateScenarioOps); this only
// reads and builds its data. No Svelte, no API.
import { findSystem, systemLabel } from '$lib/model/systems';
import {
	blankEwrRuleTable,
	DEMAND_OBJECT_CATEGORY_LABEL,
	DEMAND_SCALE_MAX,
	newDemandObjectDefaults,
	ewrSourceConfidence,
	LAND_COVER_CLASSES,
	SCALABLE_SERIES_KINDS,
	scenarioSteps,
	scheduleWindowProblem,
	upgradeLegacyModel,
	validateScenarioOps,
	type AllocationEntry,
	type AppliedOp,
	type BoreholeMode,
	type BoreholeTarget,
	type DemandCategory,
	type DemandObject,
	type DemandObjectCategory,
	type DemandObjectSizing,
	type DemandPart,
	type EwrRuleTable,
	type ModelInput,
	type NetworkNode,
	type NodeSetField,
	type OpClass,
	type ProjectModel,
	type ScalableSeriesKind,
	type ScenarioOp,
	type ScenarioOpName,
	type SettingsPath,
	type CropSetField,
	type LandCoverSetField,
	type TransferSetField
} from '@water-management/engine';
import type { DroughtRestrictionRule } from '@water-management/engine';
import { newNode } from '$lib/model/editor.svelte';
import { fmtNum, parseNum } from '$lib/format/number';
import { kindLabel } from '$lib/series/kinds';
import {
	CROP_FIELD_SPECS,
	DEMAND_OBJECT_FIELD_SPECS,
	DEMAND_PART_OPTIONS,
	LAND_COVER_FIELD_SPECS,
	SCHEDULE_LABEL,
	NODE_FIELD_SPECS,
	SETTINGS_SPECS,
	TRANSFER_FIELD_SPECS,
	formatValue,
	monthsText,
	parseValue,
	percentMessage,
	settingsValue,
	type DemandObjectFormField,
	type PeDraft,
	type ValueSpec
} from './fields';

// ---------------------------------------------------------------------------
// The base, and the input each op meets
// ---------------------------------------------------------------------------

/**
 * A run's model and settings snapshot as a ModelInput without series. Enough
 * for every op but `series.scale` (which then doesn't apply here, and changes
 * nothing): the editor only reads names and current values from it; which
 * ops apply is the server's check, made on the run's stored series.
 */
export function snapshotInput(model: unknown, settings: unknown): ModelInput {
	const m = (model && typeof model === 'object' ? model : {}) as Partial<ProjectModel>;
	return {
		settings: (settings && typeof settings === 'object' ? settings : {}) as ModelInput['settings'],
		model: upgradeLegacyModel({ nodes: [], crops: [], cropAreas: [], transfers: [], landCover: [], ...m } as ProjectModel),
		series: {}
	};
}

/**
 * The input each op meets (`before[i]`, the base with ops 0…i−1 applied as
 * the engine applies them: an op in an edit group meets the group's earlier
 * ops) and what a next op meets (`after`: every op, an incomplete last
 * `node.set` group included, so "Add a change" builds on it). The engine's
 * scenarioSteps (docs/scenarios.md § Edit groups).
 */
export function stepInputs(base: ModelInput, ops: readonly ScenarioOp[]): { before: ModelInput[]; after: ModelInput } {
	return scenarioSteps(base, ops);
}

/** Every node, crop and demand-object name the base or an op gives an id, for describing an op whose target is gone. */
export function namesOf(models: readonly (ProjectModel | undefined)[], ops: readonly ScenarioOp[] = []): Map<string, string> {
	const names = new Map<string, string>();
	for (const m of models) {
		for (const n of m?.nodes ?? []) names.set(n.id, n.name);
		for (const c of m?.crops ?? []) names.set(c.id, c.name);
		for (const o of m?.demandObjects ?? []) names.set(o.id, o.name);
	}
	for (const op of ops) {
		if ((op.op === 'node.add' || op.op === 'node.insert') && op.node?.id) names.set(op.node.id, op.node.name);
		if (op.op === 'crop.add' && op.crop?.id) names.set(op.crop.id, op.crop.name);
		if (op.op === 'demandObject.add' && op.demandObject?.id) names.set(op.demandObject.id, op.demandObject.name);
	}
	return names;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** An engine message with each id it names swapped for that node's or crop's name. */
export function nameIds(text: string, names: ReadonlyMap<string, string>): string {
	return text.replace(UUID, (id) => {
		const n = names.get(id);
		return n ? `“${n}”` : id;
	});
}

// ---------------------------------------------------------------------------
// Problems and notes, per op
// ---------------------------------------------------------------------------

export interface OpStatus {
	/** The engine's reason this op doesn't apply to the base (without its "op 3 (node.set):" prefix), or null. */
	problem: string | null;
	/** What applying it did besides its own edit (re-links, dropped references, days scaled). */
	notes: string[];
}

/** The 0-based ops a problem's `3`, `3–5` or `3, 5` names (1-based), or null if it isn't that. */
function namedOps(text: string): number[] | null {
	const out: number[] = [];
	for (const part of text.split(', ')) {
		const m = /^(\d+)(?:–(\d+))?$/.exec(part);
		if (!m) return null;
		const a = Number(m[1]);
		const b = m[2] === undefined ? a : Number(m[2]);
		if (b < a || b - a > 10_000) return null;
		for (let k = a; k <= b; k++) out.push(k - 1);
	}
	return out;
}

/**
 * Line the check's `applied` and `problems` up with the ops. A problem names
 * its op as `op N (kind): …` (1-based), or an edit group's ops as
 * `ops 3–5 (node.set, "Upper farm"): …` / `ops 3, 5 (…): …` (docs/scenarios.md
 * § Edit groups): each op it names gets it as its problem, so every op of a
 * group that doesn't apply shows why. One that names no op in range is
 * returned in `other`, so nothing the server said is dropped.
 */
export function statusByOp(count: number, applied: readonly AppliedOp[], problems: readonly string[]): { ops: OpStatus[]; other: string[] } {
	const ops: OpStatus[] = Array.from({ length: count }, () => ({ problem: null, notes: [] }));
	for (const a of applied) if (ops[a.index]) ops[a.index]!.notes = a.notes;
	const other: string[] = [];
	for (const p of problems) {
		// The label's parentheses may hold a node name with its own: the first "): " ends it.
		const m = /^ops? ([\d–, ]+?) \(.*?\): (.*)$/s.exec(p);
		const named = m ? namedOps(m[1]!) : null;
		if (!m || !named?.length || !named.every((i) => ops[i])) {
			other.push(p);
			continue;
		}
		for (const i of named) ops[i]!.problem = ops[i]!.problem ? `${ops[i]!.problem}; ${m[2]}` : m[2]!;
	}
	return { ops, other };
}

export const CLASS_LABEL: Record<OpClass, string> = { proposal: 'Proposal', baseline: 'Baseline assumption' };

// ---------------------------------------------------------------------------
// Each op in words
// ---------------------------------------------------------------------------

export const OP_LABEL: Record<ScenarioOpName, string> = {
	'node.set': "Change a node's value",
	'node.add': 'Add a node',
	'node.remove': 'Remove a node',
	'node.move': 'Move a node (what it drains into)',
	'node.insert': 'Insert a node on a reach',
	'cropArea.set': "Set a hydrological unit's crop area",
	'crop.add': 'Add a crop',
	'crop.set': 'Change a crop',
	'crop.remove': 'Remove a crop',
	'transfer.add': 'Add a transfer',
	'transfer.set': 'Change a transfer',
	'transfer.remove': 'Remove a transfer',
	'landCover.add': 'Add land cover',
	'landCover.remove': 'Remove land cover',
	'landCover.set': 'Change land cover',
	'borehole.add': 'Add a borehole',
	'borehole.remove': 'Remove a borehole',
	'demandObject.add': 'Add a demand object',
	'demandObject.set': 'Change a demand object',
	'demandObject.remove': 'Remove a demand object',
	'settings.set': 'Change a setting',
	'series.scale': 'Scale rainfall or daily A-pan',
	'demand.scale': 'Scale demand',
	'ewrRule.set': "Set an EWR site's rule table",
	'ewrRule.remove': "Remove an EWR site's rule table",
	'allocation.set': 'Set a registered volume',
	'allocation.remove': 'Remove a registered volume'
};

/** A node or crop id that neither the base nor any name source knows. */
export const UNKNOWN_NODE = 'a node the base run doesn’t have';
export const UNKNOWN_CROP = 'a crop the base run doesn’t have';

const KIND_WORD: Record<string, string> = { farm: 'hydrological unit', user: 'other water user', gauge: 'gauge' };
const ha = (m2: number) => `${fmtNum(m2 / 10_000, 2, true)} ha`;
const coverLabel = (id: string) => LAND_COVER_CLASSES.find((c) => c.id === id)?.label ?? id;
const change = (spec: ValueSpec, was: unknown, now: unknown, name: (id: string) => string) =>
	was === undefined ? `→ ${formatValue(spec, now, name)}` : `${formatValue(spec, was, name)} → ${formatValue(spec, now, name)}`;

/**
 * One op as a sentence: "Upper farm: Dam capacity 150,000 m³ → 180,000 m³".
 * `before` is the input the op meets (for the value it replaces); `names`
 * names ids it no longer has (namesOf). An id nothing names (a node removed
 * from a newer base the scenario was rebased onto) reads as UNKNOWN_NODE.
 */
export function describeOp(op: ScenarioOp, before: ModelInput | null, names: ReadonlyMap<string, string> = new Map()): string {
	const m = before?.model;
	// A system's row, by id or (a document's) preset key (engine ≥ 1.72.0), shown as "Drip, 90 %".
	const systemName = (id: string) => {
		const s = m ? findSystem(m, id) : null;
		return s ? systemLabel(s) : (names.get(id) ?? 'an irrigation system the base run doesn’t have');
	};
	const nodeName = (id: string) => m?.nodes.find((n) => n.id === id)?.name ?? names.get(id) ?? (m && findSystem(m, id) ? systemName(id) : UNKNOWN_NODE);
	const cropName = (id: string) => m?.crops.find((c) => c.id === id)?.name ?? names.get(id) ?? UNKNOWN_CROP;
	const transferName = (id: string) => {
		const t = m?.transfers.find((x) => x.id === id);
		return t ? `the transfer ${nodeName(t.fromNodeId)} → ${nodeName(t.toNodeId)}` : 'a transfer';
	};
	switch (op.op) {
		case 'node.set': {
			const f = NODE_FIELD_SPECS[op.field as NodeSetField];
			const node = m?.nodes.find((n) => n.id === op.nodeId);
			const was = node ? (node as unknown as Record<string, unknown>)[op.field] : undefined;
			return `${nodeName(op.nodeId)}: ${f?.label ?? op.field} ${f ? change(f.spec, was, op.value, nodeName) : `→ ${String(op.value)}`}`;
		}
		case 'node.add': {
			const n = op.node;
			const dam = n.kind === 'farm' && n.damCapacityM3 > 0 ? `, dam ${fmtNum(n.damCapacityM3)} m³` : '';
			const demand = n.kind === 'user' && Array.isArray(n.userDemandM3Day) ? `, demand ${formatValue(NODE_FIELD_SPECS.userDemandM3Day.spec, n.userDemandM3Day)}` : '';
			return `Add the ${KIND_WORD[n.kind] ?? n.kind} “${n.name}”, draining into ${nodeName(n.downstreamNodeId ?? '')}${dam}${demand}`;
		}
		case 'node.remove':
			return `Remove “${nodeName(op.nodeId)}”`;
		case 'node.move': {
			const was = m?.nodes.find((n) => n.id === op.nodeId)?.downstreamNodeId;
			return `Move “${nodeName(op.nodeId)}”: drains into ${was ? `${nodeName(was)} → ` : '→ '}${nodeName(op.downstreamNodeId)}`;
		}
		case 'node.insert': {
			const n = op.node;
			const dam = n.kind === 'farm' && n.damCapacityM3 > 0 ? `, dam ${fmtNum(n.damCapacityM3)} m³` : '';
			const ups = (op.upstreamNodeIds ?? []).map(nodeName).join(', ');
			return `Insert the ${KIND_WORD[n.kind] ?? n.kind} “${n.name}” above ${nodeName(n.downstreamNodeId ?? '')}, taking what ${ups} drain${op.upstreamNodeIds?.length === 1 ? 's' : ''}${dam}`;
		}
		case 'cropArea.set': {
			const was = m?.cropAreas.filter((a) => a.nodeId === op.nodeId && a.cropId === op.cropId).reduce((s, a) => s + a.areaM2, 0);
			const from = m ? `${ha(was ?? 0)} → ` : '→ ';
			// Its system on the unit (engine ≥ 1.72.0), when the op names one.
			const sys = op.irrigationSystemId === undefined ? '' : op.irrigationSystemId === null ? ", on the crop's default system" : `, on ${systemName(op.irrigationSystemId)}`;
			return `${nodeName(op.nodeId)}: ${cropName(op.cropId)} ${from}${op.areaM2 > 0 ? ha(op.areaM2) : 'none'}${sys}`;
		}
		case 'crop.add':
			return `Add the crop “${op.crop.name}”`;
		case 'crop.set': {
			const f = CROP_FIELD_SPECS[op.field as CropSetField];
			const c = m?.crops.find((x) => x.id === op.cropId);
			// A crop's own efficiency left out is the hydrological unit's, as null is.
			const was = c ? ((c as unknown as Record<string, unknown>)[op.field] ?? null) : undefined;
			return `Crop ${cropName(op.cropId)}: ${f?.label ?? op.field} ${f ? change(f.spec, was, op.value, nodeName) : `→ ${String(op.value)}`}`;
		}
		case 'crop.remove': {
			const farms = new Set(m?.cropAreas.filter((a) => a.cropId === op.cropId).map((a) => a.nodeId) ?? []).size;
			return `Remove the crop “${cropName(op.cropId)}”${m ? (farms ? `, and its area on ${farms} hydrological unit${farms === 1 ? '' : 's'}` : ', planted nowhere') : ''}`;
		}
		case 'transfer.add': {
			const t = op.transfer;
			const cap = t.dailyCapM3 != null ? `, at most ${fmtNum(t.dailyCapM3)} m³/day` : '';
			return `Add a transfer ${nodeName(t.fromNodeId)} → ${nodeName(t.toNodeId)} (${monthsText(t.months)}, up to ${fmtNum(t.maxRateM3s, 4, true)} m³/s${cap})`;
		}
		case 'transfer.set': {
			const f = TRANSFER_FIELD_SPECS[op.field as TransferSetField];
			const t = m?.transfers.find((x) => x.id === op.transferId);
			const was = t ? (t as unknown as Record<string, unknown>)[op.field] : undefined;
			const what = transferName(op.transferId);
			return `${what.charAt(0).toUpperCase()}${what.slice(1)}: ${f?.label ?? op.field} ${f ? change(f.spec, was, op.value, nodeName) : `→ ${String(op.value)}`}`;
		}
		case 'transfer.remove':
			return `Remove ${transferName(op.transferId)}`;
		case 'landCover.add': {
			const p = op.patch;
			return `${nodeName(p.nodeId)}: add ${coverLabel(p.coverClass)}, ${fmtNum(p.areaKm2, 3, true)} km² at ${fmtNum(p.densityPct * 100, 1, true)} % cover`;
		}
		case 'landCover.remove': {
			const p = m?.landCover?.find((x) => x.id === op.patchId);
			return p ? `${nodeName(p.nodeId)}: remove ${coverLabel(p.coverClass)} (${fmtNum(p.areaKm2, 3, true)} km²)` : 'Remove a land-cover patch';
		}
		case 'landCover.set': {
			const f = LAND_COVER_FIELD_SPECS[op.field as LandCoverSetField];
			const p = m?.landCover?.find((x) => x.id === op.patchId);
			const was = p ? (p as unknown as Record<string, unknown>)[op.field] : undefined;
			const what = p ? `${nodeName(p.nodeId)}, ${coverLabel(p.coverClass)} patch of ${fmtNum(p.areaKm2, 3, true)} km²` : 'A land-cover patch';
			return `${what}: ${f?.label ?? op.field} ${f ? change(f.spec, was, op.value, nodeName) : `→ ${String(op.value)}`}`;
		}
		case 'borehole.add': {
			const b = op.borehole;
			const cap = b.annualCapM3 === null ? 'no annual cap' : `at most ${fmtNum(b.annualCapM3)} m³/a`;
			const into = b.target === 'dam' ? ', into the dam' : '';
			return `${nodeName(b.nodeId)}: add the borehole “${b.name}”, ${fmtNum(b.capacityM3Day)} m³/day ${b.mode}${into}, ${cap}, depletion ${fmtNum(b.depletionFactor * 100, 1, true)} %`;
		}
		case 'borehole.remove': {
			const b = m?.boreholes?.find((x) => x.id === op.boreholeId);
			return b ? `${nodeName(b.nodeId)}: remove the borehole “${b.name}”` : 'Remove a borehole';
		}
		case 'demandObject.add': {
			const o = op.demandObject;
			return `${nodeName(o.nodeId)}: add the demand object “${o.name}”, ${objectText(o)}`;
		}
		case 'demandObject.set': {
			const o = m?.demandObjects?.find((x) => x.id === op.demandObjectId);
			const what = o ? `${nodeName(o.nodeId)}, demand object “${o.name}”` : 'A demand object';
			if (op.field === 'schedule') return `${what}: ${SCHEDULE_LABEL} ${o ? `${scheduleText(o.schedule)} → ` : '→ '}${scheduleText(op.value as DemandObject['schedule'])}`;
			const f = DEMAND_OBJECT_FIELD_SPECS[op.field as DemandObjectFormField];
			// No source has a meaning, not recorded (engine ≥ 1.56.0), and no rank too, rank 1 (engine ≥ 1.64.0): show it as the "was".
			const was = o ? ((o as unknown as Record<string, unknown>)[op.field] ?? (op.field === 'source' || op.field === 'rank' ? null : undefined)) : undefined;
			return `${what}: ${f?.label ?? op.field} ${f ? change(f.spec, was, op.value, nodeName) : `→ ${String(op.value)}`}`;
		}
		case 'demandObject.remove': {
			const o = m?.demandObjects?.find((x) => x.id === op.demandObjectId);
			return o ? `${nodeName(o.nodeId)}: remove the demand object “${o.name}” (${objectText(o)})` : 'Remove a demand object';
		}
		case 'settings.set': {
			const f = SETTINGS_SPECS[op.path as SettingsPath];
			// An unset date or PE input has a meaning (the first day with rain; pan × A-pan, as the engine runs it): show it as the "was".
			// So has no drought restriction rule (engine ≥ 1.54.0): off.
			const unsetIsNull = f?.spec.t === 'date' || f?.spec.t === 'pe' || f?.spec.t === 'restriction';
			const was = before ? (settingsValue(before.settings, op.path) ?? (unsetIsNull ? null : undefined)) : undefined;
			return `${f?.label ?? op.path}: ${f ? change(f.spec, was, op.value, nodeName) : `→ ${String(op.value)}`}`;
		}
		case 'series.scale': {
			const pct = (op.factor - 1) * 100;
			const days = op.from || op.to ? `, ${op.from ?? 'start'} to ${op.to ?? 'end'}` : '';
			return `${kindLabel(op.kind)}: × ${fmtNum(op.factor, 4, true)} (${pct > 0 ? '+' : ''}${fmtNum(pct, 2, true).replace('-', '−')} %)${days}`;
		}
		case 'demand.scale': {
			const user = op.category === 'user';
			const who = op.nodeIds?.length ? op.nodeIds.map(nodeName).join(', ') : user ? 'every other water user' : 'every hydrological unit';
			const months = op.months?.length ? `, in ${monthsText(op.months)}` : '';
			// One part of a unit's demand (engine ≥ 1.45.0): its crops, or its demand objects of one category.
			const part = op.part ? (DEMAND_PART_OPTIONS.find((p) => p.value === op.part)?.label ?? op.part) : null;
			const whose = part ? `${part} demand` : user ? 'Demand' : 'Irrigation demand';
			return `${whose} of ${who}: ${fmtNum(op.factor * 100, 2, true)} % of what they'd take (× ${fmtNum(op.factor, 4, true)})${months}`;
		}
		case 'ewrRule.set': {
			const t = op.table;
			const was = before ? siteTable(before, t.siteNodeId) : undefined;
			const now = tableText(t, true);
			const where = `Reserve rule table at ${siteName(t.siteNodeId, m, nodeName)}`;
			return was === undefined ? `${where}: → ${now}` : `${where}: ${was ? tableText(was, false) : 'none'} → ${now}`;
		}
		case 'ewrRule.remove': {
			const was = before ? siteTable(before, op.siteNodeId) : undefined;
			const where = `Reserve rule table at ${siteName(op.siteNodeId, m, nodeName)}`;
			return `${where}: ${was ? `${tableText(was, false)} → ` : was === null ? 'none → ' : ''}removed`;
		}
		case 'allocation.set': {
			const a = op.allocation;
			const was = m?.allocations?.find((x) => x.id === a.id);
			return was
				? `${nodeName(a.nodeId ?? '')}: registered volume ${volumeText(was)} → ${volumeText(a)}${was.nodeId !== a.nodeId ? ` (was on ${nodeName(was.nodeId ?? '')})` : ''}`
				: `${nodeName(a.nodeId ?? '')}: add a registered volume, ${volumeText(a)}`;
		}
		case 'allocation.remove': {
			const was = m?.allocations?.find((x) => x.id === op.allocationId);
			return was ? `${nodeName(was.nodeId ?? '')}: remove the registered volume ${volumeText(was)}` : 'Remove a registered volume';
		}
		default:
			return `Unknown change ${(op as { op?: string }).op ?? ''}`;
	}
}

/** A demand object in a few words: "Municipal (town), 300 m³/day on average" or "Livestock, 400 × 45 l a day", and piped out or off when it is. */
export function objectText(o: DemandObject): string {
	const size =
		o.sizing === 'perUnit'
			? `${fmtNum(o.count ?? 0)} × ${fmtNum(o.litresPerUnitDay ?? 0, 1, true)} l a day`
			: `${fmtNum((o.monthlyM3Day ?? []).reduce((a, v) => a + v, 0) / 12, 1, true)} m³/day on average`;
	return [DEMAND_OBJECT_CATEGORY_LABEL[o.category] ?? o.category, size, o.destination === 'external' ? 'piped out' : '', o.enabled === false ? 'not modelled' : ''].filter(Boolean).join(', ');
}

/** A demand object's schedule in words (none, null and an empty one run the same): "2 windows (Weekends × 0.5, Christmas off)". */
function scheduleText(w: DemandObject['schedule']): string {
	if (!w?.length) return 'none';
	const each = w.map((x, i) => `${x.label?.trim() || `window ${i + 1}`} ${x.factor === 0 ? 'off' : `× ${fmtNum(x.factor, 4, true)}`}`);
	return `${w.length} window${w.length === 1 ? '' : 's'} (${each.join(', ')})`;
}

/** A registered volume in words (docs/allocations.md): "surface 120,000 m³/a, valid 2020-10-01 to …, Oct–Mar only, at most 0.05 m³/s". */
export function volumeText(a: AllocationEntry): string {
	const parts = [a.waterUse === '21b' ? `${a.waterSource} storage only (s21b)` : `${a.waterSource} ${fmtNum(a.volumeM3PerYear)} m³/a`];
	if (a.validFrom || a.validTo) parts.push(`valid ${a.validFrom ?? '…'} to ${a.validTo ?? '…'}`);
	if (a.storageM3 != null) parts.push(`storage ${fmtNum(a.storageM3)} m³`);
	if (a.months?.length) parts.push(`${monthsText(a.months)} only`);
	if (a.maxRateM3s != null) parts.push(`at most ${fmtNum(a.maxRateM3s, 4, true)} m³/s`);
	return parts.join(', ');
}

/** The outlet, or a gauge by name: where an ewrRule.set puts its table. */
function siteName(siteNodeId: string | null, m: ModelInput['model'] | undefined, nodeName: (id: string) => string): string {
	const outflow = m?.nodes.find((n) => n.downstreamNodeId === null);
	if (siteNodeId === null || siteNodeId === outflow?.id) return outflow ? `the outlet (${outflow.name})` : 'the outlet';
	return nodeName(siteNodeId);
}

/**
 * The table the input has at an EWR site (null when it has none): the outlet
 * whether a table names it null or by the outlet node's id, as the engine
 * matches it (ewrRule.set, engine ≥ 1.6.0).
 */
export function siteTable(input: ModelInput, siteNodeId: string | null): EwrRuleTable | null {
	const outflow = input.model.nodes.find((n) => n.downstreamNodeId === null)?.id;
	const site = (id: string | null | undefined) => (id === undefined || id === null || id === outflow ? null : id);
	const list = Array.isArray(input.settings.ewrRules) ? input.settings.ewrRules : [];
	return list.find((x) => x && typeof x === 'object' && site(x.siteNodeId) === site(siteNodeId)) ?? null;
}

/**
 * A rule table in a few words, with its source and its confidence line (WP-3.7):
 * “GN 1234, table 3” (Gazetted Reserve), and with `detail` what it covers
 * and its % points.
 */
export function tableText(t: EwrRuleTable, detail: boolean): string {
	const source = typeof t.source === 'string' && t.source.trim() ? `“${t.source.trim()}”` : 'a table with no source';
	const confidence = ewrSourceConfidence(t.sourceKind) ?? 'kind of source not stated';
	if (!detail) return `${source} (${confidence})`;
	const covers = t.component === 'lowFlow' ? 'low flows' : 'total flow';
	const points = Array.isArray(t.points) ? t.points.length : 0;
	return `${source} (${confidence}), ${covers}, ${points} % point${points === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// The "Add a change" form
// ---------------------------------------------------------------------------

/** Everything the form can hold; each op reads its own fields. Numbers stay text until built. */
export interface OpDraft {
	kind: ScenarioOpName;
	nodeId: string;
	/** node.set / transfer.set field, or settings.set path. */
	field: string;
	/** node.set / transfer.set / settings.set value, as typed. */
	value: string;
	/** Months, for a months field or a new transfer. */
	months: number[];
	/** settings.set pe: the PE input being written. */
	pe: PeDraft;
	/** settings.set droughtRestriction (engine ≥ 1.54.0): the rule being written, null = off. */
	restriction: DroughtRestrictionRule | null;
	cropId: string;
	areaHa: string;
	/** cropArea.set's system on the unit (engine ≥ 1.72.0): '' keeps its own, 'default' is the crop's, else a row id. */
	systemId: string;
	transferId: string;
	patchId: string;
	newKind: 'farm' | 'user';
	newName: string;
	downstreamNodeId: string;
	damCapacityM3: string;
	demandM3Day: string;
	cropName: string;
	cropFactors: string;
	fromNodeId: string;
	toNodeId: string;
	maxRateM3s: string;
	dailyCapM3: string;
	minStoragePct: string;
	priority: string;
	coverClass: string;
	coverAreaKm2: string;
	densityPct: string;
	/** demandObject.set / .remove: the object (engine ≥ 1.45.0); demandObject.add: the new one's main fields, the rest its category's defaults. */
	demandObjectId: string;
	doName: string;
	doCategory: DemandObjectCategory;
	doSizing: DemandObjectSizing;
	doMonthlyM3Day: string;
	doCount: string;
	doLitres: string;
	/** demandObject.set schedule: a copy of the object, its schedule edited by the Network form's own editor. */
	doScheduleObject: DemandObject | null;
	/** borehole.remove: the borehole; borehole.add: the new one's fields (WP-3.9). */
	boreholeId: string;
	bhName: string;
	bhCapacityM3Day: string;
	bhAnnualCapM3: string;
	bhMode: BoreholeMode;
	bhTarget: BoreholeTarget;
	bhEmergencyPct: string;
	bhDepletionPct: string;
	seriesKind: ScalableSeriesKind;
	changePct: string;
	from: string;
	to: string;
	/** demand.scale (issue #53 R1): whose demand, which of them (none = all), and the new demand as a % of today's. */
	demandCategory: DemandCategory;
	demandNodeIds: string[];
	demandPct: string;
	/** demand.scale's part (engine ≥ 1.45.0): '' for the whole demand, else crops or a demand object category. */
	demandPart: DemandPart | '';
	/** ewrRule.set (engine ≥ 1.6.0): the site (OUTLET_SITE or a gauge's id), and its table as the Settings editor holds it (one table). */
	ewrSite: string;
	ewrTables: EwrRuleTable[];
	/** node.insert (engine ≥ 1.35.0): the nodes draining into the new node's downstream node that drain into it instead. */
	upstreamNodeIds: string[];
	/** allocation.set / .remove (engine ≥ 1.35.0): the volume replaced or removed (NEW_ALLOCATION for a new one), and the entry's fields. */
	allocationId: string;
	alSource: 'surface' | 'groundwater';
	alVolume: string;
	alStorage: string;
	alFrom: string;
	alTo: string;
	alRate: string;
}

/** The form's value for a new registered volume (allocation.set with a fresh id). */
export const NEW_ALLOCATION = '(new)';

/** The form's value for the outlet as an EWR site (a table's siteNodeId null). */
export const OUTLET_SITE = '(outlet)';

export function emptyDraft(kind: ScenarioOpName = 'node.set'): OpDraft {
	return {
		kind,
		nodeId: '',
		field: '',
		value: '',
		months: [],
		pe: { kind: 'pan', mm: '', source: '' },
		restriction: null,
		cropId: '',
		areaHa: '',
		systemId: '',
		transferId: '',
		patchId: '',
		newKind: 'farm',
		newName: '',
		downstreamNodeId: '',
		damCapacityM3: '0',
		demandM3Day: '0',
		cropName: '',
		cropFactors: '',
		fromNodeId: '',
		toNodeId: '',
		maxRateM3s: '',
		dailyCapM3: '',
		minStoragePct: '0',
		priority: '0',
		coverClass: LAND_COVER_CLASSES[0].id,
		coverAreaKm2: '',
		densityPct: '100',
		demandObjectId: '',
		doName: '',
		doCategory: 'municipal',
		doSizing: 'monthly',
		doMonthlyM3Day: '',
		doCount: '',
		doLitres: '',
		doScheduleObject: null,
		boreholeId: '',
		bhName: '',
		bhCapacityM3Day: '',
		bhAnnualCapM3: '',
		bhMode: 'supplemental',
		bhTarget: 'direct',
		bhEmergencyPct: '30',
		bhDepletionPct: '0',
		seriesKind: SCALABLE_SERIES_KINDS[0],
		changePct: '',
		from: '',
		to: '',
		demandCategory: 'farm',
		demandNodeIds: [],
		demandPct: '',
		demandPart: '',
		ewrSite: '',
		ewrTables: [],
		upstreamNodeIds: [],
		allocationId: '',
		alSource: 'surface',
		alVolume: '',
		alStorage: '',
		alFrom: '',
		alTo: '',
		alRate: ''
	};
}

/** The allocation.set draft's fields from a stored volume (or a new one's defaults), so a small change is a small edit. */
export function allocationDraft(d: OpDraft, a: AllocationEntry | undefined): OpDraft {
	if (!a) return { ...d, nodeId: '', months: [], alSource: 'surface', alVolume: '', alStorage: '', alFrom: '', alTo: '', alRate: '' };
	const t = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
	return {
		...d,
		nodeId: a.nodeId ?? '',
		months: [...(a.months ?? [])],
		alSource: a.waterSource,
		alVolume: t(a.volumeM3PerYear),
		alStorage: t(a.storageM3),
		alFrom: a.validFrom ?? '',
		alTo: a.validTo ?? '',
		alRate: t(a.maxRateM3s)
	};
}

/**
 * Whether a draft holds anything beyond its kind: a target, a field or a
 * value typed in. Picking a kind alone isn't work to lose (the leave guard,
 * lib/nav/unsaved.ts).
 */
export function draftStarted(d: OpDraft): boolean {
	return JSON.stringify(d) !== JSON.stringify(emptyDraft(d.kind));
}

/**
 * The table ewrRule.set starts from at a site: a copy of the one the input
 * has there (so a small change is a small edit), or a blank one at the
 * Settings form's default points.
 */
export function startTable(input: ModelInput, site: string): EwrRuleTable {
	const siteNodeId = site === OUTLET_SITE ? null : site;
	const t = siteTable(input, siteNodeId);
	return t ? { ...(JSON.parse(JSON.stringify(t)) as EwrRuleTable), siteNodeId } : blankEwrRuleTable(siteNodeId);
}

/** The value spec of the field a node.set / transfer.set / settings.set draft names, or null. */
export function draftSpec(d: Pick<OpDraft, 'kind' | 'field'>): ValueSpec | null {
	const table =
		d.kind === 'node.set'
			? NODE_FIELD_SPECS
			: d.kind === 'transfer.set'
				? TRANSFER_FIELD_SPECS
				: d.kind === 'settings.set'
					? SETTINGS_SPECS
					: d.kind === 'crop.set'
						? CROP_FIELD_SPECS
						: d.kind === 'landCover.set'
							? LAND_COVER_FIELD_SPECS
							: d.kind === 'demandObject.set'
								? DEMAND_OBJECT_FIELD_SPECS
								: null;
	return (table as Record<string, { spec: ValueSpec }> | null)?.[d.field]?.spec ?? null;
}

export type Built = { ok: true; op: ScenarioOp } | { ok: false; error: string };

const need = (v: string, what: string): string => {
	if (!v) throw new DraftError(`pick ${what}`);
	return v;
};
class DraftError extends Error {}
function number(text: string, what: string, opts: { nullable?: boolean; scale?: number; int?: boolean } = {}): number | null {
	const t = text.trim();
	if (t === '') {
		if (opts.nullable) return null;
		throw new DraftError(`enter ${what}`);
	}
	const n = parseNum(t);
	if (n === null) throw new DraftError(`${what}: “${t}” isn't a number`);
	if (opts.int && !Number.isInteger(n)) throw new DraftError(`${what} must be a whole number`);
	return Math.round((n / (opts.scale ?? 1)) * 1e9) / 1e9;
}
function parsed(spec: ValueSpec, input: string | number[] | PeDraft | DroughtRestrictionRule | null, what: string): unknown {
	const p = parseValue(spec, input);
	if (!p.ok) throw new DraftError(`${what}: ${p.error}`);
	return p.value;
}

/**
 * The form's draft as one op, checked by the engine's own validator
 * (validateScenarioOps) so the ranges are exactly the backend's. `model` is
 * the input the new op will meet (after the ops already listed), for the
 * new node's place in the order. Whether the op applies to the base (its
 * target still exists, the network stays valid) is the server's check.
 */
export function buildOp(d: OpDraft, model: ProjectModel, newId: () => string = () => crypto.randomUUID()): Built {
	let op: ScenarioOp;
	let spec: ValueSpec | null = null;
	try {
		switch (d.kind) {
			case 'node.set': {
				spec = draftSpec(d);
				if (!spec) throw new DraftError('pick what to change');
				const node = model.nodes.find((n) => n.id === need(d.nodeId, 'a node'));
				const value = parsed(spec, spec.t === 'months' ? d.months : d.value, NODE_FIELD_SPECS[d.field as NodeSetField].label);
				op = { op: 'node.set', nodeId: node?.id ?? d.nodeId, field: d.field, value } as ScenarioOp;
				break;
			}
			case 'node.add': {
				const name = d.newName.trim();
				if (!name) throw new DraftError('enter a name for the new node');
				const node: NetworkNode = { ...newNode(Math.max(0, ...model.nodes.map((n) => n.sortOrder + 1)), need(d.downstreamNodeId, 'the node it drains into')), id: newId(), name, kind: d.newKind };
				if (d.newKind === 'farm') node.damCapacityM3 = number(d.damCapacityM3, 'the dam capacity')!;
				else node.userDemandM3Day = new Array<number>(12).fill(number(d.demandM3Day, 'the demand')!);
				op = { op: 'node.add', node };
				break;
			}
			case 'node.remove':
				op = { op: 'node.remove', nodeId: need(d.nodeId, 'a node') };
				break;
			case 'node.move':
				op = { op: 'node.move', nodeId: need(d.nodeId, 'the node to move'), downstreamNodeId: need(d.downstreamNodeId, 'what it will drain into') };
				break;
			case 'node.insert': {
				const name = d.newName.trim();
				if (!name) throw new DraftError('enter a name for the new node');
				const node: NetworkNode = { ...newNode(Math.max(0, ...model.nodes.map((n) => n.sortOrder + 1)), need(d.downstreamNodeId, 'the node it drains into')), id: newId(), name, kind: d.newKind };
				if (d.newKind === 'farm') node.damCapacityM3 = number(d.damCapacityM3, 'the dam capacity')!;
				else node.userDemandM3Day = new Array<number>(12).fill(number(d.demandM3Day, 'the demand')!);
				// Only nodes that drain there now: a stale tick (the downstream node changed) is dropped.
				const ups = d.upstreamNodeIds.filter((id) => model.nodes.some((n) => n.id === id && n.downstreamNodeId === node.downstreamNodeId));
				if (!ups.length) throw new DraftError('tick the nodes that will drain into the new one (with none, add a node instead)');
				op = { op: 'node.insert', node, upstreamNodeIds: [...new Set(ups)] };
				break;
			}
			case 'cropArea.set':
				op = {
					op: 'cropArea.set',
					nodeId: need(d.nodeId, 'a hydrological unit'),
					cropId: need(d.cropId, 'a crop'),
					areaM2: number(d.areaHa, 'the area', { scale: 1 / 10_000 })!,
					...(d.systemId === '' ? {} : { irrigationSystemId: d.systemId === 'default' ? null : d.systemId })
				};
				break;
			case 'crop.add': {
				const name = d.cropName.trim();
				if (!name) throw new DraftError('enter a name for the new crop');
				const cropFactor = parsed({ t: 'monthly', unit: '', scale: 1, nullable: false }, d.cropFactors, 'Crop factors') as number[];
				op = { op: 'crop.add', crop: { id: newId(), name, cropFactor } };
				break;
			}
			case 'crop.set': {
				spec = draftSpec(d);
				if (!spec) throw new DraftError('pick what to change');
				const value = parsed(spec, d.value, CROP_FIELD_SPECS[d.field as CropSetField].label);
				op = { op: 'crop.set', cropId: need(d.cropId, 'a crop'), field: d.field, value } as ScenarioOp;
				break;
			}
			case 'crop.remove':
				op = { op: 'crop.remove', cropId: need(d.cropId, 'a crop') };
				break;
			case 'transfer.add':
				op = {
					op: 'transfer.add',
					transfer: {
						id: newId(),
						fromNodeId: need(d.fromNodeId, 'the source'),
						toNodeId: need(d.toNodeId, 'the destination'),
						months: [...new Set(d.months)].sort((a, b) => a - b),
						maxRateM3s: number(d.maxRateM3s, 'the maximum rate')!,
						dailyCapM3: number(d.dailyCapM3, 'the daily cap', { nullable: true }),
						minStoragePct: number(d.minStoragePct, 'the minimum level', { scale: 100 })!,
						enabled: true,
						priority: number(d.priority, 'the priority', { int: true })!
					}
				};
				break;
			case 'transfer.set': {
				spec = draftSpec(d);
				if (!spec) throw new DraftError('pick what to change');
				const value = parsed(spec, spec.t === 'months' ? d.months : d.value, TRANSFER_FIELD_SPECS[d.field as TransferSetField].label);
				op = { op: 'transfer.set', transferId: need(d.transferId, 'a transfer'), field: d.field, value } as ScenarioOp;
				break;
			}
			case 'transfer.remove':
				op = { op: 'transfer.remove', transferId: need(d.transferId, 'a transfer') };
				break;
			case 'landCover.add':
				op = {
					op: 'landCover.add',
					patch: {
						id: newId(),
						nodeId: need(d.nodeId, 'a hydrological unit'),
						coverClass: need(d.coverClass, 'a land-cover class') as never,
						areaKm2: number(d.coverAreaKm2, 'the area')!,
						densityPct: number(d.densityPct, 'the cover', { scale: 100 })!,
						factors: null
					}
				};
				break;
			case 'landCover.remove':
				op = { op: 'landCover.remove', patchId: need(d.patchId, 'a land-cover patch') };
				break;
			case 'landCover.set': {
				spec = draftSpec(d);
				if (!spec) throw new DraftError('pick what to change');
				const value = parsed(spec, d.value, LAND_COVER_FIELD_SPECS[d.field as LandCoverSetField].label);
				op = { op: 'landCover.set', patchId: need(d.patchId, 'a land-cover patch'), field: d.field, value } as ScenarioOp;
				break;
			}
			case 'borehole.add': {
				const name = d.bhName.trim();
				if (!name) throw new DraftError('enter a name for the borehole');
				op = {
					op: 'borehole.add',
					borehole: {
						id: newId(),
						nodeId: need(d.nodeId, 'a hydrological unit or other user'),
						name,
						capacityM3Day: number(d.bhCapacityM3Day, 'the capacity')!,
						annualCapM3: number(d.bhAnnualCapM3, 'the annual cap', { nullable: true }),
						mode: d.bhMode,
						emergencyBelowPct: number(d.bhEmergencyPct, 'the emergency level', { scale: 100 })!,
						target: d.bhTarget,
						depletionFactor: number(d.bhDepletionPct, 'the stream depletion', { scale: 100 })!
					}
				};
				break;
			}
			case 'borehole.remove':
				op = { op: 'borehole.remove', boreholeId: need(d.boreholeId, 'a borehole') };
				break;
			case 'demandObject.add': {
				const name = d.doName.trim();
				if (!name) throw new DraftError('enter a name for the demand object');
				const nodeId = need(d.nodeId, 'a hydrological unit');
				const perUnit = d.doSizing === 'perUnit';
				// Its category's defaults (the Network form's Add demand), then what was typed.
				const defaults = newDemandObjectDefaults(d.doCategory);
				const o: DemandObject = {
					id: newId(),
					nodeId,
					name,
					category: d.doCategory,
					...defaults,
					sizing: d.doSizing,
					monthlyM3Day: perUnit ? null : (parsed({ t: 'monthly', unit: 'm³/day', scale: 1, nullable: false }, d.doMonthlyM3Day, 'Demand by month') as number[]),
					count: perUnit ? number(d.doCount, 'the count') : null,
					litresPerUnitDay: perUnit ? number(d.doLitres, 'the litres per unit a day') : null,
					monthlyFactor: null,
					enabled: true,
					note: ''
				};
				op = { op: 'demandObject.add', demandObject: o };
				break;
			}
			case 'demandObject.set': {
				if (d.field === 'schedule') {
					if (!d.doScheduleObject) throw new DraftError('pick a demand object');
					// Plain data (the editor's state is a proxy); no windows is no schedule.
					const w = JSON.parse(JSON.stringify(d.doScheduleObject.schedule ?? [])) as NonNullable<DemandObject['schedule']>;
					// A window the run can't read is refused here in the Network form's words (the save rule applyScenario runs too).
					w.forEach((x, i) => {
						const bad = scheduleWindowProblem(x);
						if (bad) throw new DraftError(`window ${i + 1}${x.label ? ` (“${x.label}”)` : ''}: ${bad}`);
					});
					op = { op: 'demandObject.set', demandObjectId: need(d.demandObjectId, 'a demand object'), field: 'schedule', value: w.length ? w : null };
					break;
				}
				spec = draftSpec(d);
				if (!spec) throw new DraftError('pick what to change');
				const value = parsed(spec, d.value, DEMAND_OBJECT_FIELD_SPECS[d.field as DemandObjectFormField].label);
				op = { op: 'demandObject.set', demandObjectId: need(d.demandObjectId, 'a demand object'), field: d.field, value } as ScenarioOp;
				break;
			}
			case 'demandObject.remove':
				op = { op: 'demandObject.remove', demandObjectId: need(d.demandObjectId, 'a demand object') };
				break;
			case 'settings.set': {
				spec = draftSpec(d);
				if (!spec) throw new DraftError('pick a setting');
				const value = parsed(spec, spec.t === 'months' ? d.months : spec.t === 'pe' ? d.pe : spec.t === 'restriction' ? d.restriction : d.value, SETTINGS_SPECS[d.field as SettingsPath].label);
				op = { op: 'settings.set', path: d.field, value } as ScenarioOp;
				break;
			}
			case 'series.scale': {
				const pct = number(d.changePct, 'the change');
				const s: Extract<ScenarioOp, { op: 'series.scale' }> = { op: 'series.scale', kind: d.seriesKind, factor: Math.round((1 + pct! / 100) * 1e9) / 1e9 };
				if (d.from.trim()) s.from = d.from.trim();
				if (d.to.trim()) s.to = d.to.trim();
				op = s;
				break;
			}
			case 'demand.scale': {
				const pct = number(d.demandPct, 'the demand');
				const s: Extract<ScenarioOp, { op: 'demand.scale' }> = { op: 'demand.scale', factor: Math.round((pct! / 100) * 1e9) / 1e9 };
				// None ticked is all of them: the op then leaves the field out, as the engine reads it.
				if (d.demandNodeIds.length) s.nodeIds = [...new Set(d.demandNodeIds)];
				const months = [...new Set(d.months)].sort((a, b) => a - b);
				if (months.length && months.length < 12) s.months = months;
				if (d.demandCategory === 'user') s.category = 'user';
				else if (d.demandPart) s.part = d.demandPart;
				op = s;
				break;
			}
			case 'ewrRule.set': {
				const site = need(d.ewrSite, 'an EWR site');
				const t = d.ewrTables[0];
				if (!t) throw new DraftError('the table was removed: pick the site again');
				// Plain data (the editor's state may be a proxy); a blank cell (NaN) becomes null, which the checks name.
				const table = JSON.parse(JSON.stringify(t)) as EwrRuleTable;
				op = { op: 'ewrRule.set', table: { ...table, siteNodeId: site === OUTLET_SITE ? null : site, source: typeof table.source === 'string' ? table.source.trim() : table.source } };
				break;
			}
			case 'ewrRule.remove': {
				const site = need(d.ewrSite, 'an EWR site');
				op = { op: 'ewrRule.remove', siteNodeId: site === OUTLET_SITE ? null : site };
				break;
			}
			case 'allocation.set': {
				const which = need(d.allocationId, 'a registered volume, or a new one');
				const a: AllocationEntry = {
					id: which === NEW_ALLOCATION ? newId() : which,
					nodeId: need(d.nodeId, 'the hydrological unit or other user it is for'),
					waterSource: d.alSource,
					volumeM3PerYear: number(d.alVolume, 'the volume')!
				};
				const storage = number(d.alStorage, 'the storage', { nullable: true });
				if (storage !== null) a.storageM3 = storage;
				const date = (text: string, what: string) => {
					const t = text.trim();
					if (t && !/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new DraftError(`${what}: enter a date as YYYY-MM-DD`);
					return t || null;
				};
				const from = date(d.alFrom, 'Valid from');
				const to = date(d.alTo, 'Valid to');
				if (from) a.validFrom = from;
				if (to) a.validTo = to;
				const months = [...new Set(d.months)].sort((x, y) => x - y);
				if (months.length) a.months = months;
				const rate = number(d.alRate, 'the maximum rate', { nullable: true });
				if (rate !== null) a.maxRateM3s = rate;
				op = { op: 'allocation.set', allocation: a };
				break;
			}
			case 'allocation.remove':
				op = { op: 'allocation.remove', allocationId: need(d.allocationId, 'a registered volume') };
				break;
			default:
				throw new DraftError('pick a kind of change');
		}
	} catch (e) {
		if (e instanceof DraftError) return { ok: false, error: capital(e.message) };
		throw e;
	}
	return checkOp(op, spec);
}

/**
 * One op checked by the engine's own validator (validateScenarioOps), with its
 * error worded for a person: a 0–1 value's limits in % when `spec` says the
 * value is typed as a percentage. buildOp's check, and override mode's for
 * each op its edits diff into (overrideDiff.ts).
 */
export function checkOp(op: ScenarioOp, spec: ValueSpec | null = null): Built {
	const { errors } = validateScenarioOps([op]);
	if (errors.length) {
		const text = errors.map((x) => x.replace(/^ops\[0\]\.?/, '').replace(/^value: /, '')).join('; ');
		return { ok: false, error: capital(spec ? percentMessage(spec, text) : scaleNote(op.op, text)) };
	}
	return { ok: true, op };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// The op list as shown
// ---------------------------------------------------------------------------

export interface OpItem {
	text: string;
	/** null when the server hasn't classed it (no check: the base can't be rebuilt). */
	cls: OpClass | null;
	problem: string | null;
	notes: string[];
}

/**
 * Each op as the list shows it: in words (against the input it meets, when
 * the base is known), its class, and the check's problem and notes with ids
 * named. `check` null: the server couldn't check (the list still shows).
 */
export function opItems(
	ops: readonly ScenarioOp[],
	classified: readonly OpClass[] | null,
	check: { applied: readonly AppliedOp[]; problems: readonly string[] } | null,
	base: ModelInput | null,
	names: ReadonlyMap<string, string>
): { items: OpItem[]; other: string[] } {
	const before = base ? stepInputs(base, ops).before : null;
	const status = statusByOp(ops.length, check?.applied ?? [], check?.problems ?? []);
	const items = ops.map((op, i) => {
		const s = status.ops[i]!;
		return {
			text: describeOp(op, before?.[i] ?? null, names),
			cls: classified?.[i] ?? null,
			problem: s.problem === null ? null : nameIds(s.problem, names),
			notes: s.notes.map((x) => nameIds(x, names))
		};
	});
	return { items, other: status.other.map((x) => nameIds(x, names)) };
}

/** series.scale's factor is typed as a % change, demand.scale's as a % of today's demand: say their limits that way. */
function scaleNote(kind: ScenarioOpName, text: string): string {
	if (kind === 'series.scale') return text.replace(/^factor: must be (at least 0|at most \d+)$/, 'the change must be between −100 % and +900 %');
	// A rule table's own checks are sentences already ("Say where the table comes from …"); a shape error names its field.
	if (kind === 'ewrRule.set') return text.replace(/(^|; )table\.\w+: (?=[A-Z])/g, '$1').replace(/(^|; )table\.(\w+): /g, '$1$2 ');
	// A registered volume's errors name its field: say it in the form's words.
	if (kind === 'allocation.set')
		return text
			.replace(/(^|; )allocation\.volumeM3PerYear: /g, '$1the volume ')
			.replace(/(^|; )allocation\.storageM3: /g, '$1the storage ')
			.replace(/(^|; )allocation\.maxRateM3s: /g, '$1the maximum rate ')
			.replace(/(^|; )allocation\.validTo: is before valid from/g, '$1valid to is before valid from')
			.replace(/(^|; )allocation\.(\w+): /g, '$1$2 ');
	// A new demand object's errors name its field; a schedule's name its window.
	if (kind === 'demandObject.add') return text.replace(/(^|; )demandObject\.(\w+): /g, '$1$2 ');
	if (kind === 'demandObject.set') return text.replace(/^window (\d+): /, 'schedule window $1: ');
	if (kind === 'demand.scale') return text.replace(/^factor: must be (at least 0|at most \d+)$/, `the demand must be between 0 % and ${DEMAND_SCALE_MAX * 100} % of what they'd take`);
	return text;
}
