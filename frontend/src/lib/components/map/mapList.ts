// The Map tab's list, header line and URL pick (issue #326 E3–E6; docs/ui.md
// § Map). Pure, so the list, the card, the grid modal and the header agree
// and vitest covers them (mapList.test.ts).
import type { MapFeature, MapFeatureKind, MapNodeArea } from '$lib/api/types';
import { alreadyAccepted, areaTargets, areaText, KIND_LABEL, takesArea } from './mapData';

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
 * - `this`: the unit's area is this feature's (taken from the map); `earlier`
 *   when the feature was reshaped or split since, so the unit still has the
 *   old outline's area until Use is pressed again (docs/maps.md § Areas);
 * - `other`: from the map, from another feature;
 * - `typed`: typed in on the Network.
 */
export function areaSourceOf(f: MapFeature, nodes: readonly MapNodeArea[]): { node: MapNodeArea; source: 'this' | 'other' | 'typed'; earlier?: boolean } | null {
	if (!takesArea(f)) return null;
	const farms = areaTargets(nodes);
	// A unit that took its area from this feature, linked or not, is the one to name.
	const took = farms.find((n) => n.areaSource === 'map' && n.areaFeatureId === f.id);
	if (took) return alreadyAccepted(took, f) ? { node: took, source: 'this' } : { node: took, source: 'this', earlier: true };
	const linked = f.nodeId ? farms.find((n) => n.id === f.nodeId) : undefined;
	if (!linked) return null;
	return { node: linked, source: linked.areaSource === 'map' ? 'other' : 'typed' };
}

/** That source in a few words, for a list row: "area typed", "area from the map", "area from an earlier outline". */
export function areaSourceText(s: ReturnType<typeof areaSourceOf>): string | null {
	if (!s) return null;
	return s.source === 'this' ? (s.earlier ? 'area from an earlier outline' : 'area from the map') : s.source === 'other' ? 'area from another feature' : 'area typed';
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

/** One entry of the map's key: its words, how its swatch is drawn, its colour (from mapStyle's overlayColours), and what it is for when its name alone doesn't say. */
export interface KeyItem {
	label: string;
	swatch: 'dashed' | 'area' | 'dotted' | 'line' | 'gauge' | 'dam' | 'other';
	colour: string;
	/** A few plain words after the name ("where your click goes; the outline follows these"). */
	note?: string;
}

/** The key entry of the elevation model's channels while Delineate, Sub-catchments or a delineated proposal shows them (issue #374). */
export const CHANNEL_KEY_LABEL = 'terrain channels';
export const CHANNEL_KEY_NOTE = 'where your click goes; the outline follows these';
/** The River network's note beside the channels: the operator asked which of the two lines a catchment follows. */
export const RIVER_NETWORK_BESIDE_CHANNELS_NOTE = 'mapped rivers, for reference only; they can sit off the terrain channels';

/**
 * The two lines a delineation shows, in plain words, for the delineate and click bars (where the eye is
 * while clicking) and the key: the terrain channels the outline follows, then the mapped rivers while the
 * River network layer is on. Colours from mapStyle (channelColour, riverNetworkColour).
 */
export function delineationLines(colours: { channels: string; riverNetwork?: string | null }): KeyItem[] {
	return [
		{ label: CHANNEL_KEY_LABEL, swatch: 'line', colour: colours.channels, note: CHANNEL_KEY_NOTE },
		...(colours.riverNetwork ? [{ label: 'river network', swatch: 'dashed' as const, colour: colours.riverNetwork, note: RIVER_NETWORK_BESIDE_CHANNELS_NOTE }] : [])
	];
}

/**
 * The map's key, grouped as the Network's is (#326 E7): Areas, Lines,
 * Points. Colours come from `overlayColours(dark)` so the key can't drift
 * from the map; the point colours follow CatchmentMap's markers (gauges and dams
 * are water, told apart by shape; other in the other colour). With the River
 * network layer on, its dashed line joins the Lines; while the elevation
 * model's channels are drawn (Delineate, Sub-catchments, a delineated
 * proposal), they lead the Lines and both say what they are for
 * (delineationLines), so the two kinds of line are never a mystery.
 */
export function keyGroups(
	c: { boundary: string; parcel: string; water: string; other: string },
	layers: { riverNetwork?: string | null; channels?: string | null } = {}
): { label: string; items: KeyItem[] }[] {
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
		{
			label: 'Lines',
			items: layers.channels
				? [...delineationLines({ channels: layers.channels, riverNetwork: layers.riverNetwork }), { label: 'river', swatch: 'line', colour: c.water }]
				: [
						{ label: 'river', swatch: 'line', colour: c.water },
						// The River network layer (#345), while it is on: dashed, in its own colour (mapStyle.ts riverNetworkColour).
						...(layers.riverNetwork ? [{ label: 'river network', swatch: 'dashed' as const, colour: layers.riverNetwork }] : [])
					]
		},
		{
			label: 'Points',
			items: [
				{ label: 'gauge', swatch: 'gauge', colour: c.water },
				{ label: 'dam', swatch: 'dam', colour: c.water },
				{ label: 'other', swatch: 'other', colour: c.other }
			]
		}
	];
}

