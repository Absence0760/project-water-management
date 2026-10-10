// The catchment map's style (issue #288, WP-3.12; docs/maps.md § Basemap):
// the basemap and the overlay layers, as plain style objects. Pure (no
// MapLibre import), so vitest checks them (mapStyle.test.ts).
//
// The basemap is the Protomaps vector schema, read from one PMTiles file over
// HTTP Range (PUBLIC_TILES_URL: MinIO locally, S3 behind CloudFront in
// production, same-origin there). No tile CDN, no third-party script, no
// sprites. Place and water names (#326 A6) need glyphs: PBF glyph ranges of
// Noto Sans (OFL 1.1), self-hosted beside the tiles (PUBLIC_TILES_GLYPHS_URL:
// MinIO locally, /tiles/fonts/… in production). With no glyphs URL the
// basemap draws no labels and fetches no glyphs, as before. With no tiles
// URL (a fresh clone, CI) the map is a plain background with the features
// drawn. The quaternary outlines (#326 A6) are a layer of their own over the
// basemap, under the features, empty until the tab's toggle fills them; the
// river network (#345) is another, over them and under the features. The
// relief (shaded from a DEM, PUBLIC_TERRAIN_URL: Terrarium tiles in one more
// PMTiles file) sits over the land and under the water, only while the tab's
// Relief layer is on.
import type { MapFeature, MapGeometry, MapPosition } from '$lib/api/types';
import type { ProposalPiece } from './pieces';

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
	/** The glyph ranges' URL template ({fontstack}, {range}), only when labels are drawn. */
	glyphs?: string;
}

/** The fonts the labels use: the Protomaps basemaps-assets set (Noto Sans, OFL 1.1), self-hosted (bin/tiles-dev.sh fetch). */
export const LABEL_FONTS = { regular: 'Noto Sans Regular', medium: 'Noto Sans Medium', italic: 'Noto Sans Italic' } as const;

/**
 * The label colours (#326 A6): each text on a halo of the opposite lightness,
 * at least 4.5:1 against its halo and against every basemap colour it can sit
 * on (mapStyle.test.ts), so a name reads on land, water and land cover in
 * both themes. Water names are a darker (dark mode: lighter) blue, italic.
 */
export function labelColours(dark: boolean) {
	return dark
		? { text: '#eef0ec', water: '#b9dcf5', halo: '#0b0d0c', quaternary: '#e2cfff' }
		: { text: '#1f2320', water: '#073a57', halo: '#ffffff', quaternary: '#4a2373' };
}

/**
 * A glyphs URL as MapLibre needs it: absolute. A same-origin path
 * (`/tiles/fonts/{fontstack}/{range}.pbf`, production) is put on `origin`
 * by hand: `new URL` would percent-encode the braces. Empty → null (no labels).
 */
export function glyphsUrl(raw: string | null | undefined, origin: string): string | null {
	const v = raw?.trim();
	if (!v) return null;
	return v.startsWith('/') ? `${origin.replace(/\/$/, '')}${v}` : v;
}

const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name']];

/** The basemap's place and water names, over everything (they need the tiles and the glyphs). */
export function labelLayers(dark: boolean): Layer[] {
	const c = labelColours(dark);
	const src = { source: 'basemap' };
	const halo = { 'text-halo-color': c.halo, 'text-halo-width': 1.5, 'text-halo-blur': 0.25 };
	const kindIn = (kinds: string[]) => ['in', ['get', 'kind'], ['literal', kinds]];
	return [
		{
			id: 'bm-label-waterway',
			type: 'symbol',
			...src,
			'source-layer': 'water',
			minzoom: 11,
			filter: ['all', ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]], kindIn(['river', 'stream', 'canal']), ['has', 'name']],
			layout: { 'symbol-placement': 'line', 'text-field': NAME, 'text-font': [LABEL_FONTS.italic], 'text-size': 12, 'text-letter-spacing': 0.1 },
			paint: { 'text-color': c.water, ...halo }
		},
		{
			id: 'bm-label-water',
			type: 'symbol',
			...src,
			'source-layer': 'water',
			filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'name']],
			layout: { 'text-field': NAME, 'text-font': [LABEL_FONTS.italic], 'text-size': 12, 'text-max-width': 9 },
			paint: { 'text-color': c.water, ...halo }
		},
		{
			id: 'bm-label-places',
			type: 'symbol',
			...src,
			'source-layer': 'places',
			filter: ['all', kindIn(['locality', 'region', 'neighbourhood']), ['has', 'name']],
			layout: {
				'text-field': NAME,
				// Towns that show from far out (min_zoom ≤ 6) in the medium weight; the rest regular.
				'text-font': ['case', ['<=', ['coalesce', ['get', 'min_zoom'], 99], 6], ['literal', [LABEL_FONTS.medium]], ['literal', [LABEL_FONTS.regular]]],
				'text-size': ['interpolate', ['linear'], ['zoom'], 5, 11, 12, 14],
				'text-max-width': 8,
				'symbol-sort-key': ['coalesce', ['get', 'sort_key'], ['get', 'min_zoom'], 99]
			},
			paint: { 'text-color': c.text, ...halo }
		}
	];
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

