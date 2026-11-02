// Synthetic upload fixtures, built byte by byte (the Map's KML and shapefile
// upload; docs/maps.md § Uploads). Invented shapes and names only: the repo
// is public. A shapefile (.shp, .shx, .dbf) and a zip are written here from
// their specs rather than with a library, so the reader is tested against
// files it didn't make. Tests only (node:zlib).
//
// fixtures.test.ts checks the committed files beside this one (used by the
// e2e spec map-upload-formats.spec.ts) are what these builders make;
// `UPDATE_UPLOAD_FIXTURES=1` rewrites them.
import { crc32, deflateRawSync } from 'node:zlib';

export type XY = [number, number];
export type Shape = { type: 'point'; at: XY } | { type: 'line'; points: XY[] } | { type: 'polygon'; rings: XY[][] } | { type: 'null' };

const SHP_TYPE = { point: 1, line: 3, polygon: 5 } as const;

function content(s: Shape): Uint8Array {
	if (s.type === 'null') return new Uint8Array(4); // shape type 0
	if (s.type === 'point') {
		const b = new DataView(new ArrayBuffer(20));
		b.setInt32(0, 1, true);
		b.setFloat64(4, s.at[0], true);
		b.setFloat64(12, s.at[1], true);
		return new Uint8Array(b.buffer);
	}
	const parts = s.type === 'line' ? [s.points] : s.rings;
	const pts = parts.flat();
	const b = new DataView(new ArrayBuffer(44 + 4 * parts.length + 16 * pts.length));
	b.setInt32(0, SHP_TYPE[s.type], true);
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	[Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => b.setFloat64(4 + 8 * i, v, true));
	b.setInt32(36, parts.length, true);
	b.setInt32(40, pts.length, true);
	let start = 0;
	parts.forEach((p, i) => {
		b.setInt32(44 + 4 * i, start, true);
		start += p.length;
	});
	pts.forEach((p, i) => {
		b.setFloat64(44 + 4 * parts.length + 16 * i, p[0], true);
		b.setFloat64(44 + 4 * parts.length + 16 * i + 8, p[1], true);
	});
	return new Uint8Array(b.buffer);
}

function header(type: number, words: number, all: XY[]): DataView {
	const h = new DataView(new ArrayBuffer(100));
	h.setInt32(0, 9994);
	h.setInt32(24, words);
	h.setInt32(28, 1000, true);
	h.setInt32(32, type, true);
	const xs = all.map((p) => p[0]);
	const ys = all.map((p) => p[1]);
	if (all.length) [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => h.setFloat64(36 + 8 * i, v, true));
	return h;
}

const cat = (parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
};

/** A layer's .shp and .shx: every shape the same type (or null). */
export function shapefile(shapes: Shape[]): { shp: Uint8Array; shx: Uint8Array } {
	const kind = shapes.find((s) => s.type !== 'null')?.type ?? 'point';
	const type = SHP_TYPE[kind as keyof typeof SHP_TYPE];
	const all = shapes.flatMap((s) => (s.type === 'point' ? [s.at] : s.type === 'line' ? s.points : s.type === 'polygon' ? s.rings.flat() : []));
	const records: Uint8Array[] = [];
	const index: Uint8Array[] = [];
	let offset = 50; // words
	shapes.forEach((s, i) => {
		const c = content(s);
		const rh = new DataView(new ArrayBuffer(8));
		rh.setInt32(0, i + 1);
		rh.setInt32(4, c.length / 2);
		records.push(new Uint8Array(rh.buffer), c);
		const ix = new DataView(new ArrayBuffer(8));
		ix.setInt32(0, offset);
		ix.setInt32(4, c.length / 2);
		index.push(new Uint8Array(ix.buffer));
		offset += 4 + c.length / 2;
	});
	const shp = cat([new Uint8Array(header(type, offset, all).buffer), ...records]);
	const shx = cat([new Uint8Array(header(type, 50 + 4 * shapes.length, all).buffer), ...index]);
	return { shp, shx };
}

