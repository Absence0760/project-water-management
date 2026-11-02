// The Map's KML, KMZ and zipped-shapefile upload, read in the browser into
// GeoJSON (docs/maps.md § Uploads). Synthetic files only, built byte by byte
// in __fixtures__/build.ts. The server's checks stay the authority; these
// pin the conversion, the reprojection and the caps on untrusted files.
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shapeAreaM2 } from '../measure/measure';
import {
	CAPE_NO_SHIFT,
	layerFiles,
	LO19_ESRI,
	LO19_GDAL,
	LO19_REFERENCE,
	lo19ParcelsZip,
	lo19Square,
	shapefile,
	SYNTHETIC_KML,
	syntheticKmz,
	UTM34S_ESRI,
	WGS84_ESRI,
	zip,
	type Shape
} from './__fixtures__/build';
import { UNZIPPED_MAX_BYTES, UploadRefused } from './common';
import { pickProblem, readUpload, uploadFormatOf } from './convert';
import { kmlToGeoJson, kmzToGeoJson, type ParseXml } from './kml';
import { plainProperties, toUploadFeatures } from './normalize';
import { isSouthOrientated } from './projection';
import { shapefileToGeoJson } from './shapefile';
import { readShp, shpRecords } from './shp';
import { BROKEN_ZIP, isContentEntry, readEntries, zipEntries } from './zip';

type Geo = { type: string; coordinates: unknown };
type F = { properties: Record<string, unknown>; geometry: Geo };
const features = (text: string) => (JSON.parse(text) as { features: F[] }).features;
const xml: ParseXml = (t) => new XmlDomParser().parseFromString(t, 'application/xml') as unknown as Document;
const refusal = async (p: Promise<unknown> | (() => unknown)) => {
	try {
		await (typeof p === 'function' ? p() : p);
	} catch (e) {
		expect(e).toBeInstanceOf(UploadRefused);
		return (e as Error).message;
	}
	throw new Error('expected a refusal');
};
const near = (a: number[], b: number[], tol = 1e-6) => expect(Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!))).toBeLessThan(tol);
const ring = (g: Geo) => (g.coordinates as number[][][])[0]!;

describe('zip reader', () => {
	it('reads stored and deflated entries, and skips folders and macOS resource forks', async () => {
		const z = zip([
			{ name: 'a.txt', data: 'stored', store: true },
			{ name: 'dir/b.txt', data: 'deflated '.repeat(50) },
			{ name: '__MACOSX/dir/._b.txt', data: 'junk' }
		]);
		const entries = zipEntries(z).filter((e) => isContentEntry(e.name));
		expect(entries.map((e) => e.name)).toEqual(['a.txt', 'dir/b.txt']);
		const read = await readEntries(z, entries, 10_000, 'over');
		expect(new TextDecoder().decode(read.get('a.txt'))).toBe('stored');
		expect(new TextDecoder().decode(read.get('dir/b.txt'))).toBe('deflated '.repeat(50));
		expect(isContentEntry('x/._y.shp')).toBe(false);
		expect(isContentEntry('x/')).toBe(false);
	});

	it('refuses an entry whose declared size is over the budget, before inflating it (a zip bomb)', async () => {
		const z = zip([{ name: 'big.shp', data: new Uint8Array(1000), claimSize: UNZIPPED_MAX_BYTES + 1 }]);
		expect(await refusal(readEntries(z, zipEntries(z), UNZIPPED_MAX_BYTES, 'This zip unpacks to too much.'))).toBe('This zip unpacks to too much.');
	});

	it('stops inflating an entry the moment it passes its declared size (a zip that lies), and refuses one that comes out short', async () => {
		// 4 MB of zeros deflates to about 4 KB; the headers claim 100 bytes.
		const liar = zip([{ name: 'bomb.shp', data: new Uint8Array(4 * 1024 * 1024), claimSize: 100 }]);
		expect(await refusal(readEntries(liar, zipEntries(liar), UNZIPPED_MAX_BYTES, 'over'))).toBe(BROKEN_ZIP);
		const short = zip([{ name: 'short.shp', data: new Uint8Array(100), claimSize: 200 }]);
		expect(await refusal(readEntries(short, zipEntries(short), UNZIPPED_MAX_BYTES, 'over'))).toBe(BROKEN_ZIP);
	});

	it('refuses a password-protected entry, an unknown method, and bytes that are no zip or a cut-off one', async () => {
		const locked = zip([{ name: 'a.shp', data: 'x', encrypted: true }]);
		expect(await refusal(readEntries(locked, zipEntries(locked), 100, 'over'))).toBe('This zip is password-protected; upload one without a password.');
		const z = zip([{ name: 'a.shp', data: 'x', store: true }]);
		new DataView(z.buffer).setUint16(z.length - 22 - 46 - 5 + 10, 12, true); // the central entry's method: bzip2
		expect(await refusal(readEntries(z, zipEntries(z), 100, 'over'))).toMatch(/compression method we can’t read/);
		expect(await refusal(() => zipEntries(new TextEncoder().encode('not a zip at all, just some text')))).toBe(BROKEN_ZIP);
		const good = lo19ParcelsZip();
		expect(await refusal(shapefileToGeoJson(good.subarray(0, good.length - 30)))).toBe(BROKEN_ZIP);
		// Damaged deflate data (the central directory intact): refused, not thrown as a stream error.
		const damaged = zip([{ name: 'a.shp', data: 'some text to deflate '.repeat(20) }]);
		damaged.fill(0xff, 30 + 5, 30 + 5 + 10);
		expect(await refusal(readEntries(damaged, zipEntries(damaged), 10_000, 'over'))).toBe(BROKEN_ZIP);
	});
});

