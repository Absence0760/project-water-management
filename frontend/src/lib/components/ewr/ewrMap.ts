// The EWR page's "On the map" (docs/ui.md § EWR): each hydrological unit's
// area shaded by how the flow passing it compares with the EWR required at it,
// for the run on the page. Pure, unit-tested in ewrMap.test.ts; the Allocations
// map's component (allocations/AllocationMap.svelte) draws it through the
// scheme built here, and ewr/EwrUnitMap.svelte is the card.
//
// It reads only the run's summary, `RunSummary.unitEwr` (engine ≥ 1.116.0,
// docs/model.md §2.11c): Z is the EWR required at the unit (its own share plus
// the shares of the units above it), U its outflow. Two measures:
//   - Requirement met (the default): Σ MIN(U, Z) ÷ Σ Z, at most 100 %;
//   - Flow ÷ requirement: Σ U ÷ Σ Z, which can pass 100 %.
// A unit with no EWR at or above it (Σ Z = 0) has no ratio: "No EWR share".
// The bands are the client's (green met, orange within 10 %, light and dark red
// short), in the Allocations map's colours, so the two maps read alike.
import type { UnitEwrMet } from '@water-management/engine';
import type { MapFeature } from '#lib/api/types.js';
import { fmtNum } from '#lib/format/number.js';
import { bandColours, notInRunOf, unitPolygons, USE_FILL_OPACITY, USE_SOURCE_ID, type DrawnUnit, type MapScheme, type UnitNotInRun } from '#lib/components/allocations/useMap.js';

/** What the map shades by: the share of the requirement met (default), or the flow against it. */
export type EwrMapMeasure = 'met' | 'ratio';
export const EWR_MAP_MEASURES: readonly { id: EwrMapMeasure; label: string }[] = [
	{ id: 'met', label: 'Requirement met' },
	{ id: 'ratio', label: 'Flow ÷ requirement' }
];

/** The URL's names for the map (`ewrMap=1`, `ewrMapMeasure=ratio`; the default measure is left out). */
export const EWR_MAP_PARAM = 'ewrMap';
export const EWR_MAP_MEASURE_PARAM = 'ewrMapMeasure';

/** The measure a URL value names; anything else reads as the default. */
export const ewrMapMeasure = (v: string | null): EwrMapMeasure => EWR_MAP_MEASURES.find((m) => m.id === v)?.id ?? 'met';

/** A unit's band: met or exceeded, within 10 %, 10–50 % short, half or more short; `none`: no EWR share. */
export type EwrBand = 'met' | 'within' | 'short' | 'half' | 'none';
/** The bands with a ratio, in the key's order. */
export const EWR_BANDS: readonly Exclude<EwrBand, 'none'>[] = ['met', 'within', 'short', 'half'];

/** The key's words per band. */
export const EWR_BAND_LABEL: Record<EwrBand, string> = {
	met: 'Met or exceeded (100 % or more)',
	within: 'Within 10 % (90–100 %)',
	short: '10–50 % short (50–90 %)',
	half: 'Half or more short (under 50 %)',
	none: 'No EWR share'
};

/** The band in a few words, beside a unit in the lists and in its label's name. */
export const EWR_BAND_SHORT: Record<EwrBand, string> = {
	met: 'Met or exceeded',
	within: 'Within 10 %',
	short: '10–50 % short',
	half: 'Half or more short',
	none: 'No EWR share'
};

/** What the key divides, for its heading. */
export const EWR_MEASURE_RATIO: Record<EwrMapMeasure, string> = {
	met: 'EWR met ÷ EWR required at the unit',
	ratio: 'flow passing the unit ÷ EWR required at it'
};

/** Below this many m³ over the run a requirement counts as none (the engine's float dust). */
const NOTHING_M3 = 1e-6;
/** Sums and divisions leave dust: a ratio this close under an edge is on it. */
const EDGE = 1e-9;

/** A unit's ratio for the measure; null when no EWR is required at it. "Requirement met" is never above 1. */
export function ewrRatio(u: Pick<UnitEwrMet, 'requiredM3' | 'metM3' | 'outflowM3'>, measure: EwrMapMeasure): number | null {
	if (!(u.requiredM3 > NOTHING_M3)) return null;
	return measure === 'met' ? Math.min(1, Math.max(0, u.metM3) / u.requiredM3) : Math.max(0, u.outflowM3) / u.requiredM3;
}

/** The band a ratio falls in (each band includes its lower edge). */
export function ewrBand(ratio: number | null): EwrBand {
	if (ratio === null) return 'none';
	if (ratio >= 1 - EDGE) return 'met';
	if (ratio >= 0.9 - EDGE) return 'within';
	if (ratio >= 0.5 - EDGE) return 'short';
	return 'half';
}

/**
 * A ratio as its label: the whole per cent, rounded down so a label never
 * shows the next band's edge ("99 %" is within 10 %, never "100 %"), or "No
 * EWR share".
 */
export function ewrLabel(ratio: number | null): string {
	if (ratio === null) return EWR_BAND_LABEL.none;
	return `${fmtNum(Math.floor(ratio * 100 + EDGE * 100), 0)} %`;
}

/** The bands' colours: the Allocations map's (useMap.ts bandColours, the label text at 4.5:1 on each fill, tested there). */
export function ewrColours(dark: boolean): Record<EwrBand, { fill: string; text: string }> {
	const c = bandColours(dark);
	return { met: c.under, within: c.near, short: c.over, half: c.far, none: c.none };
}

