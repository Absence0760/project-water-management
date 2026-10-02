// "Your hydrological unit on the map" (issue #326 A3, decision D-A1/A3;
// docs/ui.md § Farmer view, docs/maps.md § The farmer's map): the words and
// the colours of the farm view's small map, as pure functions. The map draws
// only what GET …/farm/:nodeId/map answers: this farm's own land (parcels)
// and dam, and the catchment's boundary, rivers and gauges for orientation;
// never a neighbour's. Its colour is the farm view's own status, the model's
// look-back band (FarmProjection.river.band, the "Model: …" chip of
// cards.ts), never a run the farmer can't open. Everything the map shows is
// also said here in words, so the map is never the only way to read it.
import type { FarmProjection, ModelBand } from '@water-management/engine';
import type { FarmMapFeature, MapFeature, MapFeatureKind } from '$lib/api/types';
import { msg, t, tRich, type Msg } from '$lib/i18n/locale.svelte';
import type { Rich } from '$lib/i18n/rich';
import type { MapWords } from '$lib/components/map/CatchmentMap.svelte';
import { bandChip } from './cards';
import { fmtNumber } from './numbers';

/**
 * Each band's colour token: the workspace map's (map/mapStatus.ts BAND_TOKEN,
 * farmMap.test.ts keeps them one), so a farmer's land is the colour the WUA
 * sees it in. The farm view's band is the model's look back (ok, watch, short).
 */
export const FARM_BAND_TOKEN: Record<ModelBand, string> = { ok: '--success', watch: '--warning', short: '--danger' };

/** The farm's own features: what the map is about. */
export const isOwn = (f: Pick<FarmMapFeature, 'kind'>) => f.kind === 'farm_parcel' || f.kind === 'dam';

/** Whether the page shows a map at all: only when the farm has land or a dam of its own on it. */
export const showsMap = (features: readonly FarmMapFeature[]) => features.some(isOwn);

/** The farm's features in the shape the shared map component draws (no node, no properties: the route sends none). */
export function asMapFeatures(features: readonly FarmMapFeature[]): MapFeature[] {
	return features.map((f) => ({
		...f,
		nodeId: null,
		nodeName: null,
		// The server says which river carries HydroRIVERS' credit (it sends no properties); the map's
		// creditedFeature reads it here.
		properties: (f.credit ? { credit: f.credit } : {}) as Record<string, string>,
		sourceId: null,
		createdBy: null,
		createdAt: '',
		updatedAt: ''
	}));
}

/**
 * The fills by feature id: the farm's own land and dam polygons in its band's
 * colour (`resolve` turns a token into a colour MapLibre reads). Nothing is
 * filled without a band: the land keeps the map's own green.
 */
export function farmFills(features: readonly FarmMapFeature[], band: ModelBand | null, resolve: (token: string) => string): Record<string, string> {
	if (!band) return {};
	const colour = resolve(FARM_BAND_TOKEN[band]);
	if (!colour) return {};
	const out: Record<string, string> = {};
	for (const f of features) if (isOwn(f) && f.geometry.type !== 'Point') out[f.id] = colour;
	return out;
}

// i18n-section: farm.map
const KIND_WORD: Record<FarmMapFeature['kind'], Msg> = {
	farm_parcel: msg('Your land'),
	dam: msg('Your dam'),
	gauge: msg('Gauge'),
	river: msg('River'),
	catchment_boundary: msg('Catchment boundary')
};
/** A feature's kind in the reader's words (the map's point buttons and the legend). `other` never reaches a farm's map. */
export const kindWord = (k: MapFeatureKind) => (k === 'other' ? '' : t(KIND_WORD[k]));

/** What the shared map component says, in the reader's language. */
export const mapWords = (): MapWords => ({
	loading: t('Drawing the map…'),
	unavailable: t('The map can’t be drawn in this browser. Everything on it is written above.'),
	tilesNote: t('The background map couldn’t be loaded, so the map is drawn on a plain background.'),
	keys: t('use the arrow keys to move the map, + and − to zoom'),
	kind: kindWord,
	zoomIn: t('Zoom in'),
	zoomOut: t('Zoom out')
});

