// Trace a dam's outline from a click inside its water (issue #326 C2;
// docs/maps.md § Assisted drawing, § Water occurrence). Reads a square window
// of the water occurrence raster (JRC Global Surface Water's occurrence: the
// share of the valid observations 1984–2024 in which each ~30 m cell was
// water, 0–100 %) around the click, takes the cells at or above the chosen
// share that connect to the clicked one (4-neighbour flood fill), fills any
// islands, and outlines them as one polygon. A body of water that reaches the
// edge of the window grows it once; past that, or past the data's edge, the
// click is refused rather than answered with a cut-off outline.
//
// It only proposes: the outline is drawn on the map as a drawing the editor
// adjusts and saves (or drops). Nothing here writes anything.
//
// The raster is a PMTiles archive read with the delineation DEM's reader
// (dem.ts): Terrarium-encoded tiles whose "height" is the occurrence in
// percent (bin/tiles-dev.sh water writes it from the GSW download; the
// committed synthetic fixture is waterFixture.ts). A value outside 0–100 (a
// transparent pixel, GSW's 255 for no data) is no data.
import { checkGeometry, type Geometry, type Position } from '../geo/geojson.js';
import { boundsText, EARTH_RADIUS_M, readWindow, toLonLat, toPx, worldPx } from './delineate.js';
import { openDem, type Dem, type DemInfo } from './dem.js';
import { simplifyRing, traceOutline } from './outline.js';

/** Bump when the method changes what a click proposes; recorded on every traced feature. */
/** trace-dam-2 (issue #387): the snap radius measured from the exact click to each cell's centre, so a seed is never more than TRACE_SNAP_M away. */
export const TRACE_METHOD_VERSION = 'trace-dam-2';
/** The shares of observations (%) a cell must be water in to count, offered in the draw bar; 25 is the default. */
export const OCCURRENCE_CHOICES = [10, 25, 50, 75] as const;
export type MinOccurrence = (typeof OCCURRENCE_CHOICES)[number];
/** The deepest zoom read: GSW is 0.00025° (about 25–28 m over South Africa); zoom 12 is about 32 m a cell there. */
export const TRACE_ZOOM = 12;
/** The windows tried, in cells a side: about 8 km, then 16 km at zoom 12. A farm dam fits the first many times over. */
export const TRACE_WINDOWS = [256, 512] as const;
/** How far (m) a click just off the water is moved onto it. */
export const TRACE_SNAP_M = 60;
/** Fewest cells a traced outline may have (about 0.3 ha at zoom 12): less is noise, not a dam to trace. */
export const TRACE_MIN_CELLS = 3;

export type TraceRefusalCode = 'outside' | 'no_data' | 'no_water' | 'too_large' | 'too_small' | 'outline';

export class TraceRefused extends Error {
	constructor(
		readonly code: TraceRefusalCode,
		message: string
	) {
		super(message);
	}
}

export interface DamTrace {
	click: Position;
	/** The water cell the trace started from: the clicked one, or the nearest water within TRACE_SNAP_M. */
	seed: Position;
	snapDistanceM: number;
	geometry: Extract<Geometry, { type: 'Polygon' }>;
	/** Geodesic area of the outline (geo/area.ts). */
	areaM2: number;
	cells: number;
	cellSizeM: number;
	zoom: number;
	windowCells: number;
	minOccurrence: MinOccurrence;
	dataset: DemInfo;
	method: string;
	methodVersion: string;
}

/** Occurrence (%) of a cell, or NaN for no data. */
const occurrence = (v: number) => (Number.isFinite(v) && v >= 0 && v <= 100 ? v : Number.NaN);