/**
 * A string escaped for the attribution control, which MapLibre sets as
 * innerHTML: the one place the app's text becomes markup (docs/security.md §
 * Input handling). Every value put into an attribution's HTML goes through it.
 */
export const escapeAttribution = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Shown on the map whenever the relief is: the notice the Copernicus DEM
 * licence asks for on adapted data (Art. 6(b)), and the tiles' compiler.
 */
export const TERRAIN_ATTRIBUTION =
	'Relief: <a href="https://mapterhorn.com/attribution">© Mapterhorn</a>, produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved';

/** The relief's source id and layer id (#326: shaded relief from a DEM, docs/maps.md § Relief). */
export const TERRAIN_SOURCE = 'terrain';
export const RELIEF_LAYER = 'tr-hillshade';

/**
 * The relief's source: one PMTiles file of Terrarium-encoded 512 px elevation
 * tiles (the Mapterhorn build, Copernicus GLO-30 over South Africa), read over
 * HTTP Range like the basemap. MapLibre overzooms past the file's maxzoom.
 */
export const terrainSource = (url: string, dataSourcesHref?: string) => ({
	type: 'raster-dem',
	url: `pmtiles://${url}`,
	encoding: 'terrarium',
	tileSize: 512,
	attribution: dataSourcesHref ? `${TERRAIN_ATTRIBUTION} (<a href="${escapeAttribution(dataSourcesHref)}#copernicus-dem">licence notice</a>)` : TERRAIN_ATTRIBUTION
});

/**
 * The shaded relief: soft, translucent shadows and highlights, so the land
 * and land-cover colours still read through it and the overlay's strokes,
 * on their casings, keep their contrast (mapStyle.test.ts).
 */
export function reliefLayer(dark: boolean): Layer {
	return {
		id: RELIEF_LAYER,
		type: 'hillshade',
		source: TERRAIN_SOURCE,
		paint: dark
			? { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': 'rgba(0, 0, 0, 0.55)', 'hillshade-highlight-color': 'rgba(255, 255, 255, 0.10)', 'hillshade-accent-color': 'rgba(0, 0, 0, 0.25)' }
			: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': 'rgba(40, 46, 38, 0.45)', 'hillshade-highlight-color': 'rgba(255, 255, 255, 0.35)', 'hillshade-accent-color': 'rgba(40, 46, 38, 0.2)' }
	};
}

/**
 * Where the relief goes in a style's layer order: over the land and land
 * cover, under the water, roads and everything after them (the basemap's
 * water, else the first layer that isn't land: the quaternaries and features
 * with no basemap). Undefined: on top (an empty style).
 */
export function reliefBeforeId(layerIds: readonly string[]): string | undefined {
	return layerIds.find((id) => id === 'bm-water') ?? layerIds.find((id) => !['background', 'bm-earth', 'bm-landcover', 'bm-landuse'].includes(id));
}

/** The basemap layers' ids, to drop when the tiles can't be read. */
export const basemapLayerIds = (style: Style) => style.layers.filter((l) => l.id.startsWith('bm-')).map((l) => l.id);

/** The basemap's own colours (its land, background, water and land cover), for the overlay's contrast checks. */
export const basemapColours = (dark: boolean) => ({ ...(dark ? DARK : LIGHT) });

/** `#rrggbb` at an opacity, as CSS `rgba()` (MapLibre reads it too), so the map's fills and the key's swatches are one value. */
export function withAlpha(hex: string, alpha: number): string {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The overlay's colours (#326 E7): dark strokes with a light casing (or the
 * reverse in dark mode), at least 3:1 against the basemap and its
 * background, and told apart by line style and shape as well as colour
 * (WCAG 1.4.1, 1.4.11). Farm parcels are green (the app's --success), a hue
 * well away from the water blue that rivers, dams and gauges share, so a
 * parcel never reads as a dam or a river (mapStyle.test.ts checks the
 * difference). The `*Fill` entries are the area fills, translucent so the
 * basemap shows through; a dam's is the water blue, denser than a parcel's,
 * so a dam drawn as a polygon reads as water. The map's key reads its
 * swatches from here (MapTab.svelte), so key and map can't drift.
 */
export function overlayColours(dark: boolean) {
	const c = dark
		? { boundary: '#f2c14e', parcel: '#6cc58a', water: '#5fa8ff', other: '#e0e0e0', casing: '#000000', selected: '#ff8fd0' }
		: { boundary: '#7a3e00', parcel: '#1f6f3a', water: '#0047b3', other: '#3a3d3a', casing: '#ffffff', selected: '#b0006e' };
	return { ...c, parcelFill: withAlpha(c.parcel, 0.18), damFill: withAlpha(c.water, 0.45), otherFill: withAlpha(c.other, 0.18) };
}

/** How opaque a results colour (`fills`, A1) is drawn over a parcel: strong enough to read, the basemap still faintly there. */
export const RESULT_FILL_OPACITY = 0.75;

/** The fill colour of a polygon: its results colour when it has one (`fill`, from overlayData), else its kind's. */
export function fillColour(c: ReturnType<typeof overlayColours>): unknown[] {
	// to-color takes the first argument that parses, so a missing or unparseable `fill` falls back to the kind's colour.
	return ['to-color', ['get', 'fill'], ['match', ['get', 'kind'], 'dam', c.damFill, 'other', c.otherFill, c.parcelFill]];
}

/**
 * The area fills' opacity at `scale` (0–1, the Layers box's Area fill
 * slider): a results colour at RESULT_FILL_OPACITY, a kind's tint (already
 * translucent) at full, both × scale, so 0 leaves only the outlines and the
 * basemap, relief and rivers read through. Outlines and the selection keep
 * their strength whatever the scale.
 */
export function fillOpacity(scale = 1): unknown[] {
	const k = Math.min(1, Math.max(0, Number.isFinite(scale) ? scale : 1));
	return ['case', ['has', 'fill'], RESULT_FILL_OPACITY * k, k];
}

/** The layer the Area fill slider drives (CatchmentMap sets its fill-opacity in place, no restyle). */
export const AREA_FILL_LAYER = 'ov-parcel-fill';

/** The overlay layers over the `features` GeoJSON source (polygons and lines; points are DOM markers). */
export function overlayLayers(dark: boolean, fillScale = 1): Layer[] {
	const c = overlayColours(dark);
	const kind = (k: string) => ['==', ['get', 'kind'], k];
	const polygon = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
	const line = ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]];
	const selected = ['==', ['get', 'selected'], true];
	const src = { source: 'features' };
	return [
		{ id: AREA_FILL_LAYER, type: 'fill', ...src, filter: ['all', polygon, ['!', kind('catchment_boundary')]], paint: { 'fill-color': fillColour(c), 'fill-opacity': fillOpacity(fillScale) } },
		{ id: 'ov-casing', type: 'line', ...src, filter: ['any', polygon, line], paint: { 'line-color': c.casing, 'line-width': ['case', selected, 7, ['==', ['get', 'kind'], 'catchment_boundary'], 6, ['==', ['get', 'kind'], 'river'], 6, 4], 'line-opacity': 0.85 } },
		// The boundary: a long dash, thickest; parcels solid green; dams solid blue; other features dotted; rivers thicker solid blue.
		{ id: 'ov-boundary', type: 'line', ...src, filter: ['all', polygon, kind('catchment_boundary')], paint: { 'line-color': c.boundary, 'line-width': 3, 'line-dasharray': [4, 2] } },
		{ id: 'ov-parcel-line', type: 'line', ...src, filter: ['all', polygon, ['!', kind('catchment_boundary')], ['!', kind('other')]], paint: { 'line-color': ['match', ['get', 'kind'], 'dam', c.water, c.parcel], 'line-width': 2 } },
		{ id: 'ov-other-line', type: 'line', ...src, filter: ['all', ['any', polygon, line], kind('other')], paint: { 'line-color': c.other, 'line-width': 2, 'line-dasharray': [1, 1.5] } },
		{ id: 'ov-river', type: 'line', ...src, filter: ['all', line, kind('river')], paint: { 'line-color': c.water, 'line-width': 3.5 } },
		{ id: 'ov-selected', type: 'line', ...src, filter: ['all', ['any', polygon, line], selected], paint: { 'line-color': c.selected, 'line-width': 3 } }
	];
}

