// The Map tab's optional layers (issue #326 A6, the relief, the river network
// #345, the hydrological units' labels, the MAP grid and the CHIRPS grid;
// docs/ui.md § Map): which are on (`layers=` in the URL, a comma list, so a
// view can be shared and Back undoes a toggle), the bbox the quaternary
// outlines and the river network are asked for around the project's
// features, and what the units, MAP grid and CHIRPS layers draw. Pure
// (mapLayers.test.ts).
import type { MapFeature, MapPosition } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';
import { boundsOfAll } from './mapData';
import { interiorPoint } from './pieces';

/** The layers the tab can add, in the order the URL lists them. */
export const MAP_LAYERS = ['quaternaries', 'rivers', 'relief', 'units', 'mapgrid', 'chirps'] as const;
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

/** A reach's facts in words, each only when the source gives it: order, upstream area, length, modelled mean flow. */
export function reachFacts(r: { strahler: number | null; upstreamKm2: number | null; lengthKm: number | null; dischargeM3s: number | null }): string[] {
	const out: string[] = [];
	if (r.strahler !== null) out.push(`Strahler order ${r.strahler}`);
	if (r.upstreamKm2 !== null) out.push(`${fmtNum(r.upstreamKm2, r.upstreamKm2 < 100 ? 1 : 0, true)} km² upstream`);
	if (r.lengthKm !== null) out.push(`${fmtNum(r.lengthKm, 1, true)} km long`);
	// HydroRIVERS' DIS_AV_CMS is a modelled long-term mean (WaterGAP), never a gauged one: said so (persona-hydrologist, round 4).
	if (r.dischargeM3s !== null) out.push(`modelled mean flow ${fmtNum(r.dischargeM3s, 2, true)} m³/s`);
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
export function layersStatus(qt: LayerState, rv: LayerState, picked: string | null, more: readonly (string | null)[] = []): string {
	const one = (s: LayerState, loading: string, one: string, many: string) => {
		if (!s.on || s.idle || s.failed) return null;
		if (s.count === null) return loading;
		return `${s.count} ${s.count === 1 ? one : many} shown.`;
	};
	return [
		one(qt, 'Loading the quaternaries…', 'quaternary', 'quaternaries'),
		one(rv, 'Loading the river network…', 'reach', 'reaches'),
		rv.on && picked ? `Picked ${picked}.` : null,
		...more
	]
		.filter(Boolean)
		.join(' ');
}

// ---------------------------------------------------------------------------
// Hydrological units (docs/maps.md § Hydrological units layer)
// ---------------------------------------------------------------------------

/** A unit's label: the polygon it stands on, where to write it, and what. */
export interface UnitLabel {
	featureId: string;
	/** The linked unit's name, else the polygon's own, else "Unnamed area". */
	label: string;
	/** The polygon's own name when it differs from the unit's (said beside it in the list). */
	polygonName: string | null;
	areaKm2: number | null;
	at: MapPosition;
}

/**
 * The hydrological units' polygons (the farm parcels: a unit's sub-catchment,
 * docs/maps.md § Uploads) as the layer labels them, by label: each named by
 * its unit when linked to one, written at a point inside the polygon (its
 * interior point, else its centre), so a concave unit's label lands on it.
 */
export function unitLabels(features: readonly MapFeature[]): UnitLabel[] {
	return features
		.filter((f) => f.kind === 'farm_parcel' && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
		.map((f) => {
			const label = f.nodeName || f.name || 'Unnamed area';
			const at = interiorPoint(f.geometry as Extract<MapFeature['geometry'], { type: 'Polygon' | 'MultiPolygon' }>) ?? f.center;
			return { featureId: f.id, label, polygonName: f.name && f.name !== label ? f.name : null, areaKm2: f.areaM2 === null ? null : f.areaM2 / 1e6, at };
		})
		.sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// The MAP grid (docs/maps.md § MAP grid)
// ---------------------------------------------------------------------------

/** The widest view the MAP grid is asked for (the server's MAP_GRID_BBOX_MAX_DEG). */
export const MAP_GRID_BBOX_MAX_DEG = 2;
/** The grid a view is snapped out to before the MAP grid is asked for it, so small pans share one answer. */
export const MAP_GRID_VIEW_SNAP_DEG = 0.02;

/**
 * The bbox the MAP grid is asked for: the map's view, snapped outward to
 * MAP_GRID_VIEW_SNAP_DEG. Null when no view is known or it is wider than
 * MAP_GRID_BBOX_MAX_DEG a side (zoom in). The server says when a view holds
 * more of the grid's points than one answer carries.
 */
export function mapGridViewBbox(view: readonly [number, number, number, number] | null): [number, number, number, number] | null {
	if (!view || !view.every(Number.isFinite)) return null;
	const g = MAP_GRID_VIEW_SNAP_DEG;
	const r = (v: number) => Math.round(v * 1e4) / 1e4;
	const w = r(Math.max(-180, Math.floor(view[0] / g) * g));
	const s = r(Math.max(-90, Math.floor(view[1] / g) * g));
	const e = r(Math.min(180, Math.ceil(view[2] / g) * g));
	const n = r(Math.min(90, Math.ceil(view[3] / g) * g));
	if (e <= w || n <= s || e - w > MAP_GRID_BBOX_MAX_DEG || n - s > MAP_GRID_BBOX_MAX_DEG) return null;
	return [w, s, e, n];
}

/** A MAP value as the map and the list write it: whole mm. */
export const mapLabel = (mm: number) => `${fmtNum(mm, 0, true)} mm`;

// ---------------------------------------------------------------------------
// The CHIRPS grid (docs/maps.md § CHIRPS grid)
// ---------------------------------------------------------------------------

/** CHIRPS v3's cell: 0.05°, corners on whole multiples of 0.05° from 180° W and 60° N (the feed's grid, backend feeds/config.ts). */
export const CHIRPS_CELL_DEG = 0.05;
/** The most CHIRPS points the layer draws (about a 50 × 50 block): wider views say zoom in. */
export const CHIRPS_MAX_POINTS = 2_500;

/** One CHIRPS cell in view: its centre and its square (west, south, east, north). */
export interface ChirpsCell {
	lon: number;
	lat: number;
	square: [number, number, number, number];
}

/**
 * The CHIRPS v3 cells whose centres lie in the map's view (west, south, east,
 * north), from the grid's definition alone (no data is read: the points say
 * where CHIRPS's values are, not what they are). Null when the view holds
 * more than `max` (zoom in) or no view is known.
 */
export function chirpsCells(view: readonly [number, number, number, number] | null, max = CHIRPS_MAX_POINTS): ChirpsCell[] | null {
	if (!view || !view.every(Number.isFinite)) return null;
	const d = CHIRPS_CELL_DEG;
	// Centres sit at k × d + d/2 (the grid's corners are whole multiples of d).
	const k0 = Math.ceil((view[0] - d / 2) / d - 1e-9);
	const k1 = Math.floor((view[2] - d / 2) / d + 1e-9);
	const j0 = Math.ceil((view[1] - d / 2) / d - 1e-9);
	const j1 = Math.floor((view[3] - d / 2) / d + 1e-9);
	const count = Math.max(0, k1 - k0 + 1) * Math.max(0, j1 - j0 + 1);
	if (count > max) return null;
	const r = (v: number) => Math.round(v * 1e6) / 1e6;
	const out: ChirpsCell[] = [];
	for (let j = j0; j <= j1; j++) {
		for (let k = k0; k <= k1; k++) {
			const lon = r(k * d + d / 2);
			const lat = r(j * d + d / 2);
			out.push({ lon, lat, square: [r(lon - d / 2), r(lat - d / 2), r(lon + d / 2), r(lat + d / 2)] });
		}
	}
	return out;
}
