// The Allocations tab's map (issue #510, docs/allocations.md § The map): each
// hydrological unit's polygon shaded by what the run models ÷ what is
// registered for it, for the measure picked: its water use (the default), its
// irrigated area, or its dam's capacity. Pure, unit-tested in useMap.test.ts;
// AllocationMap.svelte draws it.
//
// It only reads the comparison (engine compareAllocations, the same figures
// as the table, so the map can't disagree with it) and the Map tab's unit
// polygons (a farm_parcel linked to the unit, docs/maps.md § Hydrological
// units layer). The bands are fixed for this map and separate from the
// table's ±tolerance status, which also calls 0.9–1.0 "within". The wording
// never says "lawful" or "compliant" (allocations.ts).
import { USE_BANDS, useBand, type AllocationComparison, type AllocationNodeComparison, type UseBand } from '@water-management/engine';
import type { MapFeature, MapGeometry, MapPosition } from '#lib/api/types.js';
import { fmtNum } from '#lib/format/number.js';
import { interiorPoint } from '#lib/components/map/pieces.js';

// The band rule lives in the engine (allocations/useBand.ts), so the example
// seed is held to the same edges as the map.
export { USE_BANDS, useBand, type UseBand };

/** Which water: surface (licences are per source, so the default), groundwater, or both together (total ÷ total). */
export type UseSource = 'surface' | 'groundwater' | 'both';
export const USE_SOURCES: readonly { id: UseSource; label: string }[] = [
	{ id: 'surface', label: 'Surface water' },
	{ id: 'groundwater', label: 'Groundwater' },
	{ id: 'both', label: 'Both together' }
];

/**
 * What the map shades by (docs/allocations.md § The map): the water use
 * (modelled use ÷ registered volume, per source and period), the irrigated
 * area (the run's planted crop areas ÷ the registered irrigated area) or the
 * dam capacity (the run's dam ÷ the registered storage, s21b). The last two
 * are the run's inputs, so they have no source or water year.
 */
export type MapMeasure = 'use' | 'area' | 'storage';
export const MAP_MEASURES: readonly { id: MapMeasure; label: string }[] = [
	{ id: 'use', label: 'Water use' },
	{ id: 'area', label: 'Irrigated area' },
	{ id: 'storage', label: 'Dam capacity' }
];

/** Below this many m³ a volume counts as nothing (the engine's float dust, compare.ts NOTHING_M3). */
const NOTHING_M3 = 1e-6;

/** The legend's words per band, in the order it lists them. */
export const BAND_LABEL: Record<UseBand, string> = {
	under: 'Using less than registered (under 100 %)',
	near: 'The same, up to 10 % more (100–110 %)',
	over: '10–50 % more than registered (110–150 %)',
	far: 'More than 50 % more than registered (over 150 %)',
	unregistered: 'Use, but no registered volume',
	none: 'No use, nothing registered'
};

/** The band in a few words, beside a unit in the list and the map's own label. */
export const BAND_SHORT: Record<UseBand, string> = {
	under: 'Less than registered',
	near: 'Up to 10 % more',
	over: '10–50 % more',
	far: 'Over 50 % more',
	unregistered: 'No registered volume',
	none: 'No use, none registered'
};

/** The legend's words per band for each measure (water use's are BAND_LABEL). */
export const MEASURE_BAND_LABEL: Record<MapMeasure, Record<UseBand, string>> = {
	use: BAND_LABEL,
	area: {
		under: 'Less planted than registered (under 100 %)',
		near: 'The same, up to 10 % more (100–110 %)',
		over: '10–50 % more planted than registered (110–150 %)',
		far: 'More than 50 % more planted than registered (over 150 %)',
		unregistered: 'Planted, but no irrigated area registered',
		none: 'Nothing planted, no area registered'
	},
	storage: {
		under: 'A smaller dam than registered (under 100 %)',
		near: 'The same, up to 10 % larger (100–110 %)',
		over: '10–50 % larger than registered (110–150 %)',
		far: 'More than 50 % larger than registered (over 150 %)',
		unregistered: 'A dam, but no storage registered',
		none: 'No dam, no storage registered'
	}
};

