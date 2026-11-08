// The Map tab's optional layers (issue #326 A6, the relief, the river network
// #345, the hydrological units' labels, the MAP grid, the A-pan and S-pan
// grids and the CHIRPS grid; docs/ui.md § Map): which are on (`layers=` in
// the URL, a comma list, so a view can be shared and Back undoes a toggle),
// the bbox the quaternary outlines and the river network are asked for around
// the project's features, and what the units, grid and CHIRPS layers draw. Pure
// (mapLayers.test.ts).
import type { MapFeature, MapPosition } from '#lib/api/types.js';
import { fmtNum } from '#lib/format/number.js';
import {
	ATLAS_APAN_MAP_ATTRIBUTION,
	ATLAS_APAN_STATEMENT,
	ATLAS_SPAN_MAP_ATTRIBUTION,
	ATLAS_SPAN_STATEMENT,
	HYDRORIVERS_MAP_ATTRIBUTION,
	JRC_WATER_MAP_ATTRIBUTION,
	JRC_WATER_STATEMENT,
	LYNCH_MAP_MAP_ATTRIBUTION,
	LYNCH_MAP_STATEMENT,
	WAAS_MAP_MAP_ATTRIBUTION,
	WAAS_MAP_STATEMENT
} from '#lib/components/legal/dataCredits.js';
import { boundsOfAll } from './mapData';
import { interiorPoint } from './pieces';
import type { ReadonlyURLSearchParams } from '$app/state';

/**
 * The layers the tab can add, in the order the URL lists them. An id is what
 * a shared or saved `layers=` holds, so it never changes when a label does
 * (`rivers` is labelled "Rivers (HydroRIVERS)" since the DEM rivers,
 * `channels`, came beside it).
 */
export const MAP_LAYERS = ['quaternaries', 'rivers', 'channels', 'relief', 'units', 'mapgrid', 'apangrid', 'spangrid', 'chirps', 'demgrid'] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

/** The HydroRIVERS layer's toggle (`rivers`): mapped rivers, for reference. */
export const HYDRORIVERS_LAYER_LABEL = 'Rivers (HydroRIVERS)';
/** The DEM rivers layer's toggle (`channels`, docs/maps.md § The elevation model's channels): the terrain channels, drawn outside Delineate. */
export const DEM_RIVERS_LAYER_LABEL = 'DEM rivers';
/** What the DEM rivers are, under their toggle while on. */
export const DEM_RIVERS_NOTE = 'The rivers delineation follows, worked out from the elevation model (the terrain channels in the Key): wider for a larger area upstream. The HydroRIVERS lines can sit a few hundred metres off them.';

/**
 * Whether the DEM rivers toggle is offered: to an editor (the channels route
 * is an editor's, delineation/channelRoutes.ts) once their delineation check
 * says the server has an elevation model (DEM_URL set). Without one it isn't
 * offered, as the DEM grid and the relief aren't.
 */
export const demRiversOffered = (canEdit: boolean, demAvailable: boolean) => canEdit && demAvailable;

/**
 * Whether the terrain channels are drawn: while the DEM rivers layer is on
 * (and offered), or while Delineate, Sub-catchments or a proposal under
 * review needs them, whichever of the two.
 */
export const channelsWanted = (o: { offered: boolean; layerOn: boolean; tool: boolean }) => o.offered && (o.layerOn || o.tool);

/** The DEM rivers layer's state, as the Layers box reads it (channelLayer.svelte.ts ChannelLayer). */
export interface DemRiversState {
	noView: boolean;
	zoomIn: boolean;
	error: string | null;
	loading: boolean;
	tileCount: number;
	/** The account's hourly pool of channel tiles is spent (channelLayer.svelte.ts ChannelLayer.paused). */
	paused?: boolean;
}

/** What the Layers box says while the channel tiles' own hourly pool is spent: words, not an error. */
export const DEM_RIVERS_PAUSED = 'DEM rivers paused for this hour; delineation still works.';

/** The Layers box's line for the DEM rivers while on, and whether it is the layer's failure (an alert). */
export function demRiversLine(s: DemRiversState): { text: string; kind: 'note' | 'error' } {
	if (s.noView) return { text: 'The DEM rivers are drawn on the map, which isn’t showing here.', kind: 'note' };
	// CHANNEL_VIEW_MAX_DEG (0.35°) is about 35 km north to south (and 30-odd km east to west here).
	if (s.zoomIn) return { text: 'Zoom in to about 35 km across to draw the DEM rivers.', kind: 'note' };
	if (s.paused) return { text: DEM_RIVERS_PAUSED, kind: 'note' };
	if (s.error) return { text: `The DEM rivers couldn’t be drawn: ${s.error}`, kind: 'error' };
	if (s.loading) return { text: 'Drawing the DEM rivers…', kind: 'note' };
	return { text: DEM_RIVERS_NOTE, kind: 'note' };
}

