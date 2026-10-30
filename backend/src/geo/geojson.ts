// GeoJSON in, checked (issue #288, WP-3.12; docs/maps.md § Uploads,
// docs/security.md § Map uploads). Every geometry the server stores passes
// here, whether it came from a file or from a point placed in the app:
//  - WGS84 longitude/latitude only (RFC 7946). A `crs` member naming
//    anything else, or a coordinate outside ±180 / ±90 (a projected file,
//    e.g. a Lo zone), is refused with a message, never guessed;
//  - 2D only: a third coordinate (an elevation) is refused;
//  - Point, LineString, MultiLineString, Polygon, MultiPolygon; anything
//    else (GeometryCollection, MultiPoint, null) is refused;
//  - a polygon's rings are closed, have at least 4 positions and an area,
//    and are valid as OGC Simple Features and GEOS's IsValidOp have it
//    (checkRings): no ring crosses or touches itself, no two rings cross or
//    run along each other, each hole lies inside its outer ring and outside
//    the other holes, and the holes don't cut the polygon into pieces. Rings
//    may touch at isolated points (a hole at a vertex of its outer ring or
//    of another hole, as raster-traced outlines such as DE Africa's
//    Waterbodies do at a pixel corner);
//  - at most GEO_MAX_VERTICES positions per feature and GEO_MAX_FEATURES
//    features; the file at most GEO_MAX_BYTES (the route's body limit too).
// A file's problems are listed per feature, so the person can fix them all
// at once. Properties are dropped except FEATURE_PROPERTIES; a `kind`,
// `type` or `layer` property is read only to propose each feature's kind
// (proposeKinds, issue #326 D2), and is not kept; a `layer` that names no
// kind is the name of a feature that has none (layerAsName, QGIS exports).
import { oneLineName } from '@water-management/engine';
import { geometryAreaM2 } from './area.js';
import { clipX, clipY, openRing } from './clip.js';

export type Position = [number, number];
export type GeometryType = 'Point' | 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon';
export type Geometry =
	| { type: 'Point'; coordinates: Position }
	| { type: 'LineString'; coordinates: Position[] }
	| { type: 'MultiLineString'; coordinates: Position[][] }
	| { type: 'Polygon'; coordinates: Position[][] }
	| { type: 'MultiPolygon'; coordinates: Position[][][] };

/** Largest GeoJSON file the import takes (bytes of UTF-8). */
export const GEO_MAX_BYTES = 5 * 1024 * 1024;
/** Most positions one feature may have. */
export const GEO_MAX_VERTICES = 50_000;
/** Most features one file may have. */
export const GEO_MAX_FEATURES = 500;
/** Segment pairs the self-intersection check may compare per ring before it gives up and refuses the ring as too complex. */
export const GEO_MAX_PAIR_CHECKS = 5_000_000;
/** Edge visits the overlap sweep (polygonsOverlap) may make before it gives up and refuses the shape as too complex. */
export const GEO_MAX_SWEEP_STEPS = 10_000_000;
/** The share of a shape's area its parts (or holes) may cover twice: digitising slivers between neighbours, never a part counted again. */
export const OVERLAP_SHARE = 0.001;
/** Coordinates are kept to 7 decimals (about 1 cm). */
const DECIMALS = 1e7;

/** The feature properties kept from a file, each a string, trimmed and capped. */
export const FEATURE_PROPERTIES = { description: 500, ref: 100 } as const;
/** The property a feature's name is read from, in order. */
const NAME_KEYS = ['name', 'Name', 'NAME', 'label', 'title'];
export const FEATURE_NAME_MAX = 100;

/**
 * A feature name as stored: one line (the engine's oneLineName: every run of
 * whitespace and control characters one space, trimmed; issue #385) and at
 * most FEATURE_NAME_MAX characters. For names read in bulk (a GeoJSON
 * file, a river network), which are cleaned rather than refused; a name
 * typed into a route is refused instead (routes.ts `Name`). The Map draws
 * names as labels, and migration 192 holds the column to one line.
 */
export const featureNameOf = (s: string): string => oneLineName(s).slice(0, FEATURE_NAME_MAX).trimEnd();

/** The CRS names a GeoJSON 2008 `crs` member may carry that mean WGS84 lon/lat. */
const WGS84_NAMES = new Set(['urn:ogc:def:crs:OGC:1.3:CRS84', 'urn:ogc:def:crs:OGC::CRS84', 'EPSG:4326', 'urn:ogc:def:crs:EPSG::4326', 'urn:ogc:def:crs:EPSG:4326']);

export interface ParsedFeature {
	/** Its place in the file, from 1. */
	index: number;
	geometry: Geometry;
	name: string;
	properties: Record<string, string>;
	/** Geodesic area for polygons (m²), null otherwise. */
	areaM2: number | null;
	/** What the file says the feature is (its `kind`, `type` or `layer` property, the first present; not `layer` when that became the name), for proposeKinds; never stored. */
	kindHint: string | null;
}

/** The kinds a map feature can be (geo/routes.ts MAP_FEATURE_KINDS and 152's CHECK; said here so the proposal needs no route module). */
export type FeatureKind = 'catchment_boundary' | 'farm_parcel' | 'dam' | 'gauge' | 'river' | 'other';