/** The band in a few words for each measure (water use's are BAND_SHORT). */
export const MEASURE_BAND_SHORT: Record<MapMeasure, Record<UseBand, string>> = {
	use: BAND_SHORT,
	area: {
		under: 'Less than registered',
		near: 'Up to 10 % more',
		over: '10–50 % more',
		far: 'Over 50 % more',
		unregistered: 'No area registered',
		none: 'Nothing planted or registered'
	},
	storage: {
		under: 'Smaller than registered',
		near: 'Up to 10 % larger',
		over: '10–50 % larger',
		far: 'Over 50 % larger',
		unregistered: 'No storage registered',
		none: 'No dam or storage'
	}
};

/** What the key divides, for its heading ("modelled use ÷ registered volume"). */
export const MEASURE_RATIO: Record<MapMeasure, string> = {
	use: 'modelled use ÷ registered volume',
	area: 'irrigated area in the run ÷ registered irrigated area',
	storage: 'dam capacity in the run ÷ registered storage'
};

/** A measure's figure with its unit: m³ for use and storage, hectares for the area. */
export const measureFigure = (measure: MapMeasure, v: number): string => (measure === 'area' ? `${fmtNum(v, 1, true)} ha` : `${fmtNum(v)} m³`);

/**
 * The bands' colours (theme pairs, like mapStyle.ts overlayColours: MapLibre
 * can't read CSS variables, and the legend and list read their swatches from
 * here, so key and map can't drift). `text` is the label's colour on its
 * band, at least 4.5:1 (useMap.test.ts); `none` has no fill and draws on the
 * surface. Colour is never the only cue: every unit carries its % (or the
 * band's words) as a label and the legend names each band.
 */
export function bandColours(dark: boolean): Record<UseBand, { fill: string; text: string }> {
	return dark
		? {
				under: { fill: '#3fb86a', text: '#000000' },
				near: { fill: '#ffb347', text: '#000000' },
				over: { fill: '#ff9c94', text: '#000000' },
				far: { fill: '#ff4040', text: '#000000' },
				unregistered: { fill: '#9aa09a', text: '#000000' },
				none: { fill: '#1d211e', text: '#eef0ec' }
			}
		: {
				under: { fill: '#2a8a4a', text: '#000000' },
				near: { fill: '#f0a020', text: '#000000' },
				over: { fill: '#f28b82', text: '#000000' },
				far: { fill: '#c4161c', text: '#ffffff' },
				unregistered: { fill: '#8c918a', text: '#000000' },
				none: { fill: '#ffffff', text: '#1f2320' }
			};
}

/** The hatching's stripe colour over the grey "no registered volume" fill. */
export const hatchStripe = (dark: boolean) => (dark ? '#2b2f2c' : '#3a3d3a');

/** The whole water years the comparison has (part years are left out, as in the comparison's means), oldest first. */
export function wholeWaterYears(c: AllocationComparison): number[] {
	const ys = new Set<number>();
	for (const n of c.nodes) for (const side of [n.surface, n.groundwater]) for (const y of side.years) if (!y.partial) ys.add(y.waterYear);
	return [...ys].sort((a, b) => a - b);
}

/**
 * One unit's figure against what is registered for it, for the picked measure
 * (and, for water use, source and period): m³ for use and storage, ha for the
 * area. Null when there is nothing to read (water use: the run covers no such
 * whole year; area: a comparison without areas).
 */
export interface UnitUse {
	modelled: number;
	registered: number;
	/** modelled ÷ registered; null when nothing is registered. */
	ratio: number | null;
	band: UseBand;
	/** The surface use is a dam beside the river's, measured at the river intake (engine ≥ 1.82.0, docs/model.md §2.12). */
	atIntake?: boolean;
}

