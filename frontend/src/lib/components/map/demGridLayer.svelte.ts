// The DEM grid layer's state on the Map tab (docs/maps.md § DEM grid): while
// `layers=demgrid` is in the URL, every 10th elevation-model cell each way in
// the map's view is fetched once per snapped view (GET …/map/dem-grid) and
// handed to the map, which draws each point labelled with its elevation. A
// view holding more points than one answer carries comes back `tooDense`
// (zoom in). The request comes in with the deps (MapTab passes
// api.map.demGrid), so the module never imports the app-wide API client, and
// the tests can drive it. The MAP grid layer's twin (mapGridLayer.svelte.ts),
// without its dataset choice: the server has one DEM.
import { untrack } from 'svelte';
import type { DemGridLayer as Answer } from '$lib/api/types';
import { demGridViewBbox as viewBbox } from './mapLayers';

export interface DemGridLayerDeps {
	projectId: () => string;
	on: () => boolean;
	/** The map's view (west, south, east, north); null before the map reports one. */
	view: () => readonly [number, number, number, number] | null;
	/** GET …/map/dem-grid: the points in `bbox`. */
	load: (projectId: string, bbox: readonly [number, number, number, number]) => Promise<Answer>;
}

/** How many fetched answers the layer keeps (a few views panned between). */
const DEM_GRID_CACHE_MAX = 12;

/** A point as the map draws it. */
export interface DemGridPoint {
	lon: number;
	lat: number;
	elevationM: number;
}

export class DemGridLayer {
	#deps: DemGridLayerDeps;
	answer = $state<Answer | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	#asked = '';
	#cache = new Map<string, Answer>();

	constructor(deps: DemGridLayerDeps) {
		this.#deps = deps;
		$effect(() => {
			const on = this.#deps.on();
			const bbox = on ? viewBbox(this.#deps.view()) : null;
			const id = this.#deps.projectId();
			untrack(() => {
				if (!on || !bbox) {
					if (!on) this.error = null;
					return;
				}
				const key = `${id}|${bbox.join(',')}`;
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
				void this.#load(id, bbox, key);
			});
		});
	}

	get on() {
		return this.#deps.on();
	}

	/** The view is too wide to ask for (or not known yet): zoom in. */
	get zoomIn() {
		return this.#deps.on() && !viewBbox(this.#deps.view());
	}

	/**
	 * What the map draws (empty while off, too wide, or loading the first
	 * view). Derived, not a getter: a new array on every read would hand the
	 * map new data on every pan, and it would re-send up to the server's cap of
	 * points to MapLibre's worker for a view whose answer hadn't changed.
	 */
	points = $derived.by((): DemGridPoint[] => {
		if (!this.#deps.on() || !viewBbox(this.#deps.view()) || !this.answer) return [];
		return this.answer.points.map(([lon, lat, elevationM]) => ({ lon, lat, elevationM }));
	});

	/** The lowest and highest elevation drawn, for the Layers box; null with none. */
	range = $derived.by((): [number, number] | null => {
		const p = this.points;
		if (!p.length) return null;
		let lo = Infinity;
		let hi = -Infinity;
		for (const x of p) {
			lo = Math.min(lo, x.elevationM);
			hi = Math.max(hi, x.elevationM);
		}
		return [lo, hi];
	});

	async #load(id: string, bbox: [number, number, number, number], key: string) {
		this.loading = true;
		this.error = null;
		try {
			const a = await this.#deps.load(id, bbox);
			this.#cache.set(key, a);
			if (this.#cache.size > DEM_GRID_CACHE_MAX) this.#cache.delete(this.#cache.keys().next().value!);
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
		const bbox = viewBbox(this.#deps.view());
		if (!bbox) return;
		const id = this.#deps.projectId();
		this.#asked = `${id}|${bbox.join(',')}`;
		void this.#load(id, bbox, this.#asked);
	}
}
