// One date's views of a dam joined into one row (pass.ts readDate; the
// followup "a dam across a 1° tile edge never gets a clear radar view").
//
// A scene sees only the part of a dam on its own tile or footprint: a dam
// across a Sentinel-1 1° tile edge is half on each tile, so neither tile's
// view is ever more than about half observed, and keeping the better of the
// two left the dam under the 90 % a view needs to count as clear. The same
// holds for a dam across an MGRS tile edge (Sentinel-2) or a Landsat
// footprint's edge (WOfS), more rarely, as those overlap their neighbours.
//
// So the views of one date on one LATTICE (sum.ts viewPixels: the same CRS
// and pixel size, origins whole pixels apart, so a pixel is the same ground
// in both) are joined pixel by pixel:
//
//   base   the better view (`better`: most seen clearly, then most covered,
//          then the lower item id), every pixel it has data for as it saw it
//   fill   each pixel the base has NO data for (off its tile or footprint)
//          from the next-best view that has, in `better`'s order
//
// A pixel the base saw, clearly or under cloud, is never replaced: two looks
// at one pixel (Sentinel-1's ascending and descending passes, overlapping
// tiles) are not mixed, only gaps off the base's scene are filled. The row
// keeps the base's item id as its upstream key; the scenes that filled it
// are its `fills`, kept in the file's upstream list (pass.ts).
//
// Views from two UTM zones (a dam across a zone line, as 24° E between
// zones 34 and 35: Landsat scenes are gridded in their own path's zone,
// MGRS tiles in theirs) are on different lattices, and are joined the same
// way, with each of the base's gap pixels looked up on the other view by
// NEAREST NEIGHBOUR: the base pixel's centre is taken to the ground
// (utm.ts fromUtm, in the base's zone) and into the other zone (toUtm), and
// the other view's class there is the class of its pixel that point falls
// in. The class is categorical (wet, dry, not clear, off the scene), so it
// is copied, never averaged: bilinear or majority resampling would invent
// mixes ("half wet") no scene saw or move the view's cloud and footprint
// edges. Where that pixel is outside the other view's own outline mask (the
// two grids cut the outline's edge differently, so a base pixel at the
// edge can fall in one the other mask left out), the nearest of the other
// view's outline pixels within one pixel of the point stands in; past that,
// the gap stays unseen. So the join loses at most an edge pixel here and
// there, and its counts stay in the BASE's pixels, at the base's ground area
// (mask.ts: grid area ÷ k² at the base's zone), whatever the other grid's
// pixel size or scale factor. Pixels of the base's own lattice are taken
// first (exact), then the other zones' (resampled), each in `better`'s order.
//
// Only UTM views are joined across lattices. Every view of one call is one
// source's (pass.ts readDate runs per source): WOfS and Sentinel-2 are UTM,
// Sentinel-1's s1_rtc tiles are all EPSG:4326 at one pixel size, so one
// lattice, and a geographic view never meets a UTM one here. A view on any
// other lattice, or without pixels, can't be joined: the better one is kept.
import { isUtmEpsg } from '../../../raster/cog.js';
import { fromUtm, toUtm } from '../../../raster/utm.js';
import type { SceneItem } from './stac.js';
import { observation, PX_COVERED, PX_DRY, PX_OFF, PX_WET, type ViewPixels } from './sum.js';

/** One scene's view of a dam, or null when it didn't see it (sum.ts observation). */
export interface SceneView<S extends SceneItem> {
	scene: S;
	etag?: string;
	wetAreaM2: number;
	pctObserved: number;
	clearPx: number;
	coveredPx: number;
	/** The view's pixels and classes on its lattice, for joining (absent: it can't be joined). */
	pixels?: ViewPixels;
	/** The other scenes of the date whose pixels filled this view's gaps (mergeViews). */
	fills?: { scene: S; etag?: string }[];
}

/** The better of two views of one date: most seen clearly, then most covered, then the lower item id. */
export function better<S extends SceneItem>(a: SceneView<S>, b: SceneView<S>): SceneView<S> {
	if (a.clearPx !== b.clearPx) return a.clearPx > b.clearPx ? a : b;
	if (a.coveredPx !== b.coveredPx) return a.coveredPx > b.coveredPx ? a : b;
	return a.scene.itemId <= b.scene.itemId ? a : b;
}

/** The other view's class at each of the base's lattice pixels (see the header). */
type Lookup = (col: number, row: number) => number;

/** `q`'s class at pixel (col, row) of its own lattice: off outside its window. */
const at = (q: ViewPixels, col: number, row: number) => {
	const c = col - q.col0;
	const r = row - q.row0;
	return c < 0 || r < 0 || c >= q.width || r >= q.height ? PX_OFF : q.classes[r * q.width + c]!;
};