/** The quaternary outlines' colour (#326 A6): a purple well apart from every overlay stroke, at least 3:1 on the basemap. */
export const quaternaryColour = (dark: boolean) => (dark ? '#cf6bff' : '#8f10e0');

/** An outline the quaternary layer draws: its code and polygon (GET …/map/quaternaries). */
export interface QuaternaryOutline {
	code: string;
	geometry: MapGeometry;
}

/** The `quaternaries` source's data: each outline with its code, and whether it is the one picked. */
export function quaternaryData(outlines: readonly QuaternaryOutline[] | null | undefined, picked: string | null = null) {
	return {
		type: 'FeatureCollection' as const,
		features: (outlines ?? []).map((q) => ({ type: 'Feature' as const, properties: { code: q.code, picked: q.code === picked }, geometry: q.geometry }))
	};
}

/** The layer a click on a quaternary hits (an invisible fill: the outline alone is too thin to aim at). */
export const QUATERNARY_HIT_LAYER = 'qt-fill';

/** The quaternary outlines: dashed, thin, under the features; their codes as labels only when there are glyphs. */
export function quaternaryLayers(dark: boolean, labels: boolean): { under: Layer[]; labels: Layer[] } {
	const colour = quaternaryColour(dark);
	const src = { source: 'quaternaries' };
	const picked = ['==', ['get', 'picked'], true];
	return {
		under: [
			// Opacity 0.01, not 0: an invisible fill still answers queryRenderedFeatures, so a click inside picks the quaternary.
			{ id: QUATERNARY_HIT_LAYER, type: 'fill', ...src, paint: { 'fill-color': colour, 'fill-opacity': ['case', picked, 0.12, 0.01] } },
			{ id: 'qt-line', type: 'line', ...src, paint: { 'line-color': colour, 'line-width': ['case', picked, 3, 1.75], 'line-dasharray': [5, 2.5] } }
		],
		labels: labels
			? [
					{
						id: 'qt-label',
						type: 'symbol',
						...src,
						layout: { 'text-field': ['get', 'code'], 'text-font': [LABEL_FONTS.medium], 'text-size': 13, 'text-letter-spacing': 0.05 },
						paint: { 'text-color': labelColours(dark).quaternary, 'text-halo-color': labelColours(dark).halo, 'text-halo-width': 1.5 }
					}
				]
			: []
	};
}