/** The geometry types each kind may have (152's CHECKs). */
export const KIND_GEOMETRY: Record<FeatureKind, readonly GeometryType[]> = {
	catchment_boundary: ['Polygon', 'MultiPolygon'],
	farm_parcel: ['Polygon', 'MultiPolygon'],
	dam: ['Point', 'Polygon', 'MultiPolygon'],
	gauge: ['Point'],
	river: ['LineString', 'MultiLineString'],
	other: ['Point', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']
};

/** The node kinds a feature of each kind may stand for. */
export const KIND_NODES: Record<FeatureKind, readonly string[]> = {
	catchment_boundary: [],
	farm_parcel: ['farm', 'user'],
	dam: ['farm', 'user'],
	gauge: ['gauge'],
	river: [],
	other: ['farm', 'user', 'gauge']
};
/** A hydrological unit's kind in words (the model's `farm` is a unit with land). */
export const NODE_KIND_WORD: Record<string, string> = { farm: 'a unit with land', user: 'an other water user', gauge: 'a gauge' };

/** The properties a feature's kind is read from, in order (the key's case ignored). */
const KIND_KEYS = ['kind', 'type', 'layer'];
/** The words a file may use for each kind (lower case, spaces for `_` and `-`; a plural `s` is dropped before looking up). */
const KIND_WORDS: Record<string, FeatureKind> = {
	'catchment boundary': 'catchment_boundary',
	boundary: 'catchment_boundary',
	boundaries: 'catchment_boundary',
	catchment: 'catchment_boundary',
	'farm parcel': 'farm_parcel',
	parcel: 'farm_parcel',
	farm: 'farm_parcel',
	field: 'farm_parcel',
	dam: 'dam',
	reservoir: 'dam',
	gauge: 'gauge',
	gage: 'gauge',
	weir: 'gauge',
	station: 'gauge',
	river: 'river',
	stream: 'river',
	other: 'other'
};

/** The kind a `kind`/`type`/`layer` value names, case and plural ignored ("Farm parcels" → farm_parcel), or null. */
export function kindFromWord(word: string): FeatureKind | null {
	const w = word.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
	return KIND_WORDS[w] ?? (w.endsWith('s') ? (KIND_WORDS[w.slice(0, -1)] ?? null) : null);
}

export interface KindProposal {
	kind: FeatureKind;
	/** Read from the feature's own property, or inferred from its shape. */
	from: 'property' | 'geometry';
	/** Why a property the file gave wasn't used (a sentence starting lowercase), if so. */
	note?: string;
}

/**
 * Propose each feature's kind (issue #326 D2, docs/maps.md § Uploads): its
 * `kind`/`type`/`layer` property when that names a kind that fits its
 * geometry; else from the geometry: a line is a river, a point a gauge, a
 * polygon a farm parcel, and the largest polygon containing every other
 * feature (by its centre) the catchment boundary. A lone polygon is the
 * boundary only while the project has none. Nothing here is final: the
 * editor reviews every row before anything is saved.
 */
export function proposeKinds(features: readonly ParsedFeature[], opts: { hasBoundary: boolean }): KindProposal[] {
	const out = features.map((f): KindProposal => {
		let note: string | undefined;
		if (f.kindHint !== null) {
			const k = kindFromWord(f.kindHint);
			if (k && KIND_GEOMETRY[k].includes(f.geometry.type)) return { kind: k, from: 'property' };
			note = k ? `the file says “${f.kindHint}”, which can’t be a ${f.geometry.type}` : `the file says “${f.kindHint}”, which isn’t a kind the map knows`;
		}
		const t = f.geometry.type;
		const kind: FeatureKind = t === 'Point' ? 'gauge' : t === 'LineString' || t === 'MultiLineString' ? 'river' : 'farm_parcel';
		return note ? { kind, from: 'geometry', note } : { kind, from: 'geometry' };
	});
	if (out.some((p) => p.kind === 'catchment_boundary')) return out;
	let largest = -1;
	features.forEach((f, i) => {
		if (out[i]!.from === 'geometry' && f.areaM2 !== null && (largest < 0 || f.areaM2 > features[largest]!.areaM2!)) largest = i;
	});
	if (largest < 0) return out;
	const big = features[largest]!;
	const others = features.filter((_, i) => i !== largest);
	const containsAll = others.every((f) => pointInGeometry(centerOf(f.geometry), big.geometry));
	if (containsAll && (others.length > 0 || !opts.hasBoundary)) out[largest] = { ...out[largest]!, kind: 'catchment_boundary' };
	return out;
}

export interface GeoProblem {
	/** The feature's place in the file, from 1; null for the file as a whole. */
	feature: number | null;
	message: string;
}

class Refused extends Error {}

const round = (v: number) => Math.round(v * DECIMALS) / DECIMALS;

function position(p: unknown, count: { n: number }): Position {
	if (!Array.isArray(p) || p.length < 2) throw new Refused('a position is not a [longitude, latitude] pair');
	if (p.length > 2) throw new Refused('has 3D coordinates (an elevation); export the file in 2D');
	const [x, y] = p as unknown[];
	if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Refused('a coordinate is not a number');
	if (x < -180 || x > 180 || y < -90 || y > 90) {
		throw new Refused(`has a coordinate (${x}, ${y}) outside longitude/latitude: the file looks projected (a Lo zone or UTM, say); reproject it to WGS84 (EPSG:4326)`);
	}
	if (++count.n > GEO_MAX_VERTICES) throw new Refused(`has more than ${GEO_MAX_VERTICES.toLocaleString('en-ZA')} positions; simplify it`);
	return [round(x), round(y)];
}

function positions(a: unknown, min: number, what: string, count: { n: number }): Position[] {
	if (!Array.isArray(a)) throw new Refused(`a ${what} is not a list of positions`);
	const out = a.map((p) => position(p, count));
	if (out.length < min) throw new Refused(`a ${what} needs at least ${min} positions`);
	return out;
}

/** Signed planar area of a ring in degrees² (for "has an area" and orientation only). */
function planarArea(r: readonly Position[]): number {
	let s = 0;
	for (let i = 0; i < r.length - 1; i++) s += r[i]![0] * r[i + 1]![1] - r[i + 1]![0] * r[i]![1];
	return s / 2;
}

const orient = (a: Position, b: Position, c: Position) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const onSegment = (a: Position, b: Position, c: Position) =>
	Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);

function segmentsCross(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
	const d1 = orient(p3, p4, p1);
	const d2 = orient(p3, p4, p2);
	const d3 = orient(p1, p2, p3);
	const d4 = orient(p1, p2, p4);
	if (d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) return true;
	return (d1 === 0 && onSegment(p3, p4, p1)) || (d2 === 0 && onSegment(p3, p4, p2)) || (d3 === 0 && onSegment(p1, p2, p3)) || (d4 === 0 && onSegment(p1, p2, p4));
}

