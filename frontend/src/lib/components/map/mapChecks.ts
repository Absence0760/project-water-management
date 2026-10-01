// The Map tab's consistency checks for the hydrologist (issue #326 A4;
// docs/maps.md § Checks): units with no parcel, features outside the
// boundary, overlapping parcels, the units' total area against the
// boundary's, a typed area far from its parcel's, and gauges off every river.
// Warnings only: nothing here blocks a save or a run. Pure (no DOM, no
// MapLibre) and dependency-free, so vitest covers every check
// (mapChecks.test.ts) and it ships in the tab's chunk.
//
// Geometry is done in metres on a local equirectangular projection around
// the features' mean latitude (accurate to well under 1 % over a catchment),
// and the distances people read are haversine. Areas come from the
// features' `areaM2` (the server's geodesic area) and the units' areaKm2.
import type { MapFeature, MapGeometry, MapNodeArea, MapPosition } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';
import { isPolygon, KIND_LABEL } from './mapData';

/** One warning: what it says, and the features and nodes it is about. */
export interface MapCheck {
	/** Stable per finding, e.g. `overlap:<a>:<b>`; its prefix names the check. */
	id: string;
	text: string;
	featureIds: string[];
	nodeIds: string[];
}

/** The units' total area may differ from the boundary's by this fraction before it's flagged. */
export const UNITS_VS_BOUNDARY_TOLERANCE = 0.1;
/** A unit's typed area may differ from its linked parcel's by this fraction before it's flagged. */
export const TYPED_VS_PARCEL_TOLERANCE = 0.1;
/** A gauge further than this from every river line is flagged (m). */
export const GAUGE_RIVER_DISTANCE_M = 100;
/** A vertex this close to the boundary's edge counts as on it, not outside (m). */
export const OUTSIDE_TOLERANCE_M = 10;
/** Parcels that cross or reach into each other by no more than this don't overlap (m): shared edges, rounding. */
export const OVERLAP_TOLERANCE_M = 5;

export interface MapCheckOptions {
	unitsVsBoundaryTolerance?: number;
	typedVsParcelTolerance?: number;
	gaugeRiverDistanceM?: number;
	outsideToleranceM?: number;
	overlapToleranceM?: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;
/** Floating-point slack, so exactly at a threshold counts as within it. */
const EPS = 1e-9;

/** Great-circle distance between two lon/lat positions (m). */
export function haversineM([lon1, lat1]: MapPosition, [lon2, lat2]: MapPosition): number {
	const dLat = (lat2 - lat1) * RAD;
	const dLon = (lon2 - lon1) * RAD;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

type XY = [number, number];
/** A polygon in metres: rings, the first the outer one, each without its closing vertex. */
type Poly = XY[][];

interface Projection {
	to: (p: MapPosition) => XY;
	from: (p: XY) => MapPosition;
}

/** Equirectangular metres around (lon0, lat0). */
function projection(lon0: number, lat0: number): Projection {
	const kx = EARTH_RADIUS_M * RAD * Math.cos(lat0 * RAD);
	const ky = EARTH_RADIUS_M * RAD;
	return { to: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky], from: ([x, y]) => [x / kx + lon0, y / ky + lat0] };
}

/** A ring without its closing vertex (GeoJSON repeats the first at the end). */
function open(ring: readonly MapPosition[]): MapPosition[] {
	const n = ring.length;
	if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) return ring.slice(0, -1);
	return ring.slice();
}

/** A geometry's polygons as rings of positions (none for points and lines). */
function polygonsOf(g: MapGeometry): MapPosition[][][] {
	if (g.type === 'Polygon') return [g.coordinates.map(open)];
	if (g.type === 'MultiPolygon') return g.coordinates.map((p) => p.map(open));
	return [];
}

/** A geometry's distinct vertices (a ring's closing vertex once). */
function verticesOf(g: MapGeometry): MapPosition[] {
	switch (g.type) {
		case 'Point':
			return [g.coordinates];
		case 'LineString':
			return g.coordinates;
		case 'MultiLineString':
			return g.coordinates.flat();
		default:
			return polygonsOf(g).flat(2);
	}
}

