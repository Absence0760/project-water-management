// The River network layer's state on the Map tab (issue #345; docs/maps.md §
// River network): while `layers=rivers` is in the URL, the reaches around the
// project's features are fetched once per bbox (GET …/map/rivers) and handed
// to the map; the tab lists them beside it (the map is never the only place
// to read them), and an editor adds the picked reach as the project's river
// feature, one reach at a time (POST …/map/rivers/add).
import { untrack } from 'svelte';
import { api, type MapFeature, type RiverLayer as Answer, type RiverReach } from '$lib/api';
import { reachKey, reachRef, riverBbox } from './mapLayers';
import type { NetworkReach } from './mapStyle';


export class RiverLayer {
	#deps: { projectId: () => string; on: () => boolean; features: () => readonly MapFeature[] };
	answer = $state<Answer | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	/** The reach picked on the map or in the list (drawn heavier; its facts and Add shown). */
	picked = $state<string | null>(null);
	/** The reach being added, and why the last add failed. */
	adding = $state<string | null>(null);
	addError = $state<string | null>(null);
	#asked = '';

	constructor(deps: { projectId: () => string; on: () => boolean; features: () => readonly MapFeature[] }) {
		this.#deps = deps;
		$effect(() => {
			const on = this.#deps.on();
			const bbox = on ? riverBbox(this.#deps.features()) : null;
			const id = this.#deps.projectId();
			untrack(() => {
				if (!on) {
					this.picked = null;
					this.addError = null;
					return;
				}
				if (!bbox) {
					this.answer = null;
					this.#asked = '';
					return;
				}
				const key = `${id}|${bbox.join(',')}`;
				if (key === this.#asked) return;
				this.#asked = key;
				void this.#load(id, bbox, key);
			});
		});
	}

	get on() {
		return this.#deps.on();
	}

	/** Nothing to draw around: the map has no features yet. */
	get nothingAround() {
		return this.#deps.on() && !this.#deps.features().length;
	}

	/** What the map draws (empty while off or loading). */
	get reaches(): NetworkReach[] {
		return this.on && this.answer ? this.answer.reaches.map((r) => ({ key: reachKey(r), strahler: r.strahler, geometry: r.geometry })) : [];
	}

	/** The picked reach, if it is in the answer. */
	get pickedReach(): RiverReach | null {
		return this.answer?.reaches.find((r) => reachKey(r) === this.picked) ?? null;
	}

	/**
	 * The project's river feature made from `reach`, read from the loaded
	 * features (their `ref`), so a delete or an add shows at once without a
	 * fetch; null when it isn't on the map.
	 */
	featureFor(reach: Pick<RiverReach, 'dataset' | 'reachId'>): MapFeature | null {
		const ref = reachRef(reach);
		return this.#deps.features().find((f) => f.kind === 'river' && f.properties?.ref === ref) ?? null;
	}

	pick(key: string | null) {
		this.picked = this.picked === key ? null : key;
		this.addError = null;
	}

	async #load(id: string, bbox: [number, number, number, number], key: string) {
		this.loading = true;
		this.error = null;
		try {
			const a = await api.map.rivers(id, bbox);
			if (key === this.#asked) this.answer = a;
		} catch (e) {
			if (key === this.#asked) {
				this.error = e instanceof Error ? e.message : String(e);
				this.#asked = '';
			}
		} finally {
			if (key === this.#asked || !this.#asked) this.loading = false;
		}
	}

	/** Ask again (after an error). */
	retry() {
		this.#asked = '';
		const bbox = riverBbox(this.#deps.features());
		if (!bbox) return;
		const id = this.#deps.projectId();
		this.#asked = `${id}|${bbox.join(',')}`;
		void this.#load(id, bbox, this.#asked);
	}

	/** Add `reach` as the project's river feature; the feature, or null when it failed (addError says why). */
	async add(reach: RiverReach): Promise<MapFeature | null> {
		const key = reachKey(reach);
		this.adding = key;
		this.addError = null;
		try {
			const feature = await api.map.addRiver(this.#deps.projectId(), reach.dataset, reach.reachId);
			return feature;
		} catch (e) {
			this.addError = e instanceof Error ? e.message : String(e);
			return null;
		} finally {
			this.adding = null;
		}
	}
}