/** The outline as a checked GeoJSON polygon, simplified as far as stays valid (half a cell, a quarter, then none). */
function outlinePolygon(ring: [number, number][], x0: number, y0: number, W: number): { geometry: Extract<Geometry, { type: 'Polygon' }>; areaM2: number } {
	for (const tol of [0.5, 0.25, 0]) {
		const simple = simplifyRing(ring, tol);
		// Traced clockwise on the map (y down): reversed for GeoJSON's counter-clockwise outer ring.
		const coords = simple.map(([x, y]) => toLonLat(x0 + x, y0 + y, W)).reverse();
		const checked = checkGeometry({ type: 'Polygon', coordinates: [coords] });
		if ('geometry' in checked && checked.geometry.type === 'Polygon' && checked.areaM2) return { geometry: checked.geometry, areaM2: checked.areaM2 };
	}
	throw new TraceRefused('outline', 'The water’s outline could not be made into a valid polygon. Draw the dam instead.');
}

/** Trace the water body around (lon, lat). Throws TraceRefused with a sentence for the user. */
export async function traceDam(water: Dem, click: Position, minOccurrence: MinOccurrence = 25): Promise<DamTrace> {
	const info = await water.info();
	const [lon, lat] = click;
	const [w, s, e, n] = info.bounds;
	if (lon < w || lon > e || lat < s || lat > n) {
		throw new TraceRefused('outside', `That point is outside the water occurrence data (${info.label} covers ${boundsText(info.bounds)}).`);
	}
	const z = Math.min(TRACE_ZOOM, info.maxZoom);
	const probe = toPx(lon, lat, 2 ** z);
	const here = await water.tile(z, Math.floor(probe[0]), Math.floor(probe[1]));
	if (!here) throw new TraceRefused('no_data', 'The water occurrence data has nothing at that point.');
	const size = here.size;
	const W = worldPx(z, size);
	const [gx, gy] = toPx(lon, lat, W);
	const cellSizeM = (2 * Math.PI * EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180)) / W;
	// In cells, measured from the exact click to each cell's centre (trace-dam-2, issue #387).
	const radius = TRACE_SNAP_M / cellSizeM;
	for (let wi = 0; wi < TRACE_WINDOWS.length; wi++) {
		const nc = TRACE_WINDOWS[wi]!;
		const x0 = Math.floor(gx) - nc / 2;
		const y0 = Math.floor(gy) - nc / 2;
		const grid = await readWindow(water, z, size, x0, y0, nc);
		const v = grid.z.map(occurrence);
		const cx = Math.floor(gx) - x0;
		const cy = Math.floor(gy) - y0;
		if (Number.isNaN(v[cy * nc + cx]!)) throw new TraceRefused('no_data', 'The water occurrence data has nothing at that point.');
		const wet = (i: number) => v[i]! >= minOccurrence;
		// The seed: the clicked cell, else the wet cell whose centre is nearest the exact click, within the snap radius.
		let seed = wet(cy * nc + cx) ? cy * nc + cx : -1;
		if (seed < 0) {
			const fx = gx - x0;
			const fy = gy - y0;
			const r = Math.ceil(radius);
			let best = Infinity;
			for (let y = cy - r; y <= cy + r; y++) {
				for (let x = cx - r; x <= cx + r; x++) {
					if (x < 0 || y < 0 || x >= nc || y >= nc || !wet(y * nc + x)) continue;
					const d = Math.hypot(x + 0.5 - fx, y + 0.5 - fy);
					if (d > radius || d >= best) continue;
					best = d;
					seed = y * nc + x;
				}
			}
		}
		if (seed < 0) {
			throw new TraceRefused(
				'no_water',
				`No water is mapped there (in at least ${minOccurrence} % of the observations). Click inside the dam’s water, or ask for a lower share; or draw the dam.`
			);
		}
		// Flood the wet cells connected to the seed (edge neighbours only, so two dams touching at a corner stay two).
		const mask = new Uint8Array(nc * nc);
		const stack = [seed];
		mask[seed] = 1;
		let cells = 0;
		let atEdge = false;
		let atNoData = false;
		while (stack.length) {
			const i = stack.pop()!;
			cells++;
			const x = i % nc;
			const y = (i - x) / nc;
			if (x === 0 || y === 0 || x === nc - 1 || y === nc - 1) atEdge = true;
			for (const [nx, ny] of [
				[x - 1, y],
				[x + 1, y],
				[x, y - 1],
				[x, y + 1]
			] as const) {
				if (nx < 0 || ny < 0 || nx >= nc || ny >= nc) continue;
				const j = ny * nc + nx;
				if (Number.isNaN(v[j]!)) atNoData = true;
				else if (!mask[j] && wet(j)) {
					mask[j] = 1;
					stack.push(j);
				}
			}
		}
		if (atNoData) {
			throw new TraceRefused('no_data', 'That water runs to the edge of the water occurrence data, so it can’t be traced whole. Draw the dam instead.');
		}
		if (atEdge) {
			if (wi < TRACE_WINDOWS.length - 1) continue;
			const km = Math.round((nc * cellSizeM) / 1000);
			throw new TraceRefused(
				'too_large',
				`That water reaches beyond the ${km} km the app traces around a click, so it isn’t a dam this can trace. Draw it, or ask for a higher share of observations.`
			);
		}
		if (cells < TRACE_MIN_CELLS) {
			throw new TraceRefused('too_small', 'The water there is only a cell or two: too small to trace reliably. Draw the dam instead.');
		}
		// Islands go in: an outline has no holes here (the draft edits one ring), and a dam's island is still its basin.
		const outside = new Uint8Array(nc * nc);
		const out: number[] = [];
		for (let i = 0; i < nc; i++) for (const j of [i, (nc - 1) * nc + i, i * nc, i * nc + nc - 1]) if (!mask[j] && !outside[j]) (outside[j] = 1), out.push(j);
		while (out.length) {
			const i = out.pop()!;
			const x = i % nc;
			const y = (i - x) / nc;
			for (const [nx, ny] of [
				[x - 1, y],
				[x + 1, y],
				[x, y - 1],
				[x, y + 1]
			] as const) {
				if (nx < 0 || ny < 0 || nx >= nc || ny >= nc) continue;
				const j = ny * nc + nx;
				if (!mask[j] && !outside[j]) {
					outside[j] = 1;
					out.push(j);
				}
			}
		}
		for (let i = 0; i < mask.length; i++) if (!mask[i] && !outside[i]) mask[i] = 1;
		const ring = traceOutline(nc, nc, mask);
		const { geometry, areaM2 } = outlinePolygon(ring, x0, y0, W);
		const sx = seed % nc;
		const sy = (seed - sx) / nc;
		const cellM = Math.round(cellSizeM);
		return {
			click,
			seed: toLonLat(x0 + sx + 0.5, y0 + sy + 0.5, W),
			snapDistanceM: Math.hypot(x0 + sx + 0.5 - gx, y0 + sy + 0.5 - gy) * cellSizeM,
			geometry,
			areaM2,
			cells,
			cellSizeM,
			zoom: z,
			windowCells: nc,
			minOccurrence,
			dataset: info,
			method:
				`cells mapped as water in at least ${minOccurrence} % of the observations, connected to the clicked cell (edge neighbours), islands filled; ` +
				`${cellM} m cells (zoom ${z}); outline traced on the cells’ edges and simplified (Douglas–Peucker, about ${Math.round(cellM / 2)} m)`,
			methodVersion: TRACE_METHOD_VERSION
		};
	}
	throw new TraceRefused('too_large', 'That water is too large to trace.');
}

let configured: { url: string; water: Dem } | null | undefined;

/** The water occurrence raster from WATER_URL (and WATER_LABEL), or null when tracing is off. */
export function configuredWater(env: NodeJS.ProcessEnv = process.env): Dem | null {
	const url = env.WATER_URL?.trim() ?? '';
	if (!url) return null;
	if (configured?.url !== url) configured = { url, water: openDem(url, env.WATER_LABEL) };
	return configured.water;
}
