// Results on the map, the page's side (issue #326 A1, decision D-A1; docs/ui.md
// § Map, docs/maps.md § Results on the map): what the measure picker offers and
// how it sits in the URL, the legend's rows, and the figure a card or a table
// row gives a feature. Pure: the figures come from mapStatus.ts, the run and
// its loading from mapResults.svelte.ts.
import type { MapFeature, RunMeta } from '$lib/api/types';
import { fmtDate } from '$lib/format/number';
import { BAND_TOKEN, BAND_WORD, DEFAULT_MAP_MEASURE, MAP_MEASURES, MEASURE_LEGEND, type MapBand, type MapMeasure, type MapRunChoice, type MapStatus } from './mapStatus';

/** What the map's areas are coloured by: a measure, or `kind` (each feature's kind, the colours before results). */
export type MapView = MapMeasure | 'kind';

/** The measure picker's choices, in its order: the four measures, then the kinds as the "off" state. */
export const VIEW_OPTIONS: readonly { id: MapView; label: string }[] = [...MAP_MEASURES, { id: 'kind', label: 'Kind' }];

/** `measure=` in the URL: kebab-case words, so a shared link reads. */
const SLUG: Record<MapView, string> = { daysShort: 'days-short', curtailment: 'curtailment', damLevel: 'dam-level', allocation: 'allocation', kind: 'kind' };
const FROM_SLUG = new Map(Object.entries(SLUG).map(([k, v]) => [v, k as MapView]));

export const MEASURE_PARAM = 'measure';
export const RUN_PARAM = 'run';

/** The view `measure=` names; absent or unknown is the default, days short (D-A1). */
export function viewFromParam(value: string | null): MapView {
	return (value && FROM_SLUG.get(value)) || DEFAULT_MAP_MEASURE;
}

/** `measure=`'s value for a view; null for the default, so the plain link stays plain. */
export function viewParam(view: MapView): string | null {
	return view === DEFAULT_MAP_MEASURE ? null : SLUG[view];
}

export const viewLabel = (view: MapView) => VIEW_OPTIONS.find((o) => o.id === view)!.label;

const runName = (r: Pick<RunMeta, 'label'>) => r.label || 'Untitled run';

/** A run in the run picker: its name, the day it ran, and "published" for the publication's. */
export function runOption(r: Pick<RunMeta, 'label' | 'createdAt' | 'published'>): string {
	return `${runName(r)} · ${fmtDate(r.createdAt)}${r.published ? ' · published' : ''}`;
}

/** Which run the colours are from, in words under the picker (null when there is none). */
export function runCaption(choice: MapRunChoice): string | null {
	const r = choice.run;
	if (!r) return null;
	const what = `“${runName(r)}”, ran ${fmtDate(r.createdAt)}`;
	if (choice.from === 'published') return `From the published run ${what}.`;
	if (choice.from === 'newest') return `From your newest run ${what}: nothing is published yet.`;
	return `From the run ${what} (not published).`;
}

/** Why the map shows kinds rather than results, when it has no run to show (one line, D-A1). */
export function noRunLine(canEdit: boolean, anyRuns: boolean): string {
	if (canEdit && !anyRuns) return 'No run yet, so the map shows each feature’s kind. Run the model to colour it by results.';
	return 'Nothing is published yet, so the map shows each feature’s kind.';
}

/** Bands in the legend's order, best first, "no figure" last. */
export const LEGEND_BANDS: readonly MapBand[] = ['ok', 'watch', 'short', 'none'];

export interface LegendRow {
	band: MapBand;
	word: string;
	/** What the band means for this measure. */
	text: string;
	/** How many units are in it. */
	count: number;
	token: string;
}

/**
 * The legend's rows for a measure: each band's word, what it means and how
 * many units it holds, so the colours are read in words too. A band no unit is
 * in is left out, except that an all-empty legend keeps every band (nothing to
 * count yet). Unlinked areas take the "no figure" colour (`resultFills`), so
 * that row says so.
 */
export function legendRows(measure: MapMeasure, statuses: readonly MapStatus[], unlinked = 0): LegendRow[] {
	const count = new Map<MapBand, number>();
	for (const s of statuses) count.set(s.band, (count.get(s.band) ?? 0) + 1);
	const rows = LEGEND_BANDS.map((band) => ({
		band,
		word: BAND_WORD[band],
		text: band === 'none' ? `${MEASURE_LEGEND[measure].none}; or not linked to a unit` : MEASURE_LEGEND[measure][band],
		count: count.get(band) ?? 0,
		token: BAND_TOKEN[band]
	}));
	const shown = rows.filter((r) => r.count > 0 || (r.band === 'none' && unlinked > 0));
	return shown.length ? shown : rows;
}

/** The gauges' EWR in one line: how many met and missed (null with no EWR site in the run). */
export function ewrLine(ewr: readonly MapStatus[]): string | null {
	const met = ewr.filter((s) => s.band === 'ok').length;
	const missed = ewr.filter((s) => s.band === 'short').length;
	if (!met && !missed) return null;
	const sites = (n: number) => `${n} site${n === 1 ? '' : 's'}`;
	const parts = [met ? `met every day at ${sites(met)}` : null, missed ? `missed on some days at ${sites(missed)}` : null].filter(Boolean);
	return `EWR ${parts.join(', ')}`;
}

/** The areas the results colour: polygons other than the boundary (rivers are lines). */
const colourable = (f: Pick<MapFeature, 'kind' | 'geometry'>) => f.kind !== 'catchment_boundary' && f.kind !== 'river' && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');

/**
 * The fills CatchmentMap draws while a measure is shown: `bandFills`' colours,
 * plus the "no figure" colour on every area with no figure (not linked to a
 * node, or linked to one with no status), so a parcel's own green never reads
 * as "OK" next to the results. `colour` is a band's resolved colour.
 */
export function resultFills(
	features: readonly Pick<MapFeature, 'id' | 'kind' | 'nodeId' | 'geometry'>[],
	filled: Readonly<Record<string, string>>,
	none: string
): Record<string, string> {
	const out: Record<string, string> = { ...filled };
	if (!none) return out;
	for (const f of features) if (colourable(f) && !out[f.id]) out[f.id] = none;
	return out;
}

/** How many areas have no node to take a figure from (the legend's "not linked"). */
export const unlinkedAreas = (features: readonly Pick<MapFeature, 'kind' | 'nodeId' | 'geometry'>[]) => features.filter((f) => colourable(f) && !f.nodeId).length;

/** A feature's figure for a card or a table row: its unit's, else its gauge's EWR, else why there is none. */
export function featureResult(
	f: Pick<MapFeature, 'kind' | 'nodeId' | 'geometry'>,
	units: ReadonlyMap<string, MapStatus>,
	ewr: ReadonlyMap<string, MapStatus>
): MapStatus | { band: 'none'; label: string; measure: null } | null {
	if (f.kind === 'catchment_boundary' || f.kind === 'river') return null;
	if (!f.nodeId) return { band: 'none', label: 'Not linked to a unit or gauge', measure: null };
	return units.get(f.nodeId) ?? ewr.get(f.nodeId) ?? { band: 'none', label: 'No figure for what it stands for', measure: null };
}
