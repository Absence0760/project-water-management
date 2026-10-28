// get_network (issue #610): the river network as the run modelled it (its
// model snapshot, redacted as the run route redacts it) or as the project
// holds it now: each node's kind, what it drains into, its area, dam and
// irrigation figures, its crops' hectares, its boreholes and other demand
// counted, the transfers, and for every gauge the units, dams and gauges above
// it. Every field is picked by name, so nothing else of the model reaches the
// model: no registered volumes, no borehole or demand-object labels, no
// member or farmer (they live outside the model; the tool never reads them).
import type { NetworkNode, ProjectModel } from '@water-management/engine';
import { z } from 'zod';
import { loadModel } from '../../model/store.js';
import { readRun } from '../../runs/read.js';
import { TOOL_NAMES, type AssistantTool } from '../types.js';
import { compact, parseArgs, refusal, runFor, specOf } from './common.js';

const Args = z
	.object({
		source: z
			.enum(['run', 'project'])
			.optional()
			.describe("'run': the network the run modelled (default when the project has a run); 'project': the network as saved now")
	})
	.strict();

type ModelLike = Pick<ProjectModel, 'nodes'> & Partial<Pick<ProjectModel, 'crops' | 'cropAreas' | 'transfers' | 'boreholes' | 'demandObjects'>>;

const r4 = (x: unknown) => compact(x);

/** A node's dam, or null without one. */
function damOf(n: NetworkNode) {
	if (!(n.damCapacityM3 > 0)) return null;
	return {
		capacityM3: r4(n.damCapacityM3),
		initialPct: r4(n.damInitialPct),
		minPct: r4(n.damMinPct),
		pctUpstreamToDam: r4(n.pctUpstreamToDam),
		pctRunoffToDam: r4(n.pctRunoffToDam),
		divertCapacityM3Day: r4(n.divertCapacityM3Day),
		areaFullM2: r4(n.damAreaFullM2)
	};
}

/** The network as the tool answers it. Pure, for the unit tests. */
export function networkView(model: ModelLike) {
	const nodes = model.nodes ?? [];
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const children = new Map<string, NetworkNode[]>();
	for (const n of nodes) if (n.downstreamNodeId) children.set(n.downstreamNodeId, [...(children.get(n.downstreamNodeId) ?? []), n]);
	/** Every node above `id` (a cycle can't be saved, but the walk is guarded all the same). */
	const above = (id: string): NetworkNode[] => {
		const out: NetworkNode[] = [];
		const seen = new Set([id]);
		const stack = [...(children.get(id) ?? [])];
		while (stack.length) {
			const n = stack.pop()!;
			if (seen.has(n.id)) continue;
			seen.add(n.id);
			out.push(n);
			stack.push(...(children.get(n.id) ?? []));
		}
		return out;
	};
	const cropName = new Map((model.crops ?? []).map((c) => [c.id, c.name]));
	const hectares = new Map<string, Record<string, number>>();
	for (const ca of model.cropAreas ?? []) {
		const row = hectares.get(ca.nodeId) ?? {};
		const name = cropName.get(ca.cropId) ?? 'crop';
		row[name] = (row[name] ?? 0) + ca.areaM2 / 10_000;
		hectares.set(ca.nodeId, row);
	}
	const count = (list: readonly { nodeId: string }[] | undefined, id: string) => (list ?? []).filter((x) => x.nodeId === id).length;
	return {
		nodes: nodes.map((n) => {
			const crops = hectares.get(n.id);
			const up = n.kind === 'gauge' ? above(n.id) : null;
			return {
				id: n.id,
				name: n.name,
				kind: n.kind,
				...(n.downstreamNodeId === null ? { outlet: true } : { drainsInto: n.downstreamNodeId }),
				areaKm2: r4(n.areaKm2),
				...(n.mapMm ? { mapMm: r4(n.mapMm) } : {}),
				...(n.flowShareManual !== null && n.flowShareManual !== undefined ? { flowShareManual: r4(n.flowShareManual) } : {}),
				...(n.kind === 'farm' ? { dam: damOf(n), irrigationEfficiency: r4(n.irrigationEfficiency), returnFlowFraction: r4(n.returnFlowFraction) } : {}),
				...(crops ? { cropHa: Object.fromEntries(Object.entries(crops).map(([k, v]) => [k, r4(v)])) } : {}),
				...(count(model.boreholes, n.id) ? { boreholes: count(model.boreholes, n.id) } : {}),
				...(count(model.demandObjects, n.id) ? { otherDemands: count(model.demandObjects, n.id) } : {}),
				...(up
					? {
							above: {
								units: up.filter((x) => x.kind !== 'gauge').length,
								areaKm2: r4(up.reduce((s, x) => s + (x.areaKm2 || 0), 0) + (n.areaKm2 || 0)),
								dams: up.filter((x) => x.kind === 'farm' && x.damCapacityM3 > 0).map((x) => ({ id: x.id, name: x.name, capacityM3: r4(x.damCapacityM3) })),
								gauges: up.filter((x) => x.kind === 'gauge').map((x) => ({ id: x.id, name: x.name }))
							}
						}
					: {})
			};
		}),
		transfers: (model.transfers ?? []).map((t) => ({
			from: byId.get(t.fromNodeId)?.name ?? t.fromNodeId,
			to: t.toNodeId === null ? 'outside the catchment' : (byId.get(t.toNodeId)?.name ?? t.toNodeId),
			months: t.months,
			maxRateM3s: r4(t.maxRateM3s),
			dailyCapM3: r4(t.dailyCapM3),
			minStoragePct: r4(t.minStoragePct),
			enabled: t.enabled
		}))
	};
}

export const networkTool: AssistantTool = {
	spec: specOf(
		TOOL_NAMES.network,
		"The river network: each node (hydrological unit 'farm', gauge, other water user) with what it drains into, its area, dam (capacity, how much of the upstream flow and of its own runoff enters it), irrigation and crop hectares; the transfers; and for each gauge the units, dams and gauges above it. Node ids here are what get_series and get_gauge_fit take.",
		Args
	),
	label: 'Reading the network',
	async run(ctx, args) {
		const a = parseArgs(Args, args);
		if (!a.ok) return a;
		try {
			const { role, runId } = await runFor(ctx);
			const source = a.value.source ?? (runId ? 'run' : 'project');
			if (source === 'run' && runId) {
				const { run } = await readRun(ctx.db, ctx.projectId, role, runId);
				return { ok: true, data: { source, runId, ...networkView((run.model ?? { nodes: [] }) as ModelLike) } };
			}
			return { ok: true, data: { source: 'project', ...networkView(await loadModel(ctx.db, ctx.projectId)) } };
		} catch (e) {
			return refusal(e);
		}
	}
};
