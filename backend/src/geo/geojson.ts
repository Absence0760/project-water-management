// GeoJSON in, checked (issue #288, WP-3.12; docs/maps.md § Uploads,
// docs/security.md § Map uploads). Every geometry the server stores passes
// here, whether it came from a file or from a point placed in the app:
//  - WGS84 longitude/latitude only (RFC 7946). A `crs` member naming
//    anything else, or a coordinate outside ±180 / ±90 (a projected file,
//    e.g. a Lo zone), is refused with a message, never guessed;
//  - 2D only: a third coordinate (an elevation) is refused;
//  - Point, LineString, MultiLineString, Polygon, MultiPolygon; anything
//    else (GeometryCollection, MultiPoint, null) is refused;
//  - a polygon's rings are closed, have at least 4 positions and an area,
//    don't cross themselves, and each hole starts inside its outer ring;
//  - at most GEO_MAX_VERTICES positions per feature and GEO_MAX_FEATURES
//    features; the file at most GEO_MAX_BYTES (the route's body limit too).
// A file's problems are listed per feature, so the person can fix them all
// at once. Properties are dropped except FEATURE_PROPERTIES.
import { geometryAreaM2 } from './area.js';

export type Position = [number, number];
export type GeometryType = 'Point' | 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon';
export type Geometry =
	| { type: 'Point'; coordinates: Position }
	| { type: 'LineString'; coordinates: Position[] }
	| { type: 'MultiLineString'; coordinates: Position[][] }
	| { type: 'Polygon'; coordinates: Position[][] }
	| { type: 'MultiPolygon'; coordinates: Position[][][] };

/** Largest GeoJSON file the import takes (bytes of UTF-8). */
export const GEO_MAX_BYTES = 5 * 1024 * 1024;
/** Most positions one feature may have. */
export const GEO_MAX_VERTICES = 50_000;
/** Most features one file may have. */
export const GEO_MAX_FEATURES = 500;
/** Segment pairs the self-intersection check may compare per ring before it gives up and refuses the ring as too complex. */
export const GEO_MAX_PAIR_CHECKS = 5_000_000;
/** Coordinates are kept to 7 decimals (about 1 cm). */
const DECIMALS = 1e7;

/** The feature properties kept from a file, each a string, trimmed and capped. */
export const FEATURE_PROPERTIES = { description: 500, ref: 100 } as const;
/** The property a feature's name is read from, in order. */
const NAME_KEYS = ['name', 'Name', 'NAME', 'label', 'title'];
export const FEATURE_NAME_MAX = 100;

/** The CRS names a GeoJSON 2008 `crs` member may carry that mean WGS84 lon/lat. */
const WGS84_NAMES = new Set(['urn:ogc:def:crs:OGC:1.3:CRS84', 'urn:ogc:def:crs:OGC::CRS84', 'EPSG:4326', 'urn:ogc:def:crs:EPSG::4326', 'urn:ogc:def:crs:EPSG:4326']);

export interface ParsedFeature {
	/** Its place in the file, from 1. */
	index: number;
	geometry: Geometry;
	name: string;
	properties: Record<string, string>;
	/** Geodesic area for polygons (m²), null otherwise. */
	areaM2: number | null;
}

export interface GeoProblem {
	/** The feature's place in the file, from 1; null for the file as a whole. */
	feature: number | null;
	message: string;
}

class Refused extends Error {}

const round = (v: number) => Math.round(v * DECIMALS) / DECIMALS;

function position(p: unknown, count: { n: number }): Position {
	if (!Array.isArray(p) || p.length < 2) throw new Refused('a position is not a [longitude, latitude] pair');
	if (p.length > 2) throw new Refused('has 3D coordinates (an elevation); export the file in 2D');
	const [x, y] = p as unknown[];
	if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Refused('a coordinate is not a number');
	if (x < -180 || x > 180 || y < -90 || y > 90) {
		throw new Refused(`has a coordinate (${x}, ${y}) outside longitude/latitude: the file looks projected (a Lo zone or UTM, say); reproject it to WGS84 (EPSG:4326)`);
	}
	if (++count.n > GEO_MAX_VERTICES) throw new Refused(`has more than ${GEO_MAX_VERTICES.toLocaleString('en-ZA')} positions; simplify it`);
	return [round(x), round(y)];
}