describe('zipped shapefile', () => {
	it('reprojects a Lo19 layer (GDAL’s south-orientated .prj) to WGS84, with areas within 0.5 % (WP-3.12 acceptance)', async () => {
		const out = await shapefileToGeoJson(lo19ParcelsZip());
		const fs = features(out.text);
		expect(fs.map((f) => [f.properties.name, f.properties.KIND])).toEqual([
			['Synthetic parcel A', 'farm parcel'],
			['Synthetic parcel B', 'farm parcel']
		]);
		expect(fs.every((f) => f.geometry.type === 'Polygon')).toBe(true);
		// The square's north-west corner is the reference point.
		near(ring(fs[0]!.geometry)[0]!, LO19_REFERENCE.lonLat);
		const area = (f: F) => shapeAreaM2(ring(f.geometry).slice(0, -1) as [number, number][]);
		expect(Math.abs(area(fs[0]!) / 4e6 - 1)).toBeLessThan(0.005);
		expect(Math.abs(area(fs[1]!) / 1e6 - 1)).toBeLessThan(0.005);
		// Every position is 2D and rounded; the ring stays closed.
		const r = ring(fs[0]!.geometry);
		expect(r.every((p) => p.length === 2)).toBe(true);
		expect(r[0]).toEqual(r[r.length - 1]);
		expect(out.summary).toBe('Read from a zipped shapefile, reprojected from Hartebeesthoek94 / Lo19 to WGS84.');
	});

	it('reads the Esri form of Lo19 (plain Transverse Mercator, negative east and north) and UTM 34S', async () => {
		const esri = zip(layerFiles('esri', [{ type: 'point', at: LO19_REFERENCE.eastNorth }], ['NAME'], [['Esri point']], LO19_ESRI));
		near(features((await shapefileToGeoJson(esri)).text)[0]!.geometry.coordinates as number[], LO19_REFERENCE.lonLat);
		const utm = zip(layerFiles('utm', [{ type: 'point', at: [360665.67, 6292273.97] }], ['NAME'], [['UTM point']], UTM34S_ESRI));
		near(features((await shapefileToGeoJson(utm)).text)[0]!.geometry.coordinates as number[], [19.5, -33.5], 1e-5);
		expect(isSouthOrientated(LO19_GDAL)).toBe(true);
		expect(isSouthOrientated(LO19_ESRI)).toBe(false);
	});

	it('reads every layer of a WGS84 zip, and a layer with no .prj whose positions are already longitude and latitude', async () => {
		const z = zip([
			...layerFiles('dams', [{ type: 'polygon', rings: [[[19.5, -33.5], [19.5, -33.49], [19.51, -33.49], [19.51, -33.5], [19.5, -33.5]]] }], ['Name'], [['Synthetic dam']], WGS84_ESRI),
			...layerFiles('gauges', [{ type: 'point', at: [19.52, -33.52] }, { type: 'null' }], ['NAME'], [['Synthetic gauge'], ['Empty']])
		]);
		const out = await shapefileToGeoJson(z);
		const fs = features(out.text);
		expect(fs.map((f) => [f.properties.name, f.geometry.type])).toEqual([
			['Synthetic dam', 'Polygon'],
			['Synthetic gauge', 'Point']
		]);
		expect(out.summary).toBe('Read from a zipped shapefile of 2 layers. 1 record with no shape left out.');
	});

	it('refuses a layer with no .prj in metres, a .prj proj4 can’t read, and a datum with no shift to WGS84', async () => {
		const lo = layerFiles('parcels', [{ type: 'polygon', rings: [lo19Square(100)] }], ['NAME'], [['P']]);
		expect(await refusal(shapefileToGeoJson(zip(lo)))).toBe(
			'This zip has no .prj for parcels.shp, so we can’t tell its coordinate system. Add the layer’s .prj file to the zip, or export the layer as WGS84 (EPSG:4326).'
		);
		expect(await refusal(shapefileToGeoJson(zip([...lo, { name: 'parcels.prj', data: 'PROJCS["Made up",GEOGCS["y"],PROJECTION["Nonsense"]]' }])))).toBe(
			'We can’t read the coordinate system in parcels.prj. Reproject the layer to WGS84 (EPSG:4326) in QGIS and upload it again.'
		);
		const cape = zip(layerFiles('old', [{ type: 'point', at: [19.5, -33.5] }], ['NAME'], [['Old']], CAPE_NO_SHIFT));
		expect(await refusal(shapefileToGeoJson(cape))).toMatch(/^old\.prj uses the Cape datum with no shift to WGS84, so its positions would land up to a few hundred metres out\./);
	});

	it('refuses a zip with no .shp, says so of a zipped GeoJSON, and reads a zipped KML as a KMZ', async () => {
		expect(await refusal(shapefileToGeoJson(zip([{ name: 'readme.txt', data: 'hello' }])))).toBe(
			'This zip has no shapefile in it (no .shp). Zip the layer’s .shp, .shx, .dbf and .prj files together and upload that.'
		);
		expect(await refusal(shapefileToGeoJson(zip([{ name: 'a.geojson', data: '{}' }])))).toBe('This zip holds a GeoJSON file: unzip it and upload the .geojson itself.');
		withBrowserDomParser();
		expect(features((await shapefileToGeoJson(syntheticKmz())).text)).toHaveLength(4);
	});

	it('counts the records from the .shp’s headers and refuses more than 500 before parsing them', async () => {
		const many: Shape[] = Array.from({ length: 501 }, (_, i) => ({ type: 'point', at: [19 + i / 1000, -33] }));
		expect(await refusal(shapefileToGeoJson(zip(layerFiles('many', many, ['NAME'], [], WGS84_ESRI))))).toBe(
			'The file has more than 500 features; the most one upload takes is 500.'
		);
		const shp = zip(layerFiles('one', [{ type: 'point', at: [19, -33] }], ['NAME'], [['x']]));
		const bytes = (await readEntries(shp, zipEntries(shp).slice(0, 1), 10_000, 'over')).get('one.shp')!;
		expect(shpRecords(bytes, 'one.shp', 500)).toHaveLength(1);
		// A record header claiming more bytes than the file has is refused, not looped on.
		const bad = bytes.slice();
		new DataView(bad.buffer).setInt32(104, 1_000_000);
		expect(await refusal(() => shpRecords(bad, 'one.shp', 500))).toMatch(/^one\.shp can’t be read/);
	});
});