/** A geometry's line segments (rivers): each line's consecutive pairs. */
function linesOf(g: MapGeometry): MapPosition[][] {
	if (g.type === 'LineString') return [g.coordinates];
	if (g.type === 'MultiLineString') return g.coordinates;
	return [];
}

/** Even-odd point in polygon over every ring (so a hole is outside). */
function inPoly(p: XY, poly: Poly): boolean {
	let inside = false;
	for (const ring of poly) {
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const [xi, yi] = ring[i];
			const [xj, yj] = ring[j];
			if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
		}
	}
	return inside;
}

/** The point of segment ab nearest p. */
function nearestOnSegment(p: XY, a: XY, b: XY): XY {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
	return [a[0] + t * dx, a[1] + t * dy];
}

const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Distance from p to the nearest edge of a polygon's rings (m). */
function distToEdges(p: XY, poly: Poly): number {
	let best = Infinity;
	for (const ring of poly) {
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) best = Math.min(best, dist(p, nearestOnSegment(p, ring[j], ring[i])));
	}
	return best;
}

/** Inside the polygon and further than `tol` from its edges. */
const strictlyIn = (p: XY, poly: Poly, tol: number) => inPoly(p, poly) && distToEdges(p, poly) > tol;

const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/**
 * Whether segments ab and cd cross each other properly: each one's ends lie
 * on opposite sides of the other, and every end is further than `tol` from
 * the other segment (so shared and nearly shared edges, and touching
 * corners, don't count).
 */
function crosses(a: XY, b: XY, c: XY, d: XY, tol: number): boolean {
	const d1 = cross(c, d, a);
	const d2 = cross(c, d, b);
	const d3 = cross(a, b, c);
	const d4 = cross(a, b, d);
	if (!(((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))) return false;
	return (
		dist(a, nearestOnSegment(a, c, d)) > tol &&
		dist(b, nearestOnSegment(b, c, d)) > tol &&
		dist(c, nearestOnSegment(c, a, b)) > tol &&
		dist(d, nearestOnSegment(d, a, b)) > tol
	);
}

/** Twice the signed area of a ring (positive anticlockwise). */
function signedArea2(ring: XY[]): number {
	let s = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
	return s;
}

/**
 * Points just inside a polygon's outer rings: each edge's middle, moved
 * `offset` towards the inside (kept only where that is inside the polygon).
 * They find an overlap that has no vertex or crossing to show it, such as a
 * parcel imported twice.
 */
function innerSamples(parts: Poly[], offset: number): XY[] {
	const out: XY[] = [];
	for (const poly of parts) {
		const ring = poly[0];
		if (!ring || ring.length < 3) continue;
		const sign = signedArea2(ring) > 0 ? 1 : -1;
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const [a, b] = [ring[j], ring[i]];
			const len = dist(a, b);
			if (len <= 2 * offset) continue;
			// The left normal of an anticlockwise ring's edge points inside.
			const nx = (-(b[1] - a[1]) / len) * sign;
			const ny = ((b[0] - a[0]) / len) * sign;
			const p: XY = [(a[0] + b[0]) / 2 + nx * offset, (a[1] + b[1]) / 2 + ny * offset];
			if (inPoly(p, poly)) out.push(p);
		}
	}
	return out;
}

interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

function boxOf(parts: Poly[]): Box {
	const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
	for (const [x, y] of parts.flat(2)) {
		b.x0 = Math.min(b.x0, x);
		b.y0 = Math.min(b.y0, y);
		b.x1 = Math.max(b.x1, x);
		b.y1 = Math.max(b.y1, y);
	}
	return b;
}

