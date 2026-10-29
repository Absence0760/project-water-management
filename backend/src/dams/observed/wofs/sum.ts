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
import type { OutlineMask } from '../../../raster/mask.js';

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

/** Counts the mask's pixels in `samples` (the scene's samples over `win`, from readWindow); pixels off the scene are not clear. */
export function tally(m: OutlineMask, win: PixelWindow | null, samples: ArrayLike<number> | null): Tally {
	let covered = 0;
	let clear = 0;
	let wet = 0;
	if (win && samples) {
		const w = win.col1 - win.col0 + 1;
		for (let r = win.row0; r <= win.row1; r++) {
			const mr = r - m.row0;
			for (let c = win.col0; c <= win.col1; c++) {
				if (!m.mask[mr * m.width + (c - m.col0)]) continue;
				const v = samples[(r - win.row0) * w + (c - win.col0)]!;
				if (!(v & WOFS_NO_DATA_BIT)) covered++;
				if (v === WOFS_WET) {
					wet++;
					clear++;
				} else if (v === WOFS_DRY) {
					clear++;
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
