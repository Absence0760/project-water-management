// The elevation model's channels on the Map (issue #374 item 3; docs/maps.md
// § The elevation model's channels): while Delineate or Sub-catchments is on,
// the tiles of GET …/map/channels covering the map's view are fetched (one at
// a time: each is an elevation-model request the account's cap counts, and
// at most two may run at once) and drawn, so the editor clicks the line the
// elevation model agrees with rather than a displaced river line. Fetched
// tiles are kept for the session (the server caches them too). The request
// comes in with the deps (MapTab passes api.map's), so this module never
// imports the app-wide API client and the tests can drive it.
import { untrack } from 'svelte';
import type { ChannelTileAnswer } from '$lib/api/types';
import type { ChannelLineData } from './mapStyle';

/** A tile's side (degrees), as the server's (backend delineation/channels.ts CHANNEL_TILE_DEG). */
export const CHANNEL_TILE_DEG = 0.2;
/** The widest view (degrees a side) the channels are drawn for: at most 3 × 3 tiles, each an elevation-model request. */
export const CHANNEL_VIEW_MAX_DEG = 0.35;

/** The tiles covering a view (west, south, east, north), or null when the view is too wide to draw them. Pure. */
export function tilesInView(view: readonly [number, number, number, number] | null): [number, number][] | null {
	if (!view) return null;
	const [w, s, e, n] = view;
	if (e - w > CHANNEL_VIEW_MAX_DEG || n - s > CHANNEL_VIEW_MAX_DEG) return null;
	const tiles: [number, number][] = [];
	for (let j = Math.floor(s / CHANNEL_TILE_DEG); j <= Math.floor(n / CHANNEL_TILE_DEG); j++)
		for (let i = Math.floor(w / CHANNEL_TILE_DEG); i <= Math.floor(e / CHANNEL_TILE_DEG); i++) tiles.push([i, j]);
	// The middle first: what the editor is looking at draws first.
	const cx = (w + e) / 2 / CHANNEL_TILE_DEG - 0.5;
	const cy = (s + n) / 2 / CHANNEL_TILE_DEG - 0.5;
	return tiles.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
}

export interface ChannelLayerDeps {
	projectId: () => string;
	on: () => boolean;
	/** The map's view (west, south, east, north); null before the map reports one. */
	view: () => readonly [number, number, number, number] | null;
	/** GET …/map/channels?tile=i,j. */
	load: (projectId: string, tile: readonly [number, number]) => Promise<ChannelTileAnswer>;
}

export class ChannelLayer {
	#deps: ChannelLayerDeps;
	/** Fetched tiles' lines, by `project|i,j`. */
	#tiles = $state.raw(new Map<string, ChannelLineData[]>());
	loading = $state(false);
	error = $state<string | null>(null);
	#queue: [number, number][] = [];
	#running = false;
	#project = '';

	constructor(deps: ChannelLayerDeps) {
		this.#deps = deps;
		$effect(() => {
			const on = this.#deps.on();
			const tiles = on ? tilesInView(this.#deps.view()) : null;
			const id = this.#deps.projectId();
			untrack(() => {
				if (id !== this.#project) {
					this.#project = id;
					this.#tiles = new Map();
				}
				this.#queue = (tiles ?? []).filter((t) => !this.#tiles.has(this.#key(t)));
				if (!on) this.error = null;
				void this.#drain();
			});
		});
	}

	#key = (t: readonly [number, number]) => `${this.#project}|${t[0]},${t[1]}`;

	get on() {
		return this.#deps.on();
	}
	/** On, but the map reports no view (it can't be drawn, or hasn't yet): nothing is drawn. */
	get noView() {
		return this.#deps.on() && !this.#deps.view();
	}
	/** On, but the view is too wide to draw them: zoom in. */
	get zoomIn() {
		return this.#deps.on() && !!this.#deps.view() && !tilesInView(this.#deps.view());
	}
	/** What the map draws: every fetched tile's lines while on (tiles outside the view cost nothing to keep drawn). */
	get lines(): ChannelLineData[] {
		if (!this.on) return [];
		const out: ChannelLineData[] = [];
		for (const ls of this.#tiles.values()) for (const l of ls) out.push(l);
		return out;
	}
	/** How many tiles are drawn, for the status line and the tests. */
	get tileCount() {
		return this.#tiles.size;
	}

	async #drain() {
		if (this.#running) return;
		this.#running = true;
		try {
			for (let t = this.#queue.shift(); t; t = this.#queue.shift()) {
				const key = this.#key(t);
				if (this.#tiles.has(key)) continue;
				this.loading = true;
				try {
					const a = await this.#deps.load(this.#project, t);
					const next = new Map(this.#tiles);
					next.set(key, a.lines);
					this.#tiles = next;
					this.error = null;
				} catch (e) {
					// A refusal (off the elevation model, the hourly cap) stops this view's tiles; the next view tries again.
					this.error = e instanceof Error ? e.message : String(e);
					this.#queue = [];
				}
			}
		} finally {
			this.loading = false;
			this.#running = false;
		}
	}
}
