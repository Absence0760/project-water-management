// A MAP grid layer's state on the Map tab (docs/maps.md § MAP grid): the
// WAAS 2007 MAP (`layers=mapgrid`) and the CCWR MAP (`layers=ccwrgrid`) are
// one each, toggled on their own. While on, its one dataset's points in the
// map's view are fetched once per snapped view (GET …/map/map-grid with that
// dataset) and handed to the map, which draws each point labelled with its
// MAP. A view holding more points than one answer carries comes back
// `tooDense` (zoom in); a dataset not loaded comes back with none. Where its
// dataset isn't loaded but the repo's synthetic grid is (a dev laptop, a fresh
// clone: production never loads it, referenceLoad.ts), the layer asks for the
// synthetic grid instead and draws it in its place, `standIn` true, so the
// layer can be tried locally; it never stands another real grid in. The request
// comes in with the deps (MapTab passes api.map.mapGrid), so the module never
// imports the app-wide API client and its SvelteKit $env, and the tests can
// drive it.
import { untrack } from 'svelte';
import type { MapGridLayer as Answer } from '#lib/api/types.js';
import { MAP_GRIDS, mapGridViewBbox, type MapGridKind } from './mapLayers';
import type { MapGridDraw } from './mapStyle';

export interface MapGridLayerDeps {
	/** Which MAP grid: its dataset, `layers=` id and name (mapLayers.ts MAP_GRIDS). */
	kind: MapGridKind;
	projectId: () => string;
	on: () => boolean;
	/** The map's view (west, south, east, north); null before the map reports one. */
	view: () => readonly [number, number, number, number] | null;
	/** GET …/map/map-grid: the points of `dataset` in `bbox`. */
	load: (projectId: string, bbox: readonly [number, number, number, number], dataset: string) => Promise<Answer>;
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
	#asked = '';
	#cache = new Map<string, Answer>();

	constructor(deps: MapGridLayerDeps) {
		this.#deps = deps;
		$effect(() => {
			const on = this.#deps.on();
			const bbox = on ? mapGridViewBbox(this.#deps.view()) : null;
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

	get kind() {
		return this.#deps.kind;
	}

	/** Its `layers=` id. */
	get layer() {
		return MAP_GRIDS[this.#deps.kind].layer;
	}

	/** Its name, the toggle's and its lines'. */
	get label() {
		return MAP_GRIDS[this.#deps.kind].label;
	}

	/** The one dataset it draws. */
	get dataset() {
		return MAP_GRIDS[this.#deps.kind].dataset;
	}

	/** It draws the synthetic grid in place of its own, which isn't loaded. */
	get standIn() {
		const d = this.answer?.dataset;
		return !!d?.synthetic && d.dataset !== this.dataset;
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

	/** What the map draws: the points, the grid's cell size, and its credit line while any point is drawn. */
	draw = $derived.by((): MapGridDraw => {
		const d = this.answer?.dataset ?? null;
		return { points: this.points, cellDeg: d?.cellDeg ?? null, attribution: this.points.length ? (d?.attribution ?? null) : null };
	});

	/** The layer's line in the Layers box's one live status region (null while off, too wide or failed: those say themselves). */
	get status(): string | null {
		if (!this.on || this.zoomIn || this.error) return null;
		const a = this.answer;
		if (!a) return `Loading the ${this.label}…`;
		if (!a.dataset) return `No ${this.label} is loaded.`;
		if (a.tooDense) return `Too many ${this.label} points in view: zoom in.`;
		// The synthetic grid standing in is never counted as the layer's own points.
		return `${a.cells.length} ${this.standIn ? 'synthetic test' : this.label} ${a.cells.length === 1 ? 'point' : 'points'} shown.`;
	}

	async #load(id: string, bbox: [number, number, number, number], key: string) {
		this.loading = true;
		this.error = null;
		try {
			let a = await this.#deps.load(id, bbox, this.dataset);
			const synthetic = a.dataset ? null : a.datasets.find((d) => d.synthetic);
			if (synthetic) a = await this.#deps.load(id, bbox, synthetic.dataset);
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
		this.#asked = `${id}|${bbox.join(',')}`;
		void this.#load(id, bbox, this.#asked);
	}
}
