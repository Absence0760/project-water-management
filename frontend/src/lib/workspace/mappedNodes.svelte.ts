// Which nodes get a "Show on map" link (mapLinks.ts), as reactive state for a
// page: the session's last set on the first frame, refreshed by `load()`, which
// the page calls once it has mounted so the request never delays first paint.
import { cachedMappedNodes, loadMappedNodes, type ListFeatures } from './mapLinks';

export class MappedNodes {
	#ids = $state.raw<Set<string> | undefined>();
	readonly #projectId: string;
	readonly #list: ListFeatures;

	/** `list`: the map's feature list (`api.map.list`). */
	constructor(projectId: string, list: ListFeatures) {
		this.#projectId = projectId;
		this.#list = list;
		this.#ids = projectId ? cachedMappedNodes(projectId) : undefined;
	}

	/** Refresh from the server. A failed read shows no links rather than ones that may be stale. */
	load(): Promise<void> {
		if (!this.#projectId) return Promise.resolve();
		return loadMappedNodes(this.#projectId, this.#list).then(
			(ids) => void (this.#ids = ids),
			() => void (this.#ids = undefined)
		);
	}

	/** True when a map feature is linked to this node (as far as the page knows). */
	has(nodeId: string): boolean {
		return this.#ids?.has(nodeId) ?? false;
	}
}
