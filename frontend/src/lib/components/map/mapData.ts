// The catchment map's data helpers (issue #288, WP-3.12; docs/ui.md §
// Catchment map): labels, bounds, the coordinates form's parsing, what an
// import's refusal says. Pure, so the list, the table and the map agree and
// vitest covers them (mapData.test.ts). No MapLibre here: this module ships
// in the tab's chunk; the map library loads only when the map is drawn.
import type { DamPosition, MapFeature, MapFeatureKind, MapGeometry, MapImportProblem, MapNodeArea, MapPosition } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';

export const KIND_LABEL: Record<MapFeatureKind, string> = {
	catchment_boundary: 'Catchment boundary',
	farm_parcel: 'Farm parcel',
	dam: 'Dam',
	gauge: 'Gauge',
	river: 'River',
	other: 'Other'
};

/** The kinds the coordinates form places (a point). */
export const POINT_KINDS: MapFeatureKind[] = ['gauge', 'dam', 'other'];

/** The node kinds a feature of each kind may stand for (backend geo/routes.ts KIND_NODES). */
export const KIND_NODES: Record<MapFeatureKind, readonly MapNodeArea['kind'][]> = {
	catchment_boundary: [],
	farm_parcel: ['farm', 'user'],
	dam: ['farm', 'user'],
	gauge: ['gauge'],
	river: [],
	other: ['farm', 'user', 'gauge']
};

/** Largest file the import takes (backend geo/geojson.ts GEO_MAX_BYTES). */
export const GEO_MAX_BYTES = 5 * 1024 * 1024;

export const isPolygon = (g: MapGeometry) => g.type === 'Polygon' || g.type === 'MultiPolygon';

/**
 * Whether a feature's polygon may become a hydrological unit's catchment area
 * (the backend's AREA_KINDS, geo/routes.ts): a farm parcel or an "other"
 * polygon, never a dam's water surface or the whole catchment's boundary.
 */
export const takesArea = (f: Pick<MapFeature, 'kind' | 'geometry'>) => (f.kind === 'farm_parcel' || f.kind === 'other') && isPolygon(f.geometry);

/**
 * Whether a feature says where it stands against its river (194, map_feature.dam_position): a dam drawn as its outline only,
 * the one shape Start and Divide place by its own outflow (a point has no footprint).
 */
export const takesDamPosition = (f: Pick<MapFeature, 'kind' | 'geometry'>) => f.kind === 'dam' && isPolygon(f.geometry);

/** The feature sheet's words for a dam's position; '' is unset (its outline decides). */
export const DAM_POSITION_LABEL: Record<DamPosition | '', string> = {
	'': 'Not said (from its outline)',
	on_channel: 'On the river',
	off_channel: 'Off-channel (filled by a pump or a furrow)'
};

/** An area for people: km² with 3 decimals below 10 km², else 2; ha below 1 km². */
export function areaText(m2: number | null): string {
	if (m2 === null) return '–';
	if (m2 < 1e6) return `${fmtNum(m2 / 1e4, 2)} ha`;
	return `${fmtNum(m2 / 1e6, m2 < 1e7 ? 3 : 2)} km²`;
}

/** A position as people write it: 33.6123° S, 21.3402° E. */
export function positionText([lon, lat]: MapPosition): string {
	return `${fmtNum(Math.abs(lat), 4)}° ${lat < 0 ? 'S' : 'N'}, ${fmtNum(Math.abs(lon), 4)}° ${lon < 0 ? 'W' : 'E'}`;
}

/** What a feature is, in a few words: its kind, its shape and size. */
export function featureSummary(f: MapFeature): string {
	if (f.geometry.type === 'Point') return positionText(f.geometry.coordinates);
	if (isPolygon(f.geometry)) {
		const parts = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.length : 1;
		return `${areaText(f.areaM2)}${parts > 1 ? ` in ${parts} parts` : ''}`;
	}
	const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.length : 1;
	return `${lines} line${lines === 1 ? '' : 's'}`;
}

/** [[west, south], [east, north]] of a geometry. */
export function boundsOf(g: MapGeometry): [MapPosition, MapPosition] {
	let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
	const walk = (c: unknown): void => {
		if (Array.isArray(c) && typeof c[0] === 'number') {
			const [x, y] = c as MapPosition;
			x0 = Math.min(x0, x);
			y0 = Math.min(y0, y);
			x1 = Math.max(x1, x);
			y1 = Math.max(y1, y);
		} else if (Array.isArray(c)) c.forEach(walk);
	};
	walk(g.coordinates);
	return [
		[x0, y0],
		[x1, y1]
	];
}

/** The bounds of every feature, or null with none. */
export function boundsOfAll(features: readonly MapFeature[]): [MapPosition, MapPosition] | null {
	if (!features.length) return null;
	const b = features.map((f) => boundsOf(f.geometry));
	return [
		[Math.min(...b.map((x) => x[0][0])), Math.min(...b.map((x) => x[0][1]))],
		[Math.max(...b.map((x) => x[1][0])), Math.max(...b.map((x) => x[1][1]))]
	];
}

/**
 * A coordinate typed in the form, in decimal degrees ("-33.61", "33.61 S",
 * "21,34" with a decimal comma), or why not. `axis` sets the range and the
 * hemisphere letters.
 */
export function parseDegrees(text: string, axis: 'lat' | 'lon'): { value: number } | { error: string } {
	const t = text.trim().toUpperCase().replace(',', '.').replace(/°/g, '');
	const m = /^([+-]?\d+(?:\.\d+)?)\s*([NSEW])?$/.exec(t);
	const name = axis === 'lat' ? 'Latitude' : 'Longitude';
	if (!t) return { error: `Enter the ${name.toLowerCase()}.` };
	if (!m) return { error: `${name} in decimal degrees, e.g. ${axis === 'lat' ? '-33.61 or 33.61 S' : '21.34 or 21.34 E'}.` };
	const letter = m[2];
	if (letter && (axis === 'lat' ? !'NS'.includes(letter) : !'EW'.includes(letter))) return { error: `${name} takes ${axis === 'lat' ? 'N or S' : 'E or W'}.` };
	let v = Number(m[1]);
	if (letter === 'S' || letter === 'W') v = -Math.abs(v);
	const max = axis === 'lat' ? 90 : 180;
	if (Math.abs(v) > max) return { error: `${name} is between −${max} and ${max}.` };
	return { value: v };
}

/** The per-feature problems of a refused import (the API's 422 `details`), or none. */
export function importProblems(details: unknown): MapImportProblem[] {
	if (!Array.isArray(details)) return [];
	return details.filter((d): d is MapImportProblem => !!d && typeof d === 'object' && typeof (d as MapImportProblem).message === 'string');
}

/** One import problem as a sentence: "Feature 3 has 3D coordinates…", or the file's own. */
export const problemText = (p: MapImportProblem) => (p.feature === null ? p.message : `Feature ${p.feature} ${p.message}.`);

/** The farm nodes an area can be accepted into, with where each area came from. */
export const areaTargets = (nodes: readonly MapNodeArea[]) => nodes.filter((n) => n.kind === 'farm');

/** Whether accepting `f`'s area into `n` would change nothing (the same feature already accepted, the same area). */
export const alreadyAccepted = (n: MapNodeArea, f: MapFeature) =>
	n.areaSource === 'map' && n.areaFeatureId === f.id && f.areaM2 !== null && Math.abs(n.areaKm2 - f.areaM2 / 1e6) < 1e-9;
