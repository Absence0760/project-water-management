// Sentinel-2's classification (s2.ts): MNDWI, the NDWI fallback where B11 is
// missing, SCL masking, the item's offsets, and the item check.
import { describe, expect, it } from 'vitest';
import { FeedFormatError } from '../../../feeds/errors.js';
import type { OutlineMask } from '../../../raster/mask.js';
import { S2_C1_S3_BASE } from '../wofs/stac.js';
import { loadS2Fixture } from './fixtures.js';
import { s2Item, SCL_NOT_CLEAR, tallyS2, windowOn, type BandRead } from './s2.js';

const EPSG = 32734;
/** A 4 × 2 block of 10 m pixels, all inside. */
const MASK: OutlineMask = { col0: 0, row0: 0, width: 4, height: 2, mask: new Uint8Array(8).fill(1), inside: 8, pixelAreaM2: 100 };
const grid10 = { epsg: EPSG, originX: 0, originY: 40, pixelSizeX: 10, pixelSizeY: 10, width: 4, height: 4, nodata: 0, scale: 1, offset: 0 };
const grid20 = { ...grid10, pixelSizeX: 20, pixelSizeY: 20, width: 2, height: 2 };
const C1 = -1000;

/** B03 over the block: `w` for the west half (under 20 m pixel 0), `e` for the east. */
const green = (w: number, e: number, extra: Partial<BandRead['cog']> = {}): BandRead => ({
	cog: { ...grid10, ...extra },
	win: { col0: 0, row0: 0, col1: 3, row1: 1 },
	samples: [w, w, e, e, w, w, e, e],
	itemOffset: C1
});
/** A 20 m band's top row (the block's two 20 m pixels). */
const coarse = (w: number, e: number, extra: Partial<BandRead['cog']> = {}): BandRead => ({
	cog: { ...grid20, ...extra },
	win: { col0: 0, row0: 0, col1: 1, row1: 0 },
	samples: [w, e],
	itemOffset: C1
});
const scl = (w: number, e: number) => coarse(w, e);
const { water, land } = loadS2Fixture().reflectance;

describe('tallyS2', () => {
	it('is wet where MNDWI > 0, each 10 m pixel reading the 20 m B11 its centre falls in', () => {
		// West: water reflectances; east: land.
		const t = tallyS2(MASK, green(water.green, land.green), scl(6, 4), coarse(water.swir, land.swir), null);
		expect(t).toEqual({ inside: 8, covered: 8, clear: 8, wet: 4, needNir: 0 });
	});

	it('counts green ≤ swir as dry, at the threshold too', () => {
		const t = tallyS2(MASK, green(1500, 1500), scl(4, 4), coarse(1500, 1499), null);
		// West: MNDWI = 0 (not > 0), dry; east: just above 0, wet.
		expect(t).toMatchObject({ clear: 8, wet: 4 });
	});

	it('applies the item’s offset: two reflectances summing to 0 or less are no view', () => {
		// 900 + 900 DN at −1000 each: −100 + −100.
		const t = tallyS2(MASK, green(900, water.green), scl(4, 4), coarse(900, water.swir), null);
		expect(t).toMatchObject({ covered: 8, clear: 4, wet: 4 });
	});

	it('masks cloud, cirrus, shadow and saturated pixels as not clear; SCL 0 is off the scene', () => {
		for (const cls of SCL_NOT_CLEAR) {
			const t = tallyS2(MASK, green(water.green, water.green), scl(cls, 6), coarse(water.swir, water.swir), null);
			expect(t, `SCL ${cls}`).toMatchObject({ covered: cls === 0 ? 4 : 8, clear: 4, wet: 4 });
		}
		// Every other class is a clear view (2 dark area, 4–7, 11 snow).
		for (const cls of [2, 4, 5, 6, 7, 11]) expect(tallyS2(MASK, green(water.green, land.green), scl(cls, cls), coarse(water.swir, land.swir), null).clear).toBe(8);
	});

	it('treats B03’s no-data as off the scene', () => {
		expect(tallyS2(MASK, green(0, water.green), scl(6, 6), coarse(water.swir, water.swir), null)).toMatchObject({ covered: 4, clear: 4, wet: 4 });
	});

	it('falls back to NDWI from B08 where B11 is missing, and says how many pixels need it', () => {
		const swir = coarse(0, land.swir);
		const without = tallyS2(MASK, green(water.green, land.green), scl(6, 4), swir, null);
		expect(without).toMatchObject({ covered: 8, clear: 4, wet: 0, needNir: 4 });
		const nir = { ...green(water.nir, land.nir) };
		const withNir = tallyS2(MASK, green(water.green, land.green), scl(6, 4), swir, nir);
		expect(withNir).toMatchObject({ covered: 8, clear: 8, wet: 4, needNir: 0 });
		// No B11 asset at all: NDWI everywhere.
		expect(tallyS2(MASK, green(water.green, land.green), scl(6, 4), null, nir)).toMatchObject({ clear: 8, wet: 4 });
	});

	it('uses a file’s own GDAL scale and offset instead of the item’s offset', () => {
		const scaled = { scale: 0.0001, offset: -0.1 };
		const t = tallyS2(MASK, green(water.green, land.green, scaled), scl(6, 4), coarse(water.swir, land.swir, scaled), null);
		expect(t).toMatchObject({ clear: 8, wet: 4 });
	});

	it('counts the fixture’s land and water as the classification reads them', () => {
		const mndwi = (r: typeof water) => (r.green - r.swir) / (r.green + r.swir - 2000);
		const ndwi = (r: typeof water) => (r.green - r.nir) / (r.green + r.nir - 2000);
		expect(mndwi(water)).toBeGreaterThan(0);
		expect(ndwi(water)).toBeGreaterThan(0);
		expect(mndwi(land)).toBeLessThan(0);
		expect(ndwi(land)).toBeLessThan(0);
	});
});

