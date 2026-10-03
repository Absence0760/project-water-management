// Sub-catchments at every dam and abstraction point (issue #326 C3 and the
// B-delineate stretch; docs/design/start-from-map.md § Sub-catchments).
// One DEM window around the catchment is filled and routed once; the outlet
// and every unit's point snap to the channel; each unit drains into the
// first other unit (or the outlet) its D8 path meets; and each unit owns
// the cells whose path meets it before any other unit: its incremental
// sub-catchment, outlined with its holes. The rest of the catchment is the
// outlet's own piece. A water user or a gauge inside the catchment is in the
// order but owns no land: its cells stay with the unit below it.
//
// It only proposes: start.ts stores the result as a proposal the editor
// ticks value by value; nothing here writes anything.
import { checkGeometry, type Geometry, type Position } from '../geo/geojson.js';
import { cellRowAreaM2, mercatorLat } from '../geo/area.js';
import type { Dem, DemInfo } from './dem.js';
import {
	aimAt,
	bearingWord,
	boundsText,
	cutChannel,
	DelineationRefused,
	EARTH_RADIUS_M,
	readWindow,
	SNAP_RADIUS_M,
	TARGET_ZOOM,
	TIME_BUDGET_MS,
	toLonLat,
	toPx,
	tooLargeText,
	windowOrigin,
	WINDOWS,
	worldPx,
	type Aim,
	type LargerChannel
} from './delineate.js';
import { JUNCTION_MATCH_M, JUNCTION_PATH_M, junctionOutlets, type JunctionRiver } from './junction.js';
import { GULLY_SHARE, GUARD_RADIUS_M, LARGER_FACTOR, MATCH_RADIUS_M, MIN_ACCORDANCE, onOwnChannel, place, WIDE_MATCH_M } from './place.js';
import { accumulate, d8, DX, DY, edgeMask, fill, NO_DATA_EDGE, OUT, openFlags, touchesEdge, upstream } from './flow.js';
import { simplifyRing, traceRings, type Pt } from './outline.js';
import { findPans, ncAreaM2, panReport, type PanReport } from './pans.js';

/** Bump when the method changes what a proposal holds; recorded on every proposal. */
/**
 * start-3 (issue #374): a point with a nearby river reach matched to its upstream area; the rest snapped, with a much larger channel nearby named; start-4: a click at a confluence asks for the river and goes at the DEM's own junction;
 * start-5 (issue #387): the snap radius measured from the exact point to each cell's centre, so a snap distance never exceeds it;
 * start-6: every area (each piece, the rest, the catchment, a no-land unit's total) summed from its cells, each cell's own area on the WGS84 ellipsoid, not the simplified outline's;
 * start-7 (the hydrologist's review, finding 3): Start and Divide place the outlet gauge and every point as Delineate does (each one's
 * nearby river reach looked up, its area matched, the river asked for at a confluence), keep each point's larger-channel warning and its
 * placement in the plan, take a delineated outlet's own cell (it was re-snapped up to 150 m downstream), and the method says what ran;
 * start-8 (issue #390): a point within JUNCTION_SIDE_M of a mapped junction kept on its river's side of the DEM's junction, and a junction placement on the river's own channel nearest the point, not at the junction;
 * start-9 (delineate-5's rules reaching Start, Divide and Sub-catchments): a point on the DEM's own channel stays on it, the reach's
 * matching channel offered; a gully snap offers the reach's channel out to 2.5 km; the reach's area is taken at the point;
 * start-10 (the hydrologist's review, findings 9 and 11): a dam outline that only clips a much larger channel placed at its own outflow (damOutflow), and no `unmatched` on a click cut at the window;
 * start-11 (the hydrologist's review, finding 8): the area of the catchment, of each piece and of each unit's whole catchment that
 * drains into pans (closed depressions the fill routes onward) reported as non-contributing beside the areas (pans.ts); the areas unchanged;
 * start-12 (issue #390, findings 1 and 6 reaching Start, Divide and Sub-catchments): a river the window cuts at the outlet grows the
 * window instead of leaving the outlet in a gully, each larger window is placed over the catchment (delineate.ts windowOrigin), and a
 * cut click keeps its `unmatched` unless its reach is larger than the routed square.
 */
export const START_METHOD_VERSION = 'start-12';
/** Cells kept between the boundary's box and the window's edge, so its divide isn't routed at the edge. */
const MARGIN_CELLS = 32;

export type UnitRole = 'dam' | 'abstraction' | 'user' | 'gauge';

/**
 * How a point was put on the channel: matched to its nearby river reach's area, at the DEM's junction for the river picked at a
 * confluence, snapped to the most-drained cell near it, moved onto the much larger channel the editor chose (`useLarger`), on its
 * own cell (`exact`: a delineated outlet, already placed), a dam polygon's most-drained cell, or the boundary's most-drained cell.
 */
export type PlacedBy = 'matched' | 'snapped' | 'junction' | 'larger' | 'exact' | 'polygon' | 'boundary';

/** How a point is to be placed (the expected area, the confluence, the editor's choices); none of it means the plain snap. */
export interface PlacementHints {
	/** A point's expected upstream area (km², a nearby river reach's): the point is matched to it (place.ts, issue #374). */
	expectedKm2?: number | null;
	/** The editor picked the reach at a confluence: looked for over JUNCTION_MATCH_M (place.ts `chosen`). */
	chosen?: boolean;
	/** How far the point is from that reach's line (m): off the line, a point on a DEM channel of its own stays there (place.ts rule 3). */
	reachDistanceM?: number | null;
	/** At a confluence: its rivers and the one picked; the point goes on the DEM's own junction (junction.ts), else by area. */
	junction?: { rivers: JunctionRiver[]; chosenKey: string } | null;
	/** Snapped beside a much larger channel, the editor chose that channel: the point goes on it. */
	useLarger?: boolean;
	/** Already on the DEM's channel (a delineated outlet): its own cell, not moved. */
	exact?: boolean;
}
/** Roles that own no land: in the order, their cells left to the unit below them. */
export const ownsLand = (role: UnitRole): boolean => role !== 'user' && role !== 'gauge';

export interface UnitPoint extends PlacementHints {
	/** The map feature's id: the proposal's key for the unit. */
	id: string;
	role: UnitRole;
	/** A point, or a dam's polygon (its outflow: damOutflow). */
	geometry: Geometry;
	/** What a refusal calls it ("click 2"); absent, "a point". */
	name?: string;
}

// ---------------------------------------------------------------------------
// The pure core: a routed grid, the outlet's cell and the units' cells → who
// drains into whom and who owns which cells.
// ---------------------------------------------------------------------------

