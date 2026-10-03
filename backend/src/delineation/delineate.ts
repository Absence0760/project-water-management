// Delineate the catchment upstream of a clicked point (issue #326
// B-delineate; docs/design/delineation.md). Reads a square window of the DEM
// around the click at one zoom, fills its depressions, routes flow with D8,
// snaps the click to the most-accumulating cell nearby, collects the cells
// upstream of it and outlines them. When the catchment reaches the window's
// edge the window grows, up to a cap; past the cap (or the time budget) the
// request is refused rather than answered with a cut-off catchment.
//
// It only proposes: routes.ts stores the result as a proposal the editor
// accepts or rejects; nothing here writes anything.
import { checkGeometry, type Geometry, type Position } from '../geo/geojson.js';
import type { Dem, DemInfo } from './dem.js';
import { accumulate, d8, edgeMask, fill, touchesEdge, upstream, type Grid } from './flow.js';
import { JUNCTION_SIDE_M } from './reach.js';
import { JUNCTION_FLAG_M, JUNCTION_MATCH_M, junctionOutlets, type JunctionRiver } from './junction.js';
import { GUARD_RADIUS_M, LARGER_FACTOR, MATCH_RADIUS_M, MIN_ACCORDANCE, place, type Placement } from './place.js';
import { simplifyRing, traceOutline, type Pt } from './outline.js';

/** Bump when the method changes what a click proposes; recorded on every proposal. */
/**
 * delineate-2 (issue #374): the outlet matched to a nearby river reach's upstream area, and a much larger channel nearby refused unless kept;
 * delineate-3: at a confluence the river is asked for and its outlet put at the DEM's own junction; delineate-4 (issue #387): the snap radius
 * measured from the exact click to each cell's centre, so the snap distance never exceeds it (it counted whole cells from the clicked cell);
 * delineate-7 (issue #390, the hydrologist persona's findings 5 and 12): a click within JUNCTION_SIDE_M of a mapped junction kept on its
 * river's side of the DEM's junction without asking, and every junction placement on the river's own channel nearest the click, not at
 * the junction itself; one moved over JUNCTION_FLAG_M is flagged.
 */
export const METHOD_VERSION = 'delineate-7';
/** Web Mercator zoom the DEM is read at: 512 px tiles at zoom 11 are about 33 m a cell over South Africa, GLO-30's own resolution. */
export const TARGET_ZOOM = 11;
/** How far the click snaps to the channel (docs/design/delineation.md § Snapping). */
export const SNAP_RADIUS_M = 150;
/** The windows a request tries, in cells a side; the last is its cap (about 100 km at zoom 11). */
export const WINDOWS = [1024, 2048, 3072] as const;
/**
 * The windows the background worker tries (the `delineate` job, docs/design/delineation.md § Where it runs), from the one after
 * where the request stopped: the same code, up to about 200 km at zoom 11. 6 144 cells peaks near 1 GB, which the worker's
 * memory is sized for (infra/jobs.tf, at least 2 048 MB with delineation_dem on).
 */
export const JOB_WINDOWS = [...WINDOWS, 4096, 6144] as const;
/** Fewest cells a proposal may have: less is a click on a ridge or a slope, not a catchment. */
export const MIN_CELLS = 9;
/** Wall-clock budget for one delineation, under the API Lambda's 30 s timeout. */
export const TIME_BUDGET_MS = 20_000;
/** The worker's budget: well under its 300 s timeout, leaving the tick room for the job's writes and anything it ran first. */
export const JOB_TIME_BUDGET_MS = 150_000;

export const EARTH_RADIUS_M = 6378137;

export type RefusalCode = 'outside' | 'no_data' | 'too_large' | 'too_small' | 'outline' | 'larger_channel';

/** With `larger_channel`: the channel the point probably meant, to offer (place.ts). */
export interface LargerChannel {
	/** Its cell's centre. */
	at: Position;
	/** How far it is from the click (m). */
	distanceM: number;
	/** What drains through it inside the routed window (km²; a lower bound when its catchment runs past the window). */
	km2: number;
	/** What drains through the cell the point snapped to (km²). */
	pointKm2: number;
	/** A dam outline's: the channel its outline only clips, its own outflow placed instead (subcatchments.ts damOutflow). */
	outline?: boolean;
}