describe('the .shp reader', () => {
	const sq = (x: number, y: number, d: number, cw = true): [number, number][] => {
		const r: [number, number][] = [[x, y], [x, y + d], [x + d, y + d], [x + d, y], [x, y]];
		return cw ? r : r.reverse();
	};
	const read = (shapes: Shape[]) => readShp(shapefile(shapes).shp, 't.shp', 500);

	it('gives a hole to the outer ring holding it, makes several outer rings a MultiPolygon, and several parts a MultiLineString', () => {
		const [withHole, two, lines, nothing] = [
			...read([{ type: 'polygon', rings: [sq(0, 0, 10), sq(2, 2, 2, false)] }, { type: 'polygon', rings: [sq(0, 0, 1), sq(5, 5, 1)] }]),
			...read([{ type: 'line', points: [[0, 0], [1, 1]] }]),
			...read([{ type: 'null' }, { type: 'point', at: [1, 2] }])
		];
		expect(withHole).toEqual({ type: 'Polygon', coordinates: [sq(0, 0, 10), sq(2, 2, 2, false)] });
		expect(two?.type).toBe('MultiPolygon');
		expect(lines).toEqual({ type: 'LineString', coordinates: [[0, 0], [1, 1]] });
		expect(nothing).toBeNull();
		// A hole no outer ring holds stands as an outer ring of its own, turned clockwise.
		expect(read([{ type: 'polygon', rings: [sq(0, 0, 1), sq(5, 5, 1, false)] }])[0]).toEqual({ type: 'MultiPolygon', coordinates: [[sq(0, 0, 1)], [sq(5, 5, 1)]] });
	});

	it('refuses a multipatch and a record whose counts run past it, and a .dbf claiming more rows than the .shp has', async () => {
		const { shp } = shapefile([{ type: 'point', at: [1, 2] }]);
		const patch = shp.slice();
		new DataView(patch.buffer).setInt32(108, 31, true);
		expect(await refusal(() => readShp(patch, 'p.shp', 500))).toMatch(/^p\.shp can’t be read: .*multipatch/);
		const poly = shapefile([{ type: 'polygon', rings: [sq(0, 0, 1)] }]).shp.slice();
		new DataView(poly.buffer).setInt32(108 + 40, 1_000_000, true); // numPoints
		expect(await refusal(() => readShp(poly, 'p.shp', 500))).toMatch(/^p\.shp can’t be read/);
		const files = layerFiles('rows', [{ type: 'point', at: [19, -33] }], ['NAME'], [['a']], WGS84_ESRI);
		const dbfBytes = (files[2]!.data as Uint8Array).slice();
		new DataView(dbfBytes.buffer).setUint32(4, 4_000_000_000, true);
		files[2] = { ...files[2]!, data: dbfBytes };
		expect(await refusal(shapefileToGeoJson(zip(files)))).toBe('rows.dbf (the layer’s attribute table) can’t be read: it may be damaged. Export the layer again.');
	});
});

