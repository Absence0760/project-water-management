// A dam's wet area on one Sentinel-2 scene, classified and summed inside our
// own outline (issue #624 step 4; docs/model.md §2.10l, docs/architecture.md
// § Dam observations → Sentinel-2). DE Africa publishes no Sentinel water
// mask, so the pixels are classified here, with fixed thresholds (never tuned
// per dam):
//
//   water      MNDWI = (B03 − B11) / (B03 + B11) > 0, B11 (20 m) taken for
//              each 10 m pixel from the 20 m pixel its centre falls in;
//              NDWI = (B03 − B08) / (B03 + B08) > 0 where B11 is missing
//              (its no-data, or the item has no swir16 asset)
//   not clear  SCL (20 m, as B11) 0 no data, 1 saturated or defective,
//              3 cloud shadow, 8 and 9 cloud (medium, high probability),
//              10 thin cirrus; a pixel with neither B11 nor B08, or whose
//              two reflectances sum to 0 or less
//   off scene  B03's no-data (0) or SCL 0: not covered (WOfS's bit 0)
//
// so, as WOfS's (../wofs/sum.ts observation):
//
//   wet_area_m2   = wet pixels × the 10 m pixel's ground area (100 m² ÷ k²)
//   pct_observed  = clear pixels ÷ pixels inside × 100
//
// and the reader's OBSERVED.minPctObserved rule (compare.ts) decides which
// views count. The mask is made on B03's 10 m grid (raster/mask.ts), so a
// 0.3 ha dam is ~30 pixels where WOfS's 30 m grid gives it three or none.
//
// Reflectance. DE Africa's s2_l2a_c1 items give each band's offset in
// raster:bands (−1000 DN for Collection 1, checked 2026-10-29; scale 1e-4 is
// common to all bands), applied per band: v = DN + offset. The files carry
// their own GDAL scale and offset, 1e-4 and −0.1 (the same thing, at 1e-4 a
// DN; their headers read 2026-10-29, raster/cogLayouts.ts), and a file's own
// is used where it has one (v = DN × scale + offset), so the item's offset is
// the fallback; a scene whose two bands disagree on having one is refused. With one offset shared by both bands the sign of B03 − B11
// is offset-free, so the 0 threshold is too; the offset matters only to the
// "sum to 0 or less" rule, which guards division.
//
// Reads per scene: B03's header and the tiles under the outline, B11's and
// SCL's (each 20 m, a quarter the pixels), and B08's only when a clear
// inside pixel has no B11. One request in flight, paced by the pass.
import { z } from 'zod';
import { FeedFormatError } from '../../../feeds/errors.js';
import type { FeedHttp } from '../../../feeds/http.js';
import { openCog, readWindow, type CogAccept, type CogInfo, type PixelWindow, type Samples } from '../../../raster/cog.js';
import { sceneWindow, type OutlineMask } from '../../../raster/mask.js';
import type { WantedOutline } from '../handover.js';
import { maskFor, taggedReader, type SceneView } from '../wofs/pass.js';
import { assetUrl, S2_C1_COLLECTION, type SceneItem } from '../wofs/stac.js';
import { observation, pixelClasses, PX_COVERED, PX_DRY, PX_WET, viewPixels, type Tally } from '../wofs/sum.js';

/** The reflectance bands: uint16 on a UTM grid; a GDAL scale and offset is read if a file carries one. */
export const S2_BAND_ACCEPT: CogAccept = { sampleTypes: ['uint16'], crs: ['utm'], scaleOffset: true };
/** The scene classification: uint8 classes on a UTM grid. */
export const S2_SCL_ACCEPT: CogAccept = { sampleTypes: ['uint8'], crs: ['utm'] };

/** SCL classes that are not a clear view of the ground (see the header). */
export const SCL_NOT_CLEAR: ReadonlySet<number> = new Set([0, 1, 3, 8, 9, 10]);
/** SCL 0: no data (off the scene). */
export const SCL_NO_DATA = 0;
/** The reflectance bands' no-data (DE Africa's raster:bands nodata, and GDAL_NODATA when the file has none). */
export const S2_BAND_NO_DATA = 0;