function positions(a: unknown, min: number, what: string, count: { n: number }): Position[] {
	if (!Array.isArray(a)) throw new Refused(`a ${what} is not a list of positions`);
	const out = a.map((p) => position(p, count));
	if (out.length < min) throw new Refused(`a ${what} needs at least ${min} positions`);
	return out;
}

/** Signed planar area of a ring in degrees² (for "has an area" and orientation only). */
function planarArea(r: readonly Position[]): number {
	let s = 0;
	for (let i = 0; i < r.length - 1; i++) s += r[i]![0] * r[i + 1]![1] - r[i + 1]![0] * r[i]![1];
	return s / 2;
}

const orient = (a: Position, b: Position, c: Position) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const onSegment = (a: Position, b: Position, c: Position) =>
	Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);

function segmentsCross(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
	const d1 = orient(p3, p4, p1);
	const d2 = orient(p3, p4, p2);
	const d3 = orient(p1, p2, p3);
	const d4 = orient(p1, p2, p4);
	if (d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) return true;
	return (d1 === 0 && onSegment(p3, p4, p1)) || (d2 === 0 && onSegment(p3, p4, p2)) || (d3 === 0 && onSegment(p1, p2, p3)) || (d4 === 0 && onSegment(p1, p2, p4));
}

/**
 * Whether a closed ring crosses or touches itself (other than neighbouring
 * edges sharing their vertex). A sweep over the edges sorted by their least
 * longitude, comparing only edges whose extents overlap; past
 * GEO_MAX_PAIR_CHECKS comparisons the ring is refused as too complex, so a
 * hostile ring can't cost quadratic time.
 */
export function ringSelfIntersects(ring: readonly Position[]): boolean {
	const n = ring.length - 1; // edges; the ring is closed
	const edges = Array.from({ length: n }, (_, i) => i).sort((a, b) => Math.min(ring[a]![0], ring[a + 1]![0]) - Math.min(ring[b]![0], ring[b + 1]![0]));
	const active: number[] = [];
	let checks = 0;
	for (const i of edges) {
		const a = ring[i]!;
		const b = ring[i + 1]!;
		const minX = Math.min(a[0], b[0]);
		for (let k = active.length - 1; k >= 0; k--) {
			const j = active[k]!;
			if (Math.max(ring[j]![0], ring[j + 1]![0]) < minX) {
				active.splice(k, 1);
				continue;
			}
			const adjacent = Math.abs(i - j) === 1 || Math.abs(i - j) === n - 1;
			if (adjacent) continue;
			const c = ring[j]!;
			const d = ring[j + 1]!;
			if (Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) continue;
			if (++checks > GEO_MAX_PAIR_CHECKS) throw new Refused('has a ring too complex to check; simplify it');
			if (segmentsCross(a, b, c, d)) return true;
		}
		active.push(i);
	}
	return false;
}

