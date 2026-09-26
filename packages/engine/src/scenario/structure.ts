// Structural rules of a model input that a scenario op must not break: the
// same rules the backend enforces on save (backend/src/model/validate.ts
// modelProblems), plus the settings windows. applyScenario rejects an op that
// introduces an issue the input didn't already have, so a base that already
// carries one (an old project, a fuzz input) can still take unrelated ops.
//
// Keys are id-based so renaming a node doesn't turn an existing issue into a
// "new" one; texts are for people.
import type { ModelInput } from '../project';
import { inputFlowShares, overAllocationError } from '../network/shares';
import { resolveCatchmentAreaKm2 } from '../runoff/area';

export type StructureIssues = Map<string, string>;

export function structureIssues(input: ModelInput): StructureIssues {
	const out: StructureIssues = new Map();
	const add = (key: string, text: string) => out.set(key, text);
	const m = input.model;
	const byId = new Map(m.nodes.map((n) => [n.id, n]));
	const cropIds = new Set(m.crops.map((c) => c.id));

	const dupes = (kind: string, xs: string[]) => {
		const seen = new Set<string>();
		for (const x of xs) {
			if (seen.has(x)) add(`dup:${kind}:${x}`, `duplicate ${kind} ${x}`);
			seen.add(x);
		}
	};
	dupes('node id', m.nodes.map((n) => n.id));
	dupes('node name', m.nodes.map((n) => n.name.trim().toLowerCase()));
	dupes('crop id', m.crops.map((c) => c.id));
	dupes('crop name', m.crops.map((c) => c.name.trim().toLowerCase()));
	dupes('transfer id', m.transfers.map((t) => t.id));
	dupes('crop area', m.cropAreas.map((a) => `${a.nodeId}/${a.cropId}`));
	dupes('land-cover id', (m.landCover ?? []).map((p) => p.id));

	for (const n of m.nodes) {
		if (n.downstreamNodeId !== null && !byId.has(n.downstreamNodeId)) add(`down:${n.id}`, `"${n.name}" drains into an unknown node`);
		if (n.downstreamNodeId === n.id) add(`self:${n.id}`, `"${n.name}" drains into itself`);
		if ((n.boreholeCapacityM3Day ?? 0) > 0 && n.kind === 'gauge') add(`bhGauge:${n.id}`, `gauge "${n.name}" can't have boreholes`);
		if ((n.boreholeCapacityM3Day ?? 0) > 0 && n.boreholeRule === 'drought' && !(n.kind === 'farm' && n.damCapacityM3 > 0))
			add(`bhDrought:${n.id}`, `"${n.name}": the drought borehole rule needs a farm dam to trigger on`);
	}
	for (const a of m.cropAreas) {
		if (!byId.has(a.nodeId)) add(`caNode:${a.nodeId}/${a.cropId}`, `a crop area references unknown node ${a.nodeId}`);
		else if (byId.get(a.nodeId)!.kind === 'user') add(`caUser:${a.nodeId}`, `crop area on other water user "${byId.get(a.nodeId)!.name}"`);
		if (!cropIds.has(a.cropId)) add(`caCrop:${a.nodeId}/${a.cropId}`, `a crop area references unknown crop ${a.cropId}`);
	}
	for (const t of m.transfers) {
		if (!byId.has(t.fromNodeId) || !byId.has(t.toNodeId)) add(`trNode:${t.id}`, `transfer ${t.id} references an unknown node`);
		if (byId.get(t.fromNodeId)?.kind === 'user' || byId.get(t.toNodeId)?.kind === 'user')
			add(`trUser:${t.id}`, `transfer ${t.id} involves an other water user: transfers run between farm dams`);
		if (t.fromNodeId === t.toNodeId) add(`trSelf:${t.id}`, `transfer ${t.id} goes from a node to itself`);
	}
	for (const p of m.landCover ?? []) {
		const n = byId.get(p.nodeId);
		if (!n) add(`lcNode:${p.id}`, `land cover ${p.id} references an unknown node`);
		else if (n.kind !== 'farm') add(`lcKind:${p.id}`, `land cover ${p.id} lies on a ${n.kind}, not a farm`);
	}

	if (m.nodes.length) {
		const outlets = m.nodes.filter((n) => n.downstreamNodeId === null);
		if (outlets.length !== 1) add('outlets', `the network needs exactly one outflow node; found ${outlets.length}`);
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

	// Rain needs land to fall on: runModel refuses a catchment of 0 km² (runoff/area.ts).
	const s = input.settings as Record<string, unknown>;
	const cal = (s.calibration ?? {}) as { catchmentAreaKm2?: number | null };
	if (m.nodes.length && !(resolveCatchmentAreaKm2({ catchmentAreaKm2: cal.catchmentAreaKm2 ?? null }, input) > 0))
		add('area', 'the catchment has no area left: no farm has land and calibration.catchmentAreaKm2 is not set');

	// Flow shares over 100 % make water from nowhere: runModel refuses them (network/shares.ts).
	const over = overAllocationError(inputFlowShares(input).sum);
	if (over) add('shares', over);

	// Windows: a start after its end.
	for (const [a, b, label] of [
		['simulationStart', 'simulationEnd', 'simulation'],
		['reportStart', 'reportEnd', 'reporting'],
		['calibrationStart', 'calibrationEnd', 'calibration']
	] as const) {
		const x = s[a];
		const y = s[b];
		if (typeof x === 'string' && typeof y === 'string' && x > y) add(`window:${label}`, `the ${label} window starts (${x}) after it ends (${y})`);
	}
	return out;
}