/** The four assets read, by their s2_l2a_c1 asset keys: B03 green, B08 nir, B11 swir16, SCL scl. */
export interface S2Scene extends SceneItem {
	/** B03 (10 m): `url` is its URL, kept with its ETag as the scene's upstream. */
	url: string;
	/** B11 (20 m), when the item has it. */
	swirUrl: string | null;
	/** B08 (10 m), when the item has it. */
	nirUrl: string | null;
	/** SCL (20 m). */
	sclUrl: string;
	/** Each band's DN offset from the item's raster:bands (0 when it gives none). */
	offsets: { green: number; swir: number; nir: number };
}

const Printable = z.string().min(1).max(200).regex(/^[!-~]+$/);
const Band = z.object({ offset: z.number().finite().min(-10_000).max(10_000).optional() }).passthrough();
const Asset = z.object({ href: z.string().max(1000), 'raster:bands': z.array(Band).max(4).optional() }).passthrough();
const S2Item = z.object({
	id: Printable,
	collection: z.literal(S2_C1_COLLECTION).optional(),
	properties: z.object({ datetime: z.string().datetime({ offset: true }) }).passthrough(),
	assets: z.object({ green: Asset, scl: Asset, swir16: Asset.optional(), nir: Asset.optional() }).passthrough()
});

/** An s2_l2a_c1 item as a scene: FeedFormatError for any other shape, an asset outside the bucket's keys, or neither B11 nor B08. */
export function s2Item(raw: unknown): S2Scene {
	const item = S2Item.safeParse(raw);
	if (!item.success) throw new FeedFormatError('a Sentinel-2 STAC item is not in the expected shape');
	const { green, scl, swir16, nir } = item.data.assets;
	const url = (a: z.output<typeof Asset>) => {
		const u = assetUrl(a.href, S2_C1_COLLECTION);
		if (!u) throw new FeedFormatError('a Sentinel-2 STAC item’s asset is not in the Sentinel-2 bucket');
		return u;
	};
	if (!swir16 && !nir) throw new FeedFormatError('a Sentinel-2 STAC item has neither B11 nor B08');
	const offset = (a: z.output<typeof Asset> | undefined) => a?.['raster:bands']?.[0]?.offset ?? 0;
	const datetime = new Date(item.data.properties.datetime).toISOString();
	return {
		itemId: item.data.id,
		date: datetime.slice(0, 10),
		datetime,
		url: url(green),
		swirUrl: swir16 ? url(swir16) : null,
		nirUrl: nir ? url(nir) : null,
		sclUrl: url(scl),
		offsets: { green: offset(green), swir: offset(swir16), nir: offset(nir) }
	};
}

/** One band's samples as reflectance-proportional values: its no-data, and how a DN becomes a value. */
export interface BandRead {
	cog: Pick<CogInfo, 'epsg' | 'originX' | 'originY' | 'pixelSizeX' | 'pixelSizeY' | 'width' | 'height' | 'nodata' | 'scale' | 'offset'>;
	win: PixelWindow | null;
	samples: ArrayLike<number> | null;
	/** The item's DN offset (used when the file gives no GDAL scale and offset). */
	itemOffset: number;
}

/** Whether a band's file gives its own GDAL scale and offset. */
const hasFileScale = (b: Pick<BandRead, 'cog'>) => b.cog.scale !== 1 || b.cog.offset !== 0;

/** The value of sample `v`: DN × scale + offset from the file, else DN + the item's offset. */
const valueOf = (b: BandRead, v: number) => (hasFileScale(b) ? v * b.cog.scale + b.cog.offset : v + b.itemOffset);