/** A delineated catchment waiting for the editor's decision (#326 B-delineate): a teal apart from every overlay stroke and the quaternaries' purple. */
export const proposalColour = (dark: boolean) => (dark ? '#3fe0d0' : '#006d77');

/**
 * The tints a start or divide proposal's pieces take (#326 C3's follow-up,
 * pieces.ts pieceTintsFor: neighbours never share one). Chosen away from the
 * hues the map already gives a meaning (parcel green, water blue, the
 * boundary's amber, the proposal's teal: ΔE ≥ 25 from each in both themes)
 * and apart from each other (ΔE ≥ 20, mapStyle.test.ts): vermillion, pink,
 * yellow, grey, lavender, brown. Translucent fills under the proposal's teal
 * dash, so they never carry meaning alone: every piece has its number on it,
 * and the sheet's card the same number and swatch. The same in both themes
 * (a translucent fill reads on either ground); `dark` for the map's pattern.
 */
export const pieceTints = (dark = false): readonly string[] => {
	void dark;
	return ['#d55e00', '#cc79a7', '#e6f04a', '#9e9e9e', '#b39ddb', '#8d6e63'];
};
/** How opaque a piece's tint is drawn, and the lit one's (its card has the focus or the pointer). */
export const PIECE_FILL_OPACITY = 0.22;
export const PIECE_LIT_OPACITY = 0.45;
/** The layer the pointer finds a piece on (hover lights its card's, a click opens it). */
export const PIECE_HIT_LAYER = 'pr-piece-fill';

/**
 * The `proposal` source's data: the proposed polygon and its snapped outlet,
 * or, for a start or divide proposal (`pieces`), each piece on its own with
 * its key, tint and whether it is the one lit; or nothing.
 */
export function proposalData(
	p: { geometry: MapGeometry; outlet: MapPosition; outlets?: readonly MapPosition[]; pieces?: readonly ProposalPiece[]; highlight?: string | null } | null | undefined
) {
	if (!p) return { type: 'FeatureCollection' as const, features: [] };
	const outlet = { type: 'Feature' as const, properties: { part: 'outlet' } as Record<string, unknown>, geometry: { type: 'Point' as const, coordinates: p.outlet } as MapGeometry };
	// Sub-catchments from clicks: every other click is an outlet too, marked the same way.
	const more = (p.outlets ?? []).map((at) => ({ ...outlet, geometry: { type: 'Point' as const, coordinates: at } as MapGeometry }));
	if (!p.pieces) return { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: { part: 'area' } as Record<string, unknown>, geometry: p.geometry }, outlet] };
	return {
		type: 'FeatureCollection' as const,
		features: [
			...p.pieces.flatMap((x) =>
				x.geometry ? [{ type: 'Feature' as const, properties: { part: 'piece', key: x.key, name: x.name, tint: x.tint, lit: x.key === p.highlight } as Record<string, unknown>, geometry: x.geometry as MapGeometry }] : []
			),
			outlet,
			...more
		]
	};
}

/**
 * The proposal: a faint fill, a casing and a short dash (never the boundary's
 * long one), the outlet a ringed dot. Over the features: it is what the editor
 * is deciding on. A start or divide proposal's pieces each take a tint (the
 * rest of the catchment the proposal's own teal) under the same dash, so the
 * edges between them show; the lit piece is outlined again, solid, in the
 * map's selection colour on its casing.
 */
export function proposalLayers(dark: boolean): Layer[] {
	const colour = proposalColour(dark);
	const c = overlayColours(dark);
	const casing = c.casing;
	const src = { source: 'proposal' };
	const area = ['==', ['get', 'part'], 'area'];
	const piece = ['==', ['get', 'part'], 'piece'];
	const shape = ['any', area, piece];
	const lit = ['all', piece, ['==', ['get', 'lit'], true]];
	const tints = pieceTints(dark);
	return [
		{ id: 'pr-fill', type: 'fill', ...src, filter: area, paint: { 'fill-color': colour, 'fill-opacity': 0.12 } },
		{
			id: PIECE_HIT_LAYER,
			type: 'fill',
			...src,
			filter: piece,
			paint: {
				'fill-color': ['match', ['get', 'tint'], ...tints.flatMap((t, i) => [i, t]), colour],
				'fill-opacity': ['case', ['==', ['get', 'lit'], true], PIECE_LIT_OPACITY, PIECE_FILL_OPACITY]
			}
		},
		{ id: 'pr-casing', type: 'line', ...src, filter: shape, paint: { 'line-color': casing, 'line-width': 6, 'line-opacity': 0.85 } },
		{ id: 'pr-line', type: 'line', ...src, filter: shape, paint: { 'line-color': colour, 'line-width': 3, 'line-dasharray': [1.5, 1.5] } },
		{ id: 'pr-lit-casing', type: 'line', ...src, filter: lit, paint: { 'line-color': casing, 'line-width': 8, 'line-opacity': 0.9 } },
		{ id: 'pr-lit', type: 'line', ...src, filter: lit, paint: { 'line-color': c.selected, 'line-width': 4 } },
		{
			id: 'pr-outlet',
			type: 'circle',
			...src,
			filter: ['==', ['get', 'part'], 'outlet'],
			paint: { 'circle-radius': 6, 'circle-color': colour, 'circle-stroke-color': casing, 'circle-stroke-width': 2 }
		}
	];
}

