// The MAP grid layer's state on the Map tab (docs/maps.md § MAP grid): while
// `layers=mapgrid` is in the URL, one mean annual precipitation grid's points
// in the map's view are fetched once per snapped view and dataset (GET
// …/map/map-grid) and handed to the map, which draws each point labelled with
// its MAP. A view holding more points than one answer carries comes back
// `tooDense` (zoom in). The request comes in with the deps (MapTab passes
// api.map.mapGrid), so the module never imports the app-wide API client and
// its SvelteKit $env, and the tests can drive it.
import { untrack } from 'svelte';
import type { MapGridLayer as Answer } from '$lib/api/types';
import { mapGridViewBbox } from './mapLayers';

export interface MapGridLayerDeps {
	projectId: () => string;
	on: () => boolean;
	/** The map's view (west, south, east, north); null before the map reports one. */
	view: () => readonly [number, number, number, number] | null;
	/** GET …/map/map-grid: the points of `dataset` (the default when null) in `bbox`. */
	load: (projectId: string, bbox: readonly [number, number, number, number], dataset: string | null) => Promise<Answer>;
}

/** How many fetched answers the layer keeps (a few views panned between). */
const MAP_GRID_CACHE_MAX = 12;

/** A point as the map draws it. */
export interface MapGridPoint {
	lon: number;
	lat: number;
	mapMm: number;
}

export class MapGridLayer {
	#deps: MapGridLayerDeps;
	answer = $state<Answer | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	/** The dataset picked in the Layers box; null: the server's default. */
	dataset = $state<string | null>(null);
	#asked = '';
	#cache = new Map<string, Answer>();

	constructor(deps: MapGridLayerDeps) {
		this.#deps = deps;
		$effect(() => {
			const on = this.#deps.on();
			const bbox = on ? mapGridViewBbox(this.#deps.view()) : null;
			const id = this.#deps.projectId();
			const dataset = this.dataset;
			untrack(() => {
				if (!on || !bbox) {
					if (!on) this.error = null;
					return;
				}
				const key = `${id}|${dataset ?? ''}|${bbox.join(',')}`;
				if (key === this.#asked) return;
				this.#asked = key;
				const hit = this.#cache.get(key);
				if (hit) {
					this.answer = hit;
					this.error = null;
					// A request still out for the view panned away from no longer owns `loading`.
					this.loading = false;
					return;
				}
				void this.#load(id, bbox, dataset, key);
			});
		});
	}

	get on() {
		return this.#deps.on();
	}

	/** The view is too wide to ask for (or not known yet): zoom in. */
	get zoomIn() {
		return this.#deps.on() && !mapGridViewBbox(this.#deps.view());
	}

	/**
	 * What the map draws (empty while off, too wide, or loading the first
	 * view). Derived, not a getter: a new array on every read would hand the
	 * map new data on every pan, and it would re-send up to MAP_GRID_LAYER_MAX
	 * points to MapLibre's worker for a view whose answer hadn't changed.
	 */
	points = $derived.by((): MapGridPoint[] => {
		if (!this.#deps.on() || !mapGridViewBbox(this.#deps.view()) || !this.answer) return [];
		return this.answer.cells.map(([lon, lat, mapMm]) => ({ lon, lat, mapMm }));
	});

	/** The lowest and highest MAP drawn, for the Layers box; null with none. */
	range = $derived.by((): [number, number] | null => {
		const p = this.points;
		if (!p.length) return null;
		let lo = Infinity;
		let hi = -Infinity;
		for (const x of p) {
			lo = Math.min(lo, x.mapMm);
			hi = Math.max(hi, x.mapMm);
		}
		return [lo, hi];
	});

	pick(dataset: string | null) {
		this.dataset = dataset;
	}

	async #load(id: string, bbox: [number, number, number, number], dataset: string | null, key: string) {
		this.loading = true;
		this.error = null;
		try {
			const a = await this.#deps.load(id, bbox, dataset);
			this.#cache.set(key, a);
			if (this.#cache.size > MAP_GRID_CACHE_MAX) this.#cache.delete(this.#cache.keys().next().value!);
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
		const bbox = mapGridViewBbox(this.#deps.view());
		if (!bbox) return;
		const id = this.#deps.projectId();
		this.#asked = `${id}|${this.dataset ?? ''}|${bbox.join(',')}`;
		void this.#load(id, bbox, this.dataset, this.#asked);
	}
}