/** Where a touch point lies on a ring: at its vertex `v`, or inside its edge `e` (from vertex e to e + 1). */
type Spot = { v: number } | { e: number };

/** A point where two or more of a polygon's rings meet (each only there: rings that meet along an edge are refused). */
export interface RingTouch {
	at: Position;
	/** The rings meeting there (indices into the polygon's rings), each with where on it. */
	rings: Map<number, Spot>;
}

/** What is wrong with a polygon's rings (OGC Simple Features, GEOS's IsValidOp), or where they touch and whether that cuts the interior. */
export type RingsVerdict = { problem: 'self' | 'cross' } | { problem: null; touches: RingTouch[]; disconnected: boolean };

const keyOf = (p: Position) => `${p[0]},${p[1]}`;
const same = (p: Position, q: Position) => p[0] === q[0] && p[1] === q[1];
/** Cross product of the vectors o→a and o→b (its sign: orient). */
const cross = (o: Position, a: Position, b: Position) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/**
 * Whether directions o→a and o→b leave o in that order counter-clockwise from
 * east (negative), the other way (positive) or the same way (0): the half-plane
 * first (latitude above o, or due east, is the first half), then the cross
 * product, so no angle is computed.
 */
function angleOrder(o: Position, a: Position, b: Position): number {
	const half = (p: Position) => (p[1] < o[1] || (p[1] === o[1] && p[0] < o[0]) ? 1 : 0);
	return half(a) - half(b) || -Math.sign(cross(o, a, b));
}

/** The ring's two neighbours of a point on it: the vertices either side of vertex v, or the ends of edge e. */
function neighbours(ring: readonly Position[], spot: Spot): [Position, Position] {
	const n = ring.length - 1; // vertices; the ring is closed
	if ('v' in spot) return [ring[(spot.v + n - 1) % n]!, ring[spot.v + 1]!];
	return [ring[spot.e]!, ring[spot.e + 1]!];
}

/**
 * Whether rings meeting only at `at` cross there rather than touch: round the
 * point, two rings cross when their directions alternate (A B A B). All the
 * rings' directions are sorted once by angle and read as brackets (a ring's
 * first direction opens, its second must close the innermost open one), so
 * no pair alternates exactly when they nest: linear after the sort, however
 * many rings meet there. The cut point doesn't matter, since an alternating
 * pair alternates read from anywhere. No two directions coincide (that would
 * be edges running together, refused before).
 */
function crossAt(at: Position, meeting: readonly [Position, Position][]): boolean {
	const dirs = meeting.flatMap(([p, q], r) => [{ p, r }, { p: q, r }]).sort((x, y) => angleOrder(at, x.p, y.p));
	const open = new Set<number>();
	const stack: number[] = [];
	for (const { r } of dirs) {
		if (!open.has(r)) {
			open.add(r);
			stack.push(r);
		} else if (stack.pop() !== r) return true;
	}
	return false;
}

/**
 * Check a polygon's closed rings (the outer ring first, then the holes) as
 * OGC Simple Features and GEOS's IsValidOp do (issue #604 R5's Waterbodies
 * load; docs/maps.md § Uploads):
 *  - a ring must not cross or touch itself (GEOS's "Ring Self-intersection";
 *    it refuses a self-touch too, so this does), which includes doubling
 *    back on itself (a spike's return edge ends on the edge before it):
 *    'self';
 *  - two rings must not cross, at an edge or at a vertex, nor run together
 *    along an edge: 'cross';
 *  - two rings may touch at isolated points (a hole touching its outer ring
 *    or another hole at a vertex, as raster-traced outlines do at a pixel
 *    corner), but the touches must not cut the interior into pieces: a hole
 *    touching the outer ring twice, or holes touching in a loop
 *    (`disconnected`, GEOS's "Interior is disconnected"; a flag, not a
 *    problem, so the caller can first say a hole lies outside, as GEOS
 *    does, rather than call it a cut). With rings that
 *    are simple and meet only at points, the interior's pieces are one more
 *    than the cycles in the graph of rings and touch points (each ring
 *    joined to each point it passes through), so a union-find over that
 *    graph finds them: rings meeting at one shared point make no cycle.
 * Otherwise the touch points, so later checks can test a point of a ring
 * that isn't on another (freePoint).
 *
 * The crossing test is a sweep over the edges sorted by their least
 * longitude, comparing only edges whose extents overlap. Every comparison
 * counts against GEO_MAX_PAIR_CHECKS, the ones skipped by latitude too, so
 * past it the shape is refused as too complex: a hostile ring (a zigzag whose
 * edges all overlap in longitude) can't cost quadratic time. The touch
 * points it finds are at most the comparisons made, and the rest is linear in
 * them.
 */