/**
 * A unit's figures: the mean over the whole water years (`waterYear` null,
 * the comparison's own means), or one whole water year. Both sources add
 * use to use and volume to volume. Null when there is no whole year to read.
 */
export function unitUse(n: AllocationNodeComparison, source: UseSource, waterYear: number | null): UnitUse | null {
	const sides = source === 'both' ? [n.surface, n.groundwater] : [source === 'surface' ? n.surface : n.groundwater];
	let modelled = 0;
	let registered = 0;
	for (const side of sides) {
		if (waterYear === null) {
			if (side.wholeYears === 0) return null;
			modelled += side.meanModelledM3PerYear ?? 0;
			registered += side.meanRegisteredM3PerYear ?? 0;
		} else {
			const y = side.years.find((x) => x.waterYear === waterYear && !x.partial);
			if (!y) return null;
			modelled += y.modelledM3;
			registered += y.registeredM3;
		}
	}
	const atIntake = sides.some((side) => side.measuredAt === 'intake');
	return { ...figure(modelled, registered), ...(atIntake ? { atIntake } : {}) };
}

const figure = (modelled: number, registered: number): UnitUse => ({ modelled, registered, ratio: registered > NOTHING_M3 ? modelled / registered : null, band: useBand(modelled, registered) });

/**
 * A unit's figure for the picked measure: water use as unitUse; the irrigated
 * area (the run's planted crop areas against the registered irrigated area,
 * engine withIrrigatedAreas; null without it); the dam capacity in the run
 * against the registered storage (no dam, or none registered, reads as 0).
 */
export function unitFigure(n: AllocationNodeComparison, measure: MapMeasure, source: UseSource, waterYear: number | null): UnitUse | null {
	if (measure === 'use') return unitUse(n, source, waterYear);
	if (measure === 'area') return n.irrigatedArea ? figure(n.irrigatedArea.modelledHa, n.irrigatedArea.registeredHa ?? 0) : null;
	return figure(n.storage.modelledCapacityM3 ?? 0, n.storage.registeredM3 ?? 0);
}

/** The label a unit carries on the map: its % of registered ("132 %"), or the band in a word or two. */
export function useLabel(u: Pick<UnitUse, 'ratio' | 'band'> | null, measure: MapMeasure = 'use'): string {
	if (!u) return measure === 'use' ? 'No whole year' : 'No figures';
	if (u.ratio !== null) return `${fmtNum(u.ratio * 100, 0)} %`;
	if (u.band === 'unregistered') return 'None registered';
	return measure === 'use' ? 'No use' : measure === 'area' ? 'No area' : 'No dam';
}

type Polygonal = Extract<MapGeometry, { type: 'Polygon' | 'MultiPolygon' }>;
const isPolygonal = (g: MapGeometry): g is Polygonal => g.type === 'Polygon' || g.type === 'MultiPolygon';

/**
 * A unit AllocationMap draws, whichever shading it is in: its band (a key of
 * the scheme's colours; null: nothing to read, a dashed outline), the words on
 * its label, its polygons and where the label sits.
 */
export interface DrawnUnit {
	nodeId: string;
	name: string;
	band: string | null;
	label: string;
	/** Its polygons (each linked farm_parcel); empty when it has none on the Map tab. */
	polygons: { featureId: string; geometry: Polygonal }[];
	/** Where its label sits: inside its largest polygon; null without one. */
	at: MapPosition | null;
}

/** What AllocationMap draws: the units with an area, and the areas of units the run doesn't have. */
export interface MapShading {
	drawn: readonly DrawnUnit[];
	notInRun: readonly UnitNotInRun[];
}

/**
 * How AllocationMap colours and names the units: the compared-to-run bands
 * (useScheme, below) or the run-free registered scale (registeredMap.ts).
 */
export interface MapScheme {
	/** Which shading: another id has other layers, so the map restyles. */
	id: 'use' | 'registered' | 'ewr';
	layers: (dark: boolean) => Layer[];
	colours: (dark: boolean) => Record<string, { fill: string; text: string }>;
	/** A unit's label's accessible name. */
	sentence: (u: DrawnUnit) => string;
	/** The map region's accessible name. */
	ariaLabel: string;
}

