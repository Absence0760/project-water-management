// Values accepted from the map that an edit to the map has left stale (issue
// #646 item 4, the hydrologist's review F7 and F8; docs/maps.md § Checks):
// a unit's MAP, its rain feed's cells and a planted area from land cover read
// over a polygon redrawn since, an evaporation row summarised over a
// boundary redrawn since, and the rest of the catchment's area worked out
// from the boundary as it was. The server records what each was read over
// (273_acceptance_polygons, backend geo/acceptances.ts); this compares that
// with the map now. The Map's Checks (mapChecks.ts) and the Start data list
// (startData.ts) both read it. Pure.
import type { MapAcceptances, MapFeature, MapNodeArea, PolygonStamp, StartProposal } from '#lib/api/types.js';
import { isPolygon } from './mapData';

/** Two areas of one polygon within this (m²) are one outline: a rename or a relink bumps updatedAt but not the area. backend acceptances.ts OUTLINE_SLACK_M2. */
export const OUTLINE_SLACK_M2 = 0.5;

type Outline = Pick<MapFeature, 'id' | 'updatedAt' | 'areaM2'>;

/**
 * Whether the polygon a value was read over is another outline now (backend acceptances.ts outlineChanged): gone,
 * another feature, or the same one edited since with another area. A rename or a relink keeps the outline.
 */
export function outlineChanged(then: PolygonStamp, now: Outline | null | undefined): boolean {
	if (!now) return true;
	return then.featureId !== now.id || (then.updatedAt !== now.updatedAt && Math.abs(then.areaM2 - (now.areaM2 ?? 0)) > OUTLINE_SLACK_M2);
}

/**
 * A unit's polygon, the rule of backend geo/unitPolygon.ts (issue #646 F1): the feature its area came from (a farm
 * parcel or an other area), else its only linked farm parcel; null with none, or with several and no area feature.
 */
export function unitPolygonOf(n: Pick<MapNodeArea, 'id' | 'areaFeatureId'>, features: readonly MapFeature[]): MapFeature | null {
	const own = n.areaFeatureId ? features.find((f) => f.id === n.areaFeatureId && (f.kind === 'farm_parcel' || f.kind === 'other') && isPolygon(f.geometry)) : undefined;
	if (own) return own;
	const parcels = features.filter((f) => f.kind === 'farm_parcel' && f.nodeId === n.id && isPolygon(f.geometry));
	return parcels.length === 1 ? parcels[0]! : null;
}

/** The catchment boundary a value is read over: the oldest one, as the server picks it. */
export function boundaryOf(features: readonly MapFeature[]): MapFeature | null {
	const all = features.filter((f) => f.kind === 'catchment_boundary' && isPolygon(f.geometry));
	all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
	return all[0] ?? null;
}

export type StaleKind = 'unit-map' | 'unit-rain' | 'land-cover' | 'evaporation';

/** One value read over an outline redrawn since. */
export interface StaleValue {
	kind: StaleKind;
	/** The unit it belongs to (null for evaporation, the catchment's). */
	nodeId: string | null;
	/** The polygon it should be read over now (null when there is none). */
	featureId: string | null;
	/** land-cover: the crop's name; evaporation: what the row is. */
	what?: string;
}

/** Where each stale value is proposed again, and the link's words. */
export const STALE_LINK: Record<StaleKind, { href: string; text: string }> = {
	'unit-map': { href: '?tab=settings#set-unit-map', text: 'MAP from the grid' },
	'unit-rain': { href: '?tab=series&rain=units#data-feeds', text: 'Rain for each unit' },
	'land-cover': { href: '?tab=crops', text: 'Crops' },
	evaporation: { href: '?tab=calibration#set-evaporation', text: 'Evaporation from the map' }
};

/**
 * Every value accepted from the map whose polygon has another outline now, in the order: each unit's MAP, rain and
 * land cover (the model's order), then evaporation. Only the model's land units count (a node deleted since is
 * nobody's). Empty without `accepted` (a server before 273, or nothing accepted).
 */
export function staleValues(features: readonly MapFeature[], nodes: readonly MapNodeArea[], accepted: MapAcceptances | undefined | null): StaleValue[] {
	if (!accepted) return [];
	const out: StaleValue[] = [];
	for (const n of nodes) {
		if (n.kind !== 'farm') continue;
		const now = unitPolygonOf(n, features);
		const nowId = now?.id ?? null;
		const map = accepted.unitMap.find((a) => a.nodeId === n.id);
		if (map && outlineChanged(map.polygon, now)) out.push({ kind: 'unit-map', nodeId: n.id, featureId: nowId });
		// The rain mark keeps its area to 0.001 km² (feeds/fromUnits.ts), so the area is compared at that.
		const rain = accepted.unitRain.find((a) => a.nodeId === n.id);
		if (rain && (!now || rain.featureId !== now.id || (rain.updatedAt !== now.updatedAt && Math.round((now.areaM2 ?? 0) / 1e3) / 1e3 !== rain.areaKm2))) {
			out.push({ kind: 'unit-rain', nodeId: n.id, featureId: nowId });
		}
		for (const lc of accepted.landCover) {
			if (lc.nodeId !== n.id) continue;
			if (lc.polygons.some((p) => outlineChanged(p, features.find((f) => f.id === p.featureId)))) out.push({ kind: 'land-cover', nodeId: n.id, featureId: nowId, what: lc.cropName });
		}
	}
	const boundary = boundaryOf(features);
	for (const e of accepted.evaporation) {
		if (e.boundary && outlineChanged(e.boundary, boundary)) out.push({ kind: 'evaporation', nodeId: null, featureId: boundary?.id ?? null, what: e.target === 'pe' ? 'GR4J’s PE' : 'the A-pan row' });
	}
	return out;
}

/**
 * The rest of the catchment beside units' boundaries (start-16): a land unit Start made with no outline, its area the
 * boundary less the units' as the boundary stood then (issue #646 F8). Read from the applied start proposal: null when
 * there is none, the rest wasn't kept with its area, it had an outline of its own, or it took the effective area.
 */
export interface RestOfCatchment {
	nodeId: string;
	/** The rest's area as Start set it, km². */
	takenKm2: number;
	/** The boundary's area when it was proposed, km². */
	boundaryKm2Then: number;
}

export function restOfCatchment(proposals: readonly { mode: string; status: string; decision: unknown }[] | null | undefined): RestOfCatchment | null {
	const p = proposals?.find((x) => x.mode === 'start' && x.status === 'applied') as Pick<StartProposal, 'plan' | 'decision'> | undefined;
	if (!p) return null;
	const rest = (p.decision as { rest?: { nodeId?: unknown; area?: unknown; areaBasis?: unknown } } | null)?.rest;
	if (!rest || typeof rest.nodeId !== 'string' || rest.area !== true || (rest.areaBasis !== undefined && rest.areaBasis !== 'gross')) return null;
	const { plan } = p;
	if (plan.rest.geometry || plan.rest.areaM2 === null || plan.catchment.boundaryAreaM2 === null) return null;
	return { nodeId: rest.nodeId, takenKm2: plan.rest.areaM2 / 1e6, boundaryKm2Then: plan.catchment.boundaryAreaM2 / 1e6 };
}
