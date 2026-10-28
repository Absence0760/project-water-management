// A dam's wet area on one WOfS scene, summed inside our own outline (issue
// #604 R5-C; docs/architecture.md § Dam observations → WOfS).
//
// A pixel counts for the dam when its CENTRE falls inside the outline: the
// outline (a GeoJSON Polygon or MultiPolygon in lon/lat, as map_feature
// keeps it) is projected vertex by vertex into the scene's UTM grid
// (utm.ts), its edges taken as straight there (a dam's edges are tens of
// metres; the curvature is far below a pixel), and each pixel row's centre
// line is crossed with every edge. Within one polygon the crossings pair up
// even-odd, so a hole (an island) is out; the polygons of a MultiPolygon are
// unioned, so a pixel two of them both cover counts once.
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
// The pixel's ground area is its grid area (30 m × 30 m) ÷ k², k the UTM
// scale factor at the outline's first vertex: the grid stretches ground by
// k (0.9996 on the zone's meridian, ~1.0010 at its edge), so without it a dam
// near a zone edge would read 0.2 % large. An outline no pixel centre falls
// inside (smaller than a pixel, or a sliver between centres) has no pixels:
// summing it gives null and the pass writes no row for it, rather than a
// 0 % observed row that says nothing. The same for a scene whose search box
// touched the dam but whose footprint didn't (every inside pixel no-data,
// WOfS bit 0): it didn't see the dam. A scene that saw it under cloud did,
// and gives a 0 % observed row.
import { FeedFormatError } from '../../../feeds/errors.js';
import { WINDOW_MAX_PIXELS, type CogInfo, type PixelWindow } from './cog.js';
import { toUtm } from './utm.js';

/** GeoJSON Polygon / MultiPolygon, lon/lat (the handover's WantedOutline.geometry). */
export type OutlineGeometry = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] };

/** WOfS: exactly this is a clear wet pixel. */
export const WOFS_WET = 128;
/** WOfS: exactly this is a clear dry pixel. */
export const WOFS_DRY = 0;

/** The pixels whose centres fall inside an outline, on one scene's grid. */
export interface OutlineMask {
	/** The mask's window in the scene's pixels (may run off the scene, or be negative). */
	col0: number;
	row0: number;
	width: number;
	height: number;
	/** 1 where the pixel's centre is inside, row-major, width × height. */
	mask: Uint8Array;
	/** How many pixels are inside. */
	inside: number;
	/** The ground area of one pixel, m² (grid area ÷ k²). */
	pixelAreaM2: number;
}

type Grid = Pick<CogInfo, 'epsg' | 'originX' | 'originY' | 'pixelSizeX' | 'pixelSizeY'>;

const polygonsOf = (g: OutlineGeometry): number[][][][] => {
	if (g?.type === 'Polygon') return [g.coordinates];
	if (g?.type === 'MultiPolygon') return g.coordinates;
	throw new FeedFormatError('the outline is not a Polygon or MultiPolygon');
};

/** The mask of `geometry` on `grid` (see the header). */
export function outlineMask(geometry: OutlineGeometry, grid: Grid): OutlineMask {
	const { epsg, originX, originY, pixelSizeX: px, pixelSizeY: py } = grid;
	let k = 0;
	// Each polygon's rings in fractional pixel coordinates: x = column, y = row (both from the corner, rows southward).
	const polys = polygonsOf(geometry).map((rings) =>
		rings.map((ring) => {
			if (!Array.isArray(ring) || ring.length < 3) throw new FeedFormatError('the outline has a ring of fewer than 3 points');
			return ring.map((pt) => {
				const [lon, lat] = pt as [number, number];
				if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new FeedFormatError('the outline has a point that is not a number');
				const p = toUtm(lon, lat, epsg);
				if (k === 0) k = p.k;
				return [(p.x - originX) / px, (originY - p.y) / py] as const;
			});
		})
	);
	if (k === 0) throw new FeedFormatError('the outline is empty');
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const rings of polys) {
		for (const [x, y] of rings[0] ?? []) {
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
	}
	// Pixels whose centres (c + 0.5) can be inside: the box, widened to whole pixels.
	const col0 = Math.floor(minX);
	const row0 = Math.floor(minY);
	const width = Math.max(0, Math.ceil(maxX) - col0);
	const height = Math.max(0, Math.ceil(maxY) - row0);
	if (width * height > WINDOW_MAX_PIXELS) throw new FeedFormatError('the outline is implausibly large for one scene');
	const mask = new Uint8Array(width * height);
	let inside = 0;
	const xs: number[] = [];
	for (let r = 0; r < height; r++) {
		const yc = row0 + r + 0.5;
		for (const rings of polys) {
			xs.length = 0;
			for (const ring of rings) {
				for (let i = 0; i < ring.length; i++) {
					const [x1, y1] = ring[i]!;
					const [x2, y2] = ring[(i + 1) % ring.length]!;
					// Half-open in y, so a vertex on the line is crossed once, and a horizontal edge never.
					if ((y1 <= yc && yc < y2) || (y2 <= yc && yc < y1)) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
				}
			}
			xs.sort((a, b) => a - b);
			for (let i = 0; i + 1 < xs.length; i += 2) {
				// Centres c + 0.5 in [xa, xb): c from ceil(xa - 0.5) to ceil(xb - 0.5) - 1.
				const c0 = Math.max(col0, Math.ceil(xs[i]! - 0.5));
				const c1 = Math.min(col0 + width, Math.ceil(xs[i + 1]! - 0.5));
				for (let c = c0; c < c1; c++) {
					const at = r * width + (c - col0);
					if (!mask[at]) {
						mask[at] = 1;
						inside++;
					}
				}
			}
		}
	}
	return { col0, row0, width, height, mask, inside, pixelAreaM2: (px * py) / (k * k) };
}

/** The part of the mask's window on the scene, or null when none of it is. */
export function sceneWindow(m: OutlineMask, cog: Pick<CogInfo, 'width' | 'height'>): PixelWindow | null {
	const col0 = Math.max(0, m.col0);
	const row0 = Math.max(0, m.row0);
	const col1 = Math.min(cog.width - 1, m.col0 + m.width - 1);
	const row1 = Math.min(cog.height - 1, m.row0 + m.height - 1);
	return col0 <= col1 && row0 <= row1 ? { col0, row0, col1, row1 } : null;
}

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
export function tally(m: OutlineMask, win: PixelWindow | null, samples: Uint8Array | null): Tally {
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
