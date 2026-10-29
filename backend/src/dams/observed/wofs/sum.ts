// A dam's wet area on one WOfS scene, summed inside our own outline (issue
// #604 R5-C; docs/architecture.md § Dam observations → WOfS). Which pixels
// are inside the outline, and each one's ground area, is raster/mask.ts;
// this file is what WOfS's samples mean.
//
// WOfS's value per pixel (DE Africa's WOfS feature layer, a bit field):
// exactly 128 is clear water, exactly 0 clear dry, anything else (cloud,
// cloud shadow, terrain shadow, saturation, no data at 1, …, or water seen
// with any of those flags) isn't a clear observation. A pixel inside the
// outline but off the scene isn't one either. So:
//
//   wet_area_m2   = wet pixels × the pixel's ground area
//   pct_observed  = clear pixels ÷ pixels inside × 100
//
// The pixel's ground area is its grid area (30 m × 30 m) ÷ k² (mask.ts). An
// outline no pixel centre falls inside (smaller than a pixel, or a sliver
// between centres) has no pixels: summing it gives null and the pass writes
// no row for it, rather than a 0 % observed row that says nothing. The same
// for a scene whose search box touched the dam but whose footprint didn't
// (every inside pixel no-data, WOfS bit 0): it didn't see the dam. A scene
// that saw it under cloud did, and gives a 0 % observed row.
import type { CogAccept, PixelWindow } from '../../../raster/cog.js';
import type { MaskGrid, OutlineMask } from '../../../raster/mask.js';

/** What a WOfS scene is (raster/cog.ts's header): one uint8 band of flags on a UTM grid, no scale or offset. */
export const WOFS_ACCEPT: CogAccept = { sampleTypes: ['uint8'], crs: ['utm'] };

/** WOfS: exactly this is a clear wet pixel. */
export const WOFS_WET = 128;
/** WOfS: exactly this is a clear dry pixel. */
export const WOFS_DRY = 0;

export interface Tally {
	inside: number;
	/** Inside pixels the scene has data for (WOfS bit 0, "no data", clear): cloud counts, off the scene's footprint doesn't. */
	covered: number;
	clear: number;
	wet: number;
}

/** WOfS bit 0: the scene has no data for the pixel (outside its footprint). */
export const WOFS_NO_DATA_BIT = 1;

/**
 * What one scene made of each of the outline's pixels, for joining the views of one date from neighbouring tiles
 * (merge.ts): row-major over the OutlineMask's window, 0 for a pixel the scene has no data for (or outside the outline).
 */
export const PX_OFF = 0;
/** On the scene, but not a clear view (cloud, shadow, layover, …). */
export const PX_COVERED = 1;
export const PX_DRY = 2;
export const PX_WET = 3;

/** A new per-pixel class array for `m` (all PX_OFF), for a tally to fill. */
export const pixelClasses = (m: Pick<OutlineMask, 'width' | 'height'>) => new Uint8Array(m.width * m.height);

/** Counts the mask's pixels in `samples` (the scene's samples over `win`, from readWindow); pixels off the scene are not clear. `classes` (pixelClasses) gets each pixel's class. */
export function tally(m: OutlineMask, win: PixelWindow | null, samples: ArrayLike<number> | null, classes?: Uint8Array): Tally {
	let covered = 0;
	let clear = 0;
	let wet = 0;
	if (win && samples) {
		const w = win.col1 - win.col0 + 1;
		for (let r = win.row0; r <= win.row1; r++) {
			const mr = r - m.row0;
			for (let c = win.col0; c <= win.col1; c++) {
				const at = mr * m.width + (c - m.col0);
				if (!m.mask[at]) continue;
				const v = samples[(r - win.row0) * w + (c - win.col0)]!;
				if (!(v & WOFS_NO_DATA_BIT)) {
					covered++;
					if (classes) classes[at] = PX_COVERED;
				}
				if (v === WOFS_WET) {
					wet++;
					clear++;
					if (classes) classes[at] = PX_WET;
				} else if (v === WOFS_DRY) {
					clear++;
					if (classes) classes[at] = PX_DRY;
				}
			}
		}
	}
	return { inside: m.inside, covered, clear, wet };
}

/**
 * One scene's observation of a dam, or null when there is nothing to say: no
 * pixel centre inside the outline, or none of them on the scene's footprint
 * (its search box touched the dam, its data didn't). A scene that covered
 * the dam under cloud is an observation: 0 % observed.
 */
export function observation(t: Tally, pixelAreaM2: number): { wetAreaM2: number; pctObserved: number; clearPx: number; coveredPx: number } | null {
	if (t.inside === 0 || t.covered === 0) return null;
	return {
		wetAreaM2: Math.round(t.wet * pixelAreaM2 * 100) / 100,
		pctObserved: Math.round((t.clear / t.inside) * 100 * 1000) / 1000,
		clearPx: t.clear,
		coveredPx: t.covered
	};
}

/**
 * One scene's pixels of a dam, placed on its grid's lattice (merge.ts): two scenes on grids of the same CRS and pixel
 * size whose origins differ by whole pixels (neighbouring 1° Sentinel-1 tiles, MGRS tiles of one UTM zone, Landsat
 * rows of one path) share a lattice, and a pixel's (col, row) on it is the same in both.
 */
export interface ViewPixels {
	/** The lattice: CRS, pixel size, and the origin's offset within a pixel. */
	lattice: string;
	/** The OutlineMask's window, in the lattice's columns and rows. */
	col0: number;
	row0: number;
	width: number;
	height: number;
	/** The OutlineMask's own `mask` (1 inside) and the scene's class of each pixel (PX_*). */
	mask: Uint8Array;
	classes: Uint8Array;
	pixelAreaM2: number;
}

/** A grid origin's whole pixels and the fraction left over, to 1/1000 of a pixel. */
function onLattice(origin: number, size: number): { whole: number; frac: number } {
	const q = origin / size;
	const whole = Math.round(q);
	// + 0 turns −0 into 0, so the two spellings of a whole-pixel origin are one lattice.
	return { whole, frac: Math.round((q - whole) * 1000) / 1000 + 0 };
}

/** The pixels of `m` (made on `grid`) with their classes, placed on the grid's lattice. */
export function viewPixels(grid: MaskGrid, m: OutlineMask, classes: Uint8Array): ViewPixels {
	const x = onLattice(grid.originX, grid.pixelSizeX);
	// Rows run south: the lattice row is −originY / size plus the scene's row.
	const y = onLattice(-grid.originY, grid.pixelSizeY);
	return {
		lattice: `${grid.epsg}/${grid.pixelSizeX}/${grid.pixelSizeY}/${x.frac}/${y.frac}`,
		col0: x.whole + m.col0,
		row0: y.whole + m.row0,
		width: m.width,
		height: m.height,
		mask: m.mask,
		classes,
		pixelAreaM2: m.pixelAreaM2
	};
}