export function checkRings(rings: readonly (readonly Position[])[]): RingsVerdict {
	const edges: { r: number; i: number; n: number; minX: number }[] = [];
	rings.forEach((ring, r) => {
		const n = ring.length - 1; // edges; the ring is closed
		for (let i = 0; i < n; i++) edges.push({ r, i, n, minX: Math.min(ring[i]![0], ring[i + 1]![0]) });
	});
	edges.sort((a, b) => a.minX - b.minX);
	const touches = new Map<string, RingTouch>();
	/** Where point p lies on edge i of ring r (p one of its ends, or inside it). */
	const spotOn = (r: number, i: number, n: number, p: Position): Spot => {
		const ring = rings[r]!;
		return same(p, ring[i]!) ? { v: i } : same(p, ring[i + 1]!) ? { v: (i + 1) % n } : { e: i };
	};
	const active: (typeof edges)[number][] = [];
	let checks = 0;
	for (const e of edges) {
		const ring = rings[e.r]!;
		const a = ring[e.i]!;
		const b = ring[e.i + 1]!;
		let kept = 0;
		for (let k = 0; k < active.length; k++) {
			const o = active[k]!;
			const other = rings[o.r]!;
			const c = other[o.i]!;
			const d = other[o.i + 1]!;
			if (Math.max(c[0], d[0]) < e.minX) continue; // passed: dropped from the sweep
			active[kept++] = o;
			if (++checks > GEO_MAX_PAIR_CHECKS) throw new Refused('has a ring too complex to check; simplify it');
			if (o.r === e.r && (Math.abs(e.i - o.i) === 1 || Math.abs(e.i - o.i) === e.n - 1)) continue;
			if (Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) continue;
			if (!segmentsCross(a, b, c, d)) continue;
			// They meet. One ring meeting itself anywhere but at a neighbouring edge's shared vertex: GEOS refuses a self-touch too.
			if (o.r === e.r) return { problem: 'self' };
			const [d1, d2, d3, d4] = [orient(c, d, a), orient(c, d, b), orient(a, b, c), orient(a, b, d)];
			if (d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) return { problem: 'cross' }; // through each other's insides
			let at: Position;
			if ((d1 === 0 && d2 === 0) || (d3 === 0 && d4 === 0)) {
				// On one line: along the longer axis, they share a stretch (run together: refused) or only an end.
				const ax = a[0] !== b[0] || c[0] !== d[0] ? 0 : 1;
				const lo = Math.max(Math.min(a[ax], b[ax]), Math.min(c[ax], d[ax]));
				const hi = Math.min(Math.max(a[ax], b[ax]), Math.max(c[ax], d[ax]));
				if (hi > lo) return { problem: 'cross' };
				at = a[ax] === lo ? a : b; // an end of each (edges have length, so the axis tells a from b)
			} else at = d1 === 0 && onSegment(c, d, a) ? a : d2 === 0 && onSegment(c, d, b) ? b : d3 === 0 && onSegment(a, b, c) ? c : d;
			const key = keyOf(at);
			let t = touches.get(key);
			if (!t) touches.set(key, (t = { at, rings: new Map() }));
			if (!t.rings.has(e.r)) t.rings.set(e.r, spotOn(e.r, e.i, e.n, at));
			if (!t.rings.has(o.r)) t.rings.set(o.r, spotOn(o.r, o.i, o.n, at));
		}
		active.length = kept;
		active.push(e);
	}
	const list = [...touches.values()];
	// Touching, not crossing: at each touch point, each pair of rings keeps to its own side of the other.
	for (const t of list) {
		if (crossAt(t.at, [...t.rings].map(([r, spot]) => neighbours(rings[r]!, spot)))) return { problem: 'cross' };
	}
	// The interior stays one piece: no cycle in the graph of rings (0 … rings − 1) and touch points (after them).
	const parent = Array.from({ length: rings.length + list.length }, (_, i) => i);
	const find = (x: number): number => {
		while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
		return x;
	};
	for (const [k, t] of list.entries()) {
		for (const r of t.rings.keys()) {
			const [x, y] = [find(r), find(rings.length + k)];
			if (x === y) return { problem: null, touches: list, disconnected: true };
			parent[x] = y;
		}
	}
	return { problem: null, touches: list, disconnected: false };
}

/** Whether one closed ring crosses or touches itself (checkRings of the ring alone; GEOS refuses both). */
export const ringSelfIntersects = (ring: readonly Position[]): boolean => checkRings([ring]).problem !== null;

/**
 * The touch points on each ring, by `touchesOn(i)`: built once, each touch
 * listed once per ring meeting there (no pairs), so its size is the
 * incidences checkRings found, however many rings meet at a point.
 */
export function touchesOn(touches: readonly RingTouch[]): (i: number) => ReadonlySet<string> {
	const on = new Map<number, Set<string>>();
	for (const t of touches) {
		const k = keyOf(t.at);
		for (const r of t.rings.keys()) {
			const set = on.get(r);
			if (set) set.add(k);
			else on.set(r, new Set([k]));
		}
	}
	const none: ReadonlySet<string> = new Set();
	return (i) => on.get(i) ?? none;
}

/**
 * A point of `ring` that isn't on `other`, of rings that passed checkRings,
 * given the touch points on each (`onRing`, `onOther`: touchesOn): its first
 * vertex that isn't a touch point of both, else an edge's middle that isn't.
 * Two rings touching more than once cut the interior (checkRings'
 * `disconnected`) and a ring has at least three vertices, so in a valid
 * polygon the first or second vertex serves; the middles are for a hole
 * outside its ring touching it at every vertex, refused either way. With
 * the rings not crossing, the point is inside `other` exactly when `ring`
 * lies inside it. (A ring's first vertex may be a touch point, where
 * pointInRing's answer is arbitrary: a hole touching its outer ring there was
 * called outside.)
 */
export function freePoint(ring: readonly Position[], onRing: ReadonlySet<string>, onOther: ReadonlySet<string>): Position {
	const on = (p: Position) => onRing.has(keyOf(p)) && onOther.has(keyOf(p));
	if (onRing.size === 0 || onOther.size === 0) return ring[0]!;
	for (const p of ring) if (!on(p)) return p;
	for (let k = 0; k + 1 < ring.length; k++) {
		const mid: Position = [(ring[k]![0] + ring[k + 1]![0]) / 2, (ring[k]![1] + ring[k + 1]![1]) / 2];
		if (!on(mid)) return mid;
	}
	return ring[0]!;
}

