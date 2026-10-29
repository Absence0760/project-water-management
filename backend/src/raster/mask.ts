// The pixels of a scene whose centres fall inside an outline: the mask the
// WOfS pass sums a dam's wet area over (dams/observed/wofs/sum.ts, issue
// #604 R5-C), and the one the Sentinel (#624) and WaPOR actual ET (#623)
// passes will sum over, on a UTM or a geographic (EPSG:4326) grid.
//
// A pixel counts when its CENTRE falls inside the outline: the outline (a
// GeoJSON Polygon or MultiPolygon in lon/lat, as map_feature keeps it) is
// taken vertex by vertex into the grid's fractional pixel coordinates
// (projected into UTM by utm.ts, or scaled from degrees on a geographic
// grid), its edges taken as straight there (an outline's edges are tens of
// metres; the curvature is far below a pixel), and each pixel row's centre
// line is crossed with every edge. Within one polygon the crossings pair up
// even-odd, so a hole (an island) is out; the polygons of a MultiPolygon are
// unioned, so a pixel two of them both cover counts once.
//
// The pixel's ground area:
// - UTM: its grid area (30 m × 30 m for WOfS) ÷ k², k the UTM scale factor
//   at the outline's first vertex: the grid stretches ground by k (0.9996 on
//   the zone's meridian, ~1.0010 at its edge), so without it a dam near a
//   zone edge would read 0.2 % large.
// - Geographic: the WGS 84 ellipsoid's area element M·N·cos φ · Δφ · Δλ at
//   the latitude of the outline's box centre (M, N the meridional and prime
//   vertical radii of curvature). A pixel's area changes by ~1.1 % a degree
//   of latitude at 34° S, so over an outline 0.1° tall the pixels at its
//   edges differ from the centre's by ~0.06 %, and the sum's error cancels
//   to first order.
import { FeedFormatError } from '../feeds/errors.js';
import { WINDOW_MAX_PIXELS, type CogInfo, type PixelWindow } from './cog.js';
import { toUtm } from './utm.js';

/** GeoJSON Polygon / MultiPolygon, lon/lat (the handover's WantedOutline.geometry). */
export type OutlineGeometry = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] };

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
	/** The ground area of one pixel, m² (see the header). */
	pixelAreaM2: number;
}

/** A grid: EPSG 326xx / 327xx (UTM, metres) or 4326 (geographic, degrees). */
export type MaskGrid = Pick<CogInfo, 'epsg' | 'originX' | 'originY' | 'pixelSizeX' | 'pixelSizeY'>;

const polygonsOf = (g: OutlineGeometry): number[][][][] => {
	if (g?.type === 'Polygon') return [g.coordinates];
	if (g?.type === 'MultiPolygon') return g.coordinates;
	throw new FeedFormatError('the outline is not a Polygon or MultiPolygon');
};

const WGS84_A = 6_378_137;
const WGS84_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);

/** The ground area, m², of a `dLon` × `dLat` degree cell centred at latitude `lat` on the WGS 84 ellipsoid (M·N·cos φ·Δφ·Δλ). */
export function geographicCellAreaM2(lat: number, dLon: number, dLat: number): number {
	const phi = (lat * Math.PI) / 180;
	const w = 1 - WGS84_E2 * Math.sin(phi) ** 2;
	const m = (WGS84_A * (1 - WGS84_E2)) / w ** 1.5;
	const n = WGS84_A / Math.sqrt(w);
	return m * n * Math.cos(phi) * ((dLat * Math.PI) / 180) * ((dLon * Math.PI) / 180);
}

/** The mask of `geometry` on `grid` (see the header). */
export function outlineMask(geometry: OutlineGeometry, grid: MaskGrid): OutlineMask {
	const { epsg, originX, originY, pixelSizeX: px, pixelSizeY: py } = grid;
	const geographic = epsg === 4326;
	let k = 0;
	let points = 0;
	// Each polygon's rings in fractional pixel coordinates: x = column, y = row (both from the corner, rows southward).
	const polys = polygonsOf(geometry).map((rings) =>
		rings.map((ring) => {
			if (!Array.isArray(ring) || ring.length < 3) throw new FeedFormatError('the outline has a ring of fewer than 3 points');
			return ring.map((pt) => {
				const [lon, lat] = pt as [number, number];
				if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new FeedFormatError('the outline has a point that is not a number');
				points++;
				if (geographic) return [(lon - originX) / px, (originY - lat) / py] as const;
				const p = toUtm(lon, lat, epsg);
				if (k === 0) k = p.k;
				return [(p.x - originX) / px, (originY - p.y) / py] as const;
			});
		})
	);
	if (points === 0) throw new FeedFormatError('the outline is empty');
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
	const pixelAreaM2 = geographic ? geographicCellAreaM2(originY - ((minY + maxY) / 2) * py, px, py) : (px * py) / (k * k);
	return { col0, row0, width, height, mask, inside, pixelAreaM2 };
}

/** The part of the mask's window on the scene, or null when none of it is. */
export function sceneWindow(m: OutlineMask, cog: Pick<CogInfo, 'width' | 'height'>): PixelWindow | null {
	const col0 = Math.max(0, m.col0);
	const row0 = Math.max(0, m.row0);
	const col1 = Math.min(cog.width - 1, m.col0 + m.width - 1);
	const row1 = Math.min(cog.height - 1, m.row0 + m.height - 1);
	return col0 <= col1 && row0 <= row1 ? { col0, row0, col1, row1 } : null;
}
