// A shapefile's .shp read into GeoJSON geometries in its own coordinates
// (ESRI Shapefile Technical Description, 1998). The app's own reader, small
// and bounds-checked: shpjs's would have brought every proj4 projection with
// it (proj4lite.ts). Point, PolyLine, Polygon and MultiPoint, and their Z
// and M forms, whose x/y layout is the same (the z and m values after it are
// skipped). A null shape is null; MultiPatch is refused.
//
// A polygon's rings: clockwise ones are outer rings, anticlockwise ones
// holes, each hole given to the smallest outer ring holding its first
// vertex (a hole no outer ring holds is kept as an outer ring of its own,
// as GDAL does). One outer ring is a Polygon, several a MultiPolygon.
import { tooManyFeatures, UploadRefused } from './common';

type XY = [number, number];
export type ShpGeometry = { type: 'Point'; coordinates: XY } | { type: 'MultiPoint' | 'LineString'; coordinates: XY[] } | { type: 'MultiLineString' | 'Polygon'; coordinates: XY[][] } | { type: 'MultiPolygon'; coordinates: XY[][][] };

export const shpUnreadable = (f: string) => `${f} can’t be read: it may be damaged, or hold a kind of shape the map doesn’t take (such as a multipatch).`;

/** The .shp's records (offset and length of each record's content), from its record headers alone; refused past `limit`. */
export function shpRecords(shp: Uint8Array, file: string, limit: number): { at: number; len: number }[] {
	const view = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
	if (shp.length < 100 || view.getInt32(0) !== 9994) throw new UploadRefused(shpUnreadable(file));
	const out: { at: number; len: number }[] = [];
	for (let p = 100; p + 8 <= shp.length; ) {
		const len = view.getInt32(p + 4) * 2;
		if (len < 4 || p + 8 + len > shp.length) throw new UploadRefused(shpUnreadable(file));
		out.push({ at: p + 8, len });
		p += 8 + len;
		if (out.length > limit) throw new UploadRefused(tooManyFeatures(`more than ${limit}`));
	}
	return out;
}

/** Twice the ring's signed area: positive for a clockwise ring (y up). */
function clockwiseArea2(r: XY[]): number {
	let s = 0;
	for (let i = 1; i < r.length; i++) s += (r[i]![0] - r[i - 1]![0]) * (r[i]![1] + r[i - 1]![1]);
	return s;
}

function inRing([x, y]: XY, r: XY[]): boolean {
	let inside = false;
	for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
		const [xi, yi] = r[i]!;
		const [xj, yj] = r[j]!;
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

function polygons(rings: XY[][]): ShpGeometry | null {
	const outers: { ring: XY[]; area: number; holes: XY[][] }[] = [];
	const holes: XY[][] = [];
	for (const r of rings) {
		const a = clockwiseArea2(r);
		if (a > 0) outers.push({ ring: r, area: a, holes: [] });
		else if (a < 0) holes.push(r);
	}
	for (const h of holes) {
		const host = outers.filter((o) => inRing(h[0]!, o.ring)).sort((a, b) => a.area - b.area)[0];
		if (host) host.holes.push(h);
		else outers.push({ ring: [...h].reverse(), area: -clockwiseArea2(h), holes: [] });
	}
	if (!outers.length) return null;
	const polys = outers.map((o) => [o.ring, ...o.holes]);
	return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0]! } : { type: 'MultiPolygon', coordinates: polys };
}

function record(view: DataView, at: number, len: number): ShpGeometry | null {
	const type = view.getInt32(at, true);
	const xy = (o: number): XY => [view.getFloat64(o, true), view.getFloat64(o + 8, true)];
	if (type === 0) return null;
	if (type === 1 || type === 11 || type === 21) {
		if (len < 20) throw new RangeError('short point');
		return { type: 'Point', coordinates: xy(at + 4) };
	}
	if (type === 8 || type === 18 || type === 28) {
		const n = view.getInt32(at + 36, true);
		if (n < 0 || 40 + 16 * n > len) throw new RangeError('short multipoint');
		return n ? { type: 'MultiPoint', coordinates: Array.from({ length: n }, (_, i) => xy(at + 40 + 16 * i)) } : null;
	}
	if (type === 3 || type === 13 || type === 23 || type === 5 || type === 15 || type === 25) {
		const parts = view.getInt32(at + 36, true);
		const n = view.getInt32(at + 40, true);
		const pts = at + 44 + 4 * parts;
		if (parts < 0 || n < 0 || 44 + 4 * parts + 16 * n > len) throw new RangeError('short shape');
		const starts = Array.from({ length: parts }, (_, i) => view.getInt32(at + 44 + 4 * i, true));
		const lines: XY[][] = [];
		for (let i = 0; i < parts; i++) {
			const from = starts[i]!;
			const to = i + 1 < parts ? starts[i + 1]! : n;
			if (from < 0 || to > n || from > to) throw new RangeError('bad part');
			lines.push(Array.from({ length: to - from }, (_, k) => xy(pts + 16 * (from + k))));
		}
		if (!lines.length) return null;
		if (type % 10 === 5) return polygons(lines);
		return lines.length === 1 ? { type: 'LineString', coordinates: lines[0]! } : { type: 'MultiLineString', coordinates: lines };
	}
	throw new RangeError(`shape type ${type}`);
}

/** Every record's geometry (null for a null shape), at most `limit` records. */
export function readShp(shp: Uint8Array, file: string, limit: number): (ShpGeometry | null)[] {
	const view = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
	const records = shpRecords(shp, file, limit);
	try {
		return records.map((r) => record(view, r.at, r.len));
	} catch {
		throw new UploadRefused(shpUnreadable(file));
	}
}
