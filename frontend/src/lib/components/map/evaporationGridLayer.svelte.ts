// The A-pan grid layer's state on the Map tab (docs/maps.md § A-pan grid):
// one instance per kind (A-pan only). While its layer is in the URL
// (`layers=apangrid`), one loaded grid of that kind's points in
// the map's view are fetched once per snapped view, dataset and month (GET
// …/map/evaporation-grid) and handed to the map, which draws each point
// labelled with its value: the year's total by default, or the month picked.
// A view holding more points than one answer carries comes back `tooDense`
// (zoom in). It works as the MAP grid layer does (mapGridLayer.svelte.ts),
// with the same view snapping and caps; the request comes in with the deps
// (MapTab passes api.map.evaporationGrid), so the module never imports the
// app-wide API client and the tests can drive it.
import { untrack } from 'svelte';
import type { EvaporationGridKind, EvaporationGridLayer as Answer } from '#lib/api/types.js';
import { EVAPORATION_GRID_LABEL } from './evaporationGrid';
import { mapGridViewBbox } from './mapLayers';
import type { EvaporationGridDraw } from './mapStyle';

export interface EvaporationGridLayerDeps {
	kind: EvaporationGridKind;
	projectId: () => string;
	on: () => boolean;
	/** The map's view (west, south, east, north); null before the map reports one. */
	view: () => readonly [number, number, number, number] | null;
	/** GET …/map/evaporation-grid: the points of `dataset` (the default when null) in `bbox`, for `month` (1–12; null: the year). */
	load: (projectId: string, kind: EvaporationGridKind, bbox: readonly [number, number, number, number], dataset: string | null, month: number | null) => Promise<Answer>;
}

/** How many fetched answers the layer keeps (a few views, or months, moved between). */
const CACHE_MAX = 12;

/** A point as the map draws it: its centre and value, mm. */
export interface EvaporationGridPoint {
	lon: number;
	lat: number;
	mm: number;
}

export class EvaporationGridLayer {
	#deps: EvaporationGridLayerDeps;
	answer = $state<Answer | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	/** The dataset picked in the Layers box; null: the server's default. */
	dataset = $state<string | null>(null);
	/** The calendar month picked (1–12); null: the year's total, the default. */
	month = $state<number | null>(null);
	#asked = '';
	#cache = new Map<string, Answer>();

	constructor(deps: EvaporationGridLayerDeps) {
		this.#deps = deps;
		$effect(() => {
			const on = this.#deps.on();
			const bbox = on ? mapGridViewBbox(this.#deps.view()) : null;
			const id = this.#deps.projectId();
			const dataset = this.dataset;
			const month = this.month;
			untrack(() => {
				if (!on || !bbox) {
					if (!on) this.error = null;
					return;
				}
				const key = this.#key(id, dataset, month, bbox);
				if (key === this.#asked) return;
				this.#asked = key;
				const hit = this.#cache.get(key);
				if (hit) {
					this.answer = hit;
					this.error = null;
					// A request still out for the view moved away from no longer owns `loading`.
					this.loading = false;
					return;
				}
				void this.#load(id, bbox, dataset, month, key);
			});
		});
	}

	get kind() {
		return this.#deps.kind;
	}

	get on() {
		return this.#deps.on();
	}

	/** The view is too wide to ask for (or not known yet): zoom in. */
	get zoomIn() {
		return this.#deps.on() && !mapGridViewBbox(this.#deps.view());
	}

	/** What the map draws (empty while off, too wide, or loading the first view); derived, so a pan with the same answer hands the map nothing new. */
	points = $derived.by((): EvaporationGridPoint[] => {
		if (!this.#deps.on() || !mapGridViewBbox(this.#deps.view()) || !this.answer) return [];
		return this.answer.cells.map(([lon, lat, mm]) => ({ lon, lat, mm }));
	});

	/** What the map draws: the points, the month they are, the grid's cell size, and its credit line while any point is drawn. */
	draw = $derived.by((): EvaporationGridDraw => {
		const d = this.answer?.dataset ?? null;
		return { points: this.points, month: this.answer?.month ?? null, cellDeg: d?.cellDeg ?? null, attribution: this.points.length ? (d?.attribution ?? null) : null };
	});

	/** The lowest and highest value drawn, for the Layers box; null with none. */
	range = $derived.by((): [number, number] | null => {
		const p = this.points;
		if (!p.length) return null;
		let lo = Infinity;
		let hi = -Infinity;
		for (const x of p) {
			lo = Math.min(lo, x.mm);
			hi = Math.max(hi, x.mm);
		}
		return [lo, hi];
	});

	/** The layer's line in the Layers box's one live status region (null while off, too wide or failed: those say themselves). */
	get status(): string | null {
		if (!this.on || this.zoomIn || this.error) return null;
		const a = this.answer;
		const word = EVAPORATION_GRID_LABEL[this.#deps.kind];
		if (!a) return `Loading the ${word}…`;
		if (a.tooDense) return `Too many ${word} points in view: zoom in.`;
		return `${a.cells.length} ${word} ${a.cells.length === 1 ? 'point' : 'points'} shown.`;
	}

	pick(dataset: string | null) {
		this.dataset = dataset;
	}

	/** Show one calendar month (1–12), or the year's total (null). */
	pickMonth(month: number | null) {
		this.month = month;
	}

	#key(id: string, dataset: string | null, month: number | null, bbox: readonly number[]) {
		return `${id}|${dataset ?? ''}|${month ?? ''}|${bbox.join(',')}`;
	}

	async #load(id: string, bbox: [number, number, number, number], dataset: string | null, month: number | null, key: string) {
		this.loading = true;
		this.error = null;
		try {
			const a = await this.#deps.load(id, this.#deps.kind, bbox, dataset, month);
			this.#cache.set(key, a);
			if (this.#cache.size > CACHE_MAX) this.#cache.delete(this.#cache.keys().next().value!);
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
		this.#asked = this.#key(id, this.dataset, this.month, bbox);
		void this.#load(id, bbox, this.dataset, this.month, this.#asked);
	}
}
