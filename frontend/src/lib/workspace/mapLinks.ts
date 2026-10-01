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
import type { MapLinkedNodes } from '$lib/api/types';
import { overlayHref } from './overlays';

/** The Map tab with this node selected. */
export const mapNodeHref = (nodeId: string) => overlayHref('map', 'node', nodeId);

const cache = new Map<string, Set<string>>();

/** The last set fetched for this project in this session, for the first frame; undefined before any. */
export const cachedMappedNodes = (projectId: string): Set<string> | undefined => cache.get(projectId);

/** The nodes with a linked feature in a project (`api.map.linkedNodes`). */
export type ListLinkedNodes = (projectId: string) => Promise<MapLinkedNodes>;

/**
 * Fetch which of the project's nodes have a map feature, and remember it.
 * Rejects when the list can't be read; the caller then shows no link (the
 * link is a shortcut, and the Map tab itself still opens from the Network).
 */
export async function loadMappedNodes(projectId: string, list: ListLinkedNodes): Promise<Set<string>> {
	const ids = new Set((await list(projectId)).nodeIds);
	cache.set(projectId, ids);
	return ids;
}

/** Test seam: forget every cached set. */
export function clearMappedNodes() {
	cache.clear();
}
