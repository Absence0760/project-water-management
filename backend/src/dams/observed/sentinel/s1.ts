// A dam's wet area on one Sentinel-1 radar scene, classified and summed
// inside our own outline (issue #624 step 5; docs/model.md §2.10l,
// docs/architecture.md § Dam observations → Sentinel-1). DE Africa publishes
// no Sentinel water mask, so the pixels are classified here, with one fixed
// threshold (never tuned per dam):
//
//   water      VV backscatter below S1_WATER_DB (−18 dB): calm open water
//              reflects the radar away from the satellite, so it is dark
//   not clear  RTC's `mask` band anything but 1 (valid): 2 is radar shadow
//              or layover, where the terrain hides or folds the ground; and a
//              valid pixel whose VV is no-data (NaN), not finite, or 0 or less
//   off scene  `mask` 0 (no data), or outside the scene: not covered
//
// so, as WOfS's and Sentinel-2's (../wofs/sum.ts observation):
//
//   wet_area_m2   = wet pixels × the 0.0002° cell's ground area at the outline
//   pct_observed  = clear pixels ÷ pixels inside × 100
//
// Radar is the secondary source (compare.ts isRadar): wind roughens open
// water so it looks dry, and dry sand can look wet, so it is shown and
// compared but never alone the reason a dam is called full or empty. How well
// it agrees with Sentinel-2's clear views of the same dams is measured, not
// assumed (agreement.ts).
//
// The grid. s1_rtc is gamma0 in LINEAR power (not dB), float32, no-data NaN,
// on a 0.0002° geographic grid (EPSG:4326) cut into 1° tiles (5000 × 5000,
// named by their corner, e.g. S35E019); `mask` is uint8 on the same grid
// (0 no data, 1 valid, 2 shadow or layover). Checked against one live
// s1_rtc item's metadata and DE Africa's spec page on 2026-10-29, no pixel
// fetched. The mask is made on VV's grid (raster/mask.ts, geographic), and
// the mask band must be on exactly that grid. The threshold is applied in
// linear power: VV < 10^(−18 / 10), the same test as 10·log10(VV) < −18
// without a logarithm a pixel.
//
// Reads per scene: VV's header and the tiles under the outline, then the
// mask band's. One request in flight, paced by the pass.
import { z } from 'zod';
import { FeedFormatError } from '../../../feeds/errors.js';
import type { FeedHttp } from '../../../feeds/http.js';
import { isNodata, openCog, readWindow, type CogAccept, type CogInfo, type PixelWindow } from '../../../raster/cog.js';
import { sceneWindow, type OutlineMask } from '../../../raster/mask.js';
import type { WantedOutline } from '../handover.js';
import { maskFor, taggedReader, type SceneView } from '../wofs/pass.js';
import { assetUrl, S1_RTC_COLLECTION, type SceneItem } from '../wofs/stac.js';
import { observation, pixelClasses, PX_COVERED, PX_DRY, PX_WET, viewPixels, type Tally } from '../wofs/sum.js';

/** VV: float32 gamma0 on a geographic grid, no GDAL scale or offset (refused at open). */
export const S1_VV_ACCEPT: CogAccept = { sampleTypes: ['float32'], crs: ['geographic'] };
/** The RTC data mask: uint8 on the same geographic grid. */
export const S1_MASK_ACCEPT: CogAccept = { sampleTypes: ['uint8'], crs: ['geographic'] };

/** Water is VV backscatter below this, dB: fixed (docs/model.md §2.10l), never tuned per dam. */
export const S1_WATER_DB = -18;
/** The same threshold in linear power, as s1_rtc's VV is: 10^(S1_WATER_DB / 10) ≈ 0.0158. */
export const S1_WATER_LINEAR = 10 ** (S1_WATER_DB / 10);
/** The RTC mask's values: 0 no data (off the scene), 1 valid; anything else (2, shadow or layover) is not a clear view. */
export const S1_MASK_NO_DATA = 0;
export const S1_MASK_VALID = 1;

/** The two assets read, by their s1_rtc asset keys. */
export interface S1Scene extends SceneItem {
	/** VV: `url` is its URL, kept with its ETag as the scene's upstream. */
	url: string;
	/** The RTC data mask. */
	maskUrl: string;
}

const Printable = z.string().min(1).max(200).regex(/^[!-~]+$/);
const Asset = z.object({ href: z.string().max(1000) }).passthrough();
const S1Item = z.object({
	id: Printable,
	collection: z.literal(S1_RTC_COLLECTION).optional(),
	properties: z.object({ datetime: z.string().datetime({ offset: true }) }).passthrough(),
	assets: z.object({ vv: Asset, mask: Asset }).passthrough()
});