/**
 * The layers on unless the URL turns them off: the DEM rivers (where they are offered, demRiversOffered), so an editor
 * delineating sees the rivers a click goes to. Off is `-channels` in `layers=`; `channels` there (turned on by its toggle,
 * or a view saved or shared before the default) means on, as it always did.
 */
export const DEFAULT_LAYERS: ReadonlySet<MapLayer> = new Set<MapLayer>(['channels']);

/** The names `layers=` lists, as written (`-channels` included). */
const layerTokens = (params: ReadonlyURLSearchParams) => new Set((params.get('layers') ?? '').split(',').map((s) => s.trim()));

/** The layers on: those `layers=` names, and the default ones it doesn't turn off with `-<id>` (unknown names ignored). */
export function layersOn(params: ReadonlyURLSearchParams): Set<MapLayer> {
	const asked = layerTokens(params);
	return new Set(MAP_LAYERS.filter((l) => asked.has(l) || (DEFAULT_LAYERS.has(l) && !asked.has(`-${l}`))));
}

/**
 * Whether `layers=` names the layer itself: turned on by its toggle (or a view saved that way), not only on by default.
 * A default layer's status is said only then (MapLayers' live region), so a page that opens with it on says nothing of it.
 */
export const layerAsked = (params: ReadonlyURLSearchParams, layer: MapLayer) => layerTokens(params).has(layer);

/**
 * The URL's query with `layer` turned on or off, every other param kept; `layers` dropped when none is listed. A default
 * layer toggled is written either way (`channels` on, `-channels` off), so Back undoes the toggle; otherwise it keeps what
 * the URL said of it, nothing meaning the default.
 */