/** Whether point `p` lies inside ring `r` (ray casting; on the edge counts as outside). */
export function pointInRing(p: Position, r: readonly Position[]): boolean {
	let inside = false;
	for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
		const [xi, yi] = r[i]!;
		const [xj, yj] = r[j]!;
		if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

function ring(a: unknown, count: { n: number }): Position[] {
	// A position repeated in a row (common in digitised files) is one vertex.
	const r = positions(a, 4, 'polygon ring', count).filter((p, i, all) => i === 0 || p[0] !== all[i - 1]![0] || p[1] !== all[i - 1]![1]);
	if (r.length < 4) throw new Refused('a polygon ring needs at least 4 positions');
	const [f, l] = [r[0]!, r[r.length - 1]!];
	if (f[0] !== l[0] || f[1] !== l[1]) throw new Refused('has a polygon ring that is not closed (its last position must repeat its first)');
	if (planarArea(r) === 0) throw new Refused('has a polygon ring with no area');
	if (ringSelfIntersects(r)) throw new Refused('has a polygon ring that crosses itself');
	return r;
}

function polygon(a: unknown, count: { n: number }): Position[][] {
	if (!Array.isArray(a) || a.length === 0) throw new Refused('a polygon has no rings');
	const rings = a.map((r) => ring(r, count));
	for (const hole of rings.slice(1)) {
		if (!pointInRing(hole[0]!, rings[0]!)) throw new Refused('has a hole outside its polygon');
	}
	const xs = rings[0]!.map((p) => p[0]);
	if (Math.max(...xs) - Math.min(...xs) > 180) throw new Refused('crosses the antimeridian, which isn’t supported');
	return rings;
}

/** A checked geometry, or throws Refused with what is wrong. */
function geometry(g: unknown): Geometry {
	if (g === null || typeof g !== 'object' || Array.isArray(g)) throw new Refused('has no geometry');
	const { type, coordinates } = g as { type?: unknown; coordinates?: unknown };
	const count = { n: 0 };
	switch (type) {
		case 'Point':
			return { type, coordinates: position(coordinates, count) };
		case 'LineString':
			return { type, coordinates: positions(coordinates, 2, 'line', count) };
		case 'MultiLineString':
			if (!Array.isArray(coordinates) || coordinates.length === 0) throw new Refused('a MultiLineString has no lines');
			return { type, coordinates: coordinates.map((l) => positions(l, 2, 'line', count)) };
		case 'Polygon':
			return { type, coordinates: polygon(coordinates, count) };
		case 'MultiPolygon':
			if (!Array.isArray(coordinates) || coordinates.length === 0) throw new Refused('a MultiPolygon has no polygons');
			return { type, coordinates: coordinates.map((p) => polygon(p, count)) };
		default:
			throw new Refused(
				`has a ${typeof type === 'string' ? type : 'missing'} geometry; the map takes Point, LineString, MultiLineString, Polygon and MultiPolygon`
			);
	}
}

/** One geometry, checked: `{ geometry }` or `{ problem }` (a sentence starting lowercase, "has …"). */
export function checkGeometry(g: unknown): { geometry: Geometry; areaM2: number | null } | { problem: string } {
	try {
		const out = geometry(g);
		return { geometry: out, areaM2: geometryAreaM2(out) };
	} catch (e) {
		if (e instanceof Refused) return { problem: e.message };
		throw e;
	}
}

function crsProblem(crs: unknown): string | null {
	if (crs === undefined || crs === null) return null;
	const name = (crs as { properties?: { name?: unknown } })?.properties?.name;
	if (typeof name === 'string' && WGS84_NAMES.has(name)) return null;
	return `The file is in ${typeof name === 'string' ? name : 'a coordinate system it doesn’t name'}; reproject it to WGS84 (EPSG:4326) and upload it again.`;
}

function featureName(props: Record<string, unknown>): string {
	for (const k of NAME_KEYS) {
		const v = props[k];
		if (typeof v === 'string' && v.trim()) return v.trim().slice(0, FEATURE_NAME_MAX);
		if (typeof v === 'number' && Number.isFinite(v)) return String(v);
	}
	return '';
}

function keptProperties(props: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, max] of Object.entries(FEATURE_PROPERTIES)) {
		const v = props[k];
		if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, max);
	}
	return out;
}

/**
 * Parse and check a GeoJSON file's text: a FeatureCollection, one Feature or
 * a bare geometry. Returns every feature that passed and every problem; a
 * caller refuses the file when there is any problem (a half-imported
 * boundary is worse than none).
 */