/** A .dbf of text fields (dBASE III), one row per record. */
export function dbf(fields: string[], rows: string[][]): Uint8Array {
	const width = fields.map((f, i) => Math.max(1, ...rows.map((r) => new TextEncoder().encode(r[i] ?? '').length)));
	const headerLen = 32 + 32 * fields.length + 1;
	const recordLen = 1 + width.reduce((s, w) => s + w, 0);
	const out = new Uint8Array(headerLen + recordLen * rows.length + 1);
	const v = new DataView(out.buffer);
	out[0] = 0x03;
	out[1] = 126; // 2026
	out[2] = 1;
	out[3] = 1;
	v.setUint32(4, rows.length, true);
	v.setUint16(8, headerLen, true);
	v.setUint16(10, recordLen, true);
	fields.forEach((f, i) => {
		const at = 32 + 32 * i;
		out.set(new TextEncoder().encode(f.slice(0, 10)), at);
		out[at + 11] = 'C'.charCodeAt(0);
		out[at + 16] = width[i]!;
	});
	out[headerLen - 1] = 0x0d;
	rows.forEach((r, j) => {
		let at = headerLen + recordLen * j;
		out[at++] = 0x20;
		fields.forEach((_, i) => {
			const bytes = new TextEncoder().encode((r[i] ?? '').padEnd(width[i]!, ' '));
			out.set(bytes.subarray(0, width[i]!), at);
			out.fill(0x20, at + bytes.length, at + width[i]!);
			at += width[i]!;
		});
	});
	out[out.length - 1] = 0x1a;
	return out;
}

export interface ZipFile {
	name: string;
	data: Uint8Array | string;
	/** Stored (0) instead of deflated (8, the default). */
	store?: boolean;
	/** The uncompressed size the headers claim, when it should lie. */
	claimSize?: number;
	/** Flag the entry encrypted (its data isn't). */
	encrypted?: boolean;
}

/** A zip of the files, with a fixed date so the bytes don't change between builds. */
export function zip(files: ZipFile[]): Uint8Array {
	const locals: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const f of files) {
		const raw = typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data;
		const body = f.store ? raw : new Uint8Array(deflateRawSync(raw));
		const name = new TextEncoder().encode(f.name);
		const crc = crc32(raw);
		const size = f.claimSize ?? raw.length;
		const flags = (f.encrypted ? 1 : 0) | 0x800;
		const method = f.store ? 0 : 8;
		const l = new DataView(new ArrayBuffer(30));
		l.setUint32(0, 0x04034b50, true);
		l.setUint16(4, 20, true);
		l.setUint16(6, flags, true);
		l.setUint16(8, method, true);
		l.setUint16(10, 0, true);
		l.setUint16(12, 0x5c21, true); // 2026-01-01
		l.setUint32(14, crc, true);
		l.setUint32(18, body.length, true);
		l.setUint32(22, size, true);
		l.setUint16(26, name.length, true);
		locals.push(new Uint8Array(l.buffer), name, body);
		const c = new DataView(new ArrayBuffer(46));
		c.setUint32(0, 0x02014b50, true);
		c.setUint16(4, 20, true);
		c.setUint16(6, 20, true);
		c.setUint16(8, flags, true);
		c.setUint16(10, method, true);
		c.setUint16(14, 0x5c21, true);
		c.setUint32(16, crc, true);
		c.setUint32(20, body.length, true);
		c.setUint32(24, size, true);
		c.setUint16(28, name.length, true);
		c.setUint32(42, offset, true);
		central.push(new Uint8Array(c.buffer), name);
		offset += 30 + name.length + body.length;
	}
	const cd = cat(central);
	const e = new DataView(new ArrayBuffer(22));
	e.setUint32(0, 0x06054b50, true);
	e.setUint16(8, files.length, true);
	e.setUint16(10, files.length, true);
	e.setUint32(12, cd.length, true);
	e.setUint32(16, offset, true);
	return cat([...locals, cd, new Uint8Array(e.buffer)]);
}

/** A layer's files for a zip: base.shp, .shx, .dbf and (when given) .prj. */
export function layerFiles(base: string, shapes: Shape[], fields: string[], rows: string[][], prj?: string): ZipFile[] {
	const { shp, shx } = shapefile(shapes);
	return [
		{ name: `${base}.shp`, data: shp },
		{ name: `${base}.shx`, data: shx },
		{ name: `${base}.dbf`, data: dbf(fields, rows) },
		...(prj ? [{ name: `${base}.prj`, data: prj }] : [])
	];
}

// ── Coordinate systems, as the .prj files QGIS (GDAL) and ArcGIS (Esri) write them ──

/** Hartebeesthoek94 / Lo19 (EPSG:2048), as GDAL writes it: south-orientated, westing and southing. */
export const LO19_GDAL =
	'PROJCS["Hartebeesthoek94 / Lo19",GEOGCS["Hartebeesthoek94",DATUM["Hartebeesthoek94",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],TOWGS84[0,0,0,0,0,0,0],AUTHORITY["EPSG","6148"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4148"]],PROJECTION["Transverse_Mercator_South_Orientated"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",19],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Westing",WEST],AXIS["Southing",SOUTH],AUTHORITY["EPSG","2048"]]';
/** The same zone as Esri writes it: plain Transverse Mercator, x east and y north (both negative here). */
export const LO19_ESRI =
	'PROJCS["Hartebeesthoek94_Lo19",GEOGCS["GCS_Hartebeesthoek_1994",DATUM["D_Hartebeesthoek_1994",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",19.0],PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