/**
 * The river network's colour (issue #345): a cyan-blue, so it reads as water
 * beside the project's own rivers (the overlay's water blue) yet stays apart
 * from them, and dashed and thinner, so colour is never the only difference;
 * at least 3:1 on the basemap, and well apart from every other stroke.
 */
export const riverNetworkColour = (dark: boolean) => (dark ? '#3ec1f0' : '#006b9e');

/** A reach the River network layer draws (GET …/map/rivers): its key, Strahler order and line. */
export interface NetworkReach {
	key: string;
	strahler: number | null;
	geometry: MapGeometry;
}

/** The `rivers` source's data: each reach with its key, order (1 when not given) and whether it is the one picked. */
export function riverNetworkData(reaches: readonly NetworkReach[] | null | undefined, picked: string | null = null) {
	return {
		type: 'FeatureCollection' as const,
		features: (reaches ?? []).map((r) => ({ type: 'Feature' as const, properties: { key: r.key, order: r.strahler ?? 1, picked: r.key === picked }, geometry: r.geometry }))
	};
}

/** The layer a click on a reach hits (a wide, invisible line: the dashed one is too thin to aim at). */
export const RIVER_NETWORK_HIT_LAYER = 'rn-hit';

/**
 * The river network: dashed, wider for a higher order; over the quaternaries,
 * under the features. The picked reach is drawn again on top of the others,
 * solid in the map's selection colour on a casing, so it stands out even
 * among bigger rivers.
 */
export function riverNetworkLayers(dark: boolean): Layer[] {
	const src = { source: 'rivers' };
	const picked = ['==', ['get', 'picked'], true];
	const c = overlayColours(dark);
	return [
		{ id: RIVER_NETWORK_HIT_LAYER, type: 'line', ...src, paint: { 'line-color': riverNetworkColour(dark), 'line-width': 12, 'line-opacity': 0.01 } },
		{
			id: 'rn-line',
			type: 'line',
			...src,
			layout: { 'line-cap': 'round' },
			paint: {
				'line-color': riverNetworkColour(dark),
				'line-width': ['interpolate', ['linear'], ['get', 'order'], 1, 1.25, 6, 3],
				'line-dasharray': [3, 1.5]
			}
		},
		{ id: 'rn-picked-casing', type: 'line', ...src, filter: picked, layout: { 'line-cap': 'round' }, paint: { 'line-color': c.casing, 'line-width': 7, 'line-opacity': 0.85 } },
		{ id: 'rn-picked', type: 'line', ...src, filter: picked, layout: { 'line-cap': 'round' }, paint: { 'line-color': c.selected, 'line-width': 3.5 } }
	];
}

/**
 * The elevation model's own channels (issue #374): drawn while Delineate or
 * Sub-catchments is on, where a click goes. Red, solid and wider for a
 * larger area, so it is never mistaken for a river line (the network's
 * dashed cyan-blue, the project's own water blue); at least 3:1 on the
 * basemap and well apart from every other stroke.
 */
export const channelColour = (dark: boolean) => (dark ? '#ff6b57' : '#c8102e');

/** A channel line (GET …/map/channels): its line and the upstream area at its lower end (km²). */
export interface ChannelLineData {
	coordinates: MapPosition[];
	km2: number;
}

/** How opaque the channels are while the editor clicks, and while a delineated proposal is reviewed over them (dimmed: the outline reads first, the channels it follows still show). */
export const CHANNEL_OPACITY = { on: 0.9, dim: 0.5 } as const;

/** The `channels` source's data; `dim` while a delineated proposal is reviewed over them. */
export function channelData(lines: readonly ChannelLineData[] | null | undefined, dim = false) {
	return {
		type: 'FeatureCollection' as const,
		features: (lines ?? []).map((l) => ({ type: 'Feature' as const, properties: { km2: l.km2, dim }, geometry: { type: 'LineString' as const, coordinates: l.coordinates } as MapGeometry }))
	};
}

/** The channels: solid, 1 px at 1 km² up to 3.5 px at 10 000 km², dimmed behind a proposal; over the river network, under the features. */
export function channelLayers(dark: boolean): Layer[] {
	return [
		{
			id: 'dem-channels',
			type: 'line',
			source: 'channels',
			layout: { 'line-cap': 'round', 'line-join': 'round' },
			paint: { 'line-color': channelColour(dark), 'line-width': ['interpolate', ['linear'], ['log10', ['max', 1, ['get', 'km2']]], 0, 1, 2, 2, 4, 3.5], 'line-opacity': ['case', ['==', ['get', 'dim'], true], CHANNEL_OPACITY.dim, CHANNEL_OPACITY.on] }
		}
	];
}

