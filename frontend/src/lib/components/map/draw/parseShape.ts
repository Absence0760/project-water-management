// "Paste a shape" (issue #326 C1; docs/maps.md § Drawing): a shape pasted
// as GeoJSON (a geometry, a Feature, or a FeatureCollection of one feature)
// or as WKT (POINT, LINESTRING, POLYGON, MULTILINESTRING, MULTIPOLYGON, an
// optional `SRID=4326;`), in WGS84 longitude/latitude. It is the way to make a
// shape without a pointer (WCAG 2.1.1, 2.5.7), and the way in for coordinates
// copied from QGIS or a surveyor's file. Pure, so vitest covers it
// (parseShape.test.ts). The server checks the saved geometry again.
import type { MapGeometry, MapPosition } from '$lib/api/types';

export type Parsed = { geometry: MapGeometry } | { error: string };

class Refused extends Error {}

/** Largest paste taken: the same order as an upload's per-feature limit, and plenty for a hand-made shape. */
export const PASTE_MAX_CHARS = 1_000_000;

function position(p: unknown): MapPosition {
	if (!Array.isArray(p) || p.length < 2) throw new Refused('A position isn’t a longitude, latitude pair.');
	if (p.length > 2) throw new Refused('It has 3D coordinates (an elevation); paste it in 2D.');
	const [x, y] = p as unknown[];
	if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Refused('A coordinate isn’t a number.');
	if (x < -180 || x > 180 || y < -90 || y > 90) {
		throw new Refused(`The coordinate (${x}, ${y}) isn’t a longitude and latitude: it looks projected (a Lo zone or UTM); reproject it to WGS84 (EPSG:4326).`);
	}
	return [x, y];
}

function positions(a: unknown, min: number, what: string): MapPosition[] {
	if (!Array.isArray(a)) throw new Refused(`A ${what} isn’t a list of positions.`);
	const out = a.map(position);
	if (out.length < min) throw new Refused(`A ${what} needs at least ${min} positions.`);
	return out;
}

/** A ring, closed if its last position doesn't repeat its first (a pasted outline often leaves it off). */
function ring(a: unknown): MapPosition[] {
	const r = positions(a, 3, 'polygon ring');
	const [f, l] = [r[0]!, r[r.length - 1]!];
	if (f[0] !== l[0] || f[1] !== l[1]) r.push([f[0], f[1]]);
	if (r.length < 4) throw new Refused('A polygon needs at least three corners.');
	return r;
}

function polygon(a: unknown): MapPosition[][] {
	if (!Array.isArray(a) || a.length === 0) throw new Refused('The polygon has no outline.');
	return a.map(ring);
}

/** A geometry from parsed GeoJSON or WKT coordinates, checked. */
function geometry(type: string, coordinates: unknown): MapGeometry {
	switch (type) {
		case 'Point':
			return { type, coordinates: position(coordinates) };
		case 'LineString':
			return { type, coordinates: positions(coordinates, 2, 'line') };
		case 'MultiLineString':
			if (!Array.isArray(coordinates) || !coordinates.length) throw new Refused('The MultiLineString has no lines.');
			return { type, coordinates: coordinates.map((l) => positions(l, 2, 'line')) };
		case 'Polygon':
			return { type, coordinates: polygon(coordinates) };
		case 'MultiPolygon':
			if (!Array.isArray(coordinates) || !coordinates.length) throw new Refused('The MultiPolygon has no polygons.');
			return { type, coordinates: coordinates.map(polygon) };
		default:
			throw new Refused(`It’s a ${type}; the map takes a point, a line or a polygon (or several lines or polygons).`);
	}
}

function fromGeoJson(v: unknown): MapGeometry {
	if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Refused('That isn’t a GeoJSON geometry or feature.');
	const o = v as { type?: unknown; geometry?: unknown; features?: unknown; coordinates?: unknown; crs?: { properties?: { name?: unknown } } };
	const crs = o.crs?.properties?.name;
	if (typeof crs === 'string' && !/(EPSG::?4326|CRS84)$/i.test(crs)) throw new Refused(`It’s in ${crs}; reproject it to WGS84 (EPSG:4326).`);
	if (o.type === 'FeatureCollection') {
		const fs = Array.isArray(o.features) ? o.features : [];
		if (fs.length !== 1) throw new Refused(`It holds ${fs.length} features; paste one shape, or upload the file (Upload GeoJSON) for several.`);
		return fromGeoJson(fs[0]);
	}
	if (o.type === 'Feature') {
		if (!o.geometry) throw new Refused('The feature has no geometry.');
		return fromGeoJson(o.geometry);
	}
	if (typeof o.type !== 'string') throw new Refused('That isn’t a GeoJSON geometry or feature.');
	return geometry(o.type, o.coordinates);
}

