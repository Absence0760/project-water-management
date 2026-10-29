// Sentinel-1's classification (s1.ts): VV under −18 dB in linear power, the
// RTC mask (shadow and layover not clear, 0 off the scene), VV's no-data,
// the item check, and a scene whose mask isn't on its VV grid.
import { describe, expect, it } from 'vitest';
import { FeedFormatError } from '../../../feeds/errors.js';
import type { FeedHttp } from '../../../feeds/http.js';
import { writeCog } from '../../../raster/cogWrite.js';
import { outlineMask, type OutlineMask } from '../../../raster/mask.js';
import { S1_S3_BASE } from '../wofs/stac.js';
import { pixelClasses, PX_COVERED, PX_DRY, PX_OFF, PX_WET } from '../wofs/sum.js';
import { loadS1Fixture } from './s1Fixtures.js';
import { isRadarWater, s1Item, S1_WATER_DB, S1_WATER_LINEAR, tallyS1, viewS1Scene } from './s1.js';

/** A 4 × 2 block of pixels, all inside. */
const MASK: OutlineMask = { col0: 0, row0: 0, width: 4, height: 2, mask: new Uint8Array(8).fill(1), inside: 8, pixelAreaM2: 400 };
const WIN = { col0: 0, row0: 0, col1: 3, row1: 1 };
const NAN_GRID = { nodata: Number.NaN };
const { water, land, windWater } = loadS1Fixture().backscatter;

describe('the water threshold', () => {
	it('is −18 dB, applied to linear gamma0', () => {
		expect(S1_WATER_DB).toBe(-18);
		expect(10 * Math.log10(S1_WATER_LINEAR)).toBeCloseTo(-18, 12);
		expect(isRadarWater(10 ** (-18.01 / 10))).toBe(true);
		// At the threshold itself: not below it, so dry.
		expect(isRadarWater(S1_WATER_LINEAR)).toBe(false);
		expect(isRadarWater(10 ** (-17.99 / 10))).toBe(false);
	});

	it('reads the fixture’s calm water as wet, and its land and wind-roughened water as dry', () => {
		expect(isRadarWater(water)).toBe(true);
		expect(isRadarWater(land)).toBe(false);
		expect(isRadarWater(windWater)).toBe(false);
	});
});

describe('tallyS1', () => {
	it('is wet where VV is under the threshold, on valid mask pixels', () => {
		const t = tallyS1(MASK, WIN, [water, water, land, land, water, water, land, land], NAN_GRID, new Uint8Array(8).fill(1));
		expect(t).toEqual({ inside: 8, covered: 8, clear: 8, wet: 4 });
	});

	it('counts shadow and layover (mask 2, or any value but 1) as covered but not clear; mask 0 is off the scene', () => {
		const vv = new Array(8).fill(water);
		expect(tallyS1(MASK, WIN, vv, NAN_GRID, Uint8Array.from([2, 2, 1, 1, 2, 2, 1, 1]))).toEqual({ inside: 8, covered: 8, clear: 4, wet: 4 });
		expect(tallyS1(MASK, WIN, vv, NAN_GRID, Uint8Array.from([0, 0, 1, 1, 0, 0, 1, 1]))).toEqual({ inside: 8, covered: 4, clear: 4, wet: 4 });
		expect(tallyS1(MASK, WIN, vv, NAN_GRID, Uint8Array.from([3, 7, 1, 1, 255, 1, 1, 1]))).toMatchObject({ covered: 8, clear: 5 });
	});

	it('treats a valid pixel without backscatter (NaN, infinite, 0 or less) as not clear, never as water', () => {
		const vv = [Number.NaN, Number.POSITIVE_INFINITY, 0, -0.01, water, water, water, water];
		expect(tallyS1(MASK, WIN, vv, NAN_GRID, new Uint8Array(8).fill(1))).toEqual({ inside: 8, covered: 8, clear: 4, wet: 4 });
		// A numeric no-data reads the same way.
		expect(tallyS1(MASK, WIN, [-9999, water, water, water, water, water, water, water], { nodata: -9999 }, new Uint8Array(8).fill(1))).toMatchObject({ clear: 7 });
	});

	it('gives each pixel its class for joining views (merge.ts): off the scene, shadow, wet, dry', () => {
		const classes = pixelClasses(MASK);
		tallyS1(MASK, WIN, [water, water, land, land, water, water, land, land], NAN_GRID, Uint8Array.from([0, 2, 1, 1, 0, 2, 1, 1]), classes);
		expect([...classes]).toEqual([PX_OFF, PX_COVERED, PX_DRY, PX_DRY, PX_OFF, PX_COVERED, PX_DRY, PX_DRY]);
		tallyS1(MASK, WIN, new Array(8).fill(water), NAN_GRID, new Uint8Array(8).fill(1), classes);
		expect([...classes]).toEqual(new Array(8).fill(PX_WET));
	});

	it('counts only the outline’s pixels', () => {
		const half: OutlineMask = { ...MASK, mask: Uint8Array.from([1, 1, 0, 0, 1, 1, 0, 0]), inside: 4 };
		expect(tallyS1(half, WIN, new Array(8).fill(water), NAN_GRID, new Uint8Array(8).fill(1))).toEqual({ inside: 4, covered: 4, clear: 4, wet: 4 });
	});

	it('sees nothing without a window or samples', () => {
		expect(tallyS1(MASK, null, null, NAN_GRID, null)).toEqual({ inside: 8, covered: 0, clear: 0, wet: 0 });
	});
});