// ---------------------------------------------------------------------------
// Hydrological units, the MAP grid and the CHIRPS grid (docs/maps.md §
// Hydrological units layer, § MAP grid, § CHIRPS grid): each its own source,
// empty while its layer is off, so a toggle is a setData, never a restyle.
// Their text needs glyphs, like every label; without them the points and
// lines are drawn and the Layers box lists what the labels would say.
// ---------------------------------------------------------------------------

/** A unit's label as the units source takes it (mapLayers.ts unitLabels). */
export interface UnitLabelData {
	featureId: string;
	label: string;
	at: [number, number];
}

/** The `units` source's data: each labelled unit's point (its outline comes from the features it labels). */
export function unitsData(labels: readonly UnitLabelData[] | null | undefined, features: readonly MapFeature[] = []) {
	const ids = new Set((labels ?? []).map((l) => l.featureId));
	return {
		type: 'FeatureCollection' as const,
		features: [
			...features.filter((f) => ids.has(f.id)).map((f) => ({ type: 'Feature' as const, properties: { role: 'outline' }, geometry: f.geometry })),
			...(labels ?? []).map((l) => ({ type: 'Feature' as const, properties: { role: 'label', label: l.label }, geometry: { type: 'Point' as const, coordinates: l.at } }))
		]
	};
}

/** The units layer: each unit's outline drawn heavier over the features, and its name at its middle. */
export function unitsLayers(dark: boolean, labels: boolean): { over: Layer[]; labels: Layer[] } {
	const c = overlayColours(dark);
	const t = labelColours(dark);
	const src = { source: 'units' };
	return {
		over: [
			{ id: 'units-casing', type: 'line', ...src, filter: ['==', ['get', 'role'], 'outline'], paint: { 'line-color': c.casing, 'line-width': 6, 'line-opacity': 0.85 } },
			{ id: 'units-line', type: 'line', ...src, filter: ['==', ['get', 'role'], 'outline'], paint: { 'line-color': c.parcel, 'line-width': 3 } }
		],
		labels: labels
			? [
					{
						id: 'units-label',
						type: 'symbol',
						...src,
						filter: ['==', ['get', 'role'], 'label'],
						layout: { 'text-field': ['get', 'label'], 'text-font': [LABEL_FONTS.medium], 'text-size': 13, 'text-max-width': 8 },
						paint: { 'text-color': t.text, 'text-halo-color': t.halo, 'text-halo-width': 2 }
					}
				]
			: []
	};
}

/** A MAP grid point as the map takes it. */
export interface MapGridPointData {
	lon: number;
	lat: number;
	mapMm: number;
}

/** The `mapgrid` source's data: each point with its MAP and its label ("812 mm"). */
export function mapGridData(points: readonly MapGridPointData[] | null | undefined) {
	return {
		type: 'FeatureCollection' as const,
		features: (points ?? []).map((p) => ({
			type: 'Feature' as const,
			properties: { mm: p.mapMm, label: `${Math.round(p.mapMm)} mm` },
			geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] }
		}))
	};
}

/**
 * The MAP ramp: a light-to-dark blue by mm/yr, the same in both themes (each
 * point has a casing of the opposite lightness, so the pale end reads on a
 * light basemap and the dark end on a dark one). Its stops are the key's.
 */
export const MAP_RAMP: readonly (readonly [number, string])[] = [
	[200, '#c6dbef'],
	[500, '#6baed6'],
	[800, '#2171b5'],
	[1200, '#08519c'],
	[2000, '#08306b']
];

/** The MAP grid layer: a dot per point, coloured by MAP, and its value beside it (labels thin themselves where they would overlap). */
export function mapGridLayers(dark: boolean, labels: boolean): { over: Layer[]; labels: Layer[] } {
	const t = labelColours(dark);
	const src = { source: 'mapgrid' };
	return {
		over: [
			{
				id: 'mapgrid-point',
				type: 'circle',
				...src,
				paint: {
					'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 14, 5],
					'circle-color': ['interpolate', ['linear'], ['get', 'mm'], ...MAP_RAMP.flat()],
					'circle-stroke-color': t.halo,
					'circle-stroke-width': 1
				}
			}
		],
		labels: labels
			? [
					{
						id: 'mapgrid-label',
						type: 'symbol',
						...src,
						layout: { 'text-field': ['get', 'label'], 'text-font': [LABEL_FONTS.regular], 'text-size': 11, 'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-padding': 2 },
						paint: { 'text-color': t.text, 'text-halo-color': t.halo, 'text-halo-width': 1.5 }
					}
				]
			: []
	};
}

/** A DEM grid point as the map takes it. */
export interface DemGridPointData {
	lon: number;
	lat: number;
	elevationM: number;
}

/** The `demgrid` source's data: each sampled DEM cell with its elevation and label ("812 m"). */
export function demGridData(points: readonly DemGridPointData[] | null | undefined) {
	return {
		type: 'FeatureCollection' as const,
		features: (points ?? []).map((p) => ({
			type: 'Feature' as const,
			properties: { m: p.elevationM, label: `${Math.round(p.elevationM)} m` },
			geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] }
		}))
	};
}