/** Whether point `p` lies inside ring `r` (ray casting; on the edge counts as outside). */
export function pointInRing(p: Position, r: readonly Position[]): boolean {
	let inside = false;
	for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
		const [xi, yi] = r[i]!;
		const [xj, yj] = r[j]!;
		if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/**
 * Whether a hole lies inside another hole (its area would be taken away
 * twice). The holes have passed checkRings, so no two cross, and two meet at
 * most at a point: each pair is either apart or one wholly inside the other
 * (a touch point aside), and one is inside another exactly when a point of
 * it off the other is (`testPoint(i, o)`, a point of hole i not on hole o,
 * as freePoint finds; its first vertex by default, right for holes that
 * don't touch). This is GEOS's
 * IndexedNestedHoleTester (IsValidOp, once it knows no rings cross): an
 * index of the holes' boxes, then a point-in-ring test only for a box that
 * holds another, against the ring indexed by its edges' latitudes
 * (IndexedPointInAreaLocator).
 *
 * Sub-quadratic: the holes' boxes are swept by their least longitude, so a
 * hole is compared only with the boxes still open at its west edge, and a
 * pair goes on to the point-in-ring test only when one box holds the other.
 * Each ring with candidates inside its box is indexed once into horizontal
 * strips (about √edges of them, each edge in the strips its latitudes span),
 * so a big hole with thousands of small holes in its box costs its edges
 * once plus a strip per candidate, not its edges per candidate. Every box
 * compared, edge indexed and edge tested counts against GEO_MAX_SWEEP_STEPS;
 * past it the polygon is refused as too complex (the box comparisons are
 * already bounded by checkRings' own sweep: boxes open together at a
 * longitude have edges open together there).
 */
export function holesNested(holes: readonly (readonly Position[])[], testPoint: (i: number, o: number) => Position = (i) => holes[i]![0]!): boolean {
	if (holes.length < 2) return false;
	let steps = 0;
	const spend = (n: number) => {
		steps += n;
		if (steps > GEO_MAX_SWEEP_STEPS) throw new Refused('has holes too complex to check; simplify it');
	};
	const boxes = holes.map((r) => {
		let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
		for (const [x, y] of r) (w = Math.min(w, x)), (e = Math.max(e, x)), (s = Math.min(s, y)), (n = Math.max(n, y));
		return { w, s, e, n };
	});
	spend(holes.reduce((a, r) => a + r.length, 0));
	const holds = (o: number, i: number) => {
		const [a, b] = [boxes[o]!, boxes[i]!];
		return a.w <= b.w && a.e >= b.e && a.s <= b.s && a.n >= b.n;
	};
	// Candidate pairs, by the ring that may hold the other.
	const inside = new Map<number, number[]>();
	const add = (o: number, i: number) => {
		const list = inside.get(o);
		if (list) list.push(i);
		else inside.set(o, [i]);
	};
	const order = holes.map((_, i) => i).sort((a, b) => boxes[a]!.w - boxes[b]!.w);
	const open: number[] = [];
	for (const i of order) {
		const b = boxes[i]!;
		let kept = 0;
		for (let k = 0; k < open.length; k++) {
			const o = open[k]!;
			if (boxes[o]!.e < b.w) continue; // passed: dropped from the sweep
			open[kept++] = o;
			spend(1);
			// Open boxes start at or west of this one: only an equal west edge lets this one hold the other.
			if (holds(o, i)) add(o, i);
			else if (holds(i, o)) add(i, o);
		}
		open.length = kept;
		open.push(i);
	}
	for (const [o, list] of inside) {
		const ring = holes[o]!;
		const { s, n } = boxes[o]!;
		const m = ring.length - 1; // edges; the ring is closed
		const strips = Math.max(1, Math.ceil(Math.sqrt(m)));
		const h = (n - s) / strips;
		const strip = (y: number) => Math.min(strips - 1, Math.max(0, Math.floor((y - s) / h)));
		const index: number[][] = Array.from({ length: strips }, () => []);
		for (let k = 0; k < m; k++) {
			const [lo, hi] = [ring[k]![1], ring[k + 1]![1]];
			const [a, b] = [strip(Math.min(lo, hi)), strip(Math.max(lo, hi))];
			spend(b - a + 1);
			for (let t = a; t <= b; t++) index[t]!.push(k);
		}
		for (const i of list) {
			// pointInRing's ray, over the edges of the point's strip only (an edge crosses latitude y only if it spans it).
			const [px, py] = testPoint(i, o);
			const edges = index[strip(py)]!;
			spend(edges.length);
			let odd = false;
			for (const k of edges) {
				const [xi, yi] = ring[k]!;
				const [xj, yj] = ring[k + 1]!;
				if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) odd = !odd;
			}
			if (odd) return true;
		}
	}
	return false;
}

/**
 * Whether `groups` overlap by more than `share` of their area: the area
 * inside two of them (in degrees², planar: a ratio over one catchment)
 * against the sum of their own areas. Each group is one region of closed
 * rings read even-odd, rings that don't cross each other (a polygon's outer
 * ring and holes, or one hole alone). Parts of a MultiPolygon that overlap,
 * or a hole inside another hole, make the area count twice (or take it away
 * twice), so the checks refuse them. Parts that share an edge, as
 * neighbouring quaternaries do, pass, and so do the slivers where two
 * independently digitised neighbours overlap a little along their shared
 * boundary: the DWS quaternaries overlap by up to 0.023 % of a group's area,
 * so OVERLAP_SHARE leaves several times that. (Holes inside holes are
 * holesNested's: rings that can't cross need no area sweep.)
 *
 * Two groups can overlap only inside the box their boxes share, so each
 * pair whose boxes meet is clipped to that box (geo/clip.ts) and swept
 * there: over the horizontal slabs between successive vertex latitudes,
 * where no ring has a vertex and each edge is straight, the width inside
 * both is measured at the slab's bottom, middle and top (a group inside
 * while an odd number of its edges lie to the west) and integrated by
 * Simpson's rule. Every vertex clipped and every edge visited counts against
 * GEO_MAX_SWEEP_STEPS; past it the shape is refused as too complex, so a
 * hostile file can't cost quadratic time.
 */