describe('KML and KMZ', () => {
	it('reads placemarks with their names, descriptions and ExtendedData; drops altitudes; splits a MultiGeometry; counts empty ones', () => {
		const out = kmlToGeoJson(SYNTHETIC_KML, xml);
		const fs = features(out.text);
		expect(fs.map((f) => [f.properties.name, f.geometry.type])).toEqual([
			['Synthetic dam', 'Polygon'],
			['Synthetic fields', 'MultiPolygon'],
			['Synthetic fields', 'Point'],
			['Synthetic stream', 'LineString']
		]);
		expect(fs[0]!.properties).toMatchObject({ description: 'Invented outline', kind: 'dam', ref: 'SD-1' });
		expect(ring(fs[0]!.geometry)[0]).toEqual([19.5, -33.5]);
		expect(fs[2]!.geometry.coordinates).toEqual([19.525, -33.515]);
		expect(fs[3]!.properties.layer).toBe('streams');
		expect(out.summary).toBe('Read from a KML file: 4 placemarks. 1 placemark with no shape left out.');
	});

	it('reads a KMZ’s doc.kml', async () => {
		const out = await kmzToGeoJson(syntheticKmz(), xml);
		expect(features(out.text)).toHaveLength(4);
		expect(out.summary).toMatch(/^Read from a KMZ file: 4 placemarks\./);
		expect(await refusal(kmzToGeoJson(zip([{ name: 'a.txt', data: 'x' }]), xml))).toBe('This KMZ has no .kml file in it, so there is nothing to read.');
	});

	it('refuses a DOCTYPE or entities before parsing, XML that isn’t well formed or isn’t KML, no placemarks, and more than 500', () => {
		const bomb = `<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><kml><Placemark><name>&b;</name></Placemark></kml>`;
		expect(() => kmlToGeoJson(bomb, () => { throw new Error('parsed'); })).toThrow(/declares a DOCTYPE or entities/);
		expect(() => kmlToGeoJson('<kml><Placemark>', xml)).toThrow(/isn’t well-formed XML/);
		expect(() => kmlToGeoJson('<gpx><trk/></gpx>', xml)).toThrow('This file isn’t KML: its XML has no <kml> element at the top.');
		expect(() => kmlToGeoJson('<kml><Document/></kml>', xml)).toThrow('This KML has no placemarks, so there is nothing to put on the map.');
		const many = `<kml>${'<Placemark><Point><coordinates>19,-33</coordinates></Point></Placemark>'.repeat(501)}</kml>`;
		expect(() => kmlToGeoJson(many, xml)).toThrow('The file has 501 features; the most one upload takes is 500.');
		expect(() => kmlToGeoJson('<kml><Placemark><name>x</name></Placemark></kml>', xml)).toThrow(/have no shapes/);
	});
});