/**
 * The elevation ramp: sand to dark brown by metres, a hypsometric order apart
 * from the MAP grid's blues, the same in both themes (each point ringed in the
 * halo colour, as the MAP points are). Its stops are the key's.
 */
export const DEM_RAMP: readonly (readonly [number, string])[] = [
	[0, '#f1e3b8'],
	[400, '#d8b46c'],
	[800, '#ad7c3c'],
	[1200, '#7c5026'],
	[2000, '#4a2d12']
];

/** The DEM grid layer: a dot at each sampled cell's centre (a DEM cell, not a station), coloured by elevation, and its value beside it. */
export function demGridLayers(dark: boolean, labels: boolean): { over: Layer[]; labels: Layer[] } {
	const t = labelColours(dark);
	const src = { source: 'demgrid' };
	return {
		over: [
			{
				id: 'demgrid-point',
				type: 'circle',
				...src,
				paint: {
					'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 4.5],
					'circle-color': ['interpolate', ['linear'], ['get', 'm'], ...DEM_RAMP.flat()],
					'circle-stroke-color': t.halo,
					'circle-stroke-width': 1
				}
			}
		],
		labels: labels
			? [
					{
						id: 'demgrid-label',
						type: 'symbol',
						...src,
						layout: { 'text-field': ['get', 'label'], 'text-font': [LABEL_FONTS.regular], 'text-size': 10, 'text-offset': [0, 0.8], 'text-anchor': 'top', 'text-padding': 2 },
						paint: { 'text-color': t.text, 'text-halo-color': t.halo, 'text-halo-width': 1.5 }
					}
				]
			: []
	};
}

/** The CHIRPS grid's colour: an orange apart from the water blues, the parcels' green and the quaternaries' purple. */
export const chirpsColour = (dark: boolean) => (dark ? '#ffb15c' : '#a34700');

/** A CHIRPS cell as the map takes it (mapLayers.ts chirpsCells). */
export interface ChirpsCellData {
	lon: number;
	lat: number;
	square: [number, number, number, number];
}

/** The `chirps` source's data: each cell's square (dashed) and its centre, the grid point. */
export function chirpsData(cells: readonly ChirpsCellData[] | null | undefined) {
	const sq = ([w, s, e, n]: [number, number, number, number]) => [
		[
			[w, s],
			[e, s],
			[e, n],
			[w, n],
			[w, s]
		]
	];
	return {
		type: 'FeatureCollection' as const,
		features: (cells ?? []).flatMap((c) => [
			{ type: 'Feature' as const, properties: { role: 'cell' }, geometry: { type: 'Polygon' as const, coordinates: sq(c.square) } },
			{ type: 'Feature' as const, properties: { role: 'point' }, geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] } }
		])
	};
}

/** The CHIRPS grid layer: each 0.05° cell's outline, dashed and thin, and its centre as a ringed dot. */
export function chirpsLayers(dark: boolean): Layer[] {
	const colour = chirpsColour(dark);
	const src = { source: 'chirps' };
	return [
		{ id: 'chirps-cell', type: 'line', ...src, filter: ['==', ['get', 'role'], 'cell'], paint: { 'line-color': colour, 'line-width': 1, 'line-opacity': 0.7, 'line-dasharray': [3, 3] } },
		{
			id: 'chirps-point',
			type: 'circle',
			...src,
			filter: ['==', ['get', 'role'], 'point'],
			paint: { 'circle-radius': 3.5, 'circle-color': colour, 'circle-stroke-color': labelColours(dark).halo, 'circle-stroke-width': 1.5 }
		}
	];
}

export interface StyleOptions {
	/** The glyphs URL (absolute; glyphsUrl()): place and water names, and the quaternaries' codes. Null: no labels. */
	glyphs?: string | null;
	/** The quaternary outlines to draw (null or empty: none). */
	quaternaries?: ReturnType<typeof quaternaryData>;
	/** The river network's reaches to draw (issue #345; null or empty: none). */
	rivers?: ReturnType<typeof riverNetworkData>;
	/** The elevation model's channels to draw (channelData()); none when omitted. */
	channels?: ReturnType<typeof channelData>;
	/** The relief's PMTiles URL, when the relief is shown (PUBLIC_TERRAIN_URL and the Relief layer on). Null: no relief, nothing fetched. */
	terrain?: string | null;
	/** A delineation proposal to draw (proposalData()); none when omitted. */
	proposal?: ReturnType<typeof proposalData>;
	/** The river network's credit (riversCredit()), while reaches from a credited dataset are drawn; none when omitted. */
	riversCredit?: string | null;
	/** The data sources page's URL: the relief's credit links its Copernicus section (the Art. 6(c) liability sentence). */
	dataSourcesHref?: string;
	/** The hydrological units' outlines and labels (unitsData()); none when omitted. */
	units?: ReturnType<typeof unitsData>;
	/** The MAP grid's points (mapGridData()); none when omitted. */
	mapGrid?: ReturnType<typeof mapGridData>;
	/** The CHIRPS grid's cells and points (chirpsData()); none when omitted. */
	chirps?: ReturnType<typeof chirpsData>;
	/** The DEM grid's sampled cells (demGridData()); none when omitted. */
	demGrid?: ReturnType<typeof demGridData>;
	/** The area fills' opacity scale, 0–1 (the Area fill slider, fillOpacity()); 1 when omitted. */
	fillScale?: number;
}