/** Which features a key entry stands for (group, then label), so the key lists only what the map draws. */
function keyEntryDrawn(group: string, label: string, f: MapFeature): boolean {
	const point = f.geometry.type === 'Point';
	const line = f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString';
	if (group === 'Points') return point && (label === 'gauge' ? f.kind === 'gauge' : label === 'dam' ? f.kind === 'dam' : f.kind === 'other');
	if (group === 'Lines') return label === 'river' && f.kind === 'river' && line;
	if (point) return false;
	if (label === 'catchment boundary') return f.kind === 'catchment_boundary';
	if (label === 'parcel') return f.kind === 'farm_parcel';
	if (label === 'dam') return f.kind === 'dam';
	// "other": an other area, or an other line (drawn dotted like it).
	return f.kind === 'other';
}

/**
 * The key cut to what is on the map: each entry only while a feature it stands
 * for is drawn, a group only while it has an entry. A layer's own entry (the
 * River network's dashed line, the terrain channels) stays while the layer is
 * on: it draws its own lines, not the project's features.
 */
export function presentKey(groups: { label: string; items: KeyItem[] }[], features: readonly MapFeature[]): { label: string; items: KeyItem[] }[] {
	return groups
		.map((g) => ({ ...g, items: g.items.filter((i) => i.label === 'river network' || i.label === CHANNEL_KEY_LABEL || features.some((f) => keyEntryDrawn(g.label, i.label, f))) }))
		.filter((g) => g.items.length > 0);
}

/** What turns a catchment boundary on the map into the model: the sheet it opens, its button, and one line on what it does. */
export interface BoundaryNextStep {
	sheet: 'start' | 'divide';
	label: string;
	text: string;
}

/**
 * The next step after a boundary is on the map (the operator asked "how does the catchment I create end up in
 * the network?": accepting saves a map feature only). Start from the map while the model is empty, Divide the
 * model once it has nodes (with an elevation model), each reviewed again while a proposal waits; null for a
 * viewer, with neither offered, or once a unit already took its area from the map (the map and the model are
 * joined, so there is nothing to point to).
 */
export function boundaryNextStep(s: { canStart: boolean; canDivide: boolean; pendingStart: boolean; pendingDivide: boolean; unitAreasFromMap: number }): BoundaryNextStep | null {
	const lead = 'This boundary is on the map, not in the model yet.';
	if (s.canStart)
		return {
			sheet: 'start',
			label: s.pendingStart ? 'Review the proposed model' : 'Start from the map',
			text: `${lead} Start from the map proposes the model’s units from it: each unit’s area at your dams, abstraction points and gauges, for you to tick.`
		};
	if (s.canDivide && s.unitAreasFromMap === 0)
		return {
			sheet: 'divide',
			label: s.pendingDivide ? 'Review the proposed division' : 'Divide the model',
			text: `${lead} Divide the model splits it into each unit’s area at your dams, abstraction points and gauges, for you to tick.`
		};
	return null;
}