export class DelineationRefused extends Error {
	constructor(
		readonly code: RefusalCode,
		message: string,
		readonly larger?: LargerChannel,
		/** With `too_large`: the window (cells a side) it stopped at, so the worker can go on from the next (background.ts). */
		readonly windowCells?: number
	) {
		super(message);
	}
}

/** Which way `to` lies from `from`, in words (eight points). */
export function bearingWord(from: Position, to: Position): string {
	const dx = (to[0] - from[0]) * Math.cos((from[1] * Math.PI) / 180);
	const dy = to[1] - from[1];
	const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
	return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(deg / 45) % 8]!;
}

const km2Text = (v: number) => `${v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString('en-ZA')} km²`;

/**
 * The refusal for a point beside a much larger channel: the sentence and the channel to offer. `larger.km2` counts only what
 * drains through it inside the routed window, so it isn't an "about" (the hydrologist's review, finding 10: 619 km² was quoted
 * for the Orange, which carries 340 724). `context.open`: its catchment runs past the window (`windowKm` a side), so the figure
 * is a floor; `context.reach`: the mapped river reach near the point, quoted for its own area when it is at least the channel's.
 */
export function largerChannelRefusal(
	click: Position,
	larger: LargerChannel,
	what = 'your point',
	context: { open?: boolean; windowKm?: number; reach?: { name: string; km2: number } | null } = {}
): DelineationRefused {
	const drains = context.open
		? `at least ${km2Text(larger.km2)} drains through it inside the ${context.windowKm ?? '–'} km routed around ${what}, and more from beyond`
		: `${km2Text(larger.km2)} drains through it`;
	const reach = context.reach && context.reach.km2 >= larger.km2 ? ` (the mapped river here, ${context.reach.name}, drains ${km2Text(context.reach.km2)})` : '';
	return new DelineationRefused(
		'larger_channel',
		`A much larger channel runs ${Math.round(larger.distanceM)} m ${bearingWord(click, larger.at)} of ${what}: ${drains}${reach}, against ${km2Text(larger.pointKm2)} at ${what}. River lines on the map can sit a few hundred metres off the channel the elevation model sees. Use that channel, or keep ${what} if you meant the small one.`,
		larger
	);
}

/**
 * The `too_large` sentence (the hydrologist's review, finding 11). A mapped reach larger than the routed square (`km` a side) can't
 * fit in it wherever the outlet goes, so "pick an outlet further upstream" was wrong advice on a main stem (the Orange has none):
 * there the answer is Sub-catchments, one per click, whose pieces take the water from above as an inflow. `km` null: the area isn't
 * known here (the worker's request past its last window).
 */
export function tooLargeText(what: 'click' | 'outlet', km: number | null, reachKm2: number | null | undefined): string {
	const around = km === null ? 'the area the app delineates' : `the ${km} km the app delineates`;
	const pieces = 'Sub-catchments, one per click (click down the river; the water from above the top click enters as an inflow)';
	const mainStem = reachKm2 != null && km !== null && reachKm2 > km * km;
	if (what === 'outlet') {
		return mainStem
			? `The river at the outlet drains about ${km2Text(reachKm2)} (its mapped reach), more than fits in ${around} around it, so it can’t be divided into units here. Type the units in, or outline pieces of the river with ${pieces}.`
			: `The catchment above the outlet reaches beyond ${around} around it, so it can’t be divided into units here. Pick an outlet gauge further upstream, or type the units in.`;
	}
	return mainStem
		? `The river here drains about ${km2Text(reachKm2)} (its mapped reach), more than fits in ${around} around a click, so it can’t be proposed in one piece. Divide it with ${pieces}, or draw or import the boundary.`
		: `The catchment above that point reaches beyond ${around} around a click, so it can’t be proposed whole. Click further upstream for a smaller catchment, divide the river with ${pieces}, or draw or import the boundary.`;
}

