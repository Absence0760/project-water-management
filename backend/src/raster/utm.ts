// WGS 84 → UTM, forward only: a dam outline (lon/lat, as map_feature keeps
// it) into a WOfS scene's grid (cog.ts). Transverse Mercator by Krüger's
// series in n to n⁶ (Karney, "Transverse Mercator with an accuracy of a few
// nanometers", J. Geodesy 85, 2011, eqs 7–11 and 25), which is accurate to
// well under a millimetre within the UTM zones' ±3°, and to millimetres
// several degrees beyond: what PROJ's own `tmerc` uses (utm.test.ts checks
// it against PROJ's numbers).
//
// No dependency: proj4js would be the obvious one, but this is 40 lines, and
// a backend bundle that reads one projection needn't carry a CRS database.
//
// The EPSG code decides the false northing, not the latitude: 326zz (north)
// has none and 327zz (south) has 10 000 km. DE Africa writes its southern
// scenes in the NORTH codes (EPSG:32634, negative northings), so a point
// south of the equator in 326zz rightly comes out negative.
import { isUtmEpsg } from './cog.js';

const A_AXIS = 6_378_137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const FALSE_EASTING = 500_000;
const N = F / (2 - F);
const E = Math.sqrt(F * (2 - F));
/** The rectifying radius (Karney eq 14). */
const A_RECT = (A_AXIS / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64 + N ** 6 / 256);
/** Krüger's α₁…α₆ (Karney eq 35). */
const ALPHA = [
	N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16 + (41 * N ** 4) / 180 - (127 * N ** 5) / 288 + (7891 * N ** 6) / 37800,
	(13 * N ** 2) / 48 - (3 * N ** 3) / 5 + (557 * N ** 4) / 1440 + (281 * N ** 5) / 630 - (1983433 * N ** 6) / 1935360,
	(61 * N ** 3) / 240 - (103 * N ** 4) / 140 + (15061 * N ** 5) / 26880 + (167603 * N ** 6) / 181440,
	(49561 * N ** 4) / 161280 - (179 * N ** 5) / 168 + (6601661 * N ** 6) / 7257600,
	(34729 * N ** 5) / 80640 - (3418889 * N ** 6) / 1995840,
	(212378941 * N ** 6) / 319334400
];

/** The UTM zone (1–60) of an EPSG 326zz / 327zz code; throws for any other. */
export function utmZone(epsg: number): number {
	if (!isUtmEpsg(epsg)) throw new RangeError(`EPSG ${epsg} is not WGS 84 / UTM`);
	return epsg % 100;
}

/** The central meridian of a UTM zone, degrees. */
export const centralMeridian = (zone: number) => -183 + 6 * zone;

/**
 * (lon, lat) in degrees → easting / northing in metres in `epsg`, with `k`,
 * the point scale factor there: a grid distance is the ground distance × k,
 * so a grid area is the ground area × k².
 */
export function toUtm(lon: number, lat: number, epsg: number): { x: number; y: number; k: number } {
	const zone = utmZone(epsg);
	if (!(Math.abs(lat) <= 84.5) || !Number.isFinite(lon)) throw new RangeError(`the point ${lon}, ${lat} is outside UTM's coverage`);
	let dLon = lon - centralMeridian(zone);
	dLon = ((((dLon + 180) % 360) + 360) % 360) - 180;
	// Past ~45° from the meridian the series no longer converges usefully; a dam is never there.
	if (Math.abs(dLon) > 45) throw new RangeError(`the point ${lon}, ${lat} is too far from zone ${zone}`);
	const phi = (lat * Math.PI) / 180;
	const lam = (dLon * Math.PI) / 180;
	// The conformal latitude's tangent (Karney eqs 7–9).
	const tau = Math.tan(phi);
	const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.sqrt(1 + tau * tau)));
	const t = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
	const xiP = Math.atan2(t, Math.cos(lam));
	const etaP = Math.asinh(Math.sin(lam) / Math.sqrt(t * t + Math.cos(lam) ** 2));
	let xi = xiP;
	let eta = etaP;
	let sp = 1;
	let tp = 0;
	for (let j = 1; j <= 6; j++) {
		const a = ALPHA[j - 1]!;
		xi += a * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
		eta += a * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
		sp += 2 * j * a * Math.cos(2 * j * xiP) * Math.cosh(2 * j * etaP);
		tp += 2 * j * a * Math.sin(2 * j * xiP) * Math.sinh(2 * j * etaP);
	}
	// Scale (Karney eq 25).
	const k =
		K0 *
		(A_RECT / A_AXIS) *
		Math.sqrt(1 + ((1 - N) / (1 + N)) ** 2 * tau * tau) *
		Math.sqrt((sp * sp + tp * tp) / (t * t + Math.cos(lam) ** 2));
	const falseNorthing = Math.floor(epsg / 100) === 327 ? 10_000_000 : 0;
	return { x: FALSE_EASTING + K0 * A_RECT * eta, y: falseNorthing + K0 * A_RECT * xi, k };
}

/** The UTM zone (EPSG 327zz south, 326zz north) a longitude / latitude falls in, without Norway's and Svalbard's exceptions. */
export function utmEpsgFor(lon: number, lat: number): number {
	const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
	return (lat < 0 ? 32700 : 32600) + zone;
}
