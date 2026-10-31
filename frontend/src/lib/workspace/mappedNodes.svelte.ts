// Which nodes get a "Show on map" link (mapLinks.ts), as reactive state for a
// page: the session's last set on the first frame, refreshed by `load()`, which
// the page calls once it has mounted (and again when its project changes) so
// the request never delays first paint. The workspace reuses a tab across a
// project switch, so the project is read through a getter, a set answers only
// for the project it was read for, and a late answer for an earlier project
// is dropped.
import type { LinkedDam } from '#lib/api/types.js';
import { cachedMappedNodes, loadMappedNodes, type ListLinkedNodes, type MappedSet } from './mapLinks';

export class MappedNodes {
	#ids = $state.raw<{ projectId: string; set: MappedSet } | undefined>();
	readonly #projectId: () => string;
	readonly #list: ListLinkedNodes;
	#asked = 0;

	/** `projectId`: the page's current project; `list`: the nodes with a linked feature (`api.map.linkedNodes`). */
	constructor(projectId: () => string, list: ListLinkedNodes) {
		this.#projectId = projectId;
		this.#list = list;
		const p = projectId();
		const cached = p ? cachedMappedNodes(p) : undefined;
		this.#ids = cached ? { projectId: p, set: cached } : undefined;
	}

	/** Refresh from the server for the current project. A failed read shows no links rather than ones that may be stale. */
	load(): Promise<void> {
		const p = this.#projectId();
		if (!p) return Promise.resolve();
		const asked = ++this.#asked;
		const cached = cachedMappedNodes(p);
		if (this.#ids?.projectId !== p) this.#ids = cached ? { projectId: p, set: cached } : undefined;
		return loadMappedNodes(p, this.#list).then(
			(set) => {
				if (asked === this.#asked) this.#ids = { projectId: p, set };
			},
			() => {
				if (asked === this.#asked) this.#ids = undefined;
			}
		);
	}

	/** True when a map feature is linked to this node in the current project (as far as the page knows). */
	has(nodeId: string): boolean {
		const set = this.#ids;
		return !!set && set.projectId === this.#projectId() && set.set.ids.has(nodeId);
	}

	/** The dam outlines linked to this node on the map, with their siting; empty when none (or not known). */
	dams(nodeId: string): LinkedDam[] {
		const set = this.#ids;
		return (set && set.projectId === this.#projectId() && set.set.dams.get(nodeId)) || NO_DAMS;
	}
}

const NO_DAMS: LinkedDam[] = [];
