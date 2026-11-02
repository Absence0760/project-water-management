// Shapes read from a KML or a shapefile, made into the GeoJSON the Map's
// upload already takes (docs/maps.md § Uploads): the server's checks and
// limits then apply unchanged. The server takes Point, LineString,
// MultiLineString, Polygon and MultiPolygon in 2D, so:
//   - a third coordinate (KML's altitude, a PolygonZ's z) is dropped;
//   - a KML MultiGeometry (a GeometryCollection) becomes one MultiPolygon
//     of its polygons and one MultiLineString of its lines, and each of its
//     points a Point, every piece keeping the placemark's properties;
//   - a MultiPoint becomes its Points;
//   - a placemark or record with no shape is left out and counted.
// Positions are rounded to 7 decimals (about a centimetre), which keeps a
// converted file small; a ring's closing position stays equal to its first.
import { GEO_MAX_FEATURES, tooManyFeatures, UploadRefused } from './common';

type Position = number[];
export interface InFeature {
	geometry: { type: string; coordinates?: unknown; geometries?: unknown } | null | undefined;
	properties?: Record<string, unknown> | null;
}
export interface OutFeature {
	type: 'Feature';
	properties: Record<string, string | number | boolean>;
	geometry: { type: string; coordinates?: unknown; geometries?: unknown };
}
export type Transform = (p: [number, number]) => [number, number];

/** The property names the server reads a name, description or ref from; a file's `NAME` or `Description` is copied to them. */
const NAMED_KEYS = ['name', 'label', 'title', 'description', 'ref'];
/** GeometryCollections nested deeper than this are refused rather than walked. */
const MAX_DEPTH = 8;

const round = (v: number) => Math.round(v * 1e7) / 1e7;

function position(p: unknown, t: Transform | null): Position | unknown {
	if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') return p;
	const [x, y] = t ? t([p[0], p[1]]) : [p[0], p[1]];
	return [round(x), round(y)];
}

/** Every position of a nested coordinate array, made 2D (and transformed). Leaves anything that isn't positions as it is, for the server to refuse. */
function coords(c: unknown, depth: number, t: Transform | null): unknown {
	if (!Array.isArray(c)) return c;
	return depth === 0 ? position(c, t) : c.map((x) => coords(x, depth - 1, t));
}

const DEPTH: Record<string, number> = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };

interface Parts {
	points: unknown[];
	lines: unknown[];
	polygons: unknown[];
	/** A geometry of a type the map doesn't know, kept whole for the server to refuse by name. */
	other: OutFeature['geometry'][];
}

function collect(g: InFeature['geometry'], parts: Parts, depth: number, t: Transform | null) {
	if (!g || typeof g !== 'object') return;
	if (g.type === 'GeometryCollection') {
		if (depth >= MAX_DEPTH) throw new UploadRefused('A shape in this file is nested too deeply to read (a MultiGeometry inside a MultiGeometry, many times over).');
		for (const x of Array.isArray(g.geometries) ? g.geometries : []) collect(x as InFeature['geometry'], parts, depth + 1, t);
		return;
	}
	const d = DEPTH[g.type];
	if (d === undefined || !Array.isArray(g.coordinates)) {
		parts.other.push(g);
		return;
	}
	const c = coords(g.coordinates, d, t) as unknown[];
	if (g.type === 'Point') parts.points.push(c);
	else if (g.type === 'MultiPoint') parts.points.push(...c);
	else if (g.type === 'LineString') parts.lines.push(c);
	else if (g.type === 'MultiLineString') parts.lines.push(...c);
	else if (g.type === 'Polygon') parts.polygons.push(c);
	else parts.polygons.push(...c);
}

/** A feature's properties: plain values only, with a `NAME`/`Description` also under the lowercase key the server reads. */
export function plainProperties(props: Record<string, unknown> | null | undefined): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	for (const [k, v] of Object.entries(props ?? {})) {
		if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
	}
	for (const key of NAMED_KEYS) {
		if (key in out) continue;
		const other = Object.keys(out).find((k) => k.toLowerCase() === key);
		if (other !== undefined) out[key] = out[other]!;
	}
	return out;
}

/**
 * The features as the upload's GeoJSON, and how many had no shape and were
 * left out. Refuses more than GEO_MAX_FEATURES features (counted after
 * splitting), so a file over the server's limit isn't sent.
 */
export function toUploadFeatures(features: Iterable<InFeature>, t: Transform | null = null): { features: OutFeature[]; noShape: number } {
	const out: OutFeature[] = [];
	let noShape = 0;
	for (const f of features) {
		const parts: Parts = { points: [], lines: [], polygons: [], other: [] };
		collect(f.geometry, parts, 0, t);
		const properties = plainProperties(f.properties);
		const geometries: OutFeature['geometry'][] = [];
		if (parts.polygons.length) geometries.push(parts.polygons.length === 1 ? { type: 'Polygon', coordinates: parts.polygons[0] } : { type: 'MultiPolygon', coordinates: parts.polygons });
		if (parts.lines.length) geometries.push(parts.lines.length === 1 ? { type: 'LineString', coordinates: parts.lines[0] } : { type: 'MultiLineString', coordinates: parts.lines });
		for (const p of parts.points) geometries.push({ type: 'Point', coordinates: p });
		geometries.push(...parts.other);
		if (!geometries.length) noShape++;
		for (const geometry of geometries) {
			if (out.length >= GEO_MAX_FEATURES) throw new UploadRefused(tooManyFeatures(`more than ${GEO_MAX_FEATURES}`));
			out.push({ type: 'Feature', properties: { ...properties }, geometry });
		}
	}
	return { features: out, noShape };
}

/** Whether every position of the features is a longitude/latitude pair in range (a shapefile with no .prj may be read as one only then). */
export function allLonLat(features: readonly InFeature[]): boolean {
	let seen = false;
	const walk = (c: unknown): boolean => {
		if (!Array.isArray(c)) return true;
		if (typeof c[0] === 'number') {
			seen = true;
			const [x, y] = c as number[];
			return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x!) <= 180 && Math.abs(y!) <= 90;
		}
		return c.every(walk);
	};
	const geom = (g: InFeature['geometry']): boolean =>
		!g ? true : g.type === 'GeometryCollection' ? (Array.isArray(g.geometries) ? g.geometries : []).every((x) => geom(x as InFeature['geometry'])) : walk(g.coordinates);
	return features.every((f) => geom(f.geometry)) && seen;
}