/** One unit as the map and its list show it. */
export interface ShadedUnit extends DrawnUnit {
	/** Null: the run covers no whole year of the picked period. */
	use: UnitUse | null;
	band: UseBand | null;
}

/** A polygon linked to a unit the run doesn't have (added since it ran): drawn as an outline, listed as not in this run. */
export interface UnitNotInRun {
	nodeId: string;
	name: string;
	polygons: { featureId: string; geometry: Polygonal }[];
	at: MapPosition | null;
}

export interface UseShading {
	/** Units with at least one polygon: drawn. */
	drawn: ShadedUnit[];
	/** Units with no polygon: listed under the map with their band, so none is silently missing. */
	unplaced: ShadedUnit[];
	/** Polygons of units the run doesn't have. */
	notInRun: UnitNotInRun[];
}

const BAND_RANK: Record<UseBand, number> = { far: 0, over: 1, unregistered: 2, near: 3, under: 4, none: 5 };

/**
 * Every unit of the run (farms and other water users) with its band for the
 * picked source and period, and its polygons from the Map tab's features. A
 * unit's label sits inside its largest polygon. The unplaced list is in the
 * order to look into them (furthest above first), then by name.
 */
export function useShading(c: AllocationComparison, features: readonly MapFeature[], source: UseSource, waterYear: number | null, measure: MapMeasure = 'use'): UseShading {
	const { placed, nodeIds, names } = unitPolygons(features);
	const drawn: ShadedUnit[] = [];
	const unplaced: ShadedUnit[] = [];
	const inRun = new Set<string>();
	for (const n of c.nodes) {
		inRun.add(n.nodeId);
		const use = unitFigure(n, measure, source, waterYear);
		const p = placed(n.nodeId);
		const u: ShadedUnit = { nodeId: n.nodeId, name: n.name, use, band: use?.band ?? null, label: useLabel(use, measure), ...p };
		(p.polygons.length ? drawn : unplaced).push(u);
	}
	const rank = (u: ShadedUnit) => (u.band ? BAND_RANK[u.band] : 6);
	unplaced.sort((a, b) => rank(a) - rank(b) || (b.use?.ratio ?? 0) - (a.use?.ratio ?? 0) || a.name.localeCompare(b.name));
	return { drawn, unplaced, notInRun: notInRunOf(nodeIds, inRun, names, placed) };
}

/**
 * The Map tab's unit polygons (a farm_parcel linked to a unit, docs/maps.md §
 * Hydrological units layer), for each map that shades the units (this one,
 * registeredMap.ts, ewr/ewrMap.ts): a unit's polygons, largest first, and where
 * its label sits (inside the largest; null without one), every unit id with a
 * polygon, and the units' names as the features carry them.
 */
export function unitPolygons(features: readonly MapFeature[]) {
	const byNode = new Map<string, { featureId: string; geometry: Polygonal; area: number }[]>();
	for (const f of features) {
		if (f.kind !== 'farm_parcel' || !f.nodeId || !isPolygonal(f.geometry)) continue;
		const list = byNode.get(f.nodeId) ?? [];
		list.push({ featureId: f.id, geometry: f.geometry, area: f.areaM2 ?? 0 });
		byNode.set(f.nodeId, list);
	}
	const placed = (nodeId: string): Pick<DrawnUnit, 'polygons' | 'at'> => {
		const ps = (byNode.get(nodeId) ?? []).slice().sort((a, b) => b.area - a.area);
		return { polygons: ps.map(({ featureId, geometry }) => ({ featureId, geometry })), at: ps[0] ? interiorPoint(ps[0].geometry) : null };
	};
	const names = new Map(features.filter((f) => f.nodeId && f.nodeName).map((f) => [f.nodeId!, f.nodeName!]));
	return { placed, nodeIds: [...byNode.keys()], names };
}

