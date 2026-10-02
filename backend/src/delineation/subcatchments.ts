// Sub-catchments at every dam and abstraction point (issue #326 C3 and the
// B-delineate stretch; docs/design/start-from-map.md § Sub-catchments).
// One DEM window around the catchment is filled and routed once; the outlet
// and every unit's point snap to the channel; each unit drains into the
// first other unit (or the outlet) its D8 path meets; and each unit owns
// the cells whose path meets it before any other unit: its incremental
// sub-catchment, outlined with its holes. The rest of the catchment is the
// outlet's own piece.
//
// It only proposes: start.ts stores the result as a proposal the editor
// ticks value by value; nothing here writes anything.
import { checkGeometry, type Geometry, type Position } from '../geo/geojson.js';
import type { Dem, DemInfo } from './dem.js';
import { DelineationRefused, EARTH_RADIUS_M, readWindow, SNAP_RADIUS_M, TARGET_ZOOM, TIME_BUDGET_MS, toLonLat, toPx, WINDOWS, worldPx } from './delineate.js';
import { accumulate, d8, DX, DY, edgeMask, fill, OUT, snap, touchesEdge, upstream } from './flow.js';
import { simplifyRing, traceRings, type Pt } from './outline.js';

/** Bump when the method changes what a proposal holds; recorded on every proposal. */
export const START_METHOD_VERSION = 'start-1';
/** Cells kept between the boundary's box and the window's edge, so its divide isn't routed at the edge. */
const MARGIN_CELLS = 32;

export type UnitRole = 'dam' | 'abstraction' | 'user';

export interface UnitPoint {
	/** The map feature's id: the proposal's key for the unit. */
	id: string;
	role: UnitRole;
	/** A point, or a dam's polygon (its most-drained cell is the wall's outflow). */
	geometry: Geometry;
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

/** Even–odd scanline fill of polygon rings (grid coordinates, a cell is 1 × 1, centres at +0.5) into a mask. */
export function rasterize(nx: number, ny: number, rings: readonly (readonly Pt[])[]): Uint8Array {
	const mask = new Uint8Array(nx * ny);
	let y0 = Infinity;
	let y1 = -Infinity;
	for (const r of rings) for (const p of r) (y0 = Math.min(y0, p[1])), (y1 = Math.max(y1, p[1]));
	for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(ny - 1, Math.ceil(y1)); y++) {
		const cy = y + 0.5;
		const xs: number[] = [];
		for (const r of rings) {
			for (let i = 0; i + 1 < r.length; i++) {
				const [ax, ay] = r[i]!;
				const [bx, by] = r[i + 1]!;
				if (ay > cy !== by > cy) xs.push(ax + ((cy - ay) * (bx - ax)) / (by - ay));
			}
		}
		xs.sort((a, b) => a - b);
		for (let k = 0; k + 1 < xs.length; k += 2) {
			// Cells whose centre (x + 0.5) lies in [xs[k], xs[k+1]).
			const from = Math.max(0, Math.ceil(xs[k]! - 0.5));
			const to = Math.min(nx - 1, Math.ceil(xs[k + 1]! - 0.5) - 1);
			for (let x = from; x <= to; x++) mask[y * nx + x] = 1;
		}
	}
	return mask;
}

/** The cell of `mask` with the most upstream cells, never an edge cell; -1 when none. */
export function mostDrained(mask: Uint8Array, acc: Int32Array, edge: Uint8Array): number {
	let best = -1;
	for (let i = 0; i < mask.length; i++) if (mask[i] && !edge[i] && (best < 0 || acc[i]! > acc[best]!)) best = i;
	return best;
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
	/** Its own piece: the incremental sub-catchment (null for a water user, or a piece that couldn't be outlined). */
	geometry: Extract<Geometry, { type: 'Polygon' }> | null;
	/** The piece's geodesic area (m²); 0 for a water user. */
	areaM2: number;
	/** Everything upstream of it, its own piece included (m²). */
	totalAreaM2: number;
}

