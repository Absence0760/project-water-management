// The upload's conversion refusals (a KML, a KMZ or a zipped shapefile read
// in the browser; docs/maps.md § Uploads): a message the sheet shows as it
// is, plain and specific, so the file can be fixed.
export class UploadRefused extends Error {}

/** The largest KML, KMZ or zip the browser reads (the GeoJSON it makes must still fit the server's 5 MB). */
export const CONVERT_MAX_BYTES = 25 * 1024 * 1024;
/** The most a zip or KMZ may unpack to, the entries read summed: a zip bomb stops here. */
export const UNZIPPED_MAX_BYTES = 50 * 1024 * 1024;
/** The most features one upload takes (backend geo/geojson.ts GEO_MAX_FEATURES); a converted file over it is refused before it is sent. */
export const GEO_MAX_FEATURES = 500;

export const tooManyFeatures = (n: number | string) => `The file has ${n} features; the most one upload takes is ${GEO_MAX_FEATURES}.`;

/** A converted file: the GeoJSON text the upload sends, and one line saying what was read (the review shows it). */
export interface Converted {
	text: string;
	summary: string;
}

/** "1 placemark", "3 records". */
export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