/** The band's sample at the ground point (x, y) (metres, the grid's CRS), or null off its window or at its no-data. */
function sampleAt(b: Omit<BandRead, 'itemOffset'> | null, x: number, y: number): number | null {
	if (!b?.win || !b.samples) return null;
	const c = Math.floor((x - b.cog.originX) / b.cog.pixelSizeX);
	const r = Math.floor((b.cog.originY - y) / b.cog.pixelSizeY);
	if (c < b.win.col0 || c > b.win.col1 || r < b.win.row0 || r > b.win.row1) return null;
	const v = b.samples[(r - b.win.row0) * (b.win.col1 - b.win.col0 + 1) + (c - b.win.col0)]!;
	const nd = b.cog.nodata ?? S2_BAND_NO_DATA;
	return v === nd ? null : v;
}

/** A tally of the mask's pixels (WOfS's shape), and how many clear-classified inside pixels lacked B11 and so need B08. */
export interface S2Tally extends Tally {
	needNir: number;
}

/**
 * Classifies and counts the mask's pixels (see the header). `green` is on the mask's grid; `swir`, `nir` and
 * `scl` are found by each 10 m pixel's centre on their own grids (B08 is 10 m too, but found the same way).
 * `nir` null: a pixel without B11 is counted in needNir and not clear. `classes` (sum.ts pixelClasses) gets each pixel's class.
 */
export function tallyS2(m: OutlineMask, green: BandRead, scl: Omit<BandRead, 'itemOffset'>, swir: BandRead | null, nir: BandRead | null, classes?: Uint8Array): S2Tally {
	let covered = 0;
	let clear = 0;
	let wet = 0;
	let needNir = 0;
	const win = green.win;
	if (win && green.samples) {
		const gx = green.cog;
		const w = win.col1 - win.col0 + 1;
		const gnd = gx.nodata ?? S2_BAND_NO_DATA;
		for (let r = win.row0; r <= win.row1; r++) {
			const mr = r - m.row0;
			const y = gx.originY - (r + 0.5) * gx.pixelSizeY;
			for (let c = win.col0; c <= win.col1; c++) {
				const at = mr * m.width + (c - m.col0);
				if (!m.mask[at]) continue;
				const g = green.samples[(r - win.row0) * w + (c - win.col0)]!;
				if (g === gnd) continue;
				const x = gx.originX + (c + 0.5) * gx.pixelSizeX;
				const s = sampleAt(scl, x, y);
				if (s === null || s === SCL_NO_DATA) continue;
				covered++;
				if (classes) classes[at] = PX_COVERED;
				if (SCL_NOT_CLEAR.has(s)) continue;
				let other: number | null = null;
				let band: BandRead | null = null;
				const b11 = sampleAt(swir, x, y);
				if (b11 !== null) {
					other = b11;
					band = swir;
				} else {
					const b08 = sampleAt(nir, x, y);
					if (b08 === null) {
						needNir++;
						continue;
					}
					other = b08;
					band = nir;
				}
				const gv = valueOf(green, g);
				const ov = valueOf(band!, other);
				// Neither reflectance positive: no index to read (and no division by 0).
				if (gv + ov <= 0) continue;
				clear++;
				// (gv − ov) / (gv + ov) > 0 with a positive denominator.
				const water = gv - ov > 0;
				if (water) wet++;
				if (classes) classes[at] = water ? PX_WET : PX_DRY;
			}
		}
	}
	return { inside: m.inside, covered, clear, wet, needNir };
}

/** The window of a coarser (or equal) grid under `win` of `fine` (same CRS), clipped to its image; null when none of it is. */
export function windowOn(fine: Pick<CogInfo, 'originX' | 'originY' | 'pixelSizeX' | 'pixelSizeY'>, win: PixelWindow, grid: Pick<CogInfo, 'originX' | 'originY' | 'pixelSizeX' | 'pixelSizeY' | 'width' | 'height'>): PixelWindow | null {
	const x0 = fine.originX + (win.col0 + 0.5) * fine.pixelSizeX;
	const x1 = fine.originX + (win.col1 + 0.5) * fine.pixelSizeX;
	const y0 = fine.originY - (win.row0 + 0.5) * fine.pixelSizeY;
	const y1 = fine.originY - (win.row1 + 0.5) * fine.pixelSizeY;
	const col0 = Math.max(0, Math.floor((x0 - grid.originX) / grid.pixelSizeX));
	const col1 = Math.min(grid.width - 1, Math.floor((x1 - grid.originX) / grid.pixelSizeX));
	const row0 = Math.max(0, Math.floor((grid.originY - y0) / grid.pixelSizeY));
	const row1 = Math.min(grid.height - 1, Math.floor((grid.originY - y1) / grid.pixelSizeY));
	return col0 <= col1 && row0 <= row1 ? { col0, row0, col1, row1 } : null;
}