/** One unit on the map, with its figures. */
export interface EwrUnit extends DrawnUnit {
	figures: UnitEwrMet;
	ratio: number | null;
	band: EwrBand;
}

export interface EwrShading {
	/** Units with an area on the Map tab: drawn. */
	drawn: EwrUnit[];
	/** Units with none: listed under the map, worst first, so none is silently missing. */
	unplaced: EwrUnit[];
	/** Areas of units the run doesn't have (added since it ran): a dashed outline. */
	notInRun: UnitNotInRun[];
}

const BAND_RANK: Record<EwrBand, number> = { half: 0, short: 1, within: 2, met: 3, none: 4 };

/** Worst first (the band, then the lower ratio), then by name: the order to look into them. */
export const byConcern = (a: EwrUnit, b: EwrUnit) => BAND_RANK[a.band] - BAND_RANK[b.band] || (a.ratio ?? 0) - (b.ratio ?? 0) || a.name.localeCompare(b.name);

/** Every unit of the run with its ratio, band and label for the measure, and its polygons from the Map tab's features. */
export function ewrShading(units: readonly UnitEwrMet[], features: readonly MapFeature[], measure: EwrMapMeasure): EwrShading {
	const { placed, nodeIds, names } = unitPolygons(features);
	const drawn: EwrUnit[] = [];
	const unplaced: EwrUnit[] = [];
	for (const f of units) {
		const ratio = ewrRatio(f, measure);
		const p = placed(f.nodeId);
		const u: EwrUnit = { nodeId: f.nodeId, name: f.name, figures: f, ratio, band: ewrBand(ratio), label: ewrLabel(ratio), ...p };
		(p.polygons.length ? drawn : unplaced).push(u);
	}
	unplaced.sort(byConcern);
	return { drawn, unplaced, notInRun: notInRunOf(nodeIds, new Set(units.map((u) => u.nodeId)), names, placed) };
}

/** How many units are in each band on the map, and how many have no area there (the key's counts add up to every unit). */
export function ewrCounts(s: Pick<EwrShading, 'drawn' | 'unplaced'>): Record<EwrBand | 'unplaced', number> {
	const c: Record<EwrBand | 'unplaced', number> = { met: 0, within: 0, short: 0, half: 0, none: 0, unplaced: s.unplaced.length };
	for (const u of s.drawn) c[u.band]++;
	return c;
}

const m3 = (v: number) => `${fmtNum(v)} m³`;

/**
 * A unit's figures in one sentence, for its label's accessible name and the
 * lists: it starts with the label's words, so a voice command that says what
 * the label reads reaches it (WCAG 2.5.3).
 */
export function ewrSentence(u: Pick<EwrUnit, 'name' | 'figures' | 'ratio' | 'band' | 'label'>, measure: EwrMapMeasure): string {
	if (u.ratio === null) return `${u.name}: ${u.label}, no EWR is required at this unit.`;
	const f = u.figures;
	const tail = `over the run. ${EWR_BAND_SHORT[u.band]}.`;
	return measure === 'met'
		? `${u.name}: ${u.label} of the EWR required met, ${m3(f.metM3)} of ${m3(f.requiredM3)} ${tail}`
		: `${u.name}: ${u.label}, flow of ${m3(f.outflowM3)} against ${m3(f.requiredM3)} of EWR required ${tail}`;
}

type Layer = Record<string, unknown> & { id: string; type: string };

/** The map's layers over the Allocations map's source: each band's fill (none for no EWR share), a casing and a stroke, dashed for a unit not in the run. */
export function ewrLayers(dark: boolean): Layer[] {
	const c = ewrColours(dark);
	const src = { source: USE_SOURCE_ID };
	const dashed = ['in', ['get', 'band'], ['literal', ['notinrun', 'nodata']]];
	return [
		{
			id: 'ewr-fill',
			type: 'fill',
			...src,
			filter: ['in', ['get', 'band'], ['literal', [...EWR_BANDS]]],
			paint: { 'fill-color': ['match', ['get', 'band'], 'met', c.met.fill, 'within', c.within.fill, 'short', c.short.fill, c.half.fill], 'fill-opacity': USE_FILL_OPACITY }
		},
		{ id: 'ewr-casing', type: 'line', ...src, paint: { 'line-color': dark ? '#000000' : '#ffffff', 'line-width': 5, 'line-opacity': 0.85 } },
		{ id: 'ewr-line', type: 'line', ...src, filter: ['!', dashed], paint: { 'line-color': dark ? '#eef0ec' : '#1f2320', 'line-width': 2 } },
		{ id: 'ewr-line-dashed', type: 'line', ...src, filter: dashed, paint: { 'line-color': dark ? '#eef0ec' : '#1f2320', 'line-width': 2, 'line-dasharray': [2, 2] } }
	];
}

/** The scheme AllocationMap draws the EWR shading with. */
export function ewrScheme(measure: EwrMapMeasure): MapScheme {
	return {
		id: 'ewr',
		layers: ewrLayers,
		colours: ewrColours,
		sentence: (u) => ewrSentence(u as EwrUnit, measure),
		ariaLabel: measure === 'met' ? 'Hydrological units shaded by the share of the EWR required at each that was met' : 'Hydrological units shaded by the flow passing each against the EWR required at it'
	};
}
