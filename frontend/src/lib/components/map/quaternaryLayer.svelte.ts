// The quaternary outlines layer's state on the Map tab (issue #326 A6;
// docs/maps.md § Quaternary outlines): while `layers=quaternaries` is in
// the URL, the outlines around the project's features are fetched once per
// bbox (GET …/map/quaternaries) and handed to the map; the tab lists their
// codes beside it, so the map is never the only place to read them.
import { untrack } from 'svelte';
import { api, type QuaternaryLayer as Answer } from '$lib/api';
import type { MapFeature } from '$lib/api/types';
import { quaternaryBbox } from './mapLayers';
import type { QuaternaryOutline } from './mapStyle';

export class QuaternaryLayer {
	#deps: { projectId: () => string; on: () => boolean; features: () => readonly MapFeature[] };
	answer = $state<Answer | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	/** The code picked on the map or in the list (its outline drawn heavier). */
	picked = $state<string | null>(null);
	#asked = '';

	constructor(deps: { projectId: () => string; on: () => boolean; features: () => readonly MapFeature[] }) {
		this.#deps = deps;
		$effect(() => {
			const on = this.#deps.on();
			const bbox = on ? quaternaryBbox(this.#deps.features()) : null;
			const id = this.#deps.projectId();
			untrack(() => {
				if (!on) {
					this.picked = null;
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

	/** Whether the layer is on (the URL says so). */
	get on() {
		return this.#deps.on();
	}

	/** Nothing to draw around: the map has no features yet. */
	get nothingAround() {
		return this.#deps.on() && !this.#deps.features().length;
	}

	/** What the map draws (empty while off or loading). */
	get outlines(): QuaternaryOutline[] {
		return this.on && this.answer ? this.answer.quaternaries.map((q) => ({ code: q.code, geometry: q.geometry })) : [];
	}

	async #load(id: string, bbox: [number, number, number, number], key: string) {
		this.loading = true;
		this.error = null;
		try {
			const a = await api.map.quaternaries(id, bbox);
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
		const bbox = quaternaryBbox(this.#deps.features());
		if (!bbox) return;
		const id = this.#deps.projectId();
		this.#asked = `${id}|${bbox.join(',')}`;
		void this.#load(id, bbox, this.#asked);
	}
}
