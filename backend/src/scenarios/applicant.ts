// What an applicant (the `contributor` role, 044/045, roadmap WP-3.3) sees
// of the published baseline their application applies to: D2's recommended
// default, **pending the client** (docs/roadmap/step-3-licensing.md § 11,
// docs/scenarios.md § Applications). Pure: the server rebuilds the full base
// (loadPublishedRunInput) and projects it here before anything leaves.
//
//  - settings: in full. They are catchment-wide (climate, calibration, EWR),
//    and an op on one is a baseline assumption the assessor sees in red.
//  - the applicant's own nodes (their farm links) and every gauge (public
//    infrastructure, as a farmer sees them): in full;
//  - every other node: its id, kind, place in the network and order, so a
//    new dam can be placed below it, under an anonymous name ("Farm 3",
//    "Water user 1"); every number zeroed and every list emptied, so no other
//    farm's area, dam, crops, demand or boreholes leave the server;
//  - crops, crop areas, transfers and land cover: only those on their own
//    nodes (a transfer's other end is an anonymised node).
import type { CropDef, MaskedNames, ModelInput, NetworkNode, NodeKind, ProjectModel } from '@water-management/engine';

export interface ApplicantBase {
	settings: ModelInput['settings'];
	model: ProjectModel;
	/** Nodes shown by kind and an anonymous name only: their values are not the base's. */
	anonymisedNodeIds: string[];
}

const KIND_NAME: Record<NodeKind, string> = { farm: 'Farm', gauge: 'Gauge', user: 'Water user' };
/** Kept as they are on an anonymised node: where it sits in the network, and what it is. */
const KEEP = new Set(['id', 'kind', 'downstreamNodeId', 'sortOrder']);

/** A node with everything but its place and kind blanked, under `name`. */
function anonymise(n: NetworkNode, name: string): NetworkNode {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(n)) {
		if (KEEP.has(k)) out[k] = v;
		else if (typeof v === 'number') out[k] = 0;
		else if (typeof v === 'boolean') out[k] = false;
		// Categorical settings (a user's priority, a borehole rule) are not
		// volumes; anything else (lists, objects, text) goes.
		else if (typeof v === 'string' && k !== 'name') out[k] = v;
		else out[k] = null;
	}
	out.name = name;
	return out as unknown as NetworkNode;
}

/** The base as an applicant with these own nodes sees it (module comment). */
export function projectBaseForApplicant(input: ModelInput, ownNodeIds: Iterable<string>): ApplicantBase {
	const own = new Set(ownNodeIds);
	const m = input.model;
	const shown = (n: NetworkNode) => own.has(n.id) || n.kind === 'gauge';
	const counters: Record<string, number> = {};
	const anonymisedNodeIds: string[] = [];
	const nodes = [...m.nodes]
		.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
		.map((n) => {
			if (shown(n)) return n;
			counters[n.kind] = (counters[n.kind] ?? 0) + 1;
			anonymisedNodeIds.push(n.id);
			return anonymise(n, `${KIND_NAME[n.kind] ?? 'Node'} ${counters[n.kind]}`);
		});
	// Back in the base's own order.
	const order = new Map(m.nodes.map((n, i) => [n.id, i]));
	nodes.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
	const cropAreas = m.cropAreas.filter((a) => own.has(a.nodeId));
	const planted = new Set(cropAreas.map((a) => a.cropId));
	const crops: CropDef[] = m.crops.filter((c) => planted.has(c.id));
	return {
		settings: input.settings,
		model: {
			nodes,
			crops,
			cropAreas,
			transfers: m.transfers.filter((t) => own.has(t.fromNodeId) || own.has(t.toNodeId)),
			landCover: (m.landCover ?? []).filter((p) => own.has(p.nodeId))
		},
		anonymisedNodeIds
	};
}

/**
 * The names an application's ops must not meet (applyScenario's
 * `maskedNames`): every node the projection anonymises, under the anonymous
 * name the applicant sees ("Farm 3"), and every crop it leaves out, under a
 * name made of its id (a crop the applicant never sees has no name for
 * them; its id is as unknowable to them as its name). With these the
 * engine's messages quote only names the applicant sees, and renaming their
 * own farm to a neighbour's name collides with nothing
 * (docs/followups.md § Applicants "Oracles").
 */
export function applicationMask(input: ModelInput, ownNodeIds: Iterable<string>): MaskedNames {
	const projected = projectBaseForApplicant(input, ownNodeIds);
	const hidden = new Set(projected.anonymisedNodeIds);
	const shownCrops = new Set(projected.model.crops.map((c) => c.id));
	return {
		nodes: Object.fromEntries(projected.model.nodes.filter((n) => hidden.has(n.id)).map((n) => [n.id, n.name])),
		crops: Object.fromEntries(input.model.crops.filter((c) => !shownCrops.has(c.id)).map((c) => [c.id, `crop ${c.id}`]))
	};
}