export const UTM34S_ESRI =
	'PROJCS["WGS_1984_UTM_Zone_34S",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",21.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
export const WGS84_ESRI =
	'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
/** The old Cape datum on Clarke 1880, with no TOWGS84: no shift proj4 could apply. */
export const CAPE_NO_SHIFT =
	'GEOGCS["GCS_Cape",DATUM["D_Cape",SPHEROID["Clarke_1880_Arc",6378249.145,293.4663077]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/**
 * A point whose Lo19 coordinates are known: 19.5° E, 33.5° S is 46 461.504 m
 * east of the central meridian and 3 708 314.396 m south of the equator
 * (Transverse Mercator, scale 1 on the meridian), so westing −46 461.504,
 * southing 3 708 314.396.
 */
export const LO19_REFERENCE = { lonLat: [19.5, -33.5] as XY, eastNorth: [46461.504, -3708314.396] as XY };

/** A square of `side` metres with its north-west corner at the reference point, clockwise, in Lo19 westing/southing. */
export function lo19Square(side: number, dx = 0, dy = 0): XY[] {
	const [e, n] = LO19_REFERENCE.eastNorth;
	const ws = (x: number, y: number): XY => [-(e + dx + x), -(n - dy + y)];
	// Clockwise in east/north (north-west, north-east, south-east, south-west); turning both axes keeps it clockwise.
	return [ws(0, 0), ws(side, 0), ws(side, -side), ws(0, -side), ws(0, 0)];
}

/** Two invented parcels in Lo19 (GDAL's .prj), names in the .dbf. Committed stored (`store`), so its bytes don't hang on zlib's version. */
export const lo19ParcelsZip = (store = false) =>
	zip(
		layerFiles(
			'synthetic-parcels',
			[
				{ type: 'polygon', rings: [lo19Square(2000)] },
				{ type: 'polygon', rings: [lo19Square(1000, 3000, 0)] }
			],
			['NAME', 'KIND'],
			[
				['Synthetic parcel A', 'farm parcel'],
				['Synthetic parcel B', 'farm parcel']
			],
			LO19_GDAL
		).map((f) => ({ ...f, store }))
	);

/** A KML of an invented dam outline (with altitudes), a MultiGeometry (two fields and a pump), a river and an empty placemark. */
export const SYNTHETIC_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
	<name>Synthetic farm</name>
	<Folder>
		<name>Dams</name>
		<Placemark>
			<name>Synthetic dam</name>
			<description>Invented outline</description>
			<ExtendedData><Data name="kind"><value>dam</value></Data><Data name="ref"><value>SD-1</value></Data></ExtendedData>
			<Polygon><outerBoundaryIs><LinearRing><coordinates>
				19.50,-33.50,120 19.51,-33.50,120 19.51,-33.51,120 19.50,-33.51,120 19.50,-33.50,120
			</coordinates></LinearRing></outerBoundaryIs></Polygon>
		</Placemark>
	</Folder>
	<Placemark>
		<name>Synthetic fields</name>
		<MultiGeometry>
			<Polygon><outerBoundaryIs><LinearRing><coordinates>19.52,-33.50 19.53,-33.50 19.53,-33.51 19.52,-33.51 19.52,-33.50</coordinates></LinearRing></outerBoundaryIs></Polygon>
			<Polygon><outerBoundaryIs><LinearRing><coordinates>19.54,-33.50 19.55,-33.50 19.55,-33.51 19.54,-33.51 19.54,-33.50</coordinates></LinearRing></outerBoundaryIs></Polygon>
			<Point><coordinates>19.525,-33.515,0</coordinates></Point>
		</MultiGeometry>
	</Placemark>
	<Placemark>
		<name>Synthetic stream</name>
		<ExtendedData><SchemaData schemaUrl="#s"><SimpleData name="layer">streams</SimpleData></SchemaData></ExtendedData>
		<LineString><coordinates>19.49,-33.49,0 19.50,-33.52,0 19.56,-33.53,0</coordinates></LineString>
	</Placemark>
	<Placemark>
		<name>A note with no shape</name>
	</Placemark>
</Document>
</kml>
`;

export const syntheticKmz = (store = false) => zip([{ name: 'doc.kml', data: SYNTHETIC_KML, store }]);

/** The files committed beside this one for the e2e spec, by name. */
export const COMMITTED: Record<string, () => Uint8Array | string> = {
	'synthetic-parcels-lo19.zip': () => lo19ParcelsZip(true),
	'synthetic-farm.kml': () => SYNTHETIC_KML,
	'synthetic-farm.kmz': () => syntheticKmz(true)
};