export function withLayer(search: string, layer: MapLayer, on: boolean): string {
	const q = new URLSearchParams(search);
	const asked = layerTokens(q);
	const now = layersOn(q);
	if (on) now.add(layer);
	else now.delete(layer);
	const list = MAP_LAYERS.flatMap((l) => {
		if (!DEFAULT_LAYERS.has(l)) return now.has(l) ? [l] : [];
		if (l === layer) return [on ? l : `-${l}`];
		return asked.has(l) ? [l] : asked.has(`-${l}`) ? [`-${l}`] : [];
	});
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
 * A map view (west, south, east, north) snapped outward to whole multiples of
 * `snap` degrees, so a small pan asks the same box again: null when no view
 * is known or the snapped view is wider than `maxDeg` a side (the server
 * refuses it: zoom in). The river network, the MAP grid and the DEM grid ask
 * for their view this way.
 */
export function snappedViewBbox(view: readonly [number, number, number, number] | null, snap: number, maxDeg: number): [number, number, number, number] | null {
	if (!view || !view.every(Number.isFinite)) return null;
	const r = (v: number) => Math.round(v * 1e4) / 1e4;
	const w = r(Math.max(-180, Math.floor(view[0] / snap) * snap));
	const s = r(Math.max(-90, Math.floor(view[1] / snap) * snap));
	const e = r(Math.min(180, Math.ceil(view[2] / snap) * snap));
	const n = r(Math.min(90, Math.ceil(view[3] / snap) * snap));
	if (e <= w || n <= s || e - w > maxDeg || n - s > maxDeg) return null;
	return [w, s, e, n];
}

/**
 * The bbox the river network is asked for when the project has no features
 * yet (docs/maps.md § River network): the map's view (west, south, east,
 * north), snapped outward to RIVER_VIEW_SNAP_DEG so a small pan asks the same
 * bbox again. Null when no view is known or the snapped view is wider than
 * RIVER_BBOX_MAX_DEG a side, which the server refuses: zoom in.
 */
export function riverViewBbox(view: readonly [number, number, number, number] | null): [number, number, number, number] | null {
	return snappedViewBbox(view, RIVER_VIEW_SNAP_DEG, RIVER_BBOX_MAX_DEG);
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

/**
 * Whether a project feature's outline was traced from JRC Global Surface
 * Water, whose terms (and Copernicus Delegated Regulation 1159/2013 Art. 8)
 * ask the map to name the source and say the data was modified. On the Map
 * tab its description says so (tracing writes the archive's "Source: EC
 * JRC/Google" into it, geo/routes.ts tracedMethod); the farm map gets no
 * properties, so the server flags it (`credit: 'jrc-water'`, farms/view.ts
 * farmMap). A trace from the synthetic raster names no source: no credit.
 */
export const jrcCreditedFeature = (f: Pick<MapFeature, 'properties'>) => {
	if (f.properties?.credit === 'jrc-water') return true;
	const d = f.properties?.description;
	return typeof d === 'string' && d.includes(JRC_WATER_STATEMENT);
};

/** A licensed source the map credits while its data is drawn; its id is also its section on the data sources page (`/data-sources#<id>`). */
export type MapCredit = 'hydrorivers' | 'jrc-water' | 'waas-map' | 'lynch-map' | 'atlas-apan' | 'atlas-span';

/** Each credit's line on the map's attribution control (English: the workspace's map; the farm map words its own, farmMap.ts). */
export const MAP_CREDIT_TEXT: Readonly<Record<MapCredit, string>> = {
	hydrorivers: HYDRORIVERS_MAP_ATTRIBUTION,
	'jrc-water': JRC_WATER_MAP_ATTRIBUTION,
	'waas-map': WAAS_MAP_MAP_ATTRIBUTION,
	'lynch-map': LYNCH_MAP_MAP_ATTRIBUTION,
	'atlas-apan': ATLAS_APAN_MAP_ATTRIBUTION,
	'atlas-span': ATLAS_SPAN_MAP_ATTRIBUTION
};

/**
 * The licence credits a map must show for what it draws, in a fixed order
 * (docs/maps.md § Sources): HydroRIVERS while the River network layer draws
 * its reaches (`riversDrawn`) or a river added from one is drawn, then JRC
 * Global Surface Water while a traced outline is, then the Southwestern Cape
 * MAP surface or the Lynch (2004) grid while the MAP grid layer draws points
 * of a grid stored with that surface's credit line (`mapGridAttribution`: the drawn grid's attribution, null while
 * the layer draws nothing), then the WRC Atlas's A-pan and S-pan grids while
 * the A-pan or S-pan grid layer draws points of a grid stored with that
 * credit line (`evaporationAttributions`: each drawn evaporation grid's
 * attribution). Empty when nothing drawn is licensed data. The basemap's and
 * the relief's credits are their own sources' and are not listed here.
 */
export function mapCredits(
	features: readonly Pick<MapFeature, 'kind' | 'properties'>[],
	riversDrawn = false,
	mapGridAttribution: string | null = null,
	evaporationAttributions: readonly (string | null)[] = []
): MapCredit[] {
	const out: MapCredit[] = [];
	if (riversDrawn || features.some(creditedFeature)) out.push('hydrorivers');
	if (features.some(jrcCreditedFeature)) out.push('jrc-water');
	if (mapGridAttribution === WAAS_MAP_STATEMENT) out.push('waas-map');
	if (mapGridAttribution === LYNCH_MAP_STATEMENT) out.push('lynch-map');
	if (evaporationAttributions.includes(ATLAS_APAN_STATEMENT)) out.push('atlas-apan');
	if (evaporationAttributions.includes(ATLAS_SPAN_STATEMENT)) out.push('atlas-span');
	return out;
}

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
	return snappedViewBbox(view, MAP_GRID_VIEW_SNAP_DEG, MAP_GRID_BBOX_MAX_DEG);
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

// ---------------------------------------------------------------------------
// The DEM grid (docs/maps.md § DEM grid)
// ---------------------------------------------------------------------------

/** The widest view the DEM grid is asked for (the server's DEM_GRID_BBOX_MAX_DEG). */
export const DEM_GRID_BBOX_MAX_DEG = 0.5;
/** The grid a view is snapped out to before the DEM grid is asked for it. */
export const DEM_GRID_VIEW_SNAP_DEG = 0.01;

/** The bbox the DEM grid is asked for: the view snapped out to 0.01°, null past 0.5° a side (zoom in) or with no view. */
export function demGridViewBbox(view: readonly [number, number, number, number] | null): [number, number, number, number] | null {
	return snappedViewBbox(view, DEM_GRID_VIEW_SNAP_DEG, DEM_GRID_BBOX_MAX_DEG);
}