export function polygonsOverlap(groups: readonly (readonly (readonly Position[])[])[], share = OVERLAP_SHARE): boolean {
	const boxes = groups.map((rings) => {
		let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
		for (const r of rings) for (const [x, y] of r) (w = Math.min(w, x)), (e = Math.max(e, x)), (s = Math.min(s, y)), (n = Math.max(n, y));
		return { w, s, e, n };
	});
	// The groups' own areas, holes taken away.
	const own = groups.reduce((sum, rings) => sum + Math.abs(Math.abs(planarArea(rings[0]!)) - rings.slice(1).reduce((h, r) => h + Math.abs(planarArea(r)), 0)), 0);
	const limit = share * own;
	const work = { steps: 0 };
	const spend = (n: number) => {
		work.steps += n;
		if (work.steps > GEO_MAX_SWEEP_STEPS) throw new Refused('has parts too complex to check for overlaps; simplify it');
	};
	let overlap = 0;
	for (let i = 0; i < groups.length; i++) {
		for (let j = i + 1; j < groups.length; j++) {
			const [a, b] = [boxes[i]!, boxes[j]!];
			spend(1);
			const box = { w: Math.max(a.w, b.w), s: Math.max(a.s, b.s), e: Math.min(a.e, b.e), n: Math.min(a.n, b.n) };
			if (box.w >= box.e || box.s >= box.n) continue;
			const clipped = [groups[i]!, groups[j]!].map((rings) =>
				rings.flatMap((r) => {
					spend(r.length);
					const c = clipY(clipX(openRing(r), box.w, box.e), box.s, box.n);
					return c.length >= 3 ? [c] : [];
				})
			);
			if (!clipped[0]!.length || !clipped[1]!.length) continue;
			overlap += twiceCovered(clipped, spend);
			if (overlap > limit) return true;
		}
	}
	return false;
}

/**
 * The area (degrees², planar) inside both of two regions, each its closed
 * rings read even-odd (a polygon's outer ring and holes, or every ring of a
 * MultiPolygon whose parts don't overlap): polygonsOverlap's clip and sweep,
 * for one pair. `spend` counts the work as polygonsOverlap's does, and may
 * throw to stop it. Used by the dam to waterbody match (dams/observed/match.ts).
 */
export function intersectionArea(a: readonly (readonly Position[])[], b: readonly (readonly Position[])[], spend: (n: number) => void = () => {}): number {
	const boxOf = (rings: readonly (readonly Position[])[]) => {
		let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
		for (const r of rings) for (const [x, y] of r) (w = Math.min(w, x)), (e = Math.max(e, x)), (s = Math.min(s, y)), (n = Math.max(n, y));
		return { w, s, e, n };
	};
	const [ba, bb] = [boxOf(a), boxOf(b)];
	const box = { w: Math.max(ba.w, bb.w), s: Math.max(ba.s, bb.s), e: Math.min(ba.e, bb.e), n: Math.min(ba.n, bb.n) };
	if (!(box.w < box.e && box.s < box.n)) return 0;
	const clipped = [a, b].map((rings) =>
		rings.flatMap((r) => {
			spend(r.length);
			const c = clipY(clipX(openRing(r), box.w, box.e), box.s, box.n);
			return c.length >= 3 ? [c] : [];
		})
	);
	if (!clipped[0]!.length || !clipped[1]!.length) return 0;
	return twiceCovered(clipped, spend);
}

/** The area (degrees²) inside both of two groups of open rings (each read even-odd): polygonsOverlap's slab sweep. */
function twiceCovered(groups: readonly (readonly Position[])[][], spend: (n: number) => void): number {
	// Each edge from its lower end to its upper (so an edge two groups share is computed identically for both); flat edges cross no slab.
	const edges: { g: number; x0: number; y0: number; x1: number; y1: number }[] = [];
	groups.forEach((rings, g) => {
		for (const r of rings) {
			for (let i = 0; i < r.length; i++) {
				const p = r[i]!;
				const q = r[(i + 1) % r.length]!;
				const [lo, hi] = p[1] <= q[1] ? [p, q] : [q, p];
				if (lo[1] !== hi[1]) edges.push({ g, x0: lo[0], y0: lo[1], x1: hi[0], y1: hi[1] });
			}
		}
	});
	edges.sort((a, b) => a.y0 - b.y0);
	const ys = [...new Set(edges.flatMap((e) => [e.y0, e.y1]))].sort((a, b) => a - b);
	const xAt = (e: (typeof edges)[number], y: number) => (y === e.y0 ? e.x0 : y === e.y1 ? e.x1 : e.x0 + ((e.x1 - e.x0) * (y - e.y0)) / (e.y1 - e.y0));
	/** The width inside both groups along latitude y, of the edges crossing it. */
	const both = (crossing: readonly (typeof edges)[number][], y: number) => {
		const row = crossing.map((e) => ({ g: e.g, x: xAt(e, y) })).sort((a, b) => a.x - b.x);
		const inside = [false, false];
		let w = 0;
		for (let i = 0; i < row.length - 1; i++) {
			inside[row[i]!.g] = !inside[row[i]!.g];
			if (inside[0] && inside[1]) w += row[i + 1]!.x - row[i]!.x;
		}
		return w;
	};
	let active: (typeof edges)[number][] = [];
	let next = 0;
	let area = 0;
	for (let k = 0; k < ys.length - 1; k++) {
		const lo = ys[k]!;
		const hi = ys[k + 1]!;
		active = active.filter((e) => e.y1 > lo);
		while (next < edges.length && edges[next]!.y0 <= lo) active.push(edges[next++]!);
		spend(3 * active.length);
		// Every active edge spans the whole slab, so the three lines cross the same edges.
		area += ((hi - lo) * (both(active, lo) + 4 * both(active, (lo + hi) / 2) + both(active, hi))) / 6;
	}
	return area;
}

function ring(a: unknown, count: { n: number }): Position[] {
	// A position repeated in a row (common in digitised files) is one vertex.
	const r = positions(a, 4, 'polygon ring', count).filter((p, i, all) => i === 0 || p[0] !== all[i - 1]![0] || p[1] !== all[i - 1]![1]);
	if (r.length < 4) throw new Refused('a polygon ring needs at least 4 positions');
	const [f, l] = [r[0]!, r[r.length - 1]!];
	if (f[0] !== l[0] || f[1] !== l[1]) throw new Refused('has a polygon ring that is not closed (its last position must repeat its first)');
	if (planarArea(r) === 0) throw new Refused('has a polygon ring with no area');
	return r;
}