const inMask = (q: ViewPixels, col: number, row: number) => {
	const c = col - q.col0;
	const r = row - q.row0;
	return c >= 0 && r >= 0 && c < q.width && r < q.height && q.mask[r * q.width + c] === 1;
};

/** Reads `q` at `p`'s lattice pixels: directly on one lattice, by nearest neighbour across UTM zones (the header). */
export function lookupOn(p: ViewPixels, q: ViewPixels): Lookup {
	if (q.lattice === p.lattice) return (col, row) => at(q, col, row);
	const a = p.grid;
	const b = q.grid;
	return (col, row) => {
		const g = fromUtm((col + a.fracX + 0.5) * a.pixelSizeX, -(row + a.fracY + 0.5) * a.pixelSizeY, a.epsg);
		const o = toUtm(g.lon, g.lat, b.epsg);
		// The point in q's lattice, in pixels from the lattice's corner; the pixel it falls in is the nearest one.
		const u = o.x / b.pixelSizeX - b.fracX;
		const v = -o.y / b.pixelSizeY - b.fracY;
		const qc = Math.floor(u);
		const qr = Math.floor(v);
		if (inMask(q, qc, qr)) return at(q, qc, qr);
		// Off q's outline mask: its nearest outline pixel within one pixel of the point, if any.
		let best = 1;
		let cls = PX_OFF;
		for (let dr = -1; dr <= 1; dr++) {
			for (let dc = -1; dc <= 1; dc++) {
				if (!inMask(q, qc + dc, qr + dr)) continue;
				const d = Math.hypot(qc + dc + 0.5 - u, qr + dr + 0.5 - v);
				if (d <= best) {
					best = d;
					cls = at(q, qc + dc, qr + dr);
				}
			}
		}
		return cls;
	};
}

/** Whether two views' pixels can be joined: one lattice, or two UTM grids (see the header). */
const joinable = (p: ViewPixels, q: ViewPixels) => p.lattice === q.lattice || (isUtmEpsg(p.grid.epsg) && isUtmEpsg(q.grid.epsg));

/** `base` with its gaps filled from `others` (best first, its own lattice's before the rest); base itself when none filled a pixel. */
function fill<S extends SceneItem>(base: SceneView<S>, others: SceneView<S>[]): SceneView<S> {
	const p = base.pixels!;
	const ordered = [...others.filter((o) => o.pixels!.lattice === p.lattice), ...others.filter((o) => o.pixels!.lattice !== p.lattice)];
	const lookups = ordered.map((o) => lookupOn(p, o.pixels!));
	const classes = p.classes.slice();
	const fills = new Set<SceneView<S>>();
	for (let r = 0; r < p.height; r++) {
		for (let c = 0; c < p.width; c++) {
			const i = r * p.width + c;
			if (!p.mask[i] || classes[i] !== PX_OFF) continue;
			for (let k = 0; k < ordered.length; k++) {
				const v = lookups[k]!(p.col0 + c, p.row0 + r);
				if (v === PX_OFF) continue;
				classes[i] = v;
				fills.add(ordered[k]!);
				break;
			}
		}
	}
	if (fills.size === 0) return base;
	let inside = 0;
	let covered = 0;
	let clear = 0;
	let wet = 0;
	for (let i = 0; i < classes.length; i++) {
		if (!p.mask[i]) continue;
		inside++;
		const v = classes[i]!;
		if (v >= PX_COVERED) covered++;
		if (v === PX_DRY || v === PX_WET) clear++;
		if (v === PX_WET) wet++;
	}
	const o = observation({ inside, covered, clear, wet }, p.pixelAreaM2)!;
	return {
		...base,
		...o,
		pixels: { ...p, classes },
		// In the order they were tried: the base's lattice first, then by `better`.
		fills: ordered.filter((f) => fills.has(f)).map((f) => ({ scene: f.scene, ...(f.etag ? { etag: f.etag } : {}) }))
	};
}

/** One date's views of a dam as one view (see the header), or null with none. */
export function mergeViews<S extends SceneItem>(views: SceneView<S>[]): SceneView<S> | null {
	const ordered = [...views].sort((a, b) => (better(a, b) === a ? -1 : 1));
	// Views that can be joined, as groups: the best of each is its base, every other one of the group fills it.
	const groups: SceneView<S>[][] = [];
	const loose: SceneView<S>[] = [];
	for (const v of ordered) {
		if (!v.pixels) {
			loose.push(v);
			continue;
		}
		const g = groups.find(([base]) => joinable(base!.pixels!, v.pixels!));
		if (g) g.push(v);
		else groups.push([v]);
	}
	let best: SceneView<S> | null = null;
	for (const v of [...groups.map(([base, ...others]) => fill(base!, others)), ...loose]) best = best ? better(best, v) : v;
	return best;
}
