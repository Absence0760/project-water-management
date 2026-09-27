// The model document's structural save rules: what zod's field ranges can't
// express. The one home for them (docs/scenarios.md, followups "One home for
// the model's save rules"): the backend refuses a save or an import that
// breaks one (backend/src/model/validate.ts modelProblems), and applyScenario
// refuses an op that introduces one (scenario/structure.ts). Keeping both on
// this function means a scenario can only produce a model the backend would
// accept as a save, and a rule added here reaches both.
import { SUPPLY_DEFAULTS, type ProjectModel } from './project';
import { damCurveProblem } from './network/damCurve';

/**
 * Every rule a model breaks, keyed by what breaks it (ids, not names, so
 * renaming a node doesn't turn an old issue into a new one) → a sentence for
 * people. Empty means the model is valid.
 */
export function modelRuleIssues(m: ProjectModel): Map<string, string> {
	const out = new Map<string, string>();
	const add = (key: string, text: string) => {
		if (!out.has(key)) out.set(key, text);
	};
	const byId = new Map(m.nodes.map((n) => [n.id, n]));
	const cropIds = new Set(m.crops.map((c) => c.id));

	const dupes = (kind: string, xs: string[], show: (x: string) => string = (x) => x) => {
		const seen = new Set<string>();
		for (const x of xs) {
			if (seen.has(x)) add(`dup:${kind}:${x}`, `duplicate ${kind} ${show(x)}`);
			seen.add(x);
		}
	};
	// Names compare case-insensitively (run comparison matches copies by name).
	dupes('node id', m.nodes.map((n) => n.id));
	dupes('node name', m.nodes.map((n) => n.name.trim().toLowerCase()), (x) => `"${x}"`);
	dupes('crop id', m.crops.map((c) => c.id));
	dupes('crop name', m.crops.map((c) => c.name.trim().toLowerCase()), (x) => `"${x}"`);
	dupes('transfer id', m.transfers.map((t) => t.id));
	dupes('crop area', m.cropAreas.map((a) => `${a.nodeId}/${a.cropId}`));
	dupes('land-cover id', (m.landCover ?? []).map((p) => p.id));

	for (const p of m.landCover ?? []) {
		const n = byId.get(p.nodeId);
		if (!n) add(`lcNode:${p.id}`, `land cover ${p.id} references an unknown node`);
		else if (n.kind !== 'farm')
			add(`lcKind:${p.id}`, `land cover on "${n.name}": land cover lies on a farm (a hydrological unit), not a ${n.kind === 'user' ? 'user' : 'gauge'}`);
	}
	// Individual boreholes (WP-3.9): on a farm or other user; emergency mode and pumping into the dam need a farm dam.
	dupes('borehole id', (m.boreholes ?? []).map((b) => b.id));
	for (const b of m.boreholes ?? []) {
		const n = byId.get(b.nodeId);
		if (!n) add(`bhNode:${b.id}`, `borehole ${b.id} references an unknown node`);
		else if (n.kind === 'gauge') add(`bhGauge:${b.id}`, `borehole "${b.name}" is on gauge "${n.name}": a gauge can't have boreholes`);
		else if (b.mode !== 'none' && !(n.kind === 'farm' && n.damCapacityM3 > 0)) {
			if (b.mode === 'emergency') add(`bhEmergency:${b.id}`, `borehole "${b.name}" on "${n.name}": emergency mode needs a farm dam to trigger on`);
			if (b.target === 'dam') add(`bhDam:${b.id}`, `borehole "${b.name}" on "${n.name}": it pumps into a dam, and there is none`);
		}
	}
	for (const n of m.nodes) {
		if (n.downstreamNodeId && !byId.has(n.downstreamNodeId)) add(`down:${n.id}`, `"${n.name}" drains into an unknown node`);
		// Boreholes (WP-1.34): a gauge only measures; the drought rule triggers on a dam.
		if ((n.boreholeCapacityM3Day ?? 0) > 0 && n.kind === 'gauge') add(`bhGauge:${n.id}`, `gauge "${n.name}" can't have boreholes`);
		if ((n.boreholeCapacityM3Day ?? 0) > 0 && n.boreholeRule === 'drought' && !(n.kind === 'farm' && n.damCapacityM3 > 0))
			add(`bhDrought:${n.id}`, `"${n.name}": the drought borehole rule needs a farm dam to trigger on`);
		if (n.downstreamNodeId === n.id) add(`self:${n.id}`, `"${n.name}" drains into itself`);
		// EWR sites (engine ≥ 1.5.0): the outlet always is one; only another gauge can be taken off the list.
		if (n.ewrSite === false) {
			if (n.downstreamNodeId === null) add(`ewrSiteOutlet:${n.id}`, `"${n.name}" is the outlet, which is always an EWR site`);
			else if (n.kind !== 'gauge') add(`ewrSiteKind:${n.id}`, `"${n.name}": only a gauge can be taken off the EWR sites`);
		}
		// Supply rule and river pump (WP-3.8): a farm's; trigger switches on a dam; run of river has none.
		const supply = n.supplyRule ?? 'damFirst';
		if (n.kind !== 'farm' && (supply !== 'damFirst' || (n.pumpCapacityM3Day !== null && n.pumpCapacityM3Day !== undefined)))
			add(`supplyKind:${n.id}`, `"${n.name}": only a farm has a supply rule and river pump`);
		else if (supply === 'trigger' && !(n.damCapacityM3 > 0)) add(`supplyTrigger:${n.id}`, `"${n.name}": the trigger supply rule needs a farm dam to switch on`);
		else if (supply === 'runOfRiver' && n.damCapacityM3 > 0) add(`supplyRor:${n.id}`, `"${n.name}": run of river has no dam; set the dam capacity to 0 or pick another supply rule`);
		if (n.kind === 'farm' && supply === 'trigger' && (n.supplyStopPct ?? SUPPLY_DEFAULTS.supplyStopPct) < (n.supplyTriggerPct ?? SUPPLY_DEFAULTS.supplyTriggerPct))
			add(`supplyStop:${n.id}`, `"${n.name}": the supply rule's stop level must be at least its trigger level`);
		// Dam survey curve (WP-3.5): only a farm has a dam, and the curve must be one the run can use.
		if (n.damCurve && n.damCurve.length) {
			const bad = n.kind === 'farm' ? damCurveProblem(n.damCurve) : `only a farm has a dam`;
			if (bad) add(`damCurve:${n.id}`, `"${n.name}": dam survey curve: ${bad}`);
		}
	}
	for (const a of m.cropAreas) {
		const n = byId.get(a.nodeId);
		if (!n) add(`caNode:${a.nodeId}/${a.cropId}`, `crop area references unknown node ${a.nodeId}`);
		else if (n.kind === 'user') add(`caUser:${a.nodeId}`, `crop area on other water user "${n.name}": a user's demand is its monthly demand, not crops`);
		if (!cropIds.has(a.cropId)) add(`caCrop:${a.nodeId}/${a.cropId}`, `crop area references unknown crop ${a.cropId}`);
	}
	for (const t of m.transfers) {
		if (!byId.has(t.fromNodeId) || !byId.has(t.toNodeId)) add(`trNode:${t.id}`, `transfer ${t.id} references an unknown node`);
		// A user has no dam to send from or fill (WP-1.33).
		if (byId.get(t.fromNodeId)?.kind === 'user' || byId.get(t.toNodeId)?.kind === 'user')
			add(`trUser:${t.id}`, `transfer ${t.id} involves an other water user: transfers run between farm dams`);
		if (t.fromNodeId === t.toNodeId) add(`trSelf:${t.id}`, `transfer ${t.id} goes from a node to itself`);
	}

	if (m.nodes.length) {
		const outlets = m.nodes.filter((n) => n.downstreamNodeId === null);
		if (outlets.length !== 1) add('outlets', `the network needs exactly one outflow node (drains into nothing); found ${outlets.length}`);
		// Cycle check: follow downstream pointers from each node.
		const next = new Map(m.nodes.map((n) => [n.id, n.downstreamNodeId]));
		for (const n of m.nodes) {
			const seen = new Set<string>();
			let cur: string | null | undefined = n.id;
			while (cur) {
				if (seen.has(cur)) {
					add(`loop:${n.id}`, `the network has a loop through "${n.name}"`);
					break;
				}
				seen.add(cur);
				cur = next.get(cur);
			}
		}
	}
	return out;
}

/** The model's broken rules as distinct sentences (empty = valid): what a save or an import is refused with. */
export const modelRuleProblems = (m: ProjectModel): string[] => [...new Set(modelRuleIssues(m).values())];
