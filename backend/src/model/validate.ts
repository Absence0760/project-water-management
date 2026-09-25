import { BOREHOLE_RULES, upgradeLegacyModel, USER_PRIORITIES, type ProjectModel } from '@water-management/engine';
import { z } from 'zod';

const uuid = z.string().uuid();
const frac = z.number().min(0).max(1);
const nonNeg = z.number().finite().min(0);

/**
 * A project model as PUT /model and a project document carry it. A model from
 * an older engine (a document exported before 0.16.0, a stale browser tab) is
 * read as migration 006 stored the database: `returnFlowPct` becomes irrigation
 * efficiency and loss return, missing dam fields get their defaults and a
 * transfer without a priority gets its list position (upgradeLegacyModel).
 */
export const ModelBody = z.preprocess((v) => (v && typeof v === 'object' ? upgradeLegacyModel(v as { nodes?: unknown }) : v), z.object({
	nodes: z
		.array(
			z.object({
				id: uuid,
				name: z.string().trim().min(1).max(100),
				kind: z.enum(['farm', 'gauge', 'user']),
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
				lossReturnFraction: frac,
				// Dam evaporation and seepage (audit N2): area null = estimated by the run.
				damAreaFullM2: nonNeg.nullable(),
				damAreaExponent: z.number().gt(0).max(3),
				damSeepagePerDay: frac,
				// Other water users (WP-1.33): monthly demand (water-year months), return share, priority.
				userDemandM3Day: z.array(nonNeg).length(12).nullable().default(null),
				userReturnPct: frac.default(0),
				userPriority: z.enum(USER_PRIORITIES).default('senior'),
				// Boreholes (WP-1.34): capacity null = none; depletion share and lag of the river's loss.
				boreholeCapacityM3Day: nonNeg.nullable().default(null),
				boreholeRule: z.enum(BOREHOLE_RULES).default('supplemental'),
				boreholeTriggerPct: frac.default(0.3),
				streamDepletionFrac: frac.default(0),
				streamDepletionLagDays: nonNeg.max(36_500).default(0)
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
				enabled: z.boolean(),
				// Lower moves first; equal priorities share a source dam pro rata (audit Q18).
				priority: z.number().int().min(-1_000_000).max(1_000_000)
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
	const byId = new Map(m.nodes.map((n) => [n.id, n]));

	const dupes = (xs: string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
	for (const d of dupes(m.nodes.map((n) => n.id))) problems.push(`duplicate node id ${d}`);
	for (const d of dupes(m.nodes.map((n) => n.name.toLowerCase()))) problems.push(`duplicate node name "${d}"`);
	for (const d of dupes(m.crops.map((c) => c.id))) problems.push(`duplicate crop id ${d}`);
	for (const d of dupes(m.crops.map((c) => c.name.toLowerCase()))) problems.push(`duplicate crop name "${d}"`);
	for (const d of dupes(m.transfers.map((t) => t.id))) problems.push(`duplicate transfer id ${d}`);
	for (const d of dupes(m.cropAreas.map((a) => `${a.nodeId}/${a.cropId}`))) problems.push(`duplicate crop area ${d}`);

	for (const n of m.nodes) {
		if (n.downstreamNodeId && !nodeIds.has(n.downstreamNodeId)) problems.push(`"${n.name}" drains into an unknown node`);
		// Boreholes (WP-1.34): a gauge only measures; the drought rule triggers on a dam.
		if ((n.boreholeCapacityM3Day ?? 0) > 0 && n.kind === 'gauge') problems.push(`gauge "${n.name}" can't have boreholes`);
		if ((n.boreholeCapacityM3Day ?? 0) > 0 && n.boreholeRule === 'drought' && !(n.kind === 'farm' && n.damCapacityM3 > 0))
			problems.push(`"${n.name}": the drought borehole rule needs a farm dam to trigger on`);
		if (n.downstreamNodeId === n.id) problems.push(`"${n.name}" drains into itself`);
	}
	for (const a of m.cropAreas) {
		if (!nodeIds.has(a.nodeId)) problems.push(`crop area references unknown node ${a.nodeId}`);
		if (byId.get(a.nodeId)?.kind === 'user') problems.push(`crop area on other water user "${byId.get(a.nodeId)!.name}": a user's demand is its monthly demand, not crops`);
		if (!cropIds.has(a.cropId)) problems.push(`crop area references unknown crop ${a.cropId}`);
	}
	for (const t of m.transfers) {
		if (!nodeIds.has(t.fromNodeId) || !nodeIds.has(t.toNodeId)) problems.push(`transfer ${t.id} references an unknown node`);
		// A user has no dam to send from or fill (WP-1.33).
		if (byId.get(t.fromNodeId)?.kind === 'user' || byId.get(t.toNodeId)?.kind === 'user') problems.push(`transfer ${t.id} involves an other water user: transfers run between farm dams`);
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