export interface Subcatchments {
	outlet: { point: Position; snapDistanceM: number | null; foundIn: 'snapped' | 'boundary' };
	/** The whole catchment above the outlet: its outline and geodesic area. */
	catchment: { geometry: Extract<Geometry, { type: 'Polygon' }>; areaM2: number };
	units: UnitPiece[];
	/** Points not proposed as units, with why. */
	dropped: { id: string; reason: string }[];
	/** The outlet's own piece: what drains to it through no unit. */
	rest: { geometry: Extract<Geometry, { type: 'Polygon' }> | null; areaM2: number };
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
	/** The outlet's position (a gauge, or a delineation's snapped outlet), snapped; null = the most-drained cell inside `boundary`. */
	outlet: Position | null;
	boundary: Geometry | null;
	points: readonly UnitPoint[];
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
	if (!req.outlet && !boundaryRings.length) throw new DelineationRefused('outside', 'Pick the outlet gauge, or put the catchment boundary on the map first.');
	const info = await dem.info();
	const [w, s, e, n] = info.bounds;
	const inside = ([lon, lat]: Position) => lon >= w && lon <= e && lat >= s && lat <= n;
	const z = Math.min(TARGET_ZOOM, info.maxZoom);
	// The centre: the outlet, else the boundary's box's middle.
	let lonMin = Infinity;
	let lonMax = -Infinity;
	let latMin = Infinity;
	let latMax = -Infinity;
	for (const r of boundaryRings) for (const [lo, la] of r) (lonMin = Math.min(lonMin, lo)), (lonMax = Math.max(lonMax, lo)), (latMin = Math.min(latMin, la)), (latMax = Math.max(latMax, la));
	const centre: Position = req.outlet ?? [(lonMin + lonMax) / 2, (latMin + latMax) / 2];
	if (!inside(centre)) throw new DelineationRefused('outside', `The outlet is outside the elevation model (${info.label} covers ${w}° to ${e}° E, ${s}° to ${n}° N).`);
	const probe = toPx(centre[0], centre[1], 2 ** z);
	const here = await dem.tile(z, Math.floor(probe[0]), Math.floor(probe[1]));
	if (!here) throw new DelineationRefused('no_data', 'The elevation model has no data at the outlet.');
	const size = here.size;
	const W = worldPx(z, size);
	const [gx, gy] = toPx(centre[0], centre[1], W);
	const cellAt = (lat: number) => (2 * Math.PI * EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180)) / W;
	const cellSizeM = cellAt(centre[1]);
	const radius = Math.max(1, Math.round(snapRadiusM / cellSizeM));
	// The boundary's reach from the centre, in cells: the first window must hold it.
	let reach = 0;
	for (const r of boundaryRings) {
		for (const [lo, la] of r) {
			const [px, py] = toPx(lo, la, W);
			reach = Math.max(reach, Math.abs(px - gx), Math.abs(py - gy));
		}
	}
	const need = 2 * (Math.ceil(reach) + MARGIN_CELLS);
	const first = windows.findIndex((c) => c >= need);
	if (first < 0) {
		throw new DelineationRefused('too_large', `The catchment boundary reaches beyond the ${Math.round((windows[windows.length - 1]! * cellSizeM) / 1000)} km the app delineates around its outlet, so it can’t be divided into units here. Draw or type the units instead.`);
	}
	for (let wi = first; wi < windows.length; wi++) {
		const nCells = windows[wi]!;
		const x0 = Math.floor(gx) - nCells / 2;
		const y0 = Math.floor(gy) - nCells / 2;
		const toGrid = ([lo, la]: Position): Pt => {
			const [px, py] = toPx(lo, la, W);
			return [px - x0, py - y0];
		};
		const toPos = ([x, y]: Pt): Position => toLonLat(x0 + x, y0 + y, W);
		const grid = await readWindow(dem, z, size, x0, y0, nCells);
		const noData = new Uint8Array(grid.z.length);
		for (let i = 0; i < noData.length; i++) if (Number.isNaN(grid.z[i]!)) noData[i] = 1;
		const edge = edgeMask(grid);
		fill(grid, edge);
		const dir = d8(grid, edge);
		const acc = accumulate(nCells, nCells, dir);
		const snapAt = (p: Position): number | null => {
			const [x, y] = toGrid(p);
			if (x < 0 || y < 0 || x >= nCells || y >= nCells) return null;
			return snap(nCells, nCells, acc, edge, Math.floor(x), Math.floor(y), radius);
		};
		const cellPos = (c: number): Position => {
			const cx = c % nCells;
			return toPos([cx + 0.5, (c - cx) / nCells + 0.5]);
		};
		const movedM = (p: Position, c: number) => {
			const [x, y] = toGrid(p);
			const cx = c % nCells;
			return Math.hypot(cx + 0.5 - x, (c - cx) / nCells + 0.5 - y) * cellSizeM;
		};
		// The outlet.
		let outlet: number;
		let outletSnap: number | null = null;
		if (req.outlet) {
			const c = snapAt(req.outlet);
			if (c === null) throw new DelineationRefused('no_data', 'The elevation model has no data around the outlet.');
			outlet = c;
			outletSnap = movedM(req.outlet, c);
		} else {
			outlet = mostDrained(rasterize(nCells, nCells, boundaryRings.map((r) => r.map(toGrid))), acc, edge);
			if (outlet < 0) throw new DelineationRefused('no_data', 'The elevation model has no data inside the boundary.');
		}
		const catchment = upstream(nCells, nCells, dir, outlet);
		const touch = touchesEdge(grid, edge, catchment, noData);
		if (touch.noData) throw new DelineationRefused('no_data', 'The catchment above the outlet runs past the edge of the elevation model’s data, so it can’t be divided whole.');
		if (touch.edge) {
			const next = windows[wi + 1];
			const elapsed = now() - started;
			if (next === undefined || elapsed * (1 + (next / nCells) ** 2) > budget) {
				throw new DelineationRefused(
					'too_large',
					`The catchment above the outlet reaches beyond the ${Math.round((nCells * cellSizeM) / 1000)} km the app delineates around it, so it can’t be divided into units here. Pick an outlet further upstream, or type the units in.`
				);
			}
			continue;
		}
		let catchmentCells = 0;
		for (let i = 0; i < catchment.length; i++) catchmentCells += catchment[i]!;
		if (catchmentCells < 9) throw new DelineationRefused('too_small', 'Almost nothing drains to the outlet: pick a gauge on the river itself.');
		// The units' cells: snapped points, a dam polygon's most-drained cell; dropped with a reason when they can't be units.
		const dropped: { id: string; reason: string }[] = [];
		const taken = new Map<number, string>([[outlet, '']]);
		const kept: { p: UnitPoint; cell: number; snapDistanceM: number | null }[] = [];
		for (const p of req.points) {
			let cell: number | null = null;
			let moved: number | null = null;
			if (p.geometry.type === 'Point') {
				cell = snapAt(p.geometry.coordinates);
				if (cell !== null) moved = movedM(p.geometry.coordinates, cell);
			} else {
				const rings = polygonRings(p.geometry);
				const c = rings.length ? mostDrained(rasterize(nCells, nCells, rings.map((r) => r.map(toGrid))), acc, edge) : -1;
				if (c >= 0) cell = c;
				else if (rings.length) {
					// Smaller than a cell: its first corner, snapped.
					cell = snapAt(rings[0]![0]!);
					if (cell !== null) moved = movedM(rings[0]![0]!, cell);
				}
			}
			if (cell === null || !catchment[cell]) {
				dropped.push({ id: p.id, reason: 'isn’t upstream of the outlet (it drains elsewhere, or is off the elevation model)' });
				continue;
			}
			const clash = taken.get(cell);
			if (clash !== undefined) {
				dropped.push({ id: p.id, reason: clash === '' ? 'snaps to the outlet itself' : 'snaps to the same place on the river as another point' });
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
			kept.map((k) => ({ cell: k.cell, owns: k.p.role !== 'user' }))
		);
		// Each owner's box, then its piece outlined inside the box only.
		const R = kept.length;
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
		const piece = (o: number): { geometry: Poly | null; areaM2: number } => {
			if (!count[o]) return { geometry: null, areaM2: 0 };
			const [bx0, by0, bx1, by1] = box[o]! as [number, number, number, number];
			const bw = bx1 - bx0 + 1;
			const bh = by1 - by0 + 1;
			const m = new Uint8Array(bw * bh);
			let cellArea = 0;
			for (let y = by0; y <= by1; y++) {
				const rowArea = cellAt(toPos([0, y + 0.5])[1]) ** 2;
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
			// A piece that can't be made a valid polygon keeps its area from the cells and offers no outline.
			return poly ?? { geometry: null, areaM2: cellArea };
		};
		const pieces = kept.map((_, i) => piece(i));
		const rest = piece(R);
		const { outer } = traceRings(nCells, nCells, catchment);
		const whole = piecePolygon(outer, [], toPos);
		if (!whole) throw new DelineationRefused('outline', 'The catchment’s outline could not be made into a valid polygon. Type the units in instead.');
		// Totals: each unit's piece plus everything that drains into it, summed down the tree.
		const total = pieces.map((p) => p.areaM2);
		const order = kept.map((_, i) => i);
		const depth = (i: number) => {
			let d = 0;
			for (let k = part.down[i]!; k >= 0; k = part.down[k]!) d++;
			return d;
		};
		order.sort((a, b) => depth(b) - depth(a));
		for (const i of order) {
			const d = part.down[i]!;
			if (d >= 0) total[d]! += total[i]!;
		}
		const cellM = Math.round(cellSizeM);
		return {
			outlet: { point: cellPos(outlet), snapDistanceM: outletSnap, foundIn: req.outlet ? 'snapped' : 'boundary' },
			catchment: whole,
			units: kept.map((k, i) => ({
				id: k.p.id,
				role: k.p.role,
				point: cellPos(k.cell),
				snapDistanceM: k.snapDistanceM,
				drainsInto: part.down[i]! < 0 ? null : kept[part.down[i]!]!.p.id,
				geometry: pieces[i]!.geometry,
				areaM2: pieces[i]!.areaM2,
				totalAreaM2: total[i]!
			})),
			dropped,
			rest,
			cellSizeM,
			zoom: z,
			windowCells: nCells,
			dataset: info,
			method:
				`D8 steepest descent on the DEM after Priority-Flood+ε depression filling (Barnes, Lehman & Mulla 2014), ${cellM} m cells (zoom ${z}), routed once for the whole catchment; ` +
				`the outlet and each point snapped to the most-accumulating cell within ${snapRadiusM} m (a dam polygon: its most-accumulating cell); ` +
				`each unit drains into the first unit its flow path meets, and owns the cells whose path meets it before any other unit; outlines traced on the cells’ edges with their holes, simplified (Douglas–Peucker, about ${cellM} m)`,
			methodVersion: START_METHOD_VERSION
		};
	}
	throw new DelineationRefused('too_large', 'The catchment above the outlet is too large to divide into units here.');
}
