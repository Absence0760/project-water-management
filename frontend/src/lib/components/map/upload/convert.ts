// Which file the Map's upload was given, and, for a KML, a KMZ or a zipped
// shapefile, the GeoJSON it reads as (docs/maps.md § Uploads). The sheet
// then sends that GeoJSON through the same preview and import as a GeoJSON
// file, so the server's checks and limits are the authority for every
// format. This module is small and loaded with the sheet; the readers (and
// their libraries) are import()ed only when such a file is picked.
import { GEO_MAX_BYTES } from '../mapData';
import { CONVERT_MAX_BYTES, UploadRefused, type Converted } from './common';

export type UploadFormat = 'geojson' | 'kml' | 'kmz' | 'zip' | 'shapefile-part';

/** The file input's accept list: the extensions, and the media types some pickers filter by. */
export const UPLOAD_ACCEPT =
	'.geojson,.json,.kml,.kmz,.zip,application/geo+json,application/json,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/zip';

/** The format, from the file's extension; anything unknown is read as GeoJSON (the server says if it isn't). */
export function uploadFormatOf(name: string): UploadFormat {
	const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
	if (ext === 'kml') return 'kml';
	if (ext === 'kmz') return 'kmz';
	if (ext === 'zip') return 'zip';
	if (['shp', 'shx', 'dbf', 'prj', 'cpg'].includes(ext)) return 'shapefile-part';
	return 'geojson';
}

/** Why the file can't be read before anything is read, or null. */
export function pickProblem(name: string, size: number): string | null {
	const format = uploadFormatOf(name);
	if (format === 'shapefile-part') return 'A shapefile is several files: zip the layer’s .shp, .shx, .dbf and .prj together and upload the .zip.';
	if (format === 'geojson' && size > GEO_MAX_BYTES) return `The file is larger than ${GEO_MAX_BYTES / 1024 / 1024} MB; simplify it or split it.`;
	if (format !== 'geojson' && size > CONVERT_MAX_BYTES) return `The file is larger than ${CONVERT_MAX_BYTES / 1024 / 1024} MB; simplify it or split it.`;
	return null;
}

/**
 * The file's GeoJSON text and, for a converted file, one line saying what
 * was read (null for a GeoJSON file, sent as it is). Throws UploadRefused
 * with a message for the sheet.
 */
export async function readUpload(file: File): Promise<{ text: string; summary: string | null }> {
	const problem = pickProblem(file.name, file.size);
	if (problem) throw new UploadRefused(problem);
	const format = uploadFormatOf(file.name);
	if (format === 'geojson') return { text: await file.text(), summary: null };
	let out: Converted;
	if (format === 'kml') {
		const { kmlToGeoJson } = await import('./kml');
		out = kmlToGeoJson(await file.text());
	} else {
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (format === 'kmz') {
			const { kmzToGeoJson } = await import('./kml');
			out = await kmzToGeoJson(bytes);
		} else {
			const { shapefileToGeoJson } = await import('./shapefile');
			out = await shapefileToGeoJson(bytes);
		}
	}
	if (new TextEncoder().encode(out.text).length > GEO_MAX_BYTES) {
		throw new UploadRefused(`Read as GeoJSON, the file is larger than ${GEO_MAX_BYTES / 1024 / 1024} MB; simplify it or split it.`);
	}
	return { text: out.text, summary: out.summary };
}

export { UploadRefused };