export function parseGeoJson(text: string): { features: ParsedFeature[]; problems: GeoProblem[] } {
	const whole = (message: string) => ({ features: [], problems: [{ feature: null, message }] });
	if (Buffer.byteLength(text, 'utf8') > GEO_MAX_BYTES) return whole(`The file is larger than ${GEO_MAX_BYTES / 1024 / 1024} MB; simplify it or split it.`);
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return whole('The file is not valid JSON: a GeoJSON file (.geojson or .json) is expected.');
	}
	if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return whole('The file is not a GeoJSON object.');
	const crs = crsProblem((doc as { crs?: unknown }).crs);
	if (crs) return whole(crs);
	const d = doc as { type?: unknown; features?: unknown };
	let raw: unknown[];
	if (d.type === 'FeatureCollection') {
		if (!Array.isArray(d.features)) return whole('The FeatureCollection has no features list.');
		raw = d.features;
	} else if (d.type === 'Feature') raw = [doc];
	else raw = [{ type: 'Feature', geometry: doc, properties: {} }];
	if (raw.length === 0) return whole('The file has no features.');
	if (raw.length > GEO_MAX_FEATURES) return whole(`The file has ${raw.length} features; the most one upload takes is ${GEO_MAX_FEATURES}.`);
	const features: ParsedFeature[] = [];
	const problems: GeoProblem[] = [];
	raw.forEach((f, i) => {
		const index = i + 1;
		if (f === null || typeof f !== 'object' || (f as { type?: unknown }).type !== 'Feature') {
			problems.push({ feature: index, message: 'is not a GeoJSON Feature' });
			return;
		}
		const props = (f as { properties?: unknown }).properties;
		const p = props !== null && typeof props === 'object' && !Array.isArray(props) ? (props as Record<string, unknown>) : {};
		const checked = checkGeometry((f as { geometry?: unknown }).geometry);
		if ('problem' in checked) problems.push({ feature: index, message: checked.problem });
		else features.push({ index, geometry: checked.geometry, name: featureName(p), properties: keptProperties(p), areaM2: checked.areaM2 });
	});
	return { features, problems };
}

/** A point at the middle of a geometry, for a list's "show on map" and the quaternary lookup: a point itself, a polygon's area centroid (its largest part), a line's middle vertex. */
export function centerOf(g: Geometry): Position {
	const centroid = (r: readonly Position[]): Position => {
		let a = 0;
		let cx = 0;
		let cy = 0;
		for (let i = 0; i < r.length - 1; i++) {
			const [x1, y1] = r[i]!;
			const [x2, y2] = r[i + 1]!;
			const k = x1 * y2 - x2 * y1;
			a += k;
			cx += (x1 + x2) * k;
			cy += (y1 + y2) * k;
		}
		return a === 0 ? r[0]! : [round(cx / (3 * a)), round(cy / (3 * a))];
	};
	switch (g.type) {
		case 'Point':
			return g.coordinates;
		case 'LineString':
			return g.coordinates[Math.floor(g.coordinates.length / 2)]!;
		case 'MultiLineString':
			return g.coordinates[0]![Math.floor(g.coordinates[0]!.length / 2)]!;
		case 'Polygon':
			return centroid(g.coordinates[0]!);
		case 'MultiPolygon': {
			const largest = g.coordinates.reduce((best, p) => (Math.abs(planarArea(p[0]!)) > Math.abs(planarArea(best[0]!)) ? p : best));
			return centroid(largest[0]!);
		}
	}
}

/** Whether a point lies in a Polygon or MultiPolygon (inside its outer ring and outside its holes). */
export function pointInGeometry(p: Position, g: Geometry): boolean {
	const inPolygon = (rings: readonly Position[][]) => pointInRing(p, rings[0]!) && !rings.slice(1).some((h) => pointInRing(p, h));
	if (g.type === 'Polygon') return inPolygon(g.coordinates);
	if (g.type === 'MultiPolygon') return g.coordinates.some(inPolygon);
	return false;
}
