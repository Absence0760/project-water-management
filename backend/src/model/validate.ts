import { upgradeLegacyModel, type ProjectModel } from '@water-management/engine';
import { z } from 'zod';

const uuid = z.string().uuid();
const frac = z.number().min(0).max(1);
const nonNeg = z.number().finite().min(0);

/**
 * A project model as PUT /model and a project document carry it. A model from
 * an older engine (a document exported before 0.14.0, a stale browser tab) is
 * read as migration 006 stored the database: `returnFlowPct` becomes irrigation
 * efficiency and loss return (upgradeLegacyModel).
 */
export const ModelBody = z.preprocess((v) => (v && typeof v === 'object' ? upgradeLegacyModel(v as { nodes?: unknown }) : v), z.object({
	nodes: z
		.array(
			z.object({
				id: uuid,
				name: z.string().trim().min(1).max(100),
				kind: z.enum(['farm', 'gauge']),
				downstreamNodeId: uuid.nullable(),
				sortOrder: z.number().int(),
				areaKm2: nonNeg,
				areaHiKm2: nonNeg,
				areaLoKm2: nonNeg,
				flowShareManual: frac.nullable(),
				pctUpstreamToDam: frac,
				pctRunoffToDam: frac,
				damCapacityM3: nonNeg,
				damInitialPct: frac,
				damMinPct: frac,
				divertCapacityM3Day: nonNeg,
				// 0 < e ≤ 1: abstraction demand is the crop requirement ÷ e (audit N1).
				irrigationEfficiency: z.number().gt(0).max(1),
				lossReturnFraction: frac
			})
		)
		.max(500),
	crops: z
		.array(
			z.object({
				id: uuid,
				name: z.string().trim().min(1).max(100),
				sortOrder: z.number().int().optional(),
				cropFactor: z.array(z.number().finite().min(0)).length(12)
			})
		)
		.max(200),
	cropAreas: z.array(z.object({ nodeId: uuid, cropId: uuid, areaM2: nonNeg })).max(20_000),
	transfers: z
		.array(
			z.object({
				id: uuid,
				fromNodeId: uuid,
				toNodeId: uuid,
				months: z.array(z.number().int().min(1).max(12)).max(12),
				maxRateM3s: nonNeg,
				dailyCapM3: nonNeg.nullable(),
				minStoragePct: frac,
				enabled: z.boolean()
			})
		)
		.max(500)
}));

/**
 * Structural rules zod can't express. Returns human-readable problems; empty
 * means valid. Shared expectations with the frontend's client-side check.
 */
export function modelProblems(m: ProjectModel): string[] {
	const problems: string[] = [];
	const nodeIds = new Set(m.nodes.map((n) => n.id));
	const cropIds = new Set(m.crops.map((c) => c.id));

	const dupes = (xs: string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
	for (const d of dupes(m.nodes.map((n) => n.id))) problems.push(`duplicate node id ${d}`);
	for (const d of dupes(m.nodes.map((n) => n.name.toLowerCase()))) problems.push(`duplicate node name "${d}"`);
	for (const d of dupes(m.crops.map((c) => c.id))) problems.push(`duplicate crop id ${d}`);
	for (const d of dupes(m.crops.map((c) => c.name.toLowerCase()))) problems.push(`duplicate crop name "${d}"`);
	for (const d of dupes(m.transfers.map((t) => t.id))) problems.push(`duplicate transfer id ${d}`);
	for (const d of dupes(m.cropAreas.map((a) => `${a.nodeId}/${a.cropId}`))) problems.push(`duplicate crop area ${d}`);

	for (const n of m.nodes) {
		if (n.downstreamNodeId && !nodeIds.has(n.downstreamNodeId)) problems.push(`"${n.name}" drains into an unknown node`);
		if (n.downstreamNodeId === n.id) problems.push(`"${n.name}" drains into itself`);
	}
	for (const a of m.cropAreas) {
		if (!nodeIds.has(a.nodeId)) problems.push(`crop area references unknown node ${a.nodeId}`);
		if (!cropIds.has(a.cropId)) problems.push(`crop area references unknown crop ${a.cropId}`);
	}
	for (const t of m.transfers) {
		if (!nodeIds.has(t.fromNodeId) || !nodeIds.has(t.toNodeId)) problems.push(`transfer ${t.id} references an unknown node`);
		if (t.fromNodeId === t.toNodeId) problems.push(`transfer ${t.id} goes from a node to itself`);
	}

	if (m.nodes.length) {
		const outlets = m.nodes.filter((n) => n.downstreamNodeId === null);
		if (outlets.length !== 1) {
			problems.push(`the network needs exactly one outflow node (drains into nothing); found ${outlets.length}`);
		}
		// Cycle check: follow downstream pointers from each node.
		const next = new Map(m.nodes.map((n) => [n.id, n.downstreamNodeId]));
		for (const n of m.nodes) {
			const seen = new Set<string>();
			let cur: string | null | undefined = n.id;
			while (cur) {
				if (seen.has(cur)) {
					problems.push(`the network has a loop through "${n.name}"`);
					break;
				}
				seen.add(cur);
				cur = next.get(cur);
			}
		}
	}
	return [...new Set(problems)];
}
