// "Show on map" links from the Network, Hydrological units and Dams pages into
// the Map tab (issue #326 A2): `?tab=map&node=<nodeId>`, which opens the map
// with that node's farm parcel (else its first linked feature) selected. A
// node gets the link only when a map feature is linked to it.
//
// Which nodes have a feature comes from `GET …/map/linked-nodes`, the node ids
// alone (not the feature list with every geometry, which only the Map tab
// needs). It is fetched after the page has drawn (never before first paint)
// and once per page visit: the map can change on its own tab between visits,
// so a cached set is only shown on the first frame and refreshed.
// Deliberately no import from lib/components/map: those pages must not pull
// the map's code into their bundle. The fetch is passed in
// (`api.map.linkedNodes`), so this module needs no $env.
// The same read carries each linked dam outline's siting (on the river,
// off-channel or not said), which the Network editor shows beside Upstream
// inflow to dam (network/fields.ts damSitingHint).
import type { LinkedDam, MapLinkedNodes } from '#lib/api/types.js';
import { overlayHref } from './overlays';

/** The Map tab with this node selected. */
export const mapNodeHref = (nodeId: string) => overlayHref('map', 'node', nodeId);

/** A project's linked nodes, and its linked dam outlines by node. */
export interface MappedSet {
	ids: Set<string>;
	dams: Map<string, LinkedDam[]>;
}

const cache = new Map<string, MappedSet>();

/** The last set fetched for this project in this session, for the first frame; undefined before any. */
export const cachedMappedNodes = (projectId: string): MappedSet | undefined => cache.get(projectId);

/** The nodes with a linked feature in a project (`api.map.linkedNodes`). */
export type ListLinkedNodes = (projectId: string) => Promise<MapLinkedNodes>;

/**
 * Fetch which of the project's nodes have a map feature, and remember it.
 * Rejects when the list can't be read; the caller then shows no link (the
 * link is a shortcut, and the Map tab itself still opens from the Network).
 */
export async function loadMappedNodes(projectId: string, list: ListLinkedNodes): Promise<MappedSet> {
	const res = await list(projectId);
	const dams = new Map<string, LinkedDam[]>();
	// An API released before `dams` (the web and backend ship separately) sends none.
	for (const d of res.dams ?? []) {
		const at = dams.get(d.nodeId);
		if (at) at.push(d);
		else dams.set(d.nodeId, [d]);
	}
	const set = { ids: new Set(res.nodeIds), dams };
	cache.set(projectId, set);
	return set;
}

/** Test seam: forget every cached set. */
export function clearMappedNodes() {
	cache.clear();
}