function polygon(a: unknown, count: { n: number }): Position[][] {
	if (!Array.isArray(a) || a.length === 0) throw new Refused('a polygon has no rings');
	const rings = a.map((r) => ring(r, count));
	// One sweep over every ring: a ring that crosses or touches itself, or a hole that crosses its outer ring or another hole, or runs along one.
	// Rings may touch at a point (a hole at its outer ring's vertex, as raster-traced outlines do at a pixel corner); OGC and GEOS allow it.
	const verdict = checkRings(rings);
	if (verdict.problem !== null) {
		if (verdict.problem === 'cross') throw new Refused('has polygon rings that cross each other or run along each other');
		throw new Refused(rings.length === 1 ? 'has a polygon ring that crosses itself' : 'has a polygon ring that crosses or touches itself');
	}
	// A point of each hole off the ring it's tested against: a hole's first vertex may be where it touches that ring.
	const on = touchesOn(verdict.touches);
	for (let h = 1; h < rings.length; h++) {
		if (!pointInRing(freePoint(rings[h]!, on(h), on(0)), rings[0]!)) throw new Refused('has a hole outside its polygon');
	}
	// The rings don't cross, so a hole can still lie inside another: its area would be taken away twice.
	if (rings.length > 2 && holesNested(rings.slice(1), (i, o) => freePoint(rings[i + 1]!, on(i + 1), on(o + 1)))) throw new Refused('has a hole inside another hole');
	if (verdict.disconnected) throw new Refused('has holes that cut it into pieces (touching its outer ring or each other at more than one point); make each piece its own polygon');
	const xs = rings[0]!.map((p) => p[0]);
	if (Math.max(...xs) - Math.min(...xs) > 180) throw new Refused('crosses the antimeridian, which isn’t supported');
	return rings;
}

/** A checked geometry, or throws Refused with what is wrong. */
function geometry(g: unknown): Geometry {
	if (g === null || typeof g !== 'object' || Array.isArray(g)) throw new Refused('has no geometry');
	const { type, coordinates } = g as { type?: unknown; coordinates?: unknown };
	const count = { n: 0 };
	switch (type) {
		case 'Point':
			return { type, coordinates: position(coordinates, count) };
		case 'LineString':
			return { type, coordinates: positions(coordinates, 2, 'line', count) };
		case 'MultiLineString':
			if (!Array.isArray(coordinates) || coordinates.length === 0) throw new Refused('a MultiLineString has no lines');
			return { type, coordinates: coordinates.map((l) => positions(l, 2, 'line', count)) };
		case 'Polygon':
			return { type, coordinates: polygon(coordinates, count) };
		case 'MultiPolygon':
			if (!Array.isArray(coordinates) || coordinates.length === 0) throw new Refused('a MultiPolygon has no polygons');
			const polygons = coordinates.map((p) => polygon(p, count));
			// Overlapping parts would count the overlap twice in the area (and in every share taken from it).
			if (polygons.length > 1 && polygonsOverlap(polygons)) throw new Refused('has MultiPolygon parts that overlap; merge them into one polygon');
			return { type, coordinates: polygons };
		default:
			throw new Refused(
				`has a ${typeof type === 'string' ? type : 'missing'} geometry; the map takes Point, LineString, MultiLineString, Polygon and MultiPolygon`
			);
	}
}

/** One geometry, checked: `{ geometry }` or `{ problem }` (a sentence starting lowercase, "has …"). */
export function checkGeometry(g: unknown): { geometry: Geometry; areaM2: number | null } | { problem: string } {
	try {
		const out = geometry(g);
		return { geometry: out, areaM2: geometryAreaM2(out) };
	} catch (e) {
		if (e instanceof Refused) return { problem: e.message };
		throw e;
	}
}

/** Whether polygons from several features can be one MultiPolygon: the check checkGeometry makes of a MultiPolygon's parts ('complex' past its budget). */
export function overlapProblem(polygons: readonly (readonly (readonly Position[])[])[]): 'overlap' | 'complex' | null {
	try {
		return polygons.length > 1 && polygonsOverlap(polygons) ? 'overlap' : null;
	} catch (e) {
		if (e instanceof Refused) return 'complex';
		throw e;
	}
}

function crsProblem(crs: unknown): string | null {
	if (crs === undefined || crs === null) return null;
	const name = (crs as { properties?: { name?: unknown } })?.properties?.name;
	if (typeof name === 'string' && WGS84_NAMES.has(name)) return null;
	return `The file is in ${typeof name === 'string' ? name : 'a coordinate system it doesn’t name'}; reproject it to WGS84 (EPSG:4326) and upload it again.`;
}

function featureName(props: Record<string, unknown>): string {
	for (const k of NAME_KEYS) {
		const v = props[k];
		if (typeof v === 'string' && featureNameOf(v)) return featureNameOf(v);
		if (typeof v === 'number' && Number.isFinite(v)) return String(v);
	}
	return '';
}

/**
 * A `layer` value read as the feature's name: QGIS's "Merge vector layers"
 * writes each source layer's name there, so a file of sub-catchments
 * carries their names only in `layer`. Taken only when the
 * feature has no NAME_KEYS name and the value names no kind (a `layer` of
 * "dams" still proposes the kind).
 */
function layerAsName(props: Record<string, unknown>): string | null {
	const key = Object.keys(props).find((x) => x.toLowerCase() === 'layer');
	const v = key === undefined ? undefined : props[key];
	if (typeof v !== 'string' || kindFromWord(v) !== null) return null;
	return featureNameOf(v) || null;
}

/** The first `kind`/`type`/`layer` value; `layer` skipped when it became the name (layerAsName). */
function kindHint(props: Record<string, unknown>, layerIsName: boolean): string | null {
	for (const k of KIND_KEYS) {
		if (layerIsName && k === 'layer') continue;
		const key = Object.keys(props).find((x) => x.toLowerCase() === k);
		const v = key === undefined ? undefined : props[key];
		if (typeof v === 'string' && v.trim()) return v.trim().slice(0, FEATURE_NAME_MAX);
	}
	return null;
}

function keptProperties(props: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, max] of Object.entries(FEATURE_PROPERTIES)) {
		const v = props[k];
		if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, max);
	}
	return out;
}

/**
 * Parse and check a GeoJSON file's text: a FeatureCollection, one Feature or
 * a bare geometry. Returns every feature that passed and every problem; a
 * caller refuses the file when there is any problem (a half-imported
 * boundary is worse than none).
 */
