// A zipped shapefile read in the browser into the upload's GeoJSON
// (docs/maps.md § Uploads). Loaded with import() only when a .zip is picked
// (upload/convert.ts), so proj4 and parsedbf never weigh on the Map's chunk.
//
// The zip's layers are its .shp files; each needs its .prj unless every
// position is already a longitude/latitude pair, and takes its names from
// its .dbf (parsedbf, with the .cpg's code page). The .shp is read by the
// app's own reader (shp.ts). The records are counted from the
// .shp's own headers before anything is parsed, so a file over the 500
// features the server takes is refused cheaply. A zip with no .shp but a
// .kml is read as a KMZ.
import parseDbf from 'parsedbf';
import { count, GEO_MAX_FEATURES, tooManyFeatures, UNZIPPED_MAX_BYTES, UploadRefused, type Converted } from './common';
import { allLonLat, toUploadFeatures, type InFeature, type OutFeature } from './normalize';
import { prjTransform } from './projection';
import { readShp, shpRecords } from './shp';
import { isContentEntry, readEntries, zipEntries, type ZipEntry } from './zip';

const OVER_BUDGET = `This zip unpacks to more than ${UNZIPPED_MAX_BYTES / 1024 / 1024} MB; split the layer or simplify it.`;
const MISSING_SHP = 'This zip has no shapefile in it (no .shp). Zip the layer’s .shp, .shx, .dbf and .prj files together and upload that.';

interface Layer {
	base: string;
	shp: ZipEntry;
	dbf?: ZipEntry;
	prj?: ZipEntry;
	cpg?: ZipEntry;
}

/** The zip's layers, by the path of each .shp without its extension (any case). */
function layersOf(entries: readonly ZipEntry[]): Layer[] {
	const byBase = new Map<string, Partial<Record<'shp' | 'dbf' | 'prj' | 'cpg', ZipEntry>>>();
	for (const e of entries) {
		const m = e.name.match(/^(.*)\.(shp|dbf|prj|cpg)$/i);
		if (!m) continue;
		const base = m[1]!;
		const slot = byBase.get(base) ?? {};
		slot[m[2]!.toLowerCase() as 'shp'] = e;
		byBase.set(base, slot);
	}
	return [...byBase].filter(([, s]) => s.shp).map(([base, s]) => ({ base, ...s, shp: s.shp! }));
}

const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);
const fileOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export async function shapefileToGeoJson(bytes: Uint8Array): Promise<Converted> {
	const entries = zipEntries(bytes).filter((e) => isContentEntry(e.name));
	const layers = layersOf(entries);
	if (!layers.length) {
		if (entries.some((e) => /\.kml$/i.test(e.name))) {
			const { kmzToGeoJson } = await import('./kml');
			return kmzToGeoJson(bytes);
		}
		if (entries.some((e) => /\.(geo)?json$/i.test(e.name))) throw new UploadRefused('This zip holds a GeoJSON file: unzip it and upload the .geojson itself.');
		throw new UploadRefused(MISSING_SHP);
	}
	// The .shp files first, counted before anything else is read or parsed.
	const shps = await readEntries(bytes, layers.map((l) => l.shp), UNZIPPED_MAX_BYTES, OVER_BUDGET);
	let records = 0;
	for (const l of layers) records += shpRecords(shps.get(l.shp.name)!, fileOf(l.shp.name), GEO_MAX_FEATURES - records).length;
	const used = [...shps.values()].reduce((s, b) => s + b.length, 0);
	const rest = await readEntries(bytes, layers.flatMap((l) => [l.dbf, l.prj, l.cpg].filter((e): e is ZipEntry => !!e)), UNZIPPED_MAX_BYTES - used, OVER_BUDGET);

	const out: OutFeature[] = [];
	let noShape = 0;
	const systems = new Set<string>();
	for (const l of layers) {
		const shpName = fileOf(l.shp.name);
		const geometries = readShp(shps.get(l.shp.name)!, shpName, GEO_MAX_FEATURES);
		let rows: Record<string, unknown>[] = [];
		if (l.dbf) {
			const dbf = rest.get(l.dbf.name)!;
			const damaged = `${fileOf(l.dbf.name)} (the layer’s attribute table) can’t be read: it may be damaged. Export the layer again.`;
			const view = new DataView(dbf.buffer, dbf.byteOffset, dbf.byteLength);
			// parsedbf loops over the row count its header gives: more rows than the .shp has records is a damaged file, not a reason to loop.
			if (dbf.length < 32 || view.getUint32(4, true) > geometries.length) throw new UploadRefused(damaged);
			try {
				rows = parseDbf(view, text(l.cpg && rest.get(l.cpg.name)));
			} catch {
				throw new UploadRefused(damaged);
			}
		}
		const raw: InFeature[] = geometries.map((geometry, i) => ({ geometry, properties: rows[i] ?? {} }));
		let transform = null;
		const prj = text(l.prj && rest.get(l.prj.name))?.trim();
		if (prj) {
			const p = prjTransform(prj, fileOf(l.prj!.name));
			transform = p.transform;
			systems.add(p.name);
		} else if (!allLonLat(raw)) {
			throw new UploadRefused(
				`This zip has no .prj for ${shpName}, so we can’t tell its coordinate system. Add the layer’s .prj file to the zip, or export the layer as WGS84 (EPSG:4326).`
			);
		}
		const converted = toUploadFeatures(raw, transform);
		noShape += converted.noShape;
		if (out.length + converted.features.length > GEO_MAX_FEATURES) throw new UploadRefused(tooManyFeatures(`more than ${GEO_MAX_FEATURES}`));
		out.push(...converted.features);
	}
	if (!out.length) throw new UploadRefused('This shapefile has no shapes in it: every record is empty.');
	const from = layers.length === 1 ? 'a zipped shapefile' : `a zipped shapefile of ${layers.length} layers`;
	const projected = [...systems].filter((s) => !/^(GCS[ _])?WGS[ _]?(19)?84$/i.test(s));
	const summary = [
		`Read from ${from}${projected.length ? `, reprojected from ${projected.join(', ')} to WGS84` : ''}.`,
		noShape ? `${count(noShape, 'record', 'records')} with no shape left out.` : ''
	]
		.filter(Boolean)
		.join(' ');
	return { text: JSON.stringify({ type: 'FeatureCollection', features: out }), summary };
}
