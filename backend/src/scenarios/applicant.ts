// What an applicant (the `contributor` role, 035/036, roadmap WP-3.3) sees
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
import type { CropDef, ModelInput, NetworkNode, NodeKind, ProjectModel } from '@water-management/engine';

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

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The engine's messages about ops (applyScenario's notes and problems,
 * which quote node names, some lower-cased) with every anonymised node's
 * real name swapped for its anonymous one, ignoring case, longest names
 * first so "Farm A2" isn't read as "Farm A". Ids are left alone: the
 * applicant already has them.
 *
 * What it can't hide: that a message exists. An applicant who renames their
 * own farm to a neighbour's name gets the duplicate-name problem, which says
 * a node of that name exists (docs/followups.md).
 */
export function applicantRedactor(base: ModelInput, projected: ApplicantBase): (text: string) => string {
	const anon = new Set(projected.anonymisedNodeIds);
	const shownName = new Map(projected.model.nodes.map((n) => [n.id, n.name]));
	const pairs = base.model.nodes
		.filter((n) => anon.has(n.id) && n.name.trim() !== '')
		.map((n) => [n.name.toLowerCase(), shownName.get(n.id)!] as const)
		.sort((a, b) => b[0].length - a[0].length);
	if (!pairs.length) return (t) => t;
	const re = new RegExp(pairs.map(([real]) => escape(real)).join('|'), 'gi');
	const to = new Map(pairs);
	return (text) => text.replace(re, (m) => to.get(m.toLowerCase()) ?? m);
}
