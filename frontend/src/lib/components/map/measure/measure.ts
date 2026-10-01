// The Map tab's Measure (issue #326 A7; docs/maps.md § Measure): the length
// of a path and the area of a closed shape, and how they are written. Pure
// (measure.test.ts); the map's drawing mode collects the points
// (MeasureDraft), and MeasureBar writes the result in words.
//
// Distances are great-circle (haversine, the mean Earth radius, as the
// map's checks measure them: mapChecks.ts `haversineM`). Areas use the
// server's method (backend/src/geo/area.ts): Lambert's cylindrical
// equal-area projection of the WGS84 ellipsoid and a shoelace sum, so a
// shape measured here and the same shape saved as a feature give the same
// area. The few lines are repeated rather than shared: the backend's file
// can't be imported by the frontend, and measure.test.ts pins both to the
// same reference squares.
import type { MapPosition } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';
import { haversineM } from '../mapChecks';

const A = 6_378_137;
const E2 = 0.006_694_379_990_14;
const E = Math.sqrt(E2);
const q = (sinPhi: number) => {
	const es = E * sinPhi;
	return (1 - E2) * (sinPhi / (1 - es * es) - (1 / (2 * E)) * Math.log((1 - es) / (1 + es)));
};
const QP = q(1);
const RQ = A * Math.sqrt(QP / 2);
const sinAuthalic = (latDeg: number) => Math.max(-1, Math.min(1, q(Math.sin((latDeg * Math.PI) / 180)) / QP));

/** The length (m) along the points in order (a path; not closed). */
export function pathLengthM(points: readonly MapPosition[]): number {
	let m = 0;
	for (let i = 1; i < points.length; i++) m += haversineM(points[i - 1]!, points[i]!);
	return m;
}

/** The length (m) round the closed shape: the path and back to the first point. */
export function perimeterM(points: readonly MapPosition[]): number {
	return points.length < 2 ? 0 : pathLengthM(points) + (points.length > 2 ? haversineM(points[points.length - 1]!, points[0]!) : 0);
}

/** The area (m²) of the closed shape through the points (not repeated at the end), on the WGS84 ellipsoid; 0 under three points. */
export function shapeAreaM2(points: readonly MapPosition[]): number {
	const n = points.length;
	if (n < 3) return 0;
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const [x1, y1] = points[i]!;
		const [x2, y2] = points[(i + 1) % n]!;
		sum += (((x2 - x1) * Math.PI) / 180) * (sinAuthalic(y1) + sinAuthalic(y2));
	}
	return Math.abs((sum / 2) * RQ * RQ);
}

/** A distance as people read it: metres under 1 km (to the metre), then km (2 decimals under 100 km, 1 above). */
export function distanceText(m: number): string {
	if (m < 1000) return `${fmtNum(Math.round(m), 0)} m`;
	const km = m / 1000;
	return `${fmtNum(km, km < 100 ? 2 : 1)} km`;
}

/** An area as people read it: hectares under 1 km² (2 decimals under 10 ha, else 1), then km² with the hectares after it. */
export function measuredAreaText(m2: number): string {
	const ha = m2 / 1e4;
	if (m2 < 1e6) return `${fmtNum(ha, ha < 10 ? 2 : 1)} ha`;
	const km2 = m2 / 1e6;
	return `${fmtNum(km2, km2 < 100 ? 2 : 1)} km² (${fmtNum(Math.round(ha), 0)} ha)`;
}

/** The measure's result in one sentence, for the bar (and its live region). */
export function measureText(points: readonly MapPosition[], closed: boolean): string {
	if (!points.length) return 'Click the map to add the first point, or press Enter at the crosshair.';
	if (closed && points.length >= 3) return `Area: ${measuredAreaText(shapeAreaM2(points))}. Perimeter: ${distanceText(perimeterM(points))}.`;
	if (points.length === 1) return 'Distance: 0 m (1 point). Add the next point.';
	return `Distance: ${distanceText(pathLengthM(points))} (${points.length} points).`;
}