/** "33.684° S, 21.320° E": a place, for when there is no background map to show it. */
export function placeText([lon, lat]: [number, number]): string {
	const deg = (v: number) => fmtNumber(Math.abs(v), 3);
	const ns = lat < 0 ? t('{deg}° S', { deg: deg(lat) }) : t('{deg}° N', { deg: deg(lat) });
	const ew = lon < 0 ? t('{deg}° W', { deg: deg(lon) }) : t('{deg}° E', { deg: deg(lon) });
	return `${ns}, ${ew}`;
}

/** "4.1 ha": an area in hectares. */
export const hectares = (m2: number) => t('{n} ha', { n: fmtNumber(m2 / 10_000, m2 < 100_000 ? 1 : 0) });

/** One line of the map's key: a swatch drawn like the map draws that kind, and its words. */
export interface LegendItem {
	kind: FarmMapFeature['kind'];
	label: string;
}

export interface FarmMapVm {
	heading: string;
	/** What the map shows, and that it shows no one else's hydrological unit. */
	about: string;
	/** What colours the land, with the band in words; null without a band. */
	status: Rich | null;
	/** Each feature by name, so the map is never the only way to read it. */
	lines: string[];
	/** Where the land is, in degrees: the place, said even when the background map shows it. */
	place: string;
	legend: LegendItem[];
	/** The map region's accessible name. */
	label: string;
}

const named = (features: readonly FarmMapFeature[], kind: FarmMapFeature['kind']) => features.filter((f) => f.kind === kind);
// Each name once: a river drawn as several reaches, or several pieces of one parcel, share it. A blank name (a reach the river network named none, farms/view.ts) is left out.
const names = (fs: readonly FarmMapFeature[]) => [...new Set(fs.map((f) => f.name.trim()).filter((n) => n !== ''))];

/** Everything the map card says (FarmMapCard.svelte). `features` is a non-empty answer (showsMap). */
export function farmMapCard(features: readonly FarmMapFeature[], farm: Pick<FarmProjection, 'river'>): FarmMapVm {
	const land = named(features, 'farm_parcel');
	const dams = named(features, 'dam');
	const rivers = named(features, 'river');
	const gauges = named(features, 'gauge');
	const boundary = named(features, 'catchment_boundary');
	const band = farm.river.band;

	const lines: string[] = [];
	if (land.length) {
		const area = land.reduce((s, f) => s + (f.areaM2 ?? 0), 0);
		const n = names(land);
		lines.push(n.length ? t('Your land: {names} ({area})', { names: n.join(', '), area: hectares(area) }) : t('Your land: {area}', { area: hectares(area) }));
	}
	if (dams.length) {
		const n = names(dams);
		lines.push(n.length ? t('Your dam: {names}', { names: n.join(', ') }) : t('Your dam'));
	}
	if (rivers.length) {
		const n = names(rivers);
		lines.push(n.length ? t('Rivers: {names}', { names: n.join(', ') }) : t('A river'));
	}
	if (gauges.length) {
		const n = names(gauges);
		lines.push(n.length ? t('Gauges: {names}', { names: n.join(', ') }) : t('A gauge'));
	}
	if (boundary.length) lines.push(t('The catchment boundary'));

	// The middle of the land, else of the dam.
	const middle = (land[0] ?? dams[0])!.center;

	const legend: LegendItem[] = [];
	if (land.length) legend.push({ kind: 'farm_parcel', label: band ? t('Your land · {band}', { band: bandChip(band) }) : t(KIND_WORD.farm_parcel) });
	if (dams.length) legend.push({ kind: 'dam', label: t(KIND_WORD.dam) });
	if (rivers.length) legend.push({ kind: 'river', label: t(KIND_WORD.river) });
	if (gauges.length) legend.push({ kind: 'gauge', label: t(KIND_WORD.gauge) });
	if (boundary.length) legend.push({ kind: 'catchment_boundary', label: t(KIND_WORD.catchment_boundary) });

	return {
		heading: t('Your hydrological unit on the map'),
		about: t('The map shows your own land and dam, with the catchment boundary, the rivers and the gauges to find your way. It shows no other hydrological unit.'),
		status: band ? tRich('Your land is coloured by the model’s look back: **{band}**.', { band: bandChip(band) }) : null,
		lines,
		place: t('Where: about {place}.', { place: placeText(middle) }),
		legend,
		label: t('Map of your hydrological unit')
	};
}
