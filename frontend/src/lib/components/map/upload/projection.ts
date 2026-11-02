// A shapefile's `.prj` (its coordinate system, as WKT) read with proj4, and
// a transform to WGS84 longitude/latitude (docs/maps.md § Uploads). Nothing
// is guessed: a .prj proj4 can't read, or one whose datum it can't shift to
// WGS84, is refused with a message naming it.
//
// South African data is often in a Hartebeesthoek94 Lo zone (EPSG:2046–2055,
// "Lo19" and the rest): Transverse Mercator, south-orientated, its axes
// westing and southing. proj4 knows neither the south-orientated method's
// name nor axis order from WKT, so such a .prj is read as the ordinary
// Transverse Mercator it otherwise is and both coordinates are negated
// first. The Esri form of a Lo zone (plain Transverse_Mercator, x east and y
// north, both negative) needs nothing extra.
import { Proj, proj4 } from './proj4lite';
import type { Transform } from './normalize';
import { UploadRefused } from './common';

const WGS84_A = 6378137;

/** proj4's datum types (lib/constants/values): a 3- or 7-parameter shift to WGS84, or WGS84 itself. */
const SHIFTED = new Set([1, 2, 4]);
/** proj4's "no datum": fine only on the WGS84 (or GRS80) ellipsoid, as Hartebeesthoek94 is. */
const NODATUM = 5;

const named = (wkt: string, key: string) => wkt.match(new RegExp(`${key}\\s*\\[\\s*"([^"]*)"`, 'i'))?.[1]?.replace(/_/g, ' ');

/** Whether the WKT is south-orientated: the method says so, or its axes are west and south. */
export function isSouthOrientated(wkt: string): boolean {
	if (/PROJECTION\s*\[\s*"Transverse[_ ]Mercator[_ ]\(?South[_ ]Orientated\)?"/i.test(wkt)) return true;
	const axes = [...wkt.matchAll(/AXIS\s*\[\s*"[^"]*"\s*,\s*(\w+)\s*\]/gi)].map((m) => m[1]!.toUpperCase());
	return axes.length >= 2 && axes[axes.length - 2] === 'WEST' && axes[axes.length - 1] === 'SOUTH';
}

/** The .prj as proj4 can read it: a south-orientated method as plain Transverse Mercator, without its AXIS clauses. */
function readable(wkt: string): string {
	return wkt.replace(/PROJECTION\s*\[\s*"Transverse[_ ]Mercator[_ ]\(?South[_ ]Orientated\)?"\s*\]/i, 'PROJECTION["Transverse_Mercator"]').replace(/,\s*AXIS\s*\[\s*"[^"]*"\s*,\s*\w+\s*\]/gi, '');
}

/**
 * The transform from the .prj's coordinates to WGS84 lon/lat, and the
 * system's name. `file` is the .prj's name in the zip, for the messages.
 */
export function prjTransform(wkt: string, file: string): { transform: Transform; name: string } {
	const text = wkt.trim();
	const name = named(text, 'PROJCS') ?? named(text, 'GEOGCS') ?? 'its coordinate system';
	const cantRead = `We can’t read the coordinate system in ${file}. Reproject the layer to WGS84 (EPSG:4326) in QGIS and upload it again.`;
	const south = isSouthOrientated(text);
	let proj: InstanceType<typeof Proj>;
	let converter: ReturnType<typeof proj4>;
	try {
		proj = new Proj(readable(text));
		converter = proj4(readable(text), 'EPSG:4326');
	} catch {
		throw new UploadRefused(cantRead);
	}
	if (!proj.projName) throw new UploadRefused(cantRead);
	const type = proj.datum?.datum_type;
	const wgs84Ellipsoid = proj.a !== undefined && Math.abs(proj.a - WGS84_A) < 0.5;
	if (!(type !== undefined && SHIFTED.has(type)) && !(type === NODATUM && wgs84Ellipsoid)) {
		const datum = named(text, 'DATUM')?.replace(/^D /, '');
		throw new UploadRefused(
			`${file} uses ${datum ? `the ${datum} datum` : 'a datum'} with no shift to WGS84, so its positions would land up to a few hundred metres out. Reproject the layer to WGS84 (EPSG:4326) in QGIS and upload it again.`
		);
	}
	const transform: Transform = ([x, y]) => {
		const out = converter.forward(south ? [-x, -y] : [x, y]) as number[];
		if (!Number.isFinite(out[0]) || !Number.isFinite(out[1])) {
			throw new UploadRefused(`Some positions fall outside the coordinate system in ${file} (${name}); check that the .prj belongs to this layer.`);
		}
		return [out[0]!, out[1]!];
	};
	return { transform, name };
}
