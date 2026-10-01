// The Map tab's list, header line and URL pick (issue #326 E3–E6; docs/ui.md
// § Map). Pure, so the list, the card, the grid modal and the header agree
// and vitest covers them (mapList.test.ts).
import type { MapFeature, MapFeatureKind, MapNodeArea } from '$lib/api/types';
import { areaTargets, areaText, KIND_LABEL, takesArea } from './mapData';

/** The list's groups, in order: the parcels first (what the model's units are), the boundary last (one feature, framed by Show everything). */
export const KIND_ORDER: readonly MapFeatureKind[] = ['farm_parcel', 'dam', 'gauge', 'river', 'other', 'catchment_boundary'];

/** Each group's heading. */
export const GROUP_LABEL: Record<MapFeatureKind, string> = {
	farm_parcel: 'Farm parcels',
	dam: 'Dams',
	gauge: 'Gauges',
	river: 'Rivers',
	other: 'Other',
	catchment_boundary: 'Catchment boundary'
};

export interface FeatureGroup {
	kind: MapFeatureKind;
	label: string;
	features: MapFeature[];
}

/** A feature's name for people: its own, or its kind's. */
export const featureName = (f: Pick<MapFeature, 'name' | 'kind'>) => f.name || KIND_LABEL[f.kind];

/**
 * The features grouped by kind in KIND_ORDER, each group largest first (by
 * area; a point or line, with none, after the polygons), then by name. Stable:
 * the same input gives the same order. Empty groups are left out.
 */
export function groupFeatures(features: readonly MapFeature[]): FeatureGroup[] {
	const byName = (a: MapFeature, b: MapFeature) => featureName(a).localeCompare(featureName(b), undefined, { numeric: true });
	return KIND_ORDER.map((kind) => ({
		kind,
		label: GROUP_LABEL[kind],
		features: features.filter((f) => f.kind === kind).sort((a, b) => (b.areaM2 ?? -1) - (a.areaM2 ?? -1) || byName(a, b))
	})).filter((g) => g.features.length > 0);
}

/** The features in the list's order (the groups, flattened): the grid modal's rows follow it. */
export const inListOrder = (features: readonly MapFeature[]) => groupFeatures(features).flatMap((g) => g.features);

/**
 * Where the area of the unit a feature stands for came from (E6), or null
 * when the feature can't give a unit its area or stands for no unit:
 * - `this`: the unit's area is this feature's (taken from the map);
 * - `other`: from the map, from another feature;
 * - `typed`: typed in on the Network.
 */
export function areaSourceOf(f: MapFeature, nodes: readonly MapNodeArea[]): { node: MapNodeArea; source: 'this' | 'other' | 'typed' } | null {
	if (!takesArea(f)) return null;
	const farms = areaTargets(nodes);
	// A unit that took its area from this feature, linked or not, is the one to name.
	const took = farms.find((n) => n.areaSource === 'map' && n.areaFeatureId === f.id);
	if (took) return { node: took, source: 'this' };
	const linked = f.nodeId ? farms.find((n) => n.id === f.nodeId) : undefined;
	if (!linked) return null;
	return { node: linked, source: linked.areaSource === 'map' ? 'other' : 'typed' };
}

/** That source in a few words, for a list row: "area typed", "area from this parcel", "area from the map". */
export function areaSourceText(s: ReturnType<typeof areaSourceOf>): string | null {
	if (!s) return null;
	return s.source === 'this' ? 'area from the map' : s.source === 'other' ? 'area from another feature' : 'area typed';
}

/**
 * The feature a `node=<nodeId>` link picks: that node's farm parcel (the
 * largest, if it has several), else its first linked feature in the list's
 * order, else null.
 */
export function featureForNode(features: readonly MapFeature[], nodeId: string | null): MapFeature | null {
	if (!nodeId) return null;
	const linked = inListOrder(features).filter((f) => f.nodeId === nodeId);
	return linked.find((f) => f.kind === 'farm_parcel') ?? linked[0] ?? null;
}

/**
 * The picked feature from the URL: `feature=<id>` when it names one, else the
 * one a `node=<nodeId>` link picks (featureForNode), else null.
 */
export function pickedFeature(features: readonly MapFeature[], featureParam: string | null, nodeParam: string | null): MapFeature | null {
	if (featureParam) {
		const f = features.find((x) => x.id === featureParam);
		if (f) return f;
	}
	return featureForNode(features, nodeParam);
}

/** The section header's line: "23 features · boundary 210.22 km² · 0 of 8 unit areas from the map". */
export function headerLine(features: readonly MapFeature[], nodes: readonly MapNodeArea[]): string {
	if (!features.length) return 'Nothing on the map yet';
	const boundary = features.find((f) => f.kind === 'catchment_boundary');
	const farms = areaTargets(nodes);
	const fromMap = farms.filter((n) => n.areaSource === 'map').length;
	return [
		`${features.length} feature${features.length === 1 ? '' : 's'}`,
		boundary ? `boundary ${areaText(boundary.areaM2)}` : 'no boundary',
		...(farms.length ? [`${fromMap} of ${farms.length} unit area${farms.length === 1 ? '' : 's'} from the map`] : [])
	].join(' · ');
}

/** A file's SHA-256 shortened for the screen (the full one is copied and in the tooltip). */
export const shortHash = (sha256: string) => sha256.slice(0, 12);

/** One entry of the map's key: its words, how its swatch is drawn, and its colour (from mapStyle's overlayColours). */
export interface KeyItem {
	label: string;
	swatch: 'dashed' | 'area' | 'dotted' | 'line' | 'gauge' | 'dam' | 'other';
	colour: string;
}

/**
 * The map's key, grouped as the Network's is (#326 E7): Areas, Lines,
 * Points. Colours come from `overlayColours(dark)` so the key can't drift
 * from the map; the point colours follow CatchmentMap's markers (gauge in
 * the water colour, dam in the parcel colour, other in the other colour).
 */
export function keyGroups(c: { boundary: string; parcel: string; water: string; other: string }): { label: string; items: KeyItem[] }[] {
	return [
		{
			label: 'Areas',
			items: [
				{ label: 'catchment boundary', swatch: 'dashed', colour: c.boundary },
				{ label: 'parcel', swatch: 'area', colour: c.parcel },
				{ label: 'dam', swatch: 'area', colour: c.water },
				{ label: 'other', swatch: 'dotted', colour: c.other }
			]
		},
		{ label: 'Lines', items: [{ label: 'river', swatch: 'line', colour: c.water }] },
		{
			label: 'Points',
			items: [
				{ label: 'gauge', swatch: 'gauge', colour: c.water },
				{ label: 'dam', swatch: 'dam', colour: c.parcel },
				{ label: 'other', swatch: 'other', colour: c.other }
			]
		}
	];
}
