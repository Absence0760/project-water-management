// The Map tab's optional layers (issue #326 A6, the relief, the river network
// #345; docs/ui.md § Map): which are on (`layers=` in the URL, a comma list,
// so a view can be shared and Back undoes a toggle), and the bbox the
// quaternary outlines and the river network are asked for around the
// project's features. Pure (mapLayers.test.ts).
import type { MapFeature } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';
import { boundsOfAll } from './mapData';

/** The layers the tab can add, in the order the URL lists them. */
export const MAP_LAYERS = ['quaternaries', 'rivers', 'relief'] as const;
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
/** The widest bbox the river network is asked for (the server's RIVER_BBOX_MAX_DEG). */
export const RIVER_BBOX_MAX_DEG = 2;

/**
 * The bbox (west, south, east, north) to ask a layer for: the features'
 * bounds, padded by half their size (at least 0.1°) so the neighbouring
 * quaternaries or streams show too, and capped at `maxDeg` a side around the
 * middle. Null with no features (nothing to be around).
 */
export function layerBbox(features: readonly MapFeature[], maxDeg: number): [number, number, number, number] | null {
	const b = boundsOfAll(features);
	if (!b) return null;
	const [[w, s], [e, n]] = b;
	const half = (lo: number, hi: number) => Math.min(maxDeg / 2, (hi - lo) / 2 + Math.max(0.1, (hi - lo) / 2));
	const cx = (w + e) / 2;
	const cy = (s + n) / 2;
	const hx = half(w, e);
	const hy = half(s, n);
	const r = (v: number) => Math.round(v * 1e4) / 1e4;
	return [r(Math.max(-180, cx - hx)), r(Math.max(-90, cy - hy)), r(Math.min(180, cx + hx)), r(Math.min(90, cy + hy))];
}

/** The bbox the quaternary outlines are asked for (layerBbox, at most QUATERNARY_BBOX_MAX_DEG a side). */
export const quaternaryBbox = (features: readonly MapFeature[]) => layerBbox(features, QUATERNARY_BBOX_MAX_DEG);
/** The bbox the river network is asked for (layerBbox, at most RIVER_BBOX_MAX_DEG a side). */
export const riverBbox = (features: readonly MapFeature[]) => layerBbox(features, RIVER_BBOX_MAX_DEG);

/** The grid a map view is snapped out to before the river network is asked for it, so small pans share one answer. */
export const RIVER_VIEW_SNAP_DEG = 0.05;

/**
 * The bbox the river network is asked for when the project has no features
 * yet (docs/maps.md § River network): the map's view (west, south, east,
 * north), snapped outward to RIVER_VIEW_SNAP_DEG so a small pan asks the same
 * bbox again. Null when no view is known or the snapped view is wider than
 * RIVER_BBOX_MAX_DEG a side, which the server refuses: zoom in.
 */
export function riverViewBbox(view: readonly [number, number, number, number] | null): [number, number, number, number] | null {
	if (!view || !view.every(Number.isFinite)) return null;
	const g = RIVER_VIEW_SNAP_DEG;
	const r = (v: number) => Math.round(v * 1e4) / 1e4;
	const w = r(Math.max(-180, Math.floor(view[0] / g) * g));
	const s = r(Math.max(-90, Math.floor(view[1] / g) * g));
	const e = r(Math.min(180, Math.ceil(view[2] / g) * g));
	const n = r(Math.min(90, Math.ceil(view[3] / g) * g));
	if (e <= w || n <= s || e - w > RIVER_BBOX_MAX_DEG || n - s > RIVER_BBOX_MAX_DEG) return null;
	return [w, s, e, n];
}

/**
 * Whether a reach comes from HydroRIVERS, whose licence asks for a credit
 * wherever its data is shown (docs/maps.md § Sources): by its dataset label or
 * source line, never the repo's synthetic network.
 */
export const creditedReach = (r: { dataset: string; source: string; synthetic: boolean }) => !r.synthetic && /hydro\s*(rivers|sheds)/i.test(`${r.dataset} ${r.source}`);

/**
 * Whether a project feature is a river added from a HydroRIVERS reach: its
 * data is HydroRIVERS' wherever the map draws it, so it carries the credit
 * too. On the Map tab its `ref` says so (POST …/map/rivers/add stores
 * `river-network:<dataset>:<id>`); the farm map gets no properties, so the
 * server flags it (`credit`, farms/view.ts farmMap, farmMap.ts asMapFeatures).
 */
export const creditedFeature = (f: Pick<MapFeature, 'kind' | 'properties'>) => {
	if (f.kind !== 'river') return false;
	if (f.properties?.credit === 'hydrorivers') return true;
	const ref = f.properties?.ref;
	return typeof ref === 'string' && /^river-network:hydro\s*(rivers|sheds)/i.test(ref);
};

/** A reach as the list names it: its own name, else its id. */
export const reachLabel = (r: { name: string; reachId: number }) => r.name || `Reach ${r.reachId}`;

/** A reach's facts in words, each only when the source gives it: order, upstream area, length, mean flow. */
export function reachFacts(r: { strahler: number | null; upstreamKm2: number | null; lengthKm: number | null; dischargeM3s: number | null }): string[] {
	const out: string[] = [];
	if (r.strahler !== null) out.push(`Strahler order ${r.strahler}`);
	if (r.upstreamKm2 !== null) out.push(`${fmtNum(r.upstreamKm2, r.upstreamKm2 < 100 ? 1 : 0, true)} km² upstream`);
	if (r.lengthKm !== null) out.push(`${fmtNum(r.lengthKm, 1, true)} km long`);
	if (r.dischargeM3s !== null) out.push(`mean flow ${fmtNum(r.dischargeM3s, 2, true)} m³/s`);
	return out;
}

/** A reach's key on the map and in the list: its dataset and id. */
export const reachKey = (r: { dataset: string; reachId: number }) => `${r.dataset}:${r.reachId}`;
/** The `ref` a reach added to the project carries (the server's riverRef, geo/rivers.ts), so the layer can tell it is on the map. */
export const reachRef = (r: { dataset: string; reachId: number }) => `river-network:${r.dataset}:${r.reachId}`;

/** One layer's state, as the Layers box's status line reads it. */
export interface LayerState {
	on: boolean;
	/** Nothing on the map to look around, so nothing is asked for. */
	idle: boolean;
	failed: boolean;
	/** How many came back; null while loading. */
	count: number | null;
}

/**
 * What the Layers box's one always-present status region says (WCAG 4.1.3: a
 * live region that arrives already filled is often not read, so the loading
 * lines and the results share one that stays): each layer loading, or how
 * many it shows, then the reach picked. A failure is said by its own alert,
 * so it adds nothing here.
 */
export function layersStatus(qt: LayerState, rv: LayerState, picked: string | null): string {
	const one = (s: LayerState, loading: string, one: string, many: string) => {
		if (!s.on || s.idle || s.failed) return null;
		if (s.count === null) return loading;
		return `${s.count} ${s.count === 1 ? one : many} shown.`;
	};
	return [
		one(qt, 'Loading the quaternaries…', 'quaternary', 'quaternaries'),
		one(rv, 'Loading the river network…', 'reach', 'reaches'),
		rv.on && picked ? `Picked ${picked}.` : null
	]
		.filter(Boolean)
		.join(' ');
}
