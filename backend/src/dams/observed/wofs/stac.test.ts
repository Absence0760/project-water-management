import { describe, expect, it } from 'vitest';
import { FeedFormatError, FeedRefusedError } from '../../../feeds/errors.js';
import type { FeedHttp } from '../../../feeds/http.js';
import { assetUrl, MAX_PAGES, parsePage, S3_BASE, searchScenes, searchUrl, STAC_SEARCH } from './stac.js';

/** A synthetic item in the explorer's shape (invented ids and paths). */
const item = (id: string, datetime: string, href = `s3://deafrica-services/wofs_ls/1-0-0/900/001/${datetime.slice(0, 4)}/x/${id}_water.tif`) => ({
	type: 'Feature',
	stac_version: '1.1.0',
	id,
	collection: 'wofs_ls',
	properties: { datetime, 'proj:epsg': 32634, platform: 'landsat-8' },
	assets: { water: { href, type: 'image/tiff; application=geotiff; profile=cloud-optimized' } }
});
const page = (features: unknown[], next?: string) =>
	JSON.stringify({ type: 'FeatureCollection', features, links: next ? [{ rel: 'next', href: next, method: 'GET' }, { rel: 'search', href: STAC_SEARCH }] : [] });

/** A FeedHttp answering text() from a map of URL → body (or an error to throw). */
function http(pages: Record<string, string | Error>) {
	const asked: string[] = [];
	const h: FeedHttp = {
		range: async () => null,
		text: async (url) => {
			asked.push(url);
			const p = pages[url];
			if (p instanceof Error) throw p;
			return p ?? null;
		}
	};
	return { h, asked };
}

const BBOX = [19.0, -34.0, 19.1, -33.9] as const;

describe('searchUrl', () => {
	it('asks the explorer for wofs_ls over the box and the whole days', () => {
		const u = new URL(searchUrl(BBOX, '2025-01-01', '2025-12-31'));
		expect(u.origin + u.pathname).toBe(STAC_SEARCH);
		expect(Object.fromEntries(u.searchParams)).toEqual({ collections: 'wofs_ls', bbox: '19,-34,19.1,-33.9', datetime: '2025-01-01T00:00:00Z/2025-12-31T23:59:59Z', limit: '100' });
	});
});

describe('assetUrl', () => {
	it('reads the bucket’s s3:// and https:// forms, and nothing else', () => {
		expect(assetUrl('s3://deafrica-services/wofs_ls/1-0-0/174/084/2026/09/10/a_water.tif')).toBe(`${S3_BASE}/wofs_ls/1-0-0/174/084/2026/09/10/a_water.tif`);
		expect(assetUrl(`${S3_BASE}/wofs_ls/a/b.tif`)).toBe(`${S3_BASE}/wofs_ls/a/b.tif`);
		for (const bad of [
			's3://another-bucket/wofs_ls/a.tif',
			's3://deafrica-services/waterbodies/a.tif',
			's3://deafrica-services/wofs_ls/../secret.tif',
			's3://deafrica-services/wofs_ls/a/./b.tif',
			's3://deafrica-services/wofs_ls/a.jpg',
			'https://example.com/wofs_ls/a.tif',
			's3://deafrica-services/wofs_ls/a b.tif'
		]) {
			expect(assetUrl(bad), bad).toBeNull();
		}
	});
});

describe('parsePage', () => {
	it('reads the scenes, their UTC dates, and a same-search next link', () => {
		const next = `${STAC_SEARCH}?collections=wofs_ls&_o=100&_full=True`;
		const got = parsePage(page([item('a1', '2026-09-01T08:35:02.632846Z')], next));
		expect(got.scenes).toEqual([
			{ itemId: 'a1', date: '2026-09-01', datetime: '2026-09-01T08:35:02.632Z', url: `${S3_BASE}/wofs_ls/1-0-0/900/001/2026/x/a1_water.tif` }
		]);
		expect(got.next).toBe(next);
	});

	it('dates a scene by UTC', () => {
		expect(parsePage(page([item('a', '2026-09-01T23:30:00-02:00')])).scenes[0]!.date).toBe('2026-09-02');
	});

	it.each([
		['not JSON', 'oops', /did not answer JSON/],
		['not a collection', JSON.stringify({ type: 'Feature' }), /feature collection/],
		['an item without a water asset', page([{ ...item('a', '2026-01-01T00:00:00Z'), assets: {} }]), /expected shape/],
		['an item from another collection', page([{ ...item('a', '2026-01-01T00:00:00Z'), collection: 'ls8_sr' }]), /expected shape/],
		['an asset off the bucket', page([item('a', '2026-01-01T00:00:00Z', 'https://evil.example/wofs_ls/a.tif')]), /not in the WOfS bucket/],
		['a next link to another host', page([item('a', '2026-01-01T00:00:00Z')], 'https://evil.example/stac/search?_o=1'), /not the same search/],
		['a next link to another path', page([item('a', '2026-01-01T00:00:00Z')], 'https://explorer.digitalearth.africa/admin?_o=1'), /not the same search/]
	])('refuses %s', (_l, text, message) => {
		expect(() => parsePage(text)).toThrow(FeedFormatError);
		expect(() => parsePage(text)).toThrow(message);
	});
});

describe('searchScenes', () => {
	it('follows every page, and returns each item once in time order', async () => {
		const first = searchUrl(BBOX, '2026-01-01', '2026-12-31');
		const p2 = `${STAC_SEARCH}?_o=2`;
		const p3 = `${STAC_SEARCH}?_o=4`;
		const { h, asked } = http({
			[first]: page([item('c', '2026-03-01T08:00:00Z'), item('a', '2026-01-01T08:00:00Z')], p2),
			[p2]: page([item('b', '2026-01-01T08:00:00Z'), item('a', '2026-01-01T08:00:00Z')], p3),
			// The last page links on, to an empty page: the empty page ends it.
			[p3]: page([], `${STAC_SEARCH}?_o=6`)
		});
		const got = await searchScenes(h, BBOX, '2026-01-01', '2026-12-31');
		expect(got.map((s) => s.itemId)).toEqual(['a', 'b', 'c']);
		expect(asked).toEqual([first, p2, p3]);
	});

	it(`stops at ${MAX_PAGES} pages`, async () => {
		const pages: Record<string, string> = {};
		const first = searchUrl(BBOX, '2026-01-01', '2026-12-31');
		pages[first] = page([item('i0', '2026-01-01T00:00:00Z')], `${STAC_SEARCH}?_o=1`);
		for (let i = 1; i <= MAX_PAGES + 1; i++) pages[`${STAC_SEARCH}?_o=${i}`] = page([item(`i${i}`, '2026-01-01T00:00:00Z')], `${STAC_SEARCH}?_o=${i + 1}`);
		await expect(searchScenes(http(pages).h, BBOX, '2026-01-01', '2026-12-31')).rejects.toThrow(/past 20 pages/);
	});

	it('refuses a search that answers not found, and passes a 403 on', async () => {
		await expect(searchScenes(http({}).h, BBOX, '2026-01-01', '2026-12-31')).rejects.toThrow(/not found/);
		const first = searchUrl(BBOX, '2026-01-01', '2026-12-31');
		await expect(searchScenes(http({ [first]: new FeedRefusedError() }).h, BBOX, '2026-01-01', '2026-12-31')).rejects.toBeInstanceOf(FeedRefusedError);
	});
});