describe('windowOn', () => {
	it('gives the 20 m pixels under a 10 m window, clipped to the image', () => {
		expect(windowOn(grid10, { col0: 0, row0: 0, col1: 3, row1: 1 }, grid20)).toEqual({ col0: 0, row0: 0, col1: 1, row1: 0 });
		expect(windowOn(grid10, { col0: 1, row0: 1, col1: 2, row1: 2 }, grid20)).toEqual({ col0: 0, row0: 0, col1: 1, row1: 1 });
		expect(windowOn(grid10, { col0: 0, row0: 0, col1: 3, row1: 3 }, { ...grid20, originX: 1000 })).toBeNull();
	});
});

describe('s2Item', () => {
	const href = (band: string) => `s3://deafrica-sentinel-2-l2a-c1/sentinel-2-c1-l2a/34/H/CH/2026/7/S2C_T34HCH_20260704T084601_L2A/${band}.tif`;
	const asset = (band: string, offset?: number) => ({ href: href(band), 'raster:bands': [{ nodata: 0, data_type: 'uint16', ...(offset !== undefined ? { offset } : {}) }] });
	const item = (assets: Record<string, unknown>) => ({
		type: 'Feature',
		id: 'e5f1cf10-e3b9-5f46-b068-a00c7d8ae22c',
		collection: 's2_l2a_c1',
		properties: { datetime: '2026-07-04T08:49:40.443000Z' },
		assets
	});

	it('reads B03, B11, B08 and SCL and each band’s offset', () => {
		const s = s2Item(item({ green: asset('B03', -1000), swir16: asset('B11', -1000), nir: asset('B08', -1000), scl: { href: href('SCL') } }));
		expect(s).toMatchObject({ itemId: 'e5f1cf10-e3b9-5f46-b068-a00c7d8ae22c', date: '2026-07-04', offsets: { green: -1000, swir: -1000, nir: -1000 } });
		expect(s.url).toBe(`${S2_C1_S3_BASE}/sentinel-2-c1-l2a/34/H/CH/2026/7/S2C_T34HCH_20260704T084601_L2A/B03.tif`);
		expect(s.swirUrl).toMatch(/\/B11\.tif$/);
		expect(s.sclUrl).toMatch(/\/SCL\.tif$/);
	});

	it('takes an item without B11 (NDWI then) and an offset it doesn’t give as 0', () => {
		const s = s2Item(item({ green: asset('B03'), nir: asset('B08'), scl: { href: href('SCL') } }));
		expect(s).toMatchObject({ swirUrl: null, offsets: { green: 0, swir: 0, nir: 0 } });
	});

	it('refuses an item with neither B11 nor B08, without SCL, or with an asset outside the bucket’s keys', () => {
		expect(() => s2Item(item({ green: asset('B03'), scl: { href: href('SCL') } }))).toThrow(FeedFormatError);
		expect(() => s2Item(item({ green: asset('B03'), nir: asset('B08') }))).toThrow(FeedFormatError);
		expect(() => s2Item(item({ green: { href: 's3://deafrica-services/wofs_ls/x.tif' }, nir: asset('B08'), scl: { href: href('SCL') } }))).toThrow(FeedFormatError);
		expect(() => s2Item(item({ green: { href: 'https://evil.example/sentinel-2-c1-l2a/B03.tif' }, nir: asset('B08'), scl: { href: href('SCL') } }))).toThrow(FeedFormatError);
		expect(() => s2Item(item({ green: { href: 's3://deafrica-sentinel-2-l2a-c1/sentinel-2-c1-l2a/../x/B03.tif' }, nir: asset('B08'), scl: { href: href('SCL') } }))).toThrow(FeedFormatError);
		expect(() => s2Item({ ...item({ green: asset('B03'), nir: asset('B08'), scl: { href: href('SCL') } }), collection: 'wofs_ls' })).toThrow(FeedFormatError);
	});
});
