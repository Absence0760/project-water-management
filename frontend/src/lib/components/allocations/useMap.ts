// The Allocations tab's map (issue #510, docs/allocations.md § The map): each
// hydrological unit's polygon shaded by its modelled use ÷ its registered
// volume. Pure, unit-tested in useMap.test.ts; AllocationMap.svelte draws it.
//
// It only reads the comparison (engine compareAllocations, the same figures
// as the table, so the map can't disagree with it) and the Map tab's unit
// polygons (a farm_parcel linked to the unit, docs/maps.md § Hydrological
// units layer). The bands are fixed for this map and separate from the
// table's ±tolerance status, which also calls 0.9–1.0 "within". The wording
// never says "lawful" or "compliant" (allocations.ts).
import { USE_BANDS, useBand, type AllocationComparison, type AllocationNodeComparison, type UseBand } from '@water-management/engine';
import type { MapFeature, MapGeometry, MapPosition } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';
import { interiorPoint } from '$lib/components/map/pieces';

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

/** One unit's use against its volume for the picked source and period; null when the run covers no such whole year. */
export interface UnitUse {
	modelledM3: number;
	registeredM3: number;
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
	let modelledM3 = 0;
	let registeredM3 = 0;
	for (const side of sides) {
		if (waterYear === null) {
			if (side.wholeYears === 0) return null;
			modelledM3 += side.meanModelledM3PerYear ?? 0;
			registeredM3 += side.meanRegisteredM3PerYear ?? 0;
		} else {
			const y = side.years.find((x) => x.waterYear === waterYear && !x.partial);
			if (!y) return null;
			modelledM3 += y.modelledM3;
			registeredM3 += y.registeredM3;
		}
	}
	const atIntake = sides.some((side) => side.measuredAt === 'intake');
	return { modelledM3, registeredM3, ratio: registeredM3 > NOTHING_M3 ? modelledM3 / registeredM3 : null, band: useBand(modelledM3, registeredM3), ...(atIntake ? { atIntake } : {}) };
}

/** The label a unit carries on the map: its % of registered ("132 %"), or the band in a word or two. */
export function useLabel(u: Pick<UnitUse, 'ratio' | 'band'> | null): string {
	if (!u) return 'No whole year';
	if (u.ratio !== null) return `${fmtNum(u.ratio * 100, 0)} %`;
	return u.band === 'unregistered' ? 'None registered' : 'No use';
}

type Polygonal = Extract<MapGeometry, { type: 'Polygon' | 'MultiPolygon' }>;
const isPolygonal = (g: MapGeometry): g is Polygonal => g.type === 'Polygon' || g.type === 'MultiPolygon';

/** One unit as the map and its list show it. */
export interface ShadedUnit {
	nodeId: string;
	name: string;
	/** Null: the run covers no whole year of the picked period. */
	use: UnitUse | null;
	band: UseBand | null;
	label: string;
	/** Its polygons (each linked farm_parcel); empty when it has none on the Map tab. */
	polygons: { featureId: string; geometry: Polygonal }[];
	/** Where its label sits: inside its largest polygon; null without one. */
	at: MapPosition | null;
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
export function useShading(c: AllocationComparison, features: readonly MapFeature[], source: UseSource, waterYear: number | null): UseShading {
	const byNode = new Map<string, { featureId: string; geometry: Polygonal; area: number }[]>();
	for (const f of features) {
		if (f.kind !== 'farm_parcel' || !f.nodeId || !isPolygonal(f.geometry)) continue;
		const list = byNode.get(f.nodeId) ?? [];
		list.push({ featureId: f.id, geometry: f.geometry, area: f.areaM2 ?? 0 });
		byNode.set(f.nodeId, list);
	}
	const placed = (nodeId: string) => {
		const ps = (byNode.get(nodeId) ?? []).slice().sort((a, b) => b.area - a.area);
		return { polygons: ps.map(({ featureId, geometry }) => ({ featureId, geometry })), at: ps[0] ? interiorPoint(ps[0].geometry) : null };
	};
	const drawn: ShadedUnit[] = [];
	const unplaced: ShadedUnit[] = [];
	const inRun = new Set<string>();
	for (const n of c.nodes) {
		inRun.add(n.nodeId);
		const use = unitUse(n, source, waterYear);
		const p = placed(n.nodeId);
		const u: ShadedUnit = { nodeId: n.nodeId, name: n.name, use, band: use?.band ?? null, label: useLabel(use), ...p };
		(p.polygons.length ? drawn : unplaced).push(u);
	}
	const rank = (u: ShadedUnit) => (u.band ? BAND_RANK[u.band] : 6);
	unplaced.sort((a, b) => rank(a) - rank(b) || (b.use?.ratio ?? 0) - (a.use?.ratio ?? 0) || a.name.localeCompare(b.name));
	const names = new Map(features.filter((f) => f.nodeId && f.nodeName).map((f) => [f.nodeId!, f.nodeName!]));
	const notInRun: UnitNotInRun[] = [...byNode.keys()]
		.filter((id) => !inRun.has(id))
		.map((id) => ({ nodeId: id, name: names.get(id) ?? 'A hydrological unit', ...placed(id) }))
		.sort((a, b) => a.name.localeCompare(b.name));
	return { drawn, unplaced, notInRun };
}

/** The map's GeoJSON: each drawn unit's polygons with its band, and the polygons of units not in the run. */
export function useMapData(s: UseShading) {
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
export function useBounds(s: UseShading): [[number, number], [number, number]] | null {
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

/** A unit's figures in one sentence, for its label's accessible name and the list under the map. */
export function useSentence(name: string, u: UnitUse | null, period: string): string {
	if (!u) return `${name}: the run covers no whole water year for ${period}.`;
	const m = `${fmtNum(u.modelledM3)} m³ modelled${u.atIntake ? ' (taken at the intake)' : ''}`;
	if (u.ratio === null) return u.band === 'unregistered' ? `${name}: ${m}, with no registered volume (${period}).` : `${name}: no modelled use and nothing registered (${period}).`;
	return `${name}: ${fmtNum(u.ratio * 100, 0)} % of registered, ${m} against ${fmtNum(u.registeredM3)} m³ registered (${period}). ${BAND_SHORT[u.band]}.`;
}