describe('s1Item', () => {
	const href = (band: string) => `s3://deafrica-sentinel-1/s1_rtc/S35E019/2026/09/05/0083D3/s1_rtc_0083D3_S35E019_2026_09_05_${band}.tif`;
	const item = (assets: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
		type: 'Feature',
		id: '8a811075-faa3-5045-a20b-41f902300b17',
		collection: 's1_rtc',
		properties: { datetime: '2026-09-05T17:33:11Z' },
		assets,
		...extra
	});

	it('reads VV and the mask, and the acquisition date (UTC)', () => {
		const s = s1Item(item({ vv: { href: href('VV') }, vh: { href: href('VH') }, mask: { href: href('MASK') } }));
		expect(s).toEqual({
			itemId: '8a811075-faa3-5045-a20b-41f902300b17',
			date: '2026-09-05',
			datetime: '2026-09-05T17:33:11.000Z',
			url: `${S1_S3_BASE}/s1_rtc/S35E019/2026/09/05/0083D3/s1_rtc_0083D3_S35E019_2026_09_05_VV.tif`,
			maskUrl: `${S1_S3_BASE}/s1_rtc/S35E019/2026/09/05/0083D3/s1_rtc_0083D3_S35E019_2026_09_05_MASK.tif`
		});
	});

	it('refuses an item without VV or the mask, from another collection, or naming an object outside s1_rtc/ in the bucket', () => {
		expect(() => s1Item(item({ vv: { href: href('VV') } }))).toThrow(FeedFormatError);
		expect(() => s1Item(item({ mask: { href: href('MASK') } }))).toThrow(FeedFormatError);
		expect(() => s1Item(item({ vv: { href: href('VV') }, mask: { href: href('MASK') } }, { collection: 's2_l2a_c1' }))).toThrow(FeedFormatError);
		expect(() => s1Item(item({ vv: { href: 's3://deafrica-services/wofs_ls/x.tif' }, mask: { href: href('MASK') } }))).toThrow(FeedFormatError);
		expect(() => s1Item(item({ vv: { href: 'https://evil.example/s1_rtc/x_VV.tif' }, mask: { href: href('MASK') } }))).toThrow(FeedFormatError);
		expect(() => s1Item(item({ vv: { href: 's3://deafrica-sentinel-1/s1_rtc/../x_VV.tif' }, mask: { href: href('MASK') } }))).toThrow(FeedFormatError);
		expect(() => s1Item(item({ vv: { href: 's3://deafrica-sentinel-1/other/x_VV.tif' }, mask: { href: href('MASK') } }))).toThrow(FeedFormatError);
	});
});

describe('viewS1Scene', () => {
	// A 0.004° square scene round a small square outline, VV all water, on the 0.0002° grid.
	const N = 20;
	const grid = { originX: 22.3, originY: -32.1, pixelSize: 0.0002 };
	const vvBytes = writeCog({ width: N, height: N, values: new Float32Array(N * N).fill(water), epsg: 4326, ...grid, tile: 16, nodata: 'nan' });
	const maskBytes = (g = grid) => writeCog({ width: N, height: N, values: new Uint8Array(N * N).fill(1), epsg: 4326, ...g, tile: 16, nodata: '0' });
	const outline = {
		featureId: '00000000-0000-4000-8000-0000000000b1',
		geometry: { type: 'Polygon' as const, coordinates: [[[22.3006, -32.1006], [22.3014, -32.1006], [22.3014, -32.1014], [22.3006, -32.1014], [22.3006, -32.1006]] as [number, number][]] },
		since: '1984-01-01'
	};
	const scene = { itemId: 'x', date: '2026-07-01', datetime: '2026-07-01T17:33:11.000Z', url: `${S1_S3_BASE}/s1_rtc/t/VV.tif`, maskUrl: `${S1_S3_BASE}/s1_rtc/t/MASK.tif` };
	const http = (mask: Uint8Array): FeedHttp => ({
		range: async (url, s, e) => (url === scene.url ? vvBytes : url === scene.maskUrl ? mask : null)?.subarray(s, e + 1) ?? null,
		text: async () => null
	});

	it('sums the outline’s wet pixels at the geographic cell’s ground area', async () => {
		const v = (await viewS1Scene(http(maskBytes()), scene, outline, new Map()))!;
		const m = outlineMask(outline.geometry, { epsg: 4326, originX: grid.originX, originY: grid.originY, pixelSizeX: grid.pixelSize, pixelSizeY: grid.pixelSize });
		expect(m.inside).toBe(16);
		// A 0.0002° cell at 32.1° S: about 18.8 m east–west × 22.2 m north–south, ~419 m².
		expect(m.pixelAreaM2).toBeGreaterThan(410);
		expect(m.pixelAreaM2).toBeLessThan(425);
		expect(v).toMatchObject({ pctObserved: 100, clearPx: 16, coveredPx: 16, wetAreaM2: Math.round(16 * m.pixelAreaM2 * 100) / 100 });
	});

	it('refuses a scene whose mask is not on its VV grid', async () => {
		await expect(viewS1Scene(http(maskBytes({ ...grid, originX: 22.3002 })), scene, outline, new Map())).rejects.toThrow(/not on its VV grid/);
	});
});