/** Whether two parcels (each a list of polygons) overlap by more than `tol`. */
function overlaps(a: Poly[], b: Poly[], tol: number): boolean {
	const edges = (parts: Poly[]) =>
		parts.flatMap((poly) => poly.flatMap((ring) => ring.map((p, i) => [ring[(i + ring.length - 1) % ring.length], p] as [XY, XY])));
	const inAny = (p: XY, parts: Poly[]) => parts.some((poly) => strictlyIn(p, poly, tol));
	const vertices = (parts: Poly[]) => parts.flat(2);
	if (vertices(a).some((p) => inAny(p, b)) || vertices(b).some((p) => inAny(p, a))) return true;
	const eb = edges(b);
	for (const [p, q] of edges(a)) for (const [r, s] of eb) if (crosses(p, q, r, s, tol)) return true;
	const offset = 2 * tol;
	return innerSamples(a, offset).some((p) => inAny(p, b)) || innerSamples(b, offset).some((p) => inAny(p, a));
}

const nameOf = (f: MapFeature) => f.name || KIND_LABEL[f.kind];
const km2 = (x: number) => `${fmtNum(x, 1)} km²`;
const pct = (fraction: number) => `${fmtNum(Math.abs(fraction) * 100, 0)} %`;
/** "12 % less than" / "8 % more than" for a / b − 1. */
const relative = (a: number, b: number) => `${pct(a / b - 1)} ${a < b ? 'less' : 'more'} than`;
const distanceText = (m: number) => (m < 999.5 ? `${fmtNum(m, 0)} m` : `${fmtNum(m / 1000, 1)} km`);

/**
 * Every consistency warning for a project's map, in the order of the checks
 * (docs/maps.md § Checks). An empty list means nothing to look at.
 */