/** The polygons of units a run doesn't have (added since it ran), by name: drawn as a dashed outline. */
export function notInRunOf(nodeIds: readonly string[], inRun: ReadonlySet<string>, names: ReadonlyMap<string, string>, placed: (nodeId: string) => Pick<DrawnUnit, 'polygons' | 'at'>): UnitNotInRun[] {
	return nodeIds
		.filter((id) => !inRun.has(id))
		.map((id) => ({ nodeId: id, name: names.get(id) ?? 'A hydrological unit', ...placed(id) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The map's GeoJSON: each drawn unit's polygons with its band, and the polygons of units not in the run. */
export function useMapData(s: MapShading) {
	return {
		type: 'FeatureCollection' as const,
		features: [
			...s.drawn.flatMap((u) =>
				u.polygons.map((p) => ({ type: 'Feature' as const, properties: { nodeId: u.nodeId, band: u.band ?? 'nodata' }, geometry: p.geometry }))
			),
			...s.notInRun.flatMap((u) => u.polygons.map((p) => ({ type: 'Feature' as const, properties: { nodeId: u.nodeId, band: 'notinrun' }, geometry: p.geometry })))
		]
	};
}

/** The fill-opacity of a band's fill: strong enough to read, the basemap still faintly there. */
export const USE_FILL_OPACITY = 0.7;

// Loose style types, as mapStyle.ts: maplibre-gl stays out of this module.
type Layer = Record<string, unknown> & { id: string; type: string };
export const USE_SOURCE_ID = 'use';
export const HATCH_IMAGE = 'use-hatch';

/**
 * The map's layers over the `use` source: each band's fill (the grey
 * "no registered volume" one hatched with HATCH_IMAGE), no fill for no use and
 * nothing registered, a dark casing and a stroke round every unit, dashed for
 * a unit not in the run or with no whole year.
 */
export function useLayers(dark: boolean): Layer[] {
	const c = bandColours(dark);
	const src = { source: USE_SOURCE_ID };
	const band = (b: string) => ['==', ['get', 'band'], b];
	const filled = ['in', ['get', 'band'], ['literal', ['under', 'near', 'over', 'far']]];
	const dashed = ['in', ['get', 'band'], ['literal', ['notinrun', 'nodata']]];
	return [
		{
			id: 'use-fill',
			type: 'fill',
			...src,
			filter: filled,
			paint: { 'fill-color': ['match', ['get', 'band'], 'under', c.under.fill, 'near', c.near.fill, 'over', c.over.fill, c.far.fill], 'fill-opacity': USE_FILL_OPACITY }
		},
		{ id: 'use-unregistered', type: 'fill', ...src, filter: band('unregistered'), paint: { 'fill-color': c.unregistered.fill, 'fill-opacity': USE_FILL_OPACITY } },
		{ id: 'use-hatch', type: 'fill', ...src, filter: band('unregistered'), paint: { 'fill-pattern': HATCH_IMAGE } },
		{ id: 'use-casing', type: 'line', ...src, paint: { 'line-color': dark ? '#000000' : '#ffffff', 'line-width': 5, 'line-opacity': 0.85 } },
		{ id: 'use-line', type: 'line', ...src, filter: ['!', dashed], paint: { 'line-color': dark ? '#eef0ec' : '#1f2320', 'line-width': 2 } },
		{ id: 'use-line-dashed', type: 'line', ...src, filter: dashed, paint: { 'line-color': dark ? '#eef0ec' : '#1f2320', 'line-width': 2, 'line-dasharray': [2, 2] } }
	];
}

/**
 * The hatching as raw RGBA pixels for MapLibre's addImage: diagonal stripes,
 * transparent between them, over the grey fill. `size` px square, stripes
 * every `size / 2` px, so the pattern tiles seamlessly.
 */
export function hatchPixels(dark: boolean, size = 8): { width: number; height: number; data: Uint8Array } {
	const hex = hatchStripe(dark);
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
	const data = new Uint8Array(size * size * 4);
	const period = size / 2;
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			if ((x + y) % period !== 0 && (x + y + 1) % period !== 0) continue;
			const i = (y * size + x) * 4;
			data.set([r, g, b, 255], i);
		}
	return { width: size, height: size, data };
}

/** The bounds of every polygon drawn ([[w, s], [e, n]]), or null with none. */
export function useBounds(s: MapShading): [[number, number], [number, number]] | null {
	let w = Infinity,
		so = Infinity,
		e = -Infinity,
		n = -Infinity;
	const visit = (ring: readonly MapPosition[]) => {
		for (const [x, y] of ring) {
			w = Math.min(w, x);
			e = Math.max(e, x);
			so = Math.min(so, y);
			n = Math.max(n, y);
		}
	};
	for (const u of [...s.drawn, ...s.notInRun])
		for (const p of u.polygons) for (const poly of p.geometry.type === 'Polygon' ? [p.geometry.coordinates] : p.geometry.coordinates) visit(poly[0] ?? []);
	return Number.isFinite(w) ? [[w, so], [e, n]] : null;
}

/** The scheme AllocationMap draws the compared-to-run bands with: their layers, colours and each label's sentence. */
export function useScheme(period: string, measure: MapMeasure): MapScheme {
	return {
		id: 'use',
		layers: useLayers,
		colours: bandColours,
		sentence: (u) => useSentence(u.name, (u as ShadedUnit).use, period, measure),
		ariaLabel: 'Hydrological units shaded by modelled use against the registered volume'
	};
}

/**
 * A unit's figures in one sentence, for its label's accessible name and the
 * list under the map. It holds the label's words (useLabel) in order, so a
 * voice command that says what the label reads reaches it (WCAG 2.5.3).
 */
export function useSentence(name: string, u: UnitUse | null, period: string, measure: MapMeasure = 'use'): string {
	if (measure === 'area') return areaSentence(name, u);
	if (measure === 'storage') return storageMapSentence(name, u);
	if (!u) return `${name}: no whole year; the run covers no whole water year for ${period}.`;
	const m = `${fmtNum(u.modelled)} m³ modelled${u.atIntake ? ' (taken at the intake)' : ''}`;
	if (u.ratio === null) return u.band === 'unregistered' ? `${name}: none registered, ${m} (${period}).` : `${name}: no use, nothing modelled and nothing registered (${period}).`;
	return `${name}: ${fmtNum(u.ratio * 100, 0)} % of registered, ${m} against ${fmtNum(u.registered)} m³ registered (${period}). ${BAND_SHORT[u.band]}.`;
}

function areaSentence(name: string, u: UnitUse | null): string {
	if (!u) return `${name}: no figures; run the model again for the irrigated area.`;
	const planted = `${measureFigure('area', u.modelled)} planted in the run`;
	if (u.ratio === null) return u.band === 'unregistered' ? `${name}: none registered, ${planted}.` : `${name}: no area, nothing planted in the run and no irrigated area registered.`;
	return `${name}: ${fmtNum(u.ratio * 100, 0)} % of registered, ${planted} against ${measureFigure('area', u.registered)} registered. ${MEASURE_BAND_SHORT.area[u.band]}.`;
}

function storageMapSentence(name: string, u: UnitUse | null): string {
	if (!u) return `${name}: no figures.`;
	if (u.ratio === null)
		return u.band === 'unregistered' ? `${name}: none registered, a ${measureFigure('storage', u.modelled)} dam in the run.` : `${name}: no dam in the run and no storage registered.`;
	const dam = u.modelled > NOTHING_M3 ? `a ${measureFigure('storage', u.modelled)} dam in the run` : 'no dam in the run';
	return `${name}: ${fmtNum(u.ratio * 100, 0)} % of registered, ${dam} against ${measureFigure('storage', u.registered)} of storage registered. ${MEASURE_BAND_SHORT.storage[u.band]}.`;
}