const WKT_TYPES: Record<string, MapGeometry['type'] | 'unsupported'> = {
	POINT: 'Point',
	LINESTRING: 'LineString',
	POLYGON: 'Polygon',
	MULTILINESTRING: 'MultiLineString',
	MULTIPOLYGON: 'MultiPolygon',
	MULTIPOINT: 'unsupported',
	GEOMETRYCOLLECTION: 'unsupported'
};

/** WKT's nested lists: "(1 2, 3 4)" → [[1, 2], [3, 4]], "((…), (…))" → [[…], […]]; a bare "1 2" (POINT's) → [1, 2]. */
function wktLists(body: string): unknown {
	let i = 0;
	const s = body;
	const skip = () => {
		while (i < s.length && /\s/.test(s[i]!)) i++;
	};
	const tuple = (): number[] => {
		const start = i;
		while (i < s.length && !/[,()]/.test(s[i]!)) i++;
		const parts = s.slice(start, i).trim().split(/\s+/).filter(Boolean);
		if (!parts.length) throw new Refused('A position in the WKT is empty.');
		return parts.map((t) => {
			const n = Number(t);
			if (!Number.isFinite(n)) throw new Refused(`“${t}” in the WKT isn’t a number.`);
			return n;
		});
	};
	const list = (): unknown[] => {
		// at '('
		i++;
		const out: unknown[] = [];
		for (;;) {
			skip();
			out.push(s[i] === '(' ? list() : tuple());
			skip();
			if (s[i] === ',') {
				i++;
				continue;
			}
			if (s[i] === ')') {
				i++;
				return out;
			}
			throw new Refused('The WKT’s brackets don’t match.');
		}
	};
	skip();
	if (s[i] !== '(') throw new Refused('The WKT needs its coordinates in brackets, as in POLYGON((lon lat, lon lat, …)).');
	const out = list();
	skip();
	if (i !== s.length) throw new Refused('There is text after the WKT’s closing bracket.');
	return out;
}

function fromWkt(text: string): MapGeometry {
	const t = text.replace(/^\s*SRID=(\d+)\s*;/i, (_, srid: string) => {
		if (srid !== '4326') throw new Refused(`It’s in SRID ${srid}; reproject it to WGS84 (EPSG:4326).`);
		return '';
	});
	const m = /^\s*([A-Za-z]+)(?:\s+(ZM|Z|M))?\s*(.*)$/s.exec(t);
	if (!m) throw new Refused('Paste GeoJSON, or WKT such as POLYGON((lon lat, lon lat, …)).');
	const word = m[1]!.toUpperCase();
	const type = WKT_TYPES[word];
	if (!type) throw new Refused('Paste GeoJSON, or WKT such as POLYGON((lon lat, lon lat, …)).');
	if (type === 'unsupported') throw new Refused(`It’s a ${word}; the map takes a point, a line or a polygon (or several lines or polygons).`);
	if (m[2]) throw new Refused('It has 3D coordinates (an elevation); paste it in 2D.');
	const body = m[3]!.trim();
	if (/^EMPTY$/i.test(body)) throw new Refused('The shape is empty.');
	const lists = wktLists(body) as unknown[];
	// POINT(1 2) is a list of one tuple; the other types nest as GeoJSON does.
	return geometry(type, type === 'Point' ? lists[0] : lists);
}

/** A pasted shape: GeoJSON when it starts with `{`, else WKT; `{ error }` says what is wrong, in a sentence. */
export function parseShape(text: string): Parsed {
	const t = text.trim();
	if (!t) return { error: 'Paste a shape first.' };
	if (t.length > PASTE_MAX_CHARS) return { error: 'That is too long to paste; upload it as a GeoJSON file instead.' };
	try {
		if (t.startsWith('{') || t.startsWith('[')) {
			let v: unknown;
			try {
				v = JSON.parse(t);
			} catch {
				return { error: 'That looks like GeoJSON but isn’t valid JSON.' };
			}
			return { geometry: fromGeoJson(v) };
		}
		return { geometry: fromWkt(t) };
	} catch (e) {
		if (e instanceof Refused) return { error: e.message };
		throw e;
	}
}