export function mapChecks(features: readonly MapFeature[], nodes: readonly MapNodeArea[], opts: MapCheckOptions = {}): MapCheck[] {
	const unitsTol = opts.unitsVsBoundaryTolerance ?? UNITS_VS_BOUNDARY_TOLERANCE;
	const typedTol = opts.typedVsParcelTolerance ?? TYPED_VS_PARCEL_TOLERANCE;
	const gaugeM = opts.gaugeRiverDistanceM ?? GAUGE_RIVER_DISTANCE_M;
	const outsideTol = opts.outsideToleranceM ?? OUTSIDE_TOLERANCE_M;
	const overlapTol = opts.overlapToleranceM ?? OVERLAP_TOLERANCE_M;

	const checks: MapCheck[] = [];
	const units = nodes.filter((n) => n.kind === 'farm');
	const parcels = features.filter((f) => f.kind === 'farm_parcel' && isPolygon(f.geometry));
	const boundaries = features.filter((f) => f.kind === 'catchment_boundary' && isPolygon(f.geometry));
	const parcelsOf = (nodeId: string) => parcels.filter((f) => f.nodeId === nodeId);

	const all = features.flatMap((f) => verticesOf(f.geometry));
	const lat0 = all.length ? all.reduce((s, p) => s + p[1], 0) / all.length : 0;
	const lon0 = all.length ? all.reduce((s, p) => s + p[0], 0) / all.length : 0;
	const proj = projection(lon0, lat0);
	const polysOf = (f: MapFeature): Poly[] => polygonsOf(f.geometry).map((poly) => poly.map((ring) => ring.map(proj.to)));

	// 1. Units with no farm parcel linked.
	for (const n of units) {
		if (!parcelsOf(n.id).length) checks.push({ id: `unit-no-parcel:${n.id}`, text: `${n.name} has no farm parcel linked.`, featureIds: [], nodeIds: [n.id] });
	}

	// 2. Features with a vertex outside the boundary (only with a boundary).
	if (boundaries.length) {
		const fence = boundaries.flatMap(polysOf);
		const outside = (p: XY) => !fence.some((poly) => inPoly(p, poly)) && fence.every((poly) => distToEdges(p, poly) > outsideTol);
		for (const f of features) {
			if (f.kind === 'catchment_boundary') continue;
			const vs = verticesOf(f.geometry);
			const out = vs.filter((p) => outside(proj.to(p))).length;
			if (!out) continue;
			const what = `${nameOf(f)} (${KIND_LABEL[f.kind].toLowerCase()})`;
			const text =
				f.geometry.type === 'Point'
					? `${what} is outside the catchment boundary.`
					: out === vs.length
						? `${what} lies wholly outside the catchment boundary.`
						: `${what} has ${out} of its ${vs.length} points outside the catchment boundary.`;
			checks.push({ id: `outside:${f.id}`, text, featureIds: [f.id], nodeIds: f.nodeId ? [f.nodeId] : [] });
		}
	}

	// 3. Overlapping farm parcels (shared edges within the tolerance don't count).
	const shapes = parcels.map((f) => ({ f, parts: polysOf(f) })).map((s) => ({ ...s, box: boxOf(s.parts) }));
	for (const [i, a] of shapes.entries()) {
		for (const b of shapes.slice(i + 1)) {
			if (a.box.x1 + overlapTol < b.box.x0 || b.box.x1 + overlapTol < a.box.x0 || a.box.y1 + overlapTol < b.box.y0 || b.box.y1 + overlapTol < a.box.y0) continue;
			if (!overlaps(a.parts, b.parts, overlapTol)) continue;
			checks.push({
				id: `overlap:${a.f.id}:${b.f.id}`,
				text: `Farm parcels ${nameOf(a.f)} and ${nameOf(b.f)} overlap.`,
				featureIds: [a.f.id, b.f.id],
				nodeIds: [...new Set([a.f.nodeId, b.f.nodeId].filter((x): x is string => !!x))]
			});
		}
	}

	// 4. The units' total area against the boundary's.
	const boundaryKm2 = boundaries.reduce((s, f) => s + (f.areaM2 ?? 0), 0) / 1e6;
	if (units.length && boundaryKm2 > 0) {
		const unitsKm2 = units.reduce((s, n) => s + n.areaKm2, 0);
		if (Math.abs(unitsKm2 / boundaryKm2 - 1) > unitsTol + EPS) {
			checks.push({
				id: 'units-vs-boundary',
				text: `The units add up to ${km2(unitsKm2)}, ${relative(unitsKm2, boundaryKm2)} the boundary's ${km2(boundaryKm2)}.`,
				featureIds: boundaries.map((f) => f.id),
				nodeIds: units.map((n) => n.id)
			});
		}
	}

	// 5. A typed area far from its linked parcel's.
	for (const n of units) {
		if (n.areaSource !== 'typed') continue;
		const linked = parcelsOf(n.id).filter((f) => f.areaM2 !== null);
		const parcelKm2 = linked.reduce((s, f) => s + (f.areaM2 ?? 0), 0) / 1e6;
		if (!linked.length || parcelKm2 <= 0) continue;
		if (Math.abs(n.areaKm2 / parcelKm2 - 1) <= typedTol + EPS) continue;
		const theirs = linked.length === 1 ? `its farm parcel's` : `its ${linked.length} farm parcels'`;
		checks.push({
			id: `typed-area:${n.id}`,
			text: `${n.name}'s typed area, ${km2(n.areaKm2)}, is ${relative(n.areaKm2, parcelKm2)} ${theirs} ${km2(parcelKm2)}.`,
			featureIds: linked.map((f) => f.id),
			nodeIds: [n.id]
		});
	}

	// 6. Gauges not on a river line (only with rivers).
	const rivers = features.filter((f) => f.kind === 'river').flatMap((f) => linesOf(f.geometry));
	if (rivers.some((l) => l.length)) {
		for (const g of features) {
			if (g.kind !== 'gauge' || g.geometry.type !== 'Point') continue;
			const at = g.geometry.coordinates;
			// A projection centred on the gauge, then the haversine distance to the nearest point found.
			const local = projection(at[0], at[1]);
			let best = Infinity;
			for (const line of rivers) {
				const xy = line.map(local.to);
				for (let i = 1; i < xy.length; i++) best = Math.min(best, haversineM(at, local.from(nearestOnSegment([0, 0], xy[i - 1], xy[i]))));
				if (xy.length === 1) best = Math.min(best, haversineM(at, line[0]));
			}
			if (best <= gaugeM) continue;
			checks.push({
				id: `gauge-off-river:${g.id}`,
				text: `Gauge ${nameOf(g)} is ${distanceText(best)} from the nearest river line.`,
				featureIds: [g.id],
				nodeIds: g.nodeId ? [g.nodeId] : []
			});
		}
	}

	return checks;
}