/**
 * The basemap with the overlay over it: one style, so a theme switch
 * (`setStyle`) redraws both and keeps the features and the selection. Order,
 * bottom up: the basemap's land, the relief (when on), the rest of the
 * basemap, the quaternary outlines, the river network, the features, the
 * units' outlines, the CHIRPS grid, the MAP grid's points, then every label (so a
 * results fill never hides a name).
 */
export function mapStyle(tilesUrl: string | null, dark: boolean, data: ReturnType<typeof overlayData>, opts: StyleOptions = {}): Style {
	const base = basemapStyle(tilesUrl, dark);
	const glyphs = opts.glyphs || null;
	const qt = quaternaryLayers(dark, !!glyphs);
	const un = unitsLayers(dark, !!glyphs);
	const mg = mapGridLayers(dark, !!glyphs);
	const dg = demGridLayers(dark, !!glyphs);
	const style: Style = {
		...base,
		sources: {
			...base.sources,
			quaternaries: { type: 'geojson', data: opts.quaternaries ?? quaternaryData(null) },
			rivers: { type: 'geojson', data: opts.rivers ?? riverNetworkData(null) },
			channels: { type: 'geojson', data: opts.channels ?? channelData(null) },
			features: { type: 'geojson', data },
			proposal: { type: 'geojson', data: opts.proposal ?? proposalData(null) },
			units: { type: 'geojson', data: opts.units ?? unitsData(null) },
			mapgrid: { type: 'geojson', data: opts.mapGrid ?? mapGridData(null) },
			chirps: { type: 'geojson', data: opts.chirps ?? chirpsData(null) },
			demgrid: { type: 'geojson', data: opts.demGrid ?? demGridData(null) }
		},
		layers: [
			...base.layers,
			...qt.under,
			...riverNetworkLayers(dark),
			...channelLayers(dark),
			...overlayLayers(dark, opts.fillScale ?? 1),
			...un.over,
			...chirpsLayers(dark),
			...dg.over,
			...mg.over,
			...proposalLayers(dark),
			...(glyphs && tilesUrl ? labelLayers(dark) : []),
			...qt.labels,
			...un.labels,
			...dg.labels,
			...mg.labels
		]
	};
	if (opts.terrain) {
		style.sources[TERRAIN_SOURCE] = terrainSource(opts.terrain, opts.dataSourcesHref);
		const before = reliefBeforeId(style.layers.map((l) => l.id));
		const at = before ? style.layers.findIndex((l) => l.id === before) : style.layers.length;
		style.layers.splice(at, 0, reliefLayer(dark));
	}
	if (opts.riversCredit) {
		style.sources[RIVERS_CREDIT_SOURCE] = riversCreditSource(opts.riversCredit);
		style.layers.push(RIVERS_CREDIT_LAYER);
	}
	if (glyphs) style.glyphs = glyphs;
	return style;
}

/**
 * The river network's credit on the map (HydroRIVERS' licence, docs/maps.md
 * § Sources): MapLibre's attribution control lists a source's attribution
 * only while a layer reads it, so the credit is its own empty source with
 * one invisible layer, added while reaches from HydroRIVERS are drawn and
 * removed after (CatchmentMap syncRiversCredit), as the relief's is. The
 * `rivers` source itself is always in the style, drawn or not.
 */
export const RIVERS_CREDIT_SOURCE = 'rivers-credit';
export const RIVERS_CREDIT_LAYER: Layer = { id: 'rivers-credit', type: 'line', source: RIVERS_CREDIT_SOURCE, paint: { 'line-opacity': 0 } };
export const riversCreditSource = (attribution: string) => ({ type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution });

/** The credit's HTML for the attribution control: the short line, linking to its full statement on the data sources page. */
export const riversCredit = (dataSourcesHref: string, text: string) => `<a href="${escapeAttribution(dataSourcesHref)}#hydrorivers">${escapeAttribution(text)}</a>`;

/**
 * The `features` source's data: polygons and lines (points are drawn as
 * markers), each with its id, kind, name, whether it is selected and, when
 * `fills` gives one (A1's results colouring), its fill colour.
 */
export function overlayData(features: readonly MapFeature[], selectedId: string | null, fills?: Readonly<Record<string, string>>) {
	return {
		type: 'FeatureCollection' as const,
		features: features
			.filter((f) => f.geometry.type !== 'Point')
			.map((f) => {
				const fill = fills?.[f.id];
				const properties: { id: string; kind: MapFeature['kind']; name: string; selected: boolean; fill?: string } = { id: f.id, kind: f.kind, name: f.name, selected: f.id === selectedId };
				if (fill) properties.fill = fill;
				return { type: 'Feature' as const, properties, geometry: f.geometry };
			})
	};
}
