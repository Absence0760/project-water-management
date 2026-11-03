// Where a click on the map goes on the DEM's channel network (issue #472,
// docs/design/delineation.md § Method, step 6). The outlet is a point on a terrain
// channel: a cell the DEM's own routing drains `minKm2` or more through, the
// red lines the Map draws at the zoom the editor clicked at (channels.ts; the
// frontend's channelMinKm2AtZoom: 1 km² below zoom 13, down to
// CHANNEL_FLOOR_KM2 from zoom 15). The click goes on the nearest such cell
// within the snap radius, and nowhere else; with none within it the click is
// refused, so an outlet never sits on a slope or in a gully the Map didn't
// draw. Without a `minKm2` (Enter coordinates, Start and Divide, an older
// client) it is ON_CHANNEL_KM2.
//
// Mapped rivers (HydroRIVERS, the basemap's waterways) never move it. Issue
// #374 had matched the click to the nearby HydroRIVERS reach's upstream area,
// up to a kilometre away, and asked which river at a mapped confluence; but
// the DEM's rivers often run somewhere else than the mapped lines, so the
// outlet went where the mapped river said rather than where the editor
// clicked on the DEM's (issue #472). The editor picks the channel; the app
// only puts the click on it.
//
// One check stays, from the DEM alone: when the channel the click goes on
// has a channel LARGER_FACTOR times its area within GUARD_RADIUS_M, that
// channel is named to offer ("Use that channel"), never moved to by itself:
// a gauge or a dam placed from its coordinates (Start, Divide) on a hillside
// stream beside the river it measures says so, and the editor decides.

/**
 * The smallest channel the Map's tiles carry (km²), and so the least a request may ask a click to go on (channels.ts re-exports
 * it as the tiles' floor; defined here, the module with no imports, so the two can't drift or meet in an import cycle). Below
 * about 0.25 km² an outline is a few hundred cells, and on flat ground the DEM draws spurious parallel channels.
 */
export const CHANNEL_FLOOR_KM2 = 0.1;
/** The least upstream area (km²) of a channel cell when the request names none: the red lines the Map draws below zoom 13. */
export const ON_CHANNEL_KM2 = 1;
/** The least a request may ask for (km²): the tiles' floor. */
export const MIN_ON_CHANNEL_KM2 = CHANNEL_FLOOR_KM2;

/** A request's `minKm2` held to [MIN_ON_CHANNEL_KM2, ON_CHANNEL_KM2]; absent (or not a finite number), ON_CHANNEL_KM2. Pure. */
export function clampMinKm2(v: number | null | undefined): number {
	if (v === null || v === undefined || !Number.isFinite(v)) return ON_CHANNEL_KM2;
	return Math.min(ON_CHANNEL_KM2, Math.max(MIN_ON_CHANNEL_KM2, v));
}
/** How far the larger-channel guard looks (m). */
export const GUARD_RADIUS_M = 1000;
/** How many times the placed cell's upstream cells a channel needs to be "much larger". */
export const LARGER_FACTOR = 100;

export interface Placement {
	/** The terrain-channel cell nearest the click. */
	cell: number;
	/** From the exact click to the cell's centre (m). */
	distanceM: number;
	/** A much larger channel to offer instead (its cell nearest the click and its distance): one with LARGER_FACTOR × the placed cell's cells within GUARD_RADIUS_M. */
	larger: { cell: number; distanceM: number } | null;
}

export interface PlaceGrid {
	nx: number;
	ny: number;
	acc: Int32Array;
	edge: Uint8Array;
	/** One cell's side (m), for areas and distances. */
	cellSizeM: number;
}

/**
 * Put the click at (cx, cy) (fractional cells) on the nearest terrain-channel cell (`minKm2` or more draining through it, default
 * ON_CHANNEL_KM2, held to clampMinKm2's range) within `snapRadiusM`, measured from the exact click to each cell's centre (the larger
 * area wins a tie); null when no channel cell is within it. Pure.
 */
export function place(g: PlaceGrid, cx: number, cy: number, opts: { snapRadiusM: number; minKm2?: number }): Placement | null {
	const { nx, ny, acc, edge, cellSizeM } = g;
	const minCells = (clampMinKm2(opts.minKm2) * 1e6) / (cellSizeM * cellSizeM);
	const disc = (m: number, visit: (i: number, d: number) => void) => {
		const r = Math.ceil(m / cellSizeM);
		const ix = Math.floor(cx);
		const iy = Math.floor(cy);
		for (let y = iy - r; y <= iy + r; y++) {
			if (y < 0 || y >= ny) continue;
			for (let x = ix - r; x <= ix + r; x++) {
				if (x < 0 || x >= nx) continue;
				const i = y * nx + x;
				if (edge[i]) continue;
				const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) * cellSizeM;
				if (d <= m) visit(i, d);
			}
		}
	};
	let cell = -1;
	let cellD = Infinity;
	disc(opts.snapRadiusM, (i, d) => {
		if (acc[i]! < minCells) return;
		if (d < cellD || (d === cellD && acc[i]! > acc[cell]!)) (cell = i), (cellD = d);
	});
	if (cell < 0) return null;
	// The guard: the biggest channel within reach; if it has LARGER_FACTOR times the placed cell's cells, offer its nearest cell (at
	// least half the biggest's cells, so on that channel), not its most-drained one, which lies downstream at the disc's edge.
	let max = 0;
	disc(GUARD_RADIUS_M, (i) => {
		if (acc[i]! > max) max = acc[i]!;
	});
	if (max < LARGER_FACTOR * acc[cell]!) return { cell, distanceM: cellD, larger: null };
	let near = -1;
	let nearD = Infinity;
	disc(GUARD_RADIUS_M, (i, d) => {
		if (acc[i]! >= Math.max(LARGER_FACTOR * acc[cell]!, max / 2) && d < nearD) (near = i), (nearD = d);
	});
	return { cell, distanceM: cellD, larger: { cell: near, distanceM: nearD } };
}
