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
// Views on different lattices (two UTM zones, or a view without pixels)
// can't be joined: the better one is kept, as before.
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

/** `base` with its gaps filled from `others` (best first), all on base's lattice; base itself when none filled a pixel. */
function fill<S extends SceneItem>(base: SceneView<S>, others: SceneView<S>[]): SceneView<S> {
	const p = base.pixels!;
	const classes = p.classes.slice();
	const fills = new Set<SceneView<S>>();
	for (let r = 0; r < p.height; r++) {
		for (let c = 0; c < p.width; c++) {
			const at = r * p.width + c;
			if (!p.mask[at] || classes[at] !== PX_OFF) continue;
			for (const o of others) {
				const q = o.pixels!;
				const oc = p.col0 + c - q.col0;
				const or = p.row0 + r - q.row0;
				if (oc < 0 || or < 0 || oc >= q.width || or >= q.height) continue;
				const v = q.classes[or * q.width + oc]!;
				if (v === PX_OFF) continue;
				classes[at] = v;
				fills.add(o);
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
		fills: [...fills].map((f) => ({ scene: f.scene, ...(f.etag ? { etag: f.etag } : {}) }))
	};
}

/** One date's views of a dam as one view (see the header), or null with none. */
export function mergeViews<S extends SceneItem>(views: SceneView<S>[]): SceneView<S> | null {
	const ordered = [...views].sort((a, b) => (better(a, b) === a ? -1 : 1));
	const byLattice = new Map<string, SceneView<S>[]>();
	const loose: SceneView<S>[] = [];
	for (const v of ordered) {
		if (!v.pixels) loose.push(v);
		else byLattice.set(v.pixels.lattice, [...(byLattice.get(v.pixels.lattice) ?? []), v]);
	}
	let best: SceneView<S> | null = null;
	for (const v of [...[...byLattice.values()].map(([base, ...others]) => fill(base!, others)), ...loose]) best = best ? better(best, v) : v;
	return best;
}