/** An s1_rtc item as a scene: FeedFormatError for any other shape, or an asset outside the bucket's `s1_rtc/` keys. */
export function s1Item(raw: unknown): S1Scene {
	const item = S1Item.safeParse(raw);
	if (!item.success) throw new FeedFormatError('a Sentinel-1 STAC item is not in the expected shape');
	const url = (a: z.output<typeof Asset>) => {
		const u = assetUrl(a.href, S1_RTC_COLLECTION);
		if (!u) throw new FeedFormatError('a Sentinel-1 STAC item’s asset is not in the Sentinel-1 bucket');
		return u;
	};
	const datetime = new Date(item.data.properties.datetime).toISOString();
	return { itemId: item.data.id, date: datetime.slice(0, 10), datetime, url: url(item.data.assets.vv), maskUrl: url(item.data.assets.mask) };
}

/** Whether linear VV backscatter `v` (a clear pixel's) reads as water. */
export const isRadarWater = (v: number) => v < S1_WATER_LINEAR;

/**
 * Classifies and counts the outline mask's pixels over `win` (see the header): `vv` and `mask` are the two bands'
 * samples over the same window of the same grid, row-major. `classes` (sum.ts pixelClasses) gets each pixel's class.
 */
export function tallyS1(m: OutlineMask, win: PixelWindow | null, vv: ArrayLike<number> | null, vvGrid: Pick<CogInfo, 'nodata'>, mask: ArrayLike<number> | null, classes?: Uint8Array): Tally {
	let covered = 0;
	let clear = 0;
	let wet = 0;
	if (win && vv && mask) {
		const w = win.col1 - win.col0 + 1;
		for (let r = win.row0; r <= win.row1; r++) {
			const mr = r - m.row0;
			for (let c = win.col0; c <= win.col1; c++) {
				const at = mr * m.width + (c - m.col0);
				if (!m.mask[at]) continue;
				const i = (r - win.row0) * w + (c - win.col0);
				const flag = mask[i]!;
				if (flag === S1_MASK_NO_DATA) continue;
				covered++;
				if (classes) classes[at] = PX_COVERED;
				if (flag !== S1_MASK_VALID) continue;
				const v = vv[i]!;
				// No backscatter to read: not a clear view (and no water claimed).
				if (isNodata(vvGrid, v) || !Number.isFinite(v) || v <= 0) continue;
				clear++;
				const water = isRadarWater(v);
				if (water) wet++;
				if (classes) classes[at] = water ? PX_WET : PX_DRY;
			}
		}
	}
	return { inside: m.inside, covered, clear, wet };
}

/** Whether two grids are the same pixels (the mask band must be on VV's grid). */
const sameGrid = (a: CogInfo, b: CogInfo) =>
	a.epsg === b.epsg && a.originX === b.originX && a.originY === b.originY && a.pixelSizeX === b.pixelSizeX && a.pixelSizeY === b.pixelSizeY && a.width === b.width && a.height === b.height;

/** One Sentinel-1 scene's view of a dam (see the header), or null when it didn't see it. */
export async function viewS1Scene(http: FeedHttp, scene: S1Scene, outline: WantedOutline, masks: Map<string, OutlineMask>): Promise<SceneView<S1Scene> | null> {
	const { read, tag } = taggedReader(http, scene.url);
	const vv = await openCog(read, S1_VV_ACCEPT);
	if (!vv) throw new FeedFormatError('the Sentinel-1 scene STAC lists is not in the bucket');
	const outlineMask = maskFor(masks, outline, vv);
	if (outlineMask.inside === 0) return null;
	const win = sceneWindow(outlineMask, vv);
	if (!win) return null;
	const vs = await readWindow(read, vv, win);
	const { read: readMask } = taggedReader(http, scene.maskUrl);
	const mcog = await openCog(readMask, S1_MASK_ACCEPT);
	if (!mcog) throw new FeedFormatError('the Sentinel-1 mask STAC lists is not in the bucket');
	if (!sameGrid(vv, mcog)) throw new FeedFormatError('a Sentinel-1 scene’s mask is not on its VV grid');
	const ms = await readWindow(readMask, mcog, win);
	const classes = pixelClasses(outlineMask);
	const o = observation(tallyS1(outlineMask, win, vs, vv, ms, classes), outlineMask.pixelAreaM2);
	return o && { scene, ...(tag.etag ? { etag: tag.etag } : {}), ...o, pixels: viewPixels(vv, outlineMask, classes) };
}