export interface Partition {
	/** Per cell: the owning unit's index, `units.length` for the outlet's own piece (the rest), -1 outside the catchment. */
	owner: Int32Array;
	/** Per unit: the index of the unit it drains into, or -1 for the outlet. */
	down: number[];
}

/**
 * Partition the catchment above `outlet` among `units` (cells, all upstream
 * of the outlet, distinct, none the outlet). A unit that `owns` no land (a
 * water user) is in the network but its cells stay with the unit below it.
 */
export function partition(nx: number, ny: number, dir: Uint8Array, outlet: number, units: readonly { cell: number; owns: boolean }[]): Partition {
	const n = nx * ny;
	const R = units.length;
	const node = new Int32Array(n).fill(-1);
	node[outlet] = R;
	units.forEach((u, i) => (node[u.cell] = i));
	const next = (c: number) => {
		const d = dir[c]!;
		return d === OUT ? -1 : c + DY[d]! * nx + DX[d]!;
	};
	const down = units.map((u) => {
		let k = next(u.cell);
		for (let guard = 0; k >= 0 && node[k] === -1 && guard < n; guard++) k = next(k);
		if (k < 0 || node[k] === -1) throw new Error('a unit’s cell is not upstream of the outlet');
		return node[k] === R ? -1 : node[k]!;
	});
	// Owners: the outlet and the units that own land. Each floods upstream from its cell, stopping at another owner's cell.
	const stop = new Int32Array(n).fill(-1);
	stop[outlet] = R;
	units.forEach((u, i) => {
		if (u.owns) stop[u.cell] = i;
	});
	const owner = new Int32Array(n).fill(-1);
	const flood = (start: number, o: number) => {
		owner[start] = o;
		const stack = [start];
		while (stack.length) {
			const c = stack.pop()!;
			const cx = c % nx;
			const cy = (c - cx) / nx;
			for (let d = 0; d < 8; d++) {
				const x = cx + DX[d]!;
				const y = cy + DY[d]!;
				if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
				const k = y * nx + x;
				if (owner[k] !== -1 || stop[k] !== -1 || dir[k] !== (d + 4) % 8) continue;
				owner[k] = o;
				stack.push(k);
			}
		}
	};
	flood(outlet, R);
	units.forEach((u, i) => {
		if (u.owns) flood(u.cell, i);
	});
	return { owner, down };
}

/** Edge crossings one rasterize may find before the outline is refused as too intricate for the grid. */
export const RASTER_MAX_CROSSINGS = 1_000_000;

/**
 * Even–odd scanline fill of polygon rings (grid coordinates, a cell is 1 × 1,
 * centres at +0.5) into a mask. Each edge adds its crossings only to the rows
 * it spans (not every row to every edge), so the work is the edges plus their
 * crossings; past RASTER_MAX_CROSSINGS the outline is refused.
 */
export function rasterize(nx: number, ny: number, rings: readonly (readonly Pt[])[]): Uint8Array {
	const mask = new Uint8Array(nx * ny);
	const rows: number[][] = [];
	let crossings = 0;
	for (const r of rings) {
		for (let i = 0; i + 1 < r.length; i++) {
			const [ax, ay] = r[i]!;
			const [bx, by] = r[i + 1]!;
			if (!(ay !== by)) continue;
			// Rows whose centre cy = y + 0.5 lies in [min, max): exactly those where (ay > cy) !== (by > cy).
			const lo = Math.max(0, Math.ceil(Math.min(ay, by) - 0.5));
			const hi = Math.min(ny - 1, Math.ceil(Math.max(ay, by) - 0.5) - 1);
			if (hi < lo) continue;
			crossings += hi - lo + 1;
			if (crossings > RASTER_MAX_CROSSINGS) throw new DelineationRefused('outline', 'An outline on the map is too intricate to place on the elevation model: simplify it.');
			for (let y = lo; y <= hi; y++) {
				const cy = y + 0.5;
				(rows[y] ??= []).push(ax + ((cy - ay) * (bx - ax)) / (by - ay));
			}
		}
	}
	rows.forEach((xs, y) => {
		xs.sort((a, b) => a - b);
		for (let k = 0; k + 1 < xs.length; k += 2) {
			// Cells whose centre (x + 0.5) lies in [xs[k], xs[k+1]).
			const from = Math.max(0, Math.ceil(xs[k]! - 0.5));
			const to = Math.min(nx - 1, Math.ceil(xs[k + 1]! - 0.5) - 1);
			for (let x = from; x <= to; x++) mask[y * nx + x] = 1;
		}
	});
	return mask;
}

/** The cell of `mask` with the most upstream cells, never an edge cell; -1 when none. */
export function mostDrained(mask: Uint8Array, acc: Int32Array, edge: Uint8Array): number {
	let best = -1;
	for (let i = 0; i < mask.length; i++) if (mask[i] && !edge[i] && (best < 0 || acc[i]! > acc[best]!)) best = i;
	return best;
}

/**
 * A dam polygon's outflow (the hydrologist's review, finding 9). Its most-drained cell M is the wall's outflow when the river
 * runs through the reservoir. But an off-channel dam (filled by a pump or a furrow), or an outline traced from the water that
 * clips a river beside it, has M on that river, which is not the dam's: taking M gave such a dam the river's whole catchment.
 * The river's stem inside the outline tells them apart: from M upstream along the most-drained cell flowing into it, while
 * inside the outline. A river that forms the reservoir runs its length; one that only clips the outline runs a cell or two of
 * it. So when the stem is short (twice its cells at most the outline's longer side, in cells) and M carries LARGER_FACTOR
 * times the most-drained outline cell off the stem (the guard's "much larger"; twice flagged gullies beside a dam on GLO-30),
 * the dam's outflow is that cell (its own footprint's) and M is returned as `straddled`, to offer; otherwise M, as before. A long off-channel dam lying along the river (stem as long as the outline) is
 * still taken as on it. Cells are -1 when the outline holds no non-edge cell. Pure.
 */