export function parseGeoJson(text: string): { features: ParsedFeature[]; problems: GeoProblem[] } {
	const whole = (message: string) => ({ features: [], problems: [{ feature: null, message }] });
	if (Buffer.byteLength(text, 'utf8') > GEO_MAX_BYTES) return whole(`The file is larger than ${GEO_MAX_BYTES / 1024 / 1024} MB; simplify it or split it.`);
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return whole('The file is not valid JSON: a GeoJSON file (.geojson or .json) is expected.');
	}
	if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return whole('The file is not a GeoJSON object.');
	const crs = crsProblem((doc as { crs?: unknown }).crs);
	if (crs) return whole(crs);
	const d = doc as { type?: unknown; features?: unknown };
	let raw: unknown[];
	if (d.type === 'FeatureCollection') {
		if (!Array.isArray(d.features)) return whole('The FeatureCollection has no features list.');
		raw = d.features;
	} else if (d.type === 'Feature') raw = [doc];
	else raw = [{ type: 'Feature', geometry: doc, properties: {} }];
	if (raw.length === 0) return whole('The file has no features.');
	if (raw.length > GEO_MAX_FEATURES) return whole(`The file has ${raw.length} features; the most one upload takes is ${GEO_MAX_FEATURES}.`);
	const features: ParsedFeature[] = [];
	const problems: GeoProblem[] = [];
	raw.forEach((f, i) => {
		const index = i + 1;
		if (f === null || typeof f !== 'object' || (f as { type?: unknown }).type !== 'Feature') {
			problems.push({ feature: index, message: 'is not a GeoJSON Feature' });
			return;
		}
		const props = (f as { properties?: unknown }).properties;
		const p = props !== null && typeof props === 'object' && !Array.isArray(props) ? (props as Record<string, unknown>) : {};
		const checked = checkGeometry((f as { geometry?: unknown }).geometry);
		if ('problem' in checked) problems.push({ feature: index, message: checked.problem });
		else {
			const named = featureName(p);
			const fromLayer = named ? null : layerAsName(p);
			features.push({ index, geometry: checked.geometry, name: named || fromLayer || '', properties: keptProperties(p), areaM2: checked.areaM2, kindHint: kindHint(p, fromLayer !== null) });
		}
	});
	return { features, problems };
}

/** A point at the middle of a geometry, for a list's "show on map" and the quaternary lookup: a point itself, a polygon's area centroid (its largest part), a line's middle vertex. */
export function centerOf(g: Geometry): Position {
	const centroid = (r: readonly Position[]): Position => {
		let a = 0;
		let cx = 0;
		let cy = 0;
		for (let i = 0; i < r.length - 1; i++) {
			const [x1, y1] = r[i]!;
			const [x2, y2] = r[i + 1]!;
			const k = x1 * y2 - x2 * y1;
			a += k;
			cx += (x1 + x2) * k;
			cy += (y1 + y2) * k;
		}
		return a === 0 ? r[0]! : [round(cx / (3 * a)), round(cy / (3 * a))];
	};
	switch (g.type) {
		case 'Point':
			return g.coordinates;
		case 'LineString':
			return g.coordinates[Math.floor(g.coordinates.length / 2)]!;
		case 'MultiLineString':
			return g.coordinates[0]![Math.floor(g.coordinates[0]!.length / 2)]!;
		case 'Polygon':
			return centroid(g.coordinates[0]!);
		case 'MultiPolygon': {
			const largest = g.coordinates.reduce((best, p) => (Math.abs(planarArea(p[0]!)) > Math.abs(planarArea(best[0]!)) ? p : best));
			return centroid(largest[0]!);
		}
	}
}

/**
 * A point inside a polygon (holes kept out): the middle of the widest stretch of the horizontal line through the largest
 * part's outer-ring centroid that lies inside the polygon. Inside by construction, unlike a crescent's or an L's centroid
 * or vertex average. Null when the ring is degenerate. Parity: the same algorithm as the frontend's `interiorPoint`
 * (frontend/src/lib/components/map/pieces.ts, where a piece's number goes); a change to one is made to both.
 */
export function interiorPoint(g: Extract<Geometry, { type: 'Polygon' | 'MultiPolygon' }>): Position | null {
	const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
	let best: Position[][] | null = null;
	let bestArea = -1;
	for (const p of polys) {
		const a = Math.abs(planarArea(p[0] ?? []));
		if (a > bestArea) (bestArea = a), (best = p);
	}
	if (!best || bestArea <= 0) return null;
	const outer = best[0]!;
	let cy = 0;
	let wsum = 0;
	for (let i = 0; i + 1 < outer.length; i++) {
		const [x0, y0] = outer[i]!;
		const [x1, y1] = outer[i + 1]!;
		const cross = x0 * y1 - x1 * y0;
		cy += (y0 + y1) * cross;
		wsum += cross;
	}
	const y = wsum ? cy / (3 * wsum) : outer[0]![1];
	const xs: number[] = [];
	for (const ring of best) {
		for (let i = 0; i + 1 < ring.length; i++) {
			const [ax, ay] = ring[i]!;
			const [bx, by] = ring[i + 1]!;
			if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
		}
	}
	xs.sort((a, b) => a - b);
	let mid: number | null = null;
	let width = -1;
	for (let k = 0; k + 1 < xs.length; k += 2) {
		if (xs[k + 1]! - xs[k]! > width) (width = xs[k + 1]! - xs[k]!), (mid = (xs[k]! + xs[k + 1]!) / 2);
	}
	return mid === null ? null : [mid, y];
}

/** Whether a point lies in a Polygon or MultiPolygon (inside its outer ring and outside its holes). */
export function pointInGeometry(p: Position, g: Geometry): boolean {
	const inPolygon = (rings: readonly Position[][]) => pointInRing(p, rings[0]!) && !rings.slice(1).some((h) => pointInRing(p, h));
	if (g.type === 'Polygon') return inPolygon(g.coordinates);
	if (g.type === 'MultiPolygon') return g.coordinates.some(inPolygon);
	return false;
}
