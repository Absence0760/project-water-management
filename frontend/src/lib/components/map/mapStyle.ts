// The catchment map's style (issue #288, WP-3.12; docs/maps.md § Basemap):
// the basemap and the overlay layers, as plain style objects. Pure (no
// MapLibre import), so vitest checks them (mapStyle.test.ts).
//
// The basemap is the Protomaps vector schema, read from one PMTiles file over
// HTTP Range (PUBLIC_TILES_URL: MinIO locally, S3 behind CloudFront in
// production, same-origin there). No tile CDN, no third-party script, no
// fonts or sprites: the basemap draws land, water, land use, roads and
// boundaries without labels, so no glyphs are fetched. With no tiles URL (a
// fresh clone, CI) the map is a plain background with the features drawn.
import type { MapFeature } from '$lib/api/types';

/** Shown on the map whenever the basemap is (the Protomaps / OSM licence). */
export const BASEMAP_ATTRIBUTION = '© Protomaps © OpenStreetMap contributors';

const LIGHT = { bg: '#eef0ea', earth: '#e4e7df', water: '#a9cfe0', green: '#d3e3c6', road: '#ffffff', roadCase: '#c9cdc4', border: '#9a9f97' };
const DARK = { bg: '#161917', earth: '#1d211e', water: '#20394a', green: '#22301f', road: '#3a3f3b', roadCase: '#2a2e2b', border: '#5d625e' };

// Loose types: the style spec's own types live in maplibre-gl, which this module must not import.
type Layer = Record<string, unknown> & { id: string; type: string };
export interface Style {
	version: 8;
	sources: Record<string, Record<string, unknown>>;
	layers: Layer[];
}

/** The basemap: a background, and the Protomaps layers when there is a tiles URL. */
export function basemapStyle(tilesUrl: string | null, dark: boolean): Style {
	const c = dark ? DARK : LIGHT;
	const layers: Layer[] = [{ id: 'background', type: 'background', paint: { 'background-color': c.bg } }];
	if (!tilesUrl) return { version: 8, sources: {}, layers };
	const src = { source: 'basemap' };
	layers.push(
		{ id: 'bm-earth', type: 'fill', ...src, 'source-layer': 'earth', paint: { 'fill-color': c.earth } },
		{ id: 'bm-landcover', type: 'fill', ...src, 'source-layer': 'landcover', filter: ['in', ['get', 'kind'], ['literal', ['forest', 'grassland', 'scrub', 'farmland']]], paint: { 'fill-color': c.green, 'fill-opacity': 0.6 } },
		{ id: 'bm-landuse', type: 'fill', ...src, 'source-layer': 'landuse', filter: ['in', ['get', 'kind'], ['literal', ['park', 'nature_reserve', 'farmland', 'orchard', 'vineyard']]], paint: { 'fill-color': c.green, 'fill-opacity': 0.5 } },
		{ id: 'bm-water', type: 'fill', ...src, 'source-layer': 'water', paint: { 'fill-color': c.water } },
		{ id: 'bm-boundaries', type: 'line', ...src, 'source-layer': 'boundaries', paint: { 'line-color': c.border, 'line-width': 1, 'line-dasharray': [3, 2] } },
		{ id: 'bm-roads-case', type: 'line', ...src, 'source-layer': 'roads', minzoom: 9, paint: { 'line-color': c.roadCase, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 14, 6] } },
		{ id: 'bm-roads', type: 'line', ...src, 'source-layer': 'roads', paint: { 'line-color': c.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 14, 4] } }
	);
	return {
		version: 8,
		sources: { basemap: { type: 'vector', url: `pmtiles://${tilesUrl}`, attribution: BASEMAP_ATTRIBUTION } },
		layers
	};
}

/** The basemap layers' ids, to drop when the tiles can't be read. */
export const basemapLayerIds = (style: Style) => style.layers.filter((l) => l.id.startsWith('bm-')).map((l) => l.id);

/**
 * The overlay's colours: dark strokes with a light casing (or the reverse in
 * dark mode), at least 3:1 against both the basemap and the background, and
 * told apart by line style and shape as well as colour (WCAG 1.4.1, 1.4.11).
 */
export function overlayColours(dark: boolean) {
	return dark
		? { boundary: '#f2c14e', parcel: '#7fd5e8', water: '#8ec7ff', other: '#e0e0e0', casing: '#000000', selected: '#ff8fd0' }
		: { boundary: '#7a3e00', parcel: '#0b5a73', water: '#0b4fa0', other: '#3a3d3a', casing: '#ffffff', selected: '#b0006e' };
}

/** The overlay layers over the `features` GeoJSON source (polygons and lines; points are DOM markers). */
export function overlayLayers(dark: boolean): Layer[] {
	const c = overlayColours(dark);
	const kind = (k: string) => ['==', ['get', 'kind'], k];
	const polygon = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
	const line = ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]];
	const selected = ['==', ['get', 'selected'], true];
	const src = { source: 'features' };
	return [
		{ id: 'ov-parcel-fill', type: 'fill', ...src, filter: ['all', polygon, ['!', kind('catchment_boundary')]], paint: { 'fill-color': ['match', ['get', 'kind'], 'dam', c.water, 'other', c.other, c.parcel], 'fill-opacity': 0.18 } },
		{ id: 'ov-casing', type: 'line', ...src, filter: ['any', polygon, line], paint: { 'line-color': c.casing, 'line-width': ['case', selected, 7, ['==', ['get', 'kind'], 'catchment_boundary'], 6, 4], 'line-opacity': 0.85 } },
		// The boundary: a long dash, thickest; parcels solid; other features dotted; rivers solid blue.
		{ id: 'ov-boundary', type: 'line', ...src, filter: ['all', polygon, kind('catchment_boundary')], paint: { 'line-color': c.boundary, 'line-width': 3, 'line-dasharray': [4, 2] } },
		{ id: 'ov-parcel-line', type: 'line', ...src, filter: ['all', polygon, ['!', kind('catchment_boundary')], ['!', kind('other')]], paint: { 'line-color': ['match', ['get', 'kind'], 'dam', c.water, c.parcel], 'line-width': 2 } },
		{ id: 'ov-other-line', type: 'line', ...src, filter: ['all', ['any', polygon, line], kind('other')], paint: { 'line-color': c.other, 'line-width': 2, 'line-dasharray': [1, 1.5] } },
		{ id: 'ov-river', type: 'line', ...src, filter: ['all', line, kind('river')], paint: { 'line-color': c.water, 'line-width': 2.5 } },
		{ id: 'ov-selected', type: 'line', ...src, filter: ['all', ['any', polygon, line], selected], paint: { 'line-color': c.selected, 'line-width': 3 } }
	];
}

/** The `features` source's data: polygons and lines (points are drawn as markers), each with its id, kind, name and whether it is selected. */
export function overlayData(features: readonly MapFeature[], selectedId: string | null) {
	return {
		type: 'FeatureCollection' as const,
		features: features
			.filter((f) => f.geometry.type !== 'Point')
			.map((f) => ({ type: 'Feature' as const, properties: { id: f.id, kind: f.kind, name: f.name, selected: f.id === selectedId }, geometry: f.geometry }))
	};
}