describe('normalising shapes for the upload', () => {
	it('copies a NAME or Description to the key the server reads, and keeps plain values only', () => {
		expect(plainProperties({ NAME: 'A', Description: 'd', n: 3, nested: { x: 1 }, bad: NaN })).toEqual({ NAME: 'A', Description: 'd', n: 3, name: 'A', description: 'd' });
		expect(plainProperties({ name: 'own', NAME: 'other' }).name).toBe('own');
	});

	it('splits a MultiPoint, flattens nested collections, and leaves an unknown type for the server to refuse', () => {
		const out = toUploadFeatures([
			{ geometry: { type: 'MultiPoint', coordinates: [[1, 2, 3], [4, 5]] }, properties: {} },
			{ geometry: { type: 'GeometryCollection', geometries: [{ type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[0, 0], [1, 1]] }] }, { type: 'LineString', coordinates: [[2, 2], [3, 3]] }] }, properties: {} },
			{ geometry: { type: 'Curve', coordinates: [] }, properties: {} },
			{ geometry: null, properties: {} }
		]);
		expect(out.features.map((f) => f.geometry.type)).toEqual(['Point', 'Point', 'MultiLineString', 'Curve']);
		expect(out.features[0]!.geometry.coordinates).toEqual([1, 2]);
		expect(out.noShape).toBe(1);
		let deep: Shape | object = { type: 'Point', coordinates: [0, 0] };
		for (let i = 0; i < 10; i++) deep = { type: 'GeometryCollection', geometries: [deep] };
		expect(() => toUploadFeatures([{ geometry: deep as never }])).toThrow(/nested too deeply/);
	});
});

let savedParser: unknown;
function withBrowserDomParser() {
	(globalThis as { DOMParser?: unknown }).DOMParser = XmlDomParser;
}
beforeEach(() => {
	savedParser = (globalThis as { DOMParser?: unknown }).DOMParser;
});
afterEach(() => {
	(globalThis as { DOMParser?: unknown }).DOMParser = savedParser;
});

describe('picking a file', () => {
	it('tells the formats apart by extension, refuses a lone shapefile part, and holds each format to its size', () => {
		expect(['a.geojson', 'a.JSON', 'a.kml', 'A.KMZ', 'a.zip', 'a.shp', 'a.dbf', 'a.txt'].map(uploadFormatOf)).toEqual([
			'geojson',
			'geojson',
			'kml',
			'kmz',
			'zip',
			'shapefile-part',
			'shapefile-part',
			'geojson'
		]);
		expect(pickProblem('a.shp', 10)).toBe('A shapefile is several files: zip the layer’s .shp, .shx, .dbf and .prj together and upload the .zip.');
		expect(pickProblem('a.geojson', 5 * 1024 * 1024 + 1)).toMatch(/larger than 5 MB/);
		expect(pickProblem('a.zip', 5 * 1024 * 1024 + 1)).toBeNull();
		expect(pickProblem('a.zip', 25 * 1024 * 1024 + 1)).toMatch(/larger than 25 MB/);
	});

	it('sends GeoJSON as it is, and a KML, KMZ or zip as the GeoJSON it reads as', async () => {
		withBrowserDomParser();
		expect(await readUpload(new File(['{"type":"FeatureCollection","features":[]}'], 'a.geojson'))).toEqual({ text: '{"type":"FeatureCollection","features":[]}', summary: null });
		expect(features((await readUpload(new File([SYNTHETIC_KML], 'farm.kml'))).text)).toHaveLength(4);
		expect(features((await readUpload(new File([syntheticKmz().slice()], 'farm.kmz'))).text)).toHaveLength(4);
		const shp = await readUpload(new File([lo19ParcelsZip().slice()], 'parcels.zip'));
		expect(shp.summary).toMatch(/reprojected from Hartebeesthoek94 \/ Lo19/);
		expect(await refusal(readUpload(new File(['x'], 'a.prj')))).toMatch(/^A shapefile is several files/);
	});
});
