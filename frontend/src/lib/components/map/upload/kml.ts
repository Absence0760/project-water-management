// A KML or KMZ read in the browser into the upload's GeoJSON (docs/maps.md
// § Uploads), with @tmcw/togeojson. Loaded with import() only when such a
// file is picked (upload/convert.ts).
//
// KML is always WGS84 longitude/latitude, so nothing is reprojected. Each
// placemark's name, description and simple ExtendedData values become its
// properties (the server keeps only a name, description and ref, and reads
// a kind/type/layer as the proposed kind). Its altitude is dropped and a
// MultiGeometry split by shape (normalize.ts).
//
// KML is XML from an untrusted file. The browser's DOMParser never fetches
// anything (no external entities, DTDs or XInclude), and a file declaring a
// DOCTYPE or an ENTITY is refused before parsing, since KML needs neither
// and internal entities are how a small file expands to a huge one. The
// placemarks are counted before they are converted.
import { kml } from '@tmcw/togeojson';
import { count, GEO_MAX_FEATURES, tooManyFeatures, UNZIPPED_MAX_BYTES, UploadRefused, type Converted } from './common';
import { toUploadFeatures, type InFeature } from './normalize';
import { isContentEntry, readEntries, zipEntries } from './zip';

/** Parses XML into a DOM; the browser's DOMParser unless a test passes another. */
export type ParseXml = (text: string) => Document;

const browserXml: ParseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');

const NOT_XML = 'This KML isn’t well-formed XML, so it can’t be read. Export it again (Google Earth: right-click the folder → Save Place As).';

/** The KML's text as GeoJSON, and what was read. `from` names the file in the summary ("a KML file", "a KMZ file"). */
export function kmlToGeoJson(text: string, parseXml: ParseXml = browserXml, from = 'a KML file'): Converted {
	if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new UploadRefused('This KML declares a DOCTYPE or entities, which KML doesn’t use and the map doesn’t read. Remove them, or export the file again.');
	let doc: Document;
	try {
		doc = parseXml(text);
	} catch {
		throw new UploadRefused(NOT_XML);
	}
	if (!doc?.documentElement || doc.getElementsByTagName('parsererror').length) throw new UploadRefused(NOT_XML);
	if (doc.documentElement.localName !== 'kml') throw new UploadRefused('This file isn’t KML: its XML has no <kml> element at the top.');
	const placemarks = doc.getElementsByTagName('Placemark').length;
	if (!placemarks) throw new UploadRefused('This KML has no placemarks, so there is nothing to put on the map.');
	if (placemarks > GEO_MAX_FEATURES) throw new UploadRefused(tooManyFeatures(placemarks));
	let raw: InFeature[];
	try {
		raw = kml(doc).features as InFeature[];
	} catch {
		throw new UploadRefused(NOT_XML);
	}
	const { features, noShape } = toUploadFeatures(raw);
	if (!features.length) throw new UploadRefused('This KML’s placemarks have no shapes (a polygon, line or point) to put on the map.');
	const summary = [`Read from ${from}: ${count(placemarks, 'placemark', 'placemarks')}.`, noShape ? `${count(noShape, 'placemark', 'placemarks')} with no shape left out.` : '']
		.filter(Boolean)
		.join(' ');
	return { text: JSON.stringify({ type: 'FeatureCollection', features }), summary };
}

/** A KMZ (a zip with a doc.kml, or one other .kml, in it) as GeoJSON. */
export async function kmzToGeoJson(bytes: Uint8Array, parseXml: ParseXml = browserXml): Promise<Converted> {
	const kmls = zipEntries(bytes).filter((e) => isContentEntry(e.name) && /\.kml$/i.test(e.name));
	// Google Earth's main file is doc.kml at the top; else the shallowest .kml.
	const main = kmls.find((e) => e.name.toLowerCase() === 'doc.kml') ?? kmls.sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
	if (!main) throw new UploadRefused('This KMZ has no .kml file in it, so there is nothing to read.');
	const read = await readEntries(bytes, [main], UNZIPPED_MAX_BYTES, `This KMZ unpacks to more than ${UNZIPPED_MAX_BYTES / 1024 / 1024} MB; split it or simplify it.`);
	return kmlToGeoJson(new TextDecoder().decode(read.get(main.name)!), parseXml, 'a KMZ file');
}