export interface Delineation {
	click: Position;
	/** The snapped outlet: the centre of the most-accumulating cell within the snap radius. */
	outlet: Position;
	snapDistanceM: number;
	geometry: Extract<Geometry, { type: 'Polygon' }>;
	/** Geodesic area of the polygon (geo/area.ts). */
	areaM2: number;
	/** Cells upstream of the outlet, the outlet included, and their area (cells × cell area at the outlet's latitude). */
	cells: number;
	cellAreaM2: number;
	cellSizeM: number;
	zoom: number;
	windowCells: number;
	dataset: DemInfo;
	method: string;
	methodVersion: string;
	/**
	 * A river reach was within reach of the click but no channel near it matched its upstream area (place.ts):
	 * the result may be on another stream, or the reach's area is wrong. Shown with the proposal; not stored.
	 */
	unmatched?: { reach: string; reachKm2: number };
	/**
	 * Placed by a confluence's junction (junction.ts) more than JUNCTION_FLAG_M from the click: the DEM's rivers meet away from the
	 * mapped junction, so keeping the click on its river's side moved it that far. Shown with the proposal; not stored.
	 */
	farJunction?: { reach: string; movedM: number };
}

const deg = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(2)}° ${v < 0 ? neg : pos}`;
/** A dataset's bounds in words for a refusal: "20.39° E to 21.09° E, 33.72° S to 33.14° S" (not "-33.7243397° … N"). */
export const boundsText = ([w, s, e, n]: readonly [number, number, number, number]) => `${deg(w, 'E', 'W')} to ${deg(e, 'E', 'W')}, ${deg(s, 'N', 'S')} to ${deg(n, 'N', 'S')}`;

export const worldPx = (z: number, size: number) => 2 ** z * size;
export const toPx = (lon: number, lat: number, W: number): [number, number] => {
	const s = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
	return [((lon + 180) / 360) * W, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * W];
};
export const toLonLat = (x: number, y: number, W: number): Position => [
	Math.round(((x / W) * 360 - 180) * 1e7) / 1e7,
	Math.round(((Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / W))) * 180) / Math.PI) * 1e7) / 1e7
];

/** The DEM's elevations over [x0, x0+n) × [y0, y0+n) global pixels at zoom z (NaN where it has no tile). */
export async function readWindow(dem: Dem, z: number, size: number, x0: number, y0: number, n: number): Promise<Grid> {
	const grid: Grid = { nx: n, ny: n, z: new Float64Array(n * n).fill(Number.NaN) };
	const tiles = 2 ** z;
	const tx0 = Math.floor(x0 / size);
	const ty0 = Math.floor(y0 / size);
	const tx1 = Math.floor((x0 + n - 1) / size);
	const ty1 = Math.floor((y0 + n - 1) / size);
	const jobs: Promise<void>[] = [];
	for (let ty = ty0; ty <= ty1; ty++) {
		for (let tx = tx0; tx <= tx1; tx++) {
			if (ty < 0 || ty >= tiles) continue;
			const wx = ((tx % tiles) + tiles) % tiles;
			jobs.push(
				dem.tile(z, wx, ty).then((t) => {
					if (!t) return;
					if (t.size !== size) throw new Error(`a DEM tile of ${t.size} px among ${size} px tiles`);
					for (let py = 0; py < size; py++) {
						const gy = ty * size + py - y0;
						if (gy < 0 || gy >= n) continue;
						for (let px = 0; px < size; px++) {
							const gx = tx * size + px - x0;
							if (gx < 0 || gx >= n) continue;
							grid.z[gy * n + gx] = t.z[py * size + px]!;
						}
					}
				})
			);
		}
	}
	await Promise.all(jobs);
	return grid;
}

/** The outline as a checked GeoJSON polygon, simplified as far as stays valid (1 cell, then ½, then none). */
function outlinePolygon(ring: Pt[], x0: number, y0: number, W: number): { geometry: Extract<Geometry, { type: 'Polygon' }>; areaM2: number } {
	for (const tol of [1, 0.5, 0]) {
		const simple = simplifyRing(ring, tol);
		// Traced with the region on the left in y-down cells, which is clockwise on the map: reverse for GeoJSON's counter-clockwise outer ring (RFC 7946 § 3.1.6).
		const coords = simple.map(([x, y]) => toLonLat(x0 + x, y0 + y, W)).reverse();
		const checked = checkGeometry({ type: 'Polygon', coordinates: [coords] });
		if ('geometry' in checked && checked.geometry.type === 'Polygon' && checked.areaM2) return { geometry: checked.geometry, areaM2: checked.areaM2 };
	}
	throw new DelineationRefused('outline', 'The catchment’s outline could not be made into a valid polygon. Draw or import the boundary instead.');
}

/** Delineate the catchment upstream of (lon, lat). Throws DelineationRefused with a sentence for the user. */
export async function delineate(
	dem: Dem,
	click: Position,
	opts: {
		windows?: readonly number[];
		snapRadiusM?: number;
		budgetMs?: number;
		now?: () => number;
		/**
		 * The upstream area (km²) a river reach near the click gives: the outlet is then matched to it (place.ts), and `reach` names it in the
		 * method; `chosen`: the editor picked it at a confluence, so it is looked for over JUNCTION_MATCH_M rather than MATCH_RADIUS_M.
		 */
		expected?: { km2: number; reach: string; chosen?: boolean } | null;
		/** At a confluence: its rivers and the one picked; the outlet goes on the DEM's own junction (junction.ts), else by area. */
		junction?: { rivers: JunctionRiver[]; chosenKey: string } | null;
		/** Keep the point even beside a much larger channel (otherwise refused with `larger_channel`). */
		keepPoint?: boolean;
		/** Called before each window is read, with its place in `windows` (the worker reports it as the job's progress). */
		onWindow?: (index: number, of: number) => Promise<void> | void;
	} = {}
): Promise<Delineation> {
	const now = opts.now ?? (() => performance.now());
	const started = now();
	const budget = opts.budgetMs ?? TIME_BUDGET_MS;
	const windows = opts.windows ?? WINDOWS;
	const snapRadiusM = opts.snapRadiusM ?? SNAP_RADIUS_M;
	const info = await dem.info();
	const [lon, lat] = click;
	const [w, s, e, n] = info.bounds;
	if (lon < w || lon > e || lat < s || lat > n) {
		throw new DelineationRefused('outside', `That point is outside the elevation model (${info.label} covers ${boundsText(info.bounds)}).`);
	}
	const z = Math.min(TARGET_ZOOM, info.maxZoom);
	// The tile under the click gives the tile size, and says whether there is data there at all.
	const probe = toPx(lon, lat, 2 ** z);
	const here = await dem.tile(z, Math.floor(probe[0]), Math.floor(probe[1]));
	if (!here) throw new DelineationRefused('no_data', 'The elevation model has no data at that point.');
	const size = here.size;
	const W = worldPx(z, size);
	const [gx, gy] = toPx(lon, lat, W);
	const cellSizeM = (2 * Math.PI * EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180)) / W;
	for (let wi = 0; wi < windows.length; wi++) {
		const nCells = windows[wi]!;
		await opts.onWindow?.(wi, windows.length);
		const x0 = Math.floor(gx) - nCells / 2;
		const y0 = Math.floor(gy) - nCells / 2;
		const grid = await readWindow(dem, z, size, x0, y0, nCells);
		const noData = new Uint8Array(grid.z.length);
		for (let i = 0; i < noData.length; i++) if (Number.isNaN(grid.z[i]!)) noData[i] = 1;
		const edge = edgeMask(grid);
		fill(grid, edge);
		const dir = d8(grid, edge);
		const acc = accumulate(nCells, nCells, dir);
		const grid0 = { nx: nCells, ny: nCells, acc, edge, cellSizeM };
		const atJunction = opts.junction ? junctionOutlets({ ...grid0, dir }, gx - x0, gy - y0, opts.junction.rivers, snapRadiusM)?.get(opts.junction.chosenKey) : undefined;
		const placed: (Omit<Placement, 'how'> & { how: Placement['how'] | 'junction' }) | null =
			atJunction !== undefined
				? { cell: atJunction, how: 'junction', larger: null }
				: place(grid0, gx - x0, gy - y0, { snapRadiusM, expectedKm2: opts.expected?.km2, matchRadiusM: opts.expected?.chosen ? JUNCTION_MATCH_M : undefined });
		if (placed === null) throw new DelineationRefused('no_data', 'The elevation model has no data around that point.');
		if (placed.larger && !opts.keepPoint) {
			const lx = placed.larger.cell % nCells;
			const ly = (placed.larger.cell - lx) / nCells;
			const km2 = (cells: number) => (cells * cellSizeM * cellSizeM) / 1e6;
			// Whether the channel's catchment runs past this window: then its area here is only a floor.
			const open = touchesEdge(grid, edge, upstream(nCells, nCells, dir, placed.larger.cell), noData);
			throw largerChannelRefusal(
				click,
				{
					at: toLonLat(x0 + lx + 0.5, y0 + ly + 0.5, W),
					distanceM: placed.larger.distanceM,
					km2: km2(acc[placed.larger.cell]!),
					pointKm2: km2(acc[placed.cell]!)
				},
				undefined,
				{ open: open.edge || open.noData, windowKm: Math.round((nCells * cellSizeM) / 1000), reach: opts.expected ? { name: opts.expected.reach, km2: opts.expected.km2 } : null }
			);
		}
		const outlet = placed.cell;
		const mask = upstream(nCells, nCells, dir, outlet);
		const touch = touchesEdge(grid, edge, mask, noData);
		if (touch.noData) {
			throw new DelineationRefused('no_data', 'The catchment above that point runs past the edge of the elevation model’s data, so it can’t be delineated whole.');
		}
		if (touch.edge) {
			const last = wi === windows.length - 1;
			const elapsed = now() - started;
			// The next window costs about (its cells / these cells) times this one; stop before it would break the budget.
			const next = windows[wi + 1];
			if (last || (next !== undefined && elapsed * (1 + (next / nCells) ** 2) > budget)) {
				const km = Math.round((nCells * cellSizeM) / 1000);
				throw new DelineationRefused('too_large', tooLargeText('click', km, opts.expected?.km2), undefined, nCells);
			}
			continue;
		}
		let cells = 0;
		for (let i = 0; i < mask.length; i++) cells += mask[i]!;
		if (cells < MIN_CELLS) {
			throw new DelineationRefused('too_small', 'Almost nothing drains to that point: click on the river or stream itself, at the outlet or the dam wall.');
		}
		const ring = traceOutline(nCells, nCells, mask);
		const { geometry, areaM2 } = outlinePolygon(ring, x0, y0, W);
		const ox = outlet % nCells;
		const oy = (outlet - ox) / nCells;
		const outletPos = toLonLat(x0 + ox + 0.5, y0 + oy + 0.5, W);
		const snapDistanceM = Math.hypot(x0 + ox + 0.5 - gx, y0 + oy + 0.5 - gy) * cellSizeM;
		const cellM = Math.round(cellSizeM);
		return {
			...(opts.expected && placed.how === 'snapped' ? { unmatched: { reach: opts.expected.reach, reachKm2: opts.expected.km2 } } : {}),
			...(opts.expected && placed.how === 'junction' && snapDistanceM > JUNCTION_FLAG_M ? { farJunction: { reach: opts.expected.reach, movedM: snapDistanceM } } : {}),
			click,
			outlet: outletPos,
			snapDistanceM,
			geometry,
			areaM2,
			cells,
			cellAreaM2: cellSizeM * cellSizeM,
			cellSizeM,
			zoom: z,
			windowCells: nCells,
			dataset: info,
			method:
				`D8 steepest descent on the DEM after Priority-Flood+ε depression filling (Barnes, Lehman & Mulla 2014), ${cellM} m cells (zoom ${z}); ` +
				(placed.how === 'junction'
					? `outlet placed on the channel of ${opts.expected!.reach} nearest the point, on its side of the DEM's own junction (the tributary's channel matched by its area and followed downhill to where the main river joins it), ${opts.expected!.chosen ? 'the river picked at a confluence' : `the nearest river reach, within ${JUNCTION_SIDE_M} m of a mapped junction`}; `
					: placed.how === 'matched'
					? `outlet placed on the cell within ${opts.expected?.chosen ? JUNCTION_MATCH_M : MATCH_RADIUS_M} m whose upstream area best matches ${opts.expected!.reach} (${Math.round(opts.expected!.km2)} km²; Lehner 2012: area accordance at least ${MIN_ACCORDANCE} %, ranked by area and distance); `
					: `outlet snapped to the most-accumulating cell within ${snapRadiusM} m (a channel with ${LARGER_FACTOR}× its upstream cells within ${GUARD_RADIUS_M} m is offered instead, unless the point is kept); `) +
				`outline traced on the cells’ edges and simplified (Douglas–Peucker, about ${cellM} m)`,
			methodVersion: METHOD_VERSION
		};
	}
	// Unreachable: the last window either returns or throws.
	throw new DelineationRefused('too_large', 'The catchment above that point is too large to delineate.');
}