export function damOutflow(nx: number, mask: Uint8Array, dir: Uint8Array, acc: Int32Array, edge: Uint8Array): { cell: number; straddled: number | null } {
	const m = mostDrained(mask, acc, edge);
	if (m < 0) return { cell: -1, straddled: null };
	const ny = mask.length / nx;
	const stem = new Uint8Array(mask.length);
	let stemCells = 0;
	for (let c = m; c >= 0; ) {
		stem[c] = 1;
		stemCells++;
		const cx = c % nx;
		const cy = (c - cx) / nx;
		// The river upstream: the most-drained cell flowing into this one, inside the outline or not; the stem stops where it leaves.
		let up = -1;
		for (let d = 0; d < 8; d++) {
			const x = cx + DX[d]!;
			const y = cy + DY[d]!;
			if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
			const k = y * nx + x;
			if (dir[k] === (d + 4) % 8 && (up < 0 || acc[k]! > acc[up]!)) up = k;
		}
		c = up >= 0 && mask[up] && !stem[up] ? up : -1;
	}
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	const off = new Uint8Array(mask.length);
	for (let i = 0; i < mask.length; i++) {
		if (!mask[i]) continue;
		const x = i % nx;
		const y = (i - x) / nx;
		(x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
		if (!stem[i]) off[i] = 1;
	}
	const side = Math.max(x1 - x0, y1 - y0) + 1;
	const own = mostDrained(off, acc, edge);
	if (own < 0 || 2 * stemCells > side || acc[m]! < LARGER_FACTOR * acc[own]!) return { cell: m, straddled: null };
	return { cell: own, straddled: m };
}

// ---------------------------------------------------------------------------
// The driver: reads the DEM, routes it, snaps, partitions and outlines.
// ---------------------------------------------------------------------------

export interface UnitPiece {
	id: string;
	role: UnitRole;
	/** The snapped cell's centre. */
	point: Position;
	/** How far the point moved to the channel (m); null for a dam polygon (its most-drained cell). */
	snapDistanceM: number | null;
	/** The unit it drains into, by id; null = the outlet. */
	drainsInto: string | null;
	/** Its own piece: the incremental sub-catchment (null for a water user or a gauge, or a piece that couldn't be outlined). */
	geometry: Extract<Geometry, { type: 'Polygon' }> | null;
	/** The piece's geodesic area (m²); 0 for a water user or a gauge. */
	areaM2: number;
	/**
	 * Everything upstream of it, its own piece included (m²): the pieces above
	 * it summed for a unit that owns land; for a water user or a gauge, its
	 * cells upstream counted (each at its row's cell size), since the land
	 * just above it belongs to the unit below.
	 */
	totalAreaM2: number;
	/** Of `areaM2` and of `totalAreaM2`, what drains into pans (pans.ts; m²): reported, not taken out. */
	nonContributingM2: number;
	totalNonContributingM2: number;
	/** How the point was put on the channel (place.ts, PlacedBy). */
	placedBy?: PlacedBy;
	/** Snapped beside a much larger channel: that channel, to offer (the point stays where it snapped). */
	larger?: LargerChannel;
	/** It had an expected area (a nearby river reach) but no channel near it matched (place.ts): it may be on another stream. */
	unmatched?: boolean;
	/**
	 * Only with `outlet: 'lowest'`: its catchment runs past the routed window (or the DEM's data), so its piece is not whole.
	 * Its outline is null and its areas count only the cells inside the window; the water from above it enters as an inflow.
	 */
	open?: boolean;
}

export interface Subcatchments {
	/** `id`: with `outlet: 'lowest'`, the point taken as the outlet (it owns the rest, and is not among the units). */
	outlet: { point: Position; snapDistanceM: number | null; foundIn: 'snapped' | 'boundary' | 'lowest'; id?: string; placedBy?: PlacedBy; larger?: LargerChannel; unmatched?: boolean };
	/** The whole catchment above the outlet: its outline and geodesic area. */
	catchment: { geometry: Extract<Geometry, { type: 'Polygon' }>; areaM2: number };
	units: UnitPiece[];
	/** Points not proposed as units, with why. */
	dropped: { id: string; reason: string; placedBy?: PlacedBy; larger?: LargerChannel; unmatched?: boolean }[];
	/** The outlet's own piece: what drains to it through no unit. */
	rest: { geometry: Extract<Geometry, { type: 'Polygon' }> | null; areaM2: number; nonContributingM2: number; open?: boolean };
	/** The catchment's pans (pans.ts): what of it drains into one (NaN when the catchment is cut at the window, as its area), and the largest. */
	pans: PanReport;
	cellSizeM: number;
	zoom: number;
	windowCells: number;
	dataset: DemInfo;
	method: string;
	methodVersion: string;
}

type Poly = Extract<Geometry, { type: 'Polygon' }>;

const polygonRings = (g: Geometry): Position[][] =>
	g.type === 'Polygon' ? (g.coordinates as Position[][]) : g.type === 'MultiPolygon' ? (g.coordinates as Position[][][]).flat() : [];

function segmentsCross(a: readonly Pt[], b: readonly Pt[]): boolean {
	const orient = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
	for (let i = 0; i + 1 < a.length; i++) {
		for (let j = 0; j + 1 < b.length; j++) {
			const [p, q, r, s] = [a[i]!, a[i + 1]!, b[j]!, b[j + 1]!];
			const o1 = orient(p, q, r);
			const o2 = orient(p, q, s);
			const o3 = orient(r, s, p);
			const o4 = orient(r, s, q);
			if (o1 * o2 <= 0 && o3 * o4 <= 0 && !(o1 === 0 && o2 === 0)) return true;
		}
	}
	return false;
}

// The grid's row latitudes and cell areas live in geo/area.ts (delineate.ts's pans need them too); re-exported for the callers here.
export { cellRowAreaM2, mercatorLat };

/** A piece's rings as a checked GeoJSON polygon (holes kept), simplified as far as stays valid; null when it can't be made one. */
function piecePolygon(outer: Pt[], holes: Pt[][], toPos: (p: Pt) => Position): { geometry: Poly; areaM2: number } | null {
	for (const tol of [1, 0.5, 0]) {
		const o = simplifyRing(outer, tol);
		const hs = holes.map((h) => simplifyRing(h, tol));
		if (hs.some((h) => segmentsCross(o, h)) || hs.some((h, i) => hs.some((k, j) => j > i && segmentsCross(h, k)))) continue;
		// Traced y-down with the region on the left: reverse, so the outer ring is counter-clockwise and the holes clockwise (RFC 7946 § 3.1.6).
		const coordinates = [o, ...hs].map((r) => r.map(toPos).reverse());
		const checked = checkGeometry({ type: 'Polygon', coordinates });
		if ('geometry' in checked && checked.geometry.type === 'Polygon' && checked.areaM2) return { geometry: checked.geometry, areaM2: checked.areaM2 };
	}
	return null;
}

export interface SubcatchmentRequest {
	/**
	 * The outlet's position (a gauge, or a delineation's snapped outlet), snapped; null = the most-drained cell inside `boundary`;
	 * 'lowest' = the point (all must be points) that most water drains through, once snapped: clicks on the rivers, each one's piece its incremental catchment.
	 */
	outlet: Position | null | 'lowest';
	/** How a fixed outlet (a Position) is placed: as a point is (PlacementHints); absent, the plain snap. */
	outletHints?: PlacementHints;
	boundary: Geometry | null;
	points: readonly UnitPoint[];
}

/** start_proposal.method's limit (178_start_proposal.sql): the method must fit whatever ran. */
export const METHOD_MAX_CHARS = 1000;

/**
 * The method's sentence on where the points went, from what ran (never a rule that didn't): `placed` is each point's
 * placement but the outlet's, `outletPlaced` the outlet's (null when it is a click), `unmatched` how many snapped points had a
 * reach near but no match. Each rule that ran is defined once; `brief` names the method version for the definitions instead, the
 * form fitMethod falls back to when every rule at once would pass METHOD_MAX_CHARS. Pure.
 */
export function placementText(placed: readonly PlacedBy[], unmatched: number, outletPlaced: PlacedBy | null, snapRadiusM: number, brief = false): string {
	const short: Record<PlacedBy, string> = {
		matched: 'matched',
		junction: 'at a junction',
		snapped: 'snapped',
		larger: 'on the larger channel chosen',
		exact: 'on its delineated cell',
		polygon: 'at a dam polygon’s outflow',
		boundary: 'at the boundary’s most-accumulating cell'
	};
	const order: PlacedBy[] = ['matched', 'junction', 'snapped', 'larger', 'exact', 'polygon', 'boundary'];
	const parts: string[] = [];
	if (outletPlaced) parts.push(`the outlet ${short[outletPlaced]}`);
	for (const how of order) {
		const k = placed.filter((p) => p === how).length;
		if (k) parts.push(`${k === 1 ? '1 point' : `${k} points`} ${short[how]}`);
	}
	if (!parts.length) return 'no points placed';
	const ran = new Set([...placed, ...(outletPlaced ? [outletPlaced] : [])]);
	const defs: string[] = [];
	if (ran.has('matched'))
		defs.push(`matched: the cell within ${MATCH_RADIUS_M} m (${JUNCTION_MATCH_M} m at a picked confluence) best matching the reach’s area (Lehner 2012, ≥ ${MIN_ACCORDANCE} %)`);
	// The default (the outline's most-accumulating cell) needs no words; the exception does (damOutflow).
	if (ran.has('polygon')) defs.push('outflow: its own if a river only clips it');
	if (ran.has('junction')) defs.push('at a junction: the DEM’s junction for the river picked');
	if (ran.has('snapped') || ran.has('larger'))
		defs.push(`snapped: the most-accumulating cell within ${snapRadiusM} m${unmatched ? ` (${unmatched} by an unmatched reach)` : ''}, a ${LARGER_FACTOR}× larger channel within ${GUARD_RADIUS_M} m named`);
	if (brief && defs.length) return `placed on the channel: ${parts.join(', ')} (each rule as ${START_METHOD_VERSION} defines it, docs/maps.md)`;
	return `placed on the channel: ${parts.join(', ')}${defs.length ? ` (${defs.join('; ')})` : ''}`;
}

/** The whole method sentence for a division: the routing, where the points went (placementText) and the partition. Pure. */
export function startMethod(cellSizeM: number, zoom: number, placement: string): string {
	const cellM = Math.round(cellSizeM);
	return (
		`D8 after Priority-Flood+ε filling (Barnes, Lehman & Mulla 2014), ${cellM} m cells (zoom ${zoom}), routed once for the catchment; ` +
		`${placement}; ` +
		`each unit drains into the first unit its flow path meets and owns the cells reaching it first (a water user or a gauge owns none); areas summed from the cells, each on the WGS84 ellipsoid; outlines simplified for the map (Douglas–Peucker, about ${cellM} m)`
	);
}

/**
 * The method that fits start_proposal.method: in full when it fits, else with the placement rules named by the method version
 * instead of defined (a proposal with nearly every kind of placement at once ran past the column's 1 000 characters, which the
 * insert would refuse). Pure.
 */
export function fitMethod(cellSizeM: number, zoom: number, placement: (brief: boolean) => string): string {
	const full = startMethod(cellSizeM, zoom, placement(false));
	return full.length <= METHOD_MAX_CHARS ? full : startMethod(cellSizeM, zoom, placement(true));
}

/**
 * The refusal when every click's piece is cut at `past` (the window, or the DEM's data). A click dropped as draining elsewhere is
 * named, since it is usually why: meant below the lowest click, it missed the river (the hydrologist's review, finding 11: the
 * refusal blamed the clicks' layout when the lower click had landed in a gully beside the river). Pure.
 */
export function allOpenText(
	past: string,
	points: readonly Pick<UnitPoint, 'id' | 'name' | 'geometry'>[],
	outletId: string | undefined,
	droppedKm2: ReadonlyMap<string, number>,
	how: ReadonlyMap<string, { larger?: LargerChannel }>
): string {
	const missed = points.filter((p) => droppedKm2.has(p.id));
	if (!missed.length || outletId === undefined) {
		return `Every click’s catchment runs past ${past}, so none is whole. Click a smaller river, or click further down a river you have clicked upstream: the piece between the two clicks is whole, and the water from above the upper one enters as an inflow.`;
	}
	const top = points.find((p) => p.id === outletId)?.name ?? 'the lowest click';
	const km2Text = (v: number) => (v < 10 ? `${v.toFixed(2)} km²` : `${Math.round(v).toLocaleString('en-ZA')} km²`);
	const why = missed.map((p) => {
		const larger = how.get(p.id)?.larger;
		const name = p.name ?? 'a point';
		const where = larger && p.geometry.type === 'Point' ? ` ${bearingWord(p.geometry.coordinates, larger.at)} of it` : '';
		return `${name} landed on a channel draining ${km2Text(droppedKm2.get(p.id)!)}${larger ? `, with a much larger channel ${Math.round(larger.distanceM)} m${where}` : ''}`;
	});
	const one = missed.length === 1;
	const cap = (t: string) => `${t[0]!.toUpperCase()}${t.slice(1)}`;
	return (
		`${cap(top)} is the click most water drains through, and its catchment runs past ${past}, so it can’t be a whole piece. ` +
		`${cap(why.join('; '))}: ${one ? 'it doesn’t' : 'they don’t'} drain to ${top}, so ${one ? 'it is' : 'each is'} on another river or missed this one. ` +
		`If you meant ${one ? 'it' : 'them'} below ${top}, Undo and click on the river itself: the piece between the two clicks is whole, and the water from above ${top} enters as an inflow.`
	);
}

/** Partition the catchment above the outlet among the points. Throws DelineationRefused with a sentence for the user. */
export async function delineateUnits(
	dem: Dem,
	req: SubcatchmentRequest,
	opts: { windows?: readonly number[]; snapRadiusM?: number; budgetMs?: number; now?: () => number } = {}
): Promise<Subcatchments> {
	const now = opts.now ?? (() => performance.now());
	const started = now();
	const budget = opts.budgetMs ?? TIME_BUDGET_MS;
	const windows = opts.windows ?? WINDOWS;
	const snapRadiusM = opts.snapRadiusM ?? SNAP_RADIUS_M;
	const boundaryRings = req.boundary ? polygonRings(req.boundary) : [];
	const lowest = req.outlet === 'lowest';
	const fixedOutlet = req.outlet === 'lowest' ? null : req.outlet;
	const clicks = lowest ? req.points.flatMap((p) => (p.geometry.type === 'Point' ? [p.geometry.coordinates] : [])) : [];
	if (lowest && !clicks.length) throw new DelineationRefused('outside', 'Click a river first.');
	if (!lowest && !fixedOutlet && !boundaryRings.length) throw new DelineationRefused('outside', 'Pick the outlet gauge, or put the catchment boundary on the map first.');
	/** What the outlet is called in a refusal. */
	const theOutlet = lowest ? 'the lowest click' : 'the outlet';
	const info = await dem.info();
	const [w, s, e, n] = info.bounds;
	const inside = ([lon, lat]: Position) => lon >= w && lon <= e && lat >= s && lat <= n;
	const z = Math.min(TARGET_ZOOM, info.maxZoom);
	// The centre: the outlet, else the boundary's box's middle.
	let lonMin = Infinity;
	let lonMax = -Infinity;
	let latMin = Infinity;
	let latMax = -Infinity;
	for (const r of [...boundaryRings, clicks]) for (const [lo, la] of r) (lonMin = Math.min(lonMin, lo)), (lonMax = Math.max(lonMax, lo)), (latMin = Math.min(latMin, la)), (latMax = Math.max(latMax, la));
	const centre: Position = fixedOutlet ?? [(lonMin + lonMax) / 2, (latMin + latMax) / 2];
	if (!inside(centre)) throw new DelineationRefused('outside', `${lowest ? 'The clicks are' : 'The outlet is'} outside the elevation model (${info.label} covers ${boundsText(info.bounds)}).`);
	const probe = toPx(centre[0], centre[1], 2 ** z);
	const here = await dem.tile(z, Math.floor(probe[0]), Math.floor(probe[1]));
	if (!here) throw new DelineationRefused('no_data', `The elevation model has no data at ${lowest ? 'the clicks' : 'the outlet'}.`);
	const size = here.size;
	const W = worldPx(z, size);
	const [gx, gy] = toPx(centre[0], centre[1], W);
	const cellAt = (lat: number) => (2 * Math.PI * EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180)) / W;
	const cellSizeM = cellAt(centre[1]);
	// The boundary's reach from the centre, in cells: the first window must hold it.
	let reach = 0;
	for (const r of [...boundaryRings, clicks]) {
		for (const [lo, la] of r) {
			const [px, py] = toPx(lo, la, W);
			reach = Math.max(reach, Math.abs(px - gx), Math.abs(py - gy));
		}
	}
	const need = 2 * (Math.ceil(reach) + MARGIN_CELLS);
	const first = windows.findIndex((c) => c >= need);
	// What every window keeps inside around the centre, wherever it is placed (delineate.ts windowOrigin): the points and the
	// boundary with their margin, and the junction's match and its path downhill.
	const keep = Math.max(Math.ceil(reach) + MARGIN_CELLS, Math.ceil((JUNCTION_MATCH_M + JUNCTION_PATH_M) / cellSizeM) + 2);
	const capCells = windows[windows.length - 1]!;
	const cellKm2 = (cellSizeM * cellSizeM) / 1e6;
	/** Where the last window cut the catchment: the next window is placed over it. */
	let aim: Aim | null = null;
	if (first < 0) {
		throw new DelineationRefused('too_large', `The catchment boundary reaches beyond the ${Math.round((windows[windows.length - 1]! * cellSizeM) / 1000)} km the app delineates around its outlet, so it can’t be divided into units here. Draw or type the units instead.`);
	}
	for (let wi = first; wi < windows.length; wi++) {
		const nCells = windows[wi]!;
		const [x0, y0] = windowOrigin(nCells, gx, gy, Math.min(keep, Math.floor((nCells - 1) / 2)), aim);
		const toGrid = ([lo, la]: Position): Pt => {
			const [px, py] = toPx(lo, la, W);
			return [px - x0, py - y0];
		};
		const toPos = ([x, y]: Pt): Position => toLonLat(x0 + x, y0 + y, W);
		const grid = await readWindow(dem, z, size, x0, y0, nCells);
		const edge = edgeMask(grid);
		// The elevations before the fill, to tell its pans (pans.ts): 4 bytes a cell.
		const before = new Float32Array(grid.z);
		fill(grid, edge);
		const dir = d8(grid, edge);
		const acc = accumulate(nCells, nCells, dir);
		/** Whether each cell's catchment runs past the window or the data's edge (flow.ts openFlags). */
		const cutFlags = openFlags(nCells, nCells, dir, edge);
		const km2 = (cells: number) => (cells * cellSizeM * cellSizeM) / 1e6;
		// Each window row's cell area (m²): a Web Mercator cell is a longitude × latitude rectangle, so its area on the ellipsoid
		// is exact in (λ, sin β), as geo/area.ts measures every polygon: the area of an unsimplified outline is its cells' sum.
		const rowM2 = new Float64Array(nCells);
		// The rows' latitudes unrounded (toLonLat keeps 7 decimals, a few parts in ten thousand of a 10 m cell).
		for (let y = 0; y < nCells; y++) rowM2[y] = cellRowAreaM2(mercatorLat(y0 + y, W), mercatorLat(y0 + y + 1, W), W);
		/** Each point's placement, by its key, for the pieces' facts. */
		const how = new Map<string, { placedBy: PlacedBy; larger?: LargerChannel; unmatched?: boolean }>();
		/** The outlet's own key in `how` (no point's id is empty). */
		const OUTLET = '';
		const snapAt = (p: Position, key?: string, hints: PlacementHints = {}): number | null => {
			const [x, y] = toGrid(p);
			if (x < 0 || y < 0 || x >= nCells || y >= nCells) return null;
			const record = (v: { placedBy: PlacedBy; larger?: LargerChannel; unmatched?: boolean }) => key !== undefined && how.set(key, v);
			if (hints.exact) {
				const c = Math.floor(y) * nCells + Math.floor(x);
				if (edge[c]) return null;
				record({ placedBy: 'exact' });
				return c;
			}
			const g0 = { nx: nCells, ny: nCells, acc, edge, cellSizeM };
			const placed = place(g0, x, y, { snapRadiusM, expectedKm2: hints.expectedKm2, chosen: hints.chosen, reachDistanceM: hints.reachDistanceM });
			// Beside a junction nobody picked a river at, a point on a DEM channel of its own stays there (place.ts rule 3), as in Delineate.
			const ownChannel = !hints.chosen && onOwnChannel(g0, x, y, { expectedKm2: hints.expectedKm2, reachDistanceM: hints.reachDistanceM });
			const atJunction = hints.junction && !ownChannel ? junctionOutlets({ ...g0, dir }, x, y, hints.junction.rivers, snapRadiusM)?.get(hints.junction.chosenKey) : undefined;
			if (atJunction !== undefined) {
				record({ placedBy: 'junction' });
				return atJunction;
			}
			if (!placed) return null;
			// A channel matching the reach, offered (place.ts rules 3 and 4), says more than "unmatched" would.
			const unmatched = !!hints.expectedKm2 && placed.how === 'snapped' && !placed.larger?.reach;
			if (placed.larger && hints.useLarger) {
				// The editor chose the channel the guard named: the point goes on it (found again here, never taken from the request).
				record({ placedBy: 'larger', ...(unmatched ? { unmatched } : {}) });
				return placed.larger.cell;
			}
			const larger = placed.larger
				? (() => {
						const lx = placed.larger.cell % nCells;
						return {
							at: toPos([lx + 0.5, (placed.larger.cell - lx) / nCells + 0.5]),
							distanceM: placed.larger.distanceM,
							km2: km2(acc[placed.larger.cell]!),
							pointKm2: km2(acc[placed.cell]!),
							...(placed.larger.reach && hints.expectedKm2 ? { reachKm2: hints.expectedKm2 } : {})
						};
					})()
				: undefined;
			record({ placedBy: placed.how, ...(larger ? { larger } : {}), ...(unmatched ? { unmatched } : {}) });
			return placed.cell;
		};
		const cellPos = (c: number): Position => {
			const cx = c % nCells;
			return toPos([cx + 0.5, (c - cx) / nCells + 0.5]);
		};
		const cellDistM = (a: number, b: number) => Math.hypot((a % nCells) - (b % nCells), Math.floor(a / nCells) - Math.floor(b / nCells)) * cellSizeM;
		const movedM = (p: Position, c: number) => {
			const [x, y] = toGrid(p);
			const cx = c % nCells;
			return Math.hypot(cx + 0.5 - x, (c - cx) / nCells + 0.5 - y) * cellSizeM;
		};
		// The outlet.
		let outlet: number;
		let outletSnap: number | null = null;
		let outletId: string | undefined;
		if (lowest) {
			// The click most water drains through, once snapped; the first of equals.
			outlet = -1;
			for (const p of req.points) {
				if (p.geometry.type !== 'Point') continue;
				const c = snapAt(p.geometry.coordinates, p.id, p);
				if (c === null || (outlet >= 0 && acc[c]! <= acc[outlet]!)) continue;
				outlet = c;
				outletId = p.id;
				outletSnap = movedM(p.geometry.coordinates, c);
			}
			if (outlet < 0) throw new DelineationRefused('no_data', 'The elevation model has no data around the clicks.');
		} else if (fixedOutlet) {
			const c = snapAt(fixedOutlet, OUTLET, req.outletHints);
			if (c === null) throw new DelineationRefused('no_data', 'The elevation model has no data around the outlet.');
			outlet = c;
			outletSnap = movedM(fixedOutlet, c);
		} else {
			outlet = mostDrained(rasterize(nCells, nCells, boundaryRings.map((r) => r.map(toGrid))), acc, edge);
			if (outlet < 0) throw new DelineationRefused('no_data', 'The elevation model has no data inside the boundary.');
			how.set(OUTLET, { placedBy: 'boundary' });
		}
		// The outlet's river cut by the window (delineate.ts, delineate-6): a reach near the outlet, nothing matching its area, a
		// channel in reach cut by the window with under twice it. In a window smaller than the river, a gauge on it snaps into a
		// gully whose catchment never reaches the border, and the plan was proposed whole. Grown (placed over that channel) up to
		// the cap, as long as the reach fits the cap's square; not when the editor chose the guard's channel or a matching channel
		// is already offered (place.ts rules 3 and 4).
		const outletHints: PlacementHints | undefined = lowest ? req.points.find((p) => p.id === outletId) : fixedOutlet ? req.outletHints : undefined;
		const outletAt: Position | null = lowest ? (req.points.find((p) => p.id === outletId)?.geometry as { coordinates?: Position } | undefined)?.coordinates ?? null : fixedOutlet;
		const outletHow = how.get(lowest ? (outletId ?? OUTLET) : OUTLET);
		const expectedKm2 = outletHints?.expectedKm2;
		if (expectedKm2 && outletAt && outletHow?.placedBy === 'snapped' && outletHow.larger?.reachKm2 === undefined && !outletHints?.useLarger) {
			const [cx, cy] = toGrid(outletAt);
			const gully = acc[outlet]! * cellKm2 < GULLY_SHARE * expectedKm2;
			const radiusM = outletHints?.chosen || gully ? WIDE_MATCH_M : MATCH_RADIUS_M;
			const cut = cutChannel({ nx: nCells, ny: nCells, acc, edge, cellSizeM }, cutFlags, cx, cy, radiusM, (2 * expectedKm2) / cellKm2);
			if (cut >= 0 && cutFlags[cut]! & NO_DATA_EDGE) {
				throw new DelineationRefused('no_data', `The river at ${theOutlet} runs past the edge of the elevation model’s data, so its catchment can’t be divided whole.`);
			}
			if (cut >= 0 && nCells < capCells && expectedKm2 <= (capCells * cellSizeM) ** 2 / 1e6) {
				const next = windows[wi + 1]!;
				if ((now() - started) * (1 + (next / nCells) ** 2) > budget) {
					throw new DelineationRefused('too_large', tooLargeText('outlet', Math.round((nCells * cellSizeM) / 1000), expectedKm2));
				}
				aim = aimAt(upstream(nCells, nCells, dir, cut), nCells, x0, y0);
				continue;
			}
		}
		const catchment = upstream(nCells, nCells, dir, outlet);
		const touch = touchesEdge(grid, edge, catchment);
		// Clicks: a catchment past the window is not refused. The pieces past it are open (inflows), the others whole; refused only when every piece is open.
		let truncated = false;
		if (lowest && (touch.edge || touch.noData)) {
			const next = windows[wi + 1];
			const elapsed = now() - started;
			// A bigger window can close a piece at the window's border, never one at the DEM's no-data.
			if (!touch.noData && next !== undefined && elapsed * (1 + (next / nCells) ** 2) <= budget) {
				aim = aimAt(catchment, nCells, x0, y0);
				continue;
			}
			truncated = true;
		}
		if (touch.noData && !lowest) throw new DelineationRefused('no_data', `The catchment above ${theOutlet} runs past the edge of the elevation model’s data, so it can’t be divided whole.`);
		if (touch.edge && !lowest) {
			const next = windows[wi + 1];
			const elapsed = now() - started;
			if (next === undefined || elapsed * (1 + (next / nCells) ** 2) > budget) {
				throw new DelineationRefused('too_large', tooLargeText('outlet', Math.round((nCells * cellSizeM) / 1000), req.outletHints?.expectedKm2));
			}
			aim = aimAt(catchment, nCells, x0, y0);
			continue;
		}
		let catchmentCells = 0;
		for (let i = 0; i < catchment.length; i++) catchmentCells += catchment[i]!;
		if (catchmentCells < 9) {
			throw new DelineationRefused('too_small', lowest ? 'Almost nothing drains to the lowest click: click on the river itself.' : 'Almost nothing drains to the outlet: pick a gauge on the river itself.');
		}
		// The units' cells: snapped points, a dam polygon's most-drained cell; dropped with a reason when they can't be units.
		const dropped: { id: string; reason: string }[] = [];
		/** What drains through a point dropped as draining elsewhere, where it landed (km²): a refusal names a click that missed the river. */
		const droppedKm2 = new Map<string, number>();
		const taken = new Map<number, string>([[outlet, '']]);
		const kept: { p: UnitPoint; cell: number; snapDistanceM: number | null }[] = [];
		for (const p of req.points) {
			if (p.id === outletId) continue;
			let cell: number | null = null;
			let moved: number | null = null;
			if (p.geometry.type === 'Point') {
				cell = snapAt(p.geometry.coordinates, p.id, p);
				if (cell !== null) moved = movedM(p.geometry.coordinates, cell);
			} else {
				const rings = polygonRings(p.geometry);
				const out = rings.length ? damOutflow(nCells, rasterize(nCells, nCells, rings.map((r) => r.map(toGrid))), dir, acc, edge) : null;
				if (out && out.cell >= 0 && out.straddled !== null && p.useLarger) {
					// The editor said the dam is on the channel its outline clips: its outflow is that channel's cell.
					cell = out.straddled;
					how.set(p.id, { placedBy: 'larger' });
				} else if (out && out.cell >= 0) {
					cell = out.cell;
					const m = out.straddled;
					how.set(p.id, {
						placedBy: 'polygon',
						// The channel the outline clips, offered as a snapped point's larger channel is ("Use that channel").
						...(m !== null ? { larger: { at: cellPos(m), distanceM: cellDistM(out.cell, m), km2: km2(acc[m]!), pointKm2: km2(acc[out.cell]!), outline: true } } : {})
					});
				} else if (rings.length) {
					// Smaller than a cell: its first corner, snapped (its larger-channel guard kept).
					cell = snapAt(rings[0]![0]!, p.id);
					if (cell !== null) moved = movedM(rings[0]![0]!, cell);
				}
			}
			if (cell === null || !catchment[cell]) {
				if (cell !== null) droppedKm2.set(p.id, km2(acc[cell]!));
				dropped.push({
					id: p.id,
					reason: lowest ? 'doesn’t drain to the lowest click (it is on another river, or off the elevation model)' : 'isn’t upstream of the outlet (it drains elsewhere, or is off the elevation model)'
				});
				continue;
			}
			const clash = taken.get(cell);
			if (clash !== undefined) {
				dropped.push({ id: p.id, reason: clash === '' ? `snaps to ${lowest ? 'the same place on the river as the lowest click' : 'the outlet itself'}` : 'snaps to the same place on the river as another point' });
				continue;
			}
			taken.set(cell, p.id);
			kept.push({ p, cell, snapDistanceM: moved });
		}
		const part = partition(
			nCells,
			nCells,
			dir,
			outlet,
			kept.map((k) => ({ cell: k.cell, owns: ownsLand(k.p.role) }))
		);
		// The pans: what drains into a closed depression (none at the outlet or a point), per owner.
		const R = kept.length;
		const found = findPans(
			{ nx: nCells, ny: nCells, before, after: grid.z, dir, acc, mask: catchment, rowM2, toPos: cellPos },
			[outlet, ...kept.map((k) => k.cell)],
			Math.ceil(snapRadiusM / cellSizeM) + 1
		);
		const ncOf = new Float64Array(R + 1);
		for (let i = 0; i < found.nc.length; i++) if (found.nc[i] && part.owner[i]! >= 0) ncOf[part.owner[i]!]! += rowM2[(i - (i % nCells)) / nCells]!;
		// Each owner's box, then its piece outlined inside the box only.
		const box = Array.from({ length: R + 1 }, () => [Infinity, Infinity, -Infinity, -Infinity]);
		const count = new Int32Array(R + 1);
		for (let i = 0; i < part.owner.length; i++) {
			const o = part.owner[i]!;
			if (o < 0) continue;
			count[o]!++;
			const x = i % nCells;
			const y = (i - x) / nCells;
			const b = box[o]!;
			if (x < b[0]!) b[0] = x;
			if (y < b[1]!) b[1] = y;
			if (x > b[2]!) b[2] = x;
			if (y > b[3]!) b[3] = y;
		}
		const pieceOf = (o: number): { geometry: Poly | null; areaM2: number } => {
			if (!count[o]) return { geometry: null, areaM2: 0 };
			const [bx0, by0, bx1, by1] = box[o]! as [number, number, number, number];
			const bw = bx1 - bx0 + 1;
			const bh = by1 - by0 + 1;
			const m = new Uint8Array(bw * bh);
			let cellArea = 0;
			for (let y = by0; y <= by1; y++) {
				const rowArea = rowM2[y]!;
				for (let x = bx0; x <= bx1; x++) {
					if (part.owner[y * nCells + x] === o) {
						m[(y - by0) * bw + (x - bx0)] = 1;
						cellArea += rowArea;
					}
				}
			}
			const { outer, holes } = traceRings(bw, bh, m);
			const shift = (p: Pt): Pt => [p[0] + bx0, p[1] + by0];
			const poly = outer.length ? piecePolygon(outer.map(shift), holes.map((h) => h.map(shift)), toPos) : null;
			// The area is the cells' (the partition is exact in cells); the outline, simplified, is for the map only and its own
			// area runs short of the cells' on a jagged piece. A piece that can't be made a valid polygon offers no outline.
			return { geometry: poly?.geometry ?? null, areaM2: cellArea };
		};
		// Open owners: any of their cells beside the window's edge or the DEM's no-data (only when the catchment was cut).
		const open = new Uint8Array(R + 1);
		if (truncated) {
			for (let i = 0; i < part.owner.length; i++) {
				const o = part.owner[i]!;
				if (o < 0 || open[o]) continue;
				const x = i % nCells;
				const y = (i - x) / nCells;
				for (let d = 0; d < 8; d++) {
					const xx = x + DX[d]!;
					const yy = y + DY[d]!;
					if (xx >= 0 && yy >= 0 && xx < nCells && yy < nCells && edge[yy * nCells + xx]) {
						open[o] = 1;
						break;
					}
				}
			}
			if (open.every((v, o) => v || (o < R && !ownsLand(kept[o]!.p.role)))) {
				const past = touch.noData ? 'the edge of the elevation model’s data' : `the ${Math.round((nCells * cellSizeM) / 1000)} km the app routes around the clicks`;
				throw new DelineationRefused(touch.noData ? 'no_data' : 'too_large', allOpenText(past, req.points, outletId, droppedKm2, how));
			}
		}
		// A click whose catchment runs past the window can't be matched to its reach in it (the Orange's 340 724 km² in a 100 km
		// window): calling it unmatched was a false alarm on every main-stem click (the hydrologist's review, finding 11). Cut are
		// the lowest click, and every unit with an open piece and those below it. Only a reach larger than the routed square loses
		// it (as Delineate grows only for a reach that fits, start-12): a smaller one could have matched, so the warning stands.
		if (truncated) {
			const cut = new Set<string>(outletId !== undefined ? [outletId] : []);
			kept.forEach((_, i) => {
				if (!open[i]) return;
				for (let k = i; k >= 0; k = part.down[k]!) cut.add(kept[k]!.p.id);
			});
			for (const id of cut) {
				const h = how.get(id);
				const reachKm2 = req.points.find((p) => p.id === id)?.expectedKm2;
				if (h?.unmatched && reachKm2 && reachKm2 > (nCells * cellSizeM) ** 2 / 1e6) how.set(id, { placedBy: h.placedBy, ...(h.larger ? { larger: h.larger } : {}) });
			}
		}
		// An open piece isn't outlined (it would be cut at the window, and the API doesn't show it): no geometry, no area.
		const piece = (o: number): { geometry: Poly | null; areaM2: number } => (open[o] ? { geometry: null, areaM2: 0 } : pieceOf(o));
		const pieces = kept.map((_, i) => piece(i));
		const rest = piece(R);
		const outer = truncated ? [] : traceRings(nCells, nCells, catchment).outer;
		// Cut at the window (clicks with open pieces), the catchment is not whole: it isn't outlined, and its area is unknown
		// (NaN; every total below an open piece is unknown too, clicks.ts). Its geometry is then a whole piece's, never shown.
		const outline = truncated ? null : piecePolygon(outer, [], toPos);
		let catchmentM2 = 0;
		for (let i = 0; i < catchment.length; i++) if (catchment[i]) catchmentM2 += rowM2[(i - (i % nCells)) / nCells]!;
		const whole = outline ? { geometry: outline.geometry, areaM2: catchmentM2 } : null;
		const firstWhole = [...pieces, rest].find((p) => p.geometry)?.geometry;
		const catchmentShape = whole ?? (truncated && firstWhole ? { geometry: firstWhole, areaM2: Number.NaN } : null);
		if (!catchmentShape) throw new DelineationRefused('outline', 'The catchment’s outline could not be made into a valid polygon. Type the units in instead.');
		// Totals: each unit's piece plus everything that drains into it, summed down the tree (the pans' share too).
		const total = pieces.map((p) => p.areaM2);
		const ncPiece = kept.map((_, i) => (open[i] ? 0 : ncOf[i]!));
		const ncTotal = [...ncPiece];
		const order = kept.map((_, i) => i);
		const depth = (i: number) => {
			let d = 0;
			for (let k = part.down[i]!; k >= 0; k = part.down[k]!) d++;
			return d;
		};
		order.sort((a, b) => depth(b) - depth(a));
		for (const i of order) {
			const d = part.down[i]!;
			if (d >= 0) {
				total[d]! += total[i]!;
				ncTotal[d]! += ncTotal[i]!;
			}
		}
		// A unit that owns no land: the cells above it, counted (the pieces above it would miss the land between).
		kept.forEach((k, i) => {
			if (ownsLand(k.p.role)) return;
			const above = upstream(nCells, nCells, dir, k.cell);
			let m2 = 0;
			for (let y = 0; y < nCells; y++) {
				let row = 0;
				for (let x = 0; x < nCells; x++) row += above[y * nCells + x]!;
				if (row) m2 += row * rowM2[y]!;
			}
			total[i] = m2;
			ncTotal[i] = ncAreaM2(nCells, found.nc, rowM2, (c) => above[c] === 1);
		});
		return {
			outlet: {
			point: cellPos(outlet),
			snapDistanceM: outletSnap,
			foundIn: lowest ? 'lowest' : fixedOutlet ? 'snapped' : 'boundary',
			...(outletId !== undefined ? { id: outletId, ...(how.get(outletId) ?? {}) } : (how.get(OUTLET) ?? {}))
		},
			catchment: catchmentShape,
			units: kept.map((k, i) => ({
				id: k.p.id,
				role: k.p.role,
				point: cellPos(k.cell),
				snapDistanceM: k.snapDistanceM,
				drainsInto: part.down[i]! < 0 ? null : kept[part.down[i]!]!.p.id,
				geometry: pieces[i]!.geometry,
				areaM2: pieces[i]!.areaM2,
				totalAreaM2: total[i]!,
				nonContributingM2: ownsLand(k.p.role) ? ncPiece[i]! : 0,
				totalNonContributingM2: ncTotal[i]!,
				...(how.get(k.p.id) ?? {}),
				...(open[i] ? { open: true } : {})
			})),
			// A dropped point keeps its placement: one snapped into a gully beside its river names the river, so it can be moved there.
			dropped: dropped.map((d) => ({ ...d, ...(how.get(d.id) ?? {}) })),
			rest: open[R] ? { ...rest, nonContributingM2: 0, open: true } : { ...rest, nonContributingM2: ncOf[R]! },
			pans: panReport(truncated ? Number.NaN : ncAreaM2(nCells, found.nc, rowM2), found.pans),
			cellSizeM,
			zoom: z,
			windowCells: nCells,
			dataset: info,
			method: fitMethod(
				cellSizeM,
				z,
				(brief) =>
					placementText(
						req.points.flatMap((p) => (p.id === outletId || !how.has(p.id) ? [] : [how.get(p.id)!.placedBy])),
						req.points.filter((p) => p.id !== outletId && how.get(p.id)?.unmatched).length,
						lowest ? (outletId !== undefined ? (how.get(outletId)?.placedBy ?? null) : null) : (how.get(OUTLET)?.placedBy ?? null),
						snapRadiusM,
						brief
					) + (lowest ? ' (the outlet: the click most water drains through)' : '')
			),
			methodVersion: START_METHOD_VERSION
		};
	}
	throw new DelineationRefused('too_large', 'The catchment above the outlet is too large to divide into units here.');
}