/** Opens one band; FeedFormatError when it isn't in the bucket or isn't on the scene's CRS. */
async function openBand(http: FeedHttp, url: string, accept: CogAccept, epsg: number | null) {
	const { read } = taggedReader(http, url);
	const cog = await openCog(read, accept);
	if (!cog) throw new FeedFormatError('a Sentinel-2 band STAC lists is not in the bucket');
	if (epsg !== null && cog.epsg !== epsg) throw new FeedFormatError('a Sentinel-2 scene’s bands are not on one CRS');
	return { read, cog };
}

/** Reads the window of a band under B03's window; null samples when none of it is on the band's image. */
async function bandUnder(http: FeedHttp, url: string, accept: CogAccept, green: CogInfo, gwin: PixelWindow): Promise<{ cog: CogInfo; win: PixelWindow | null; samples: Samples | null }> {
	const { read, cog } = await openBand(http, url, accept, green.epsg);
	const win = windowOn(green, gwin, cog);
	return { cog, win, samples: win ? await readWindow(read, cog, win) : null };
}

/** One Sentinel-2 scene's view of a dam (see the header), or null when it didn't see it. */
export async function viewS2Scene(http: FeedHttp, scene: S2Scene, outline: WantedOutline, masks: Map<string, OutlineMask>): Promise<SceneView<S2Scene> | null> {
	const { read, tag } = taggedReader(http, scene.url);
	const green = await openCog(read, S2_BAND_ACCEPT);
	if (!green) throw new FeedFormatError('the Sentinel-2 scene STAC lists is not in the bucket');
	const mask = maskFor(masks, outline, green);
	if (mask.inside === 0) return null;
	const gwin = sceneWindow(mask, green);
	if (!gwin) return null;
	const gs = await readWindow(read, green, gwin);
	const greenBand: BandRead = { cog: green, win: gwin, samples: gs, itemOffset: scene.offsets.green };
	const scl = await bandUnder(http, scene.sclUrl, S2_SCL_ACCEPT, green, gwin);
	const swir = scene.swirUrl ? await bandUnder(http, scene.swirUrl, S2_BAND_ACCEPT, green, gwin) : null;
	const swirBand: BandRead | null = swir && { ...swir, itemOffset: scene.offsets.swir };
	if (swirBand && hasFileScale(swirBand) !== hasFileScale(greenBand)) throw new FeedFormatError('a Sentinel-2 scene’s bands disagree on their scale');
	const classes = pixelClasses(mask);
	let t = tallyS2(mask, greenBand, scl, swirBand, null, classes);
	// B08 only when some clear inside pixel has no B11.
	if (t.needNir > 0 && scene.nirUrl) {
		const nir = await bandUnder(http, scene.nirUrl, S2_BAND_ACCEPT, green, gwin);
		const nirBand: BandRead = { ...nir, itemOffset: scene.offsets.nir };
		if (hasFileScale(nirBand) !== hasFileScale(greenBand)) throw new FeedFormatError('a Sentinel-2 scene’s bands disagree on their scale');
		t = tallyS2(mask, greenBand, scl, swirBand, nirBand, classes);
	}
	const o = observation(t, mask.pixelAreaM2);
	return o && { scene, ...(tag.etag ? { etag: tag.etag } : {}), ...o, pixels: viewPixels(green, mask, classes) };
}
