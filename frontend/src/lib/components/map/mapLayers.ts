// The Map tab's optional layers (issue #326 A6, the relief; docs/ui.md § Map): which are
// on (`layers=` in the URL, a comma list, so a view can be shared and Back
// undoes a toggle), and the bbox the quaternary outlines are asked for
// around the project's features. Pure (mapLayers.test.ts).
import type { MapFeature } from '$lib/api/types';
import { boundsOfAll } from './mapData';

/** The layers the tab can add, in the order the URL lists them. */
export const MAP_LAYERS = ['quaternaries', 'relief'] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

/** The layers `layers=` turns on (unknown names ignored). */
export function layersOn(params: URLSearchParams): Set<MapLayer> {
	const asked = new Set((params.get('layers') ?? '').split(',').map((s) => s.trim()));
	return new Set(MAP_LAYERS.filter((l) => asked.has(l)));
}

/** The URL's query with `layer` turned on or off, every other param kept; `layers` dropped when none is on. */
export function withLayer(search: string, layer: MapLayer, on: boolean): string {
	const q = new URLSearchParams(search);
	const now = layersOn(q);
	if (on) now.add(layer);
	else now.delete(layer);
	const list = MAP_LAYERS.filter((l) => now.has(l));
	if (list.length) q.set('layers', list.join(','));
	else q.delete('layers');
	return `?${q}`;
}

/** The widest bbox asked for (the server's QUATERNARY_BBOX_MAX_DEG). */
export const QUATERNARY_BBOX_MAX_DEG = 5;

/**
 * The bbox (west, south, east, north) to ask the quaternaries for: the
 * features' bounds, padded by half their size (at least 0.1°) so the
 * neighbouring quaternaries show too, and capped at QUATERNARY_BBOX_MAX_DEG
 * a side around the middle. Null with no features (nothing to be around).
 */
export function quaternaryBbox(features: readonly MapFeature[]): [number, number, number, number] | null {
	const b = boundsOfAll(features);
	if (!b) return null;
	const [[w, s], [e, n]] = b;
	const half = (lo: number, hi: number) => Math.min(QUATERNARY_BBOX_MAX_DEG / 2, (hi - lo) / 2 + Math.max(0.1, (hi - lo) / 2));
	const cx = (w + e) / 2;
	const cy = (s + n) / 2;
	const hx = half(w, e);
	const hy = half(s, n);
	const r = (v: number) => Math.round(v * 1e4) / 1e4;
	return [r(Math.max(-180, cx - hx)), r(Math.max(-90, cy - hy)), r(Math.min(180, cx + hx)), r(Math.min(90, cy + hy))];
}
