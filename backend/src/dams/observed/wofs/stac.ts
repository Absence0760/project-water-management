// The WOfS scenes over a dam, from Digital Earth Africa's STAC search
// (issue #604 R5-C; docs/architecture.md § Dam observations → WOfS).
//
// One search per window: collection `wofs_ls` (Landsat 5, 7, 8 and 9 WOfS
// feature layers, one item per Landsat path/row scene), the outline's
// lon/lat box snapped outward to a 0.05° grid (snapSearchBox: DE Africa never
// sees a dam's exact box), the window's dates, 100 items a page. The explorer pages with
// a `next` link (an `_o` offset, checked 2026-10-27); the link is followed
// only to the same search endpoint, up to MAX_PAGES. `/stac/collections/
// wofs_ls` itself answered HTTP 500 that day; `/stac/search` is the one we
// read.
//
// Each item is checked: its id (a UUID upstream; printable, bounded), its
// acquisition time, and its `water` asset, an `s3://deafrica-services/
// wofs_ls/…tif` object read over HTTPS from the bucket's public endpoint
// (WOFS_S3_BASE). Anything else is refused as a FeedFormatError: we never follow
// an href to another host. The item's CRS is taken from the scene's own
// GeoKeys (raster/cog.ts), not from the item.
//
// assetUrl also knows the two Sentinel collections' buckets (issue #624;
// docs/data-sources.md, deafrica-sentinel-2-c1 and deafrica-sentinel-1):
// `s2_l2a_c1` objects under `sentinel-2-c1-l2a/` in deafrica-sentinel-2-l2a-c1,
// `s1_rtc` objects under `s1_rtc/` in deafrica-sentinel-1 (both checked on
// DE Africa's spec pages 2026-10-29). Each collection's hrefs are read only
// against its own bucket and key prefix: a WOfS item can't point at a
// Sentinel object, nor a Sentinel item at another key of its bucket.
// searchItems runs the same search for any of them, each item through the
// collection's own parser (wofsItem here; sentinel/s2.ts s2Item for
// `s2_l2a_c1`), on the same endpoint and paging rules.
import { z } from 'zod';
import { FeedFormatError } from '../../../feeds/errors.js';
import type { FeedHttp } from '../../../feeds/http.js';
import { DEAFRICA_SERVICES_BASE } from '../upstream.js';

/** DE Africa's STAC search endpoint (the explorer). */
export const WOFS_STAC_SEARCH = 'https://explorer.digitalearth.africa/stac/search';
/** The public HTTPS endpoint of the bucket the scenes are in (no trailing slash). */
export const WOFS_S3_BASE = DEAFRICA_SERVICES_BASE.replace(/\/+$/, '');
export const WOFS_COLLECTION = 'wofs_ls';
/** Items per page: a page is ~4 KB an item, so 100 is ~400 KB, inside the live client's 4 MiB cap. */
export const PAGE_LIMIT = 100;
/** Pages followed per search at most: a year over one dam is ~50–200 items. */
export const MAX_PAGES = 20;

/** The Sentinel-2 L2A Collection 1 collection and the public HTTPS endpoint of its bucket (af-south-1, anonymous). */
export const S2_C1_COLLECTION = 's2_l2a_c1';
export const S2_C1_S3_BASE = 'https://deafrica-sentinel-2-l2a-c1.s3.af-south-1.amazonaws.com';
/** The Sentinel-1 RTC collection and the public HTTPS endpoint of its bucket (af-south-1, anonymous). */
export const S1_RTC_COLLECTION = 's1_rtc';
export const S1_S3_BASE = 'https://deafrica-sentinel-1.s3.af-south-1.amazonaws.com';

/** A collection whose asset hrefs assetUrl reads. */
export type AssetCollection = typeof WOFS_COLLECTION | typeof S2_C1_COLLECTION | typeof S1_RTC_COLLECTION;

/** A .tif key under `prefix/`: plain path characters (the `..` and `.` parts refused apart). */
const keyUnder = (prefix: string) => new RegExp(`^${prefix}\\/(?:[A-Za-z0-9_.-]+\\/)*[A-Za-z0-9_.-]+\\.tif$`);

/** Per collection: its bucket (the s3:// name), the bucket's HTTPS endpoint, and the keys an item may name. */
const ASSET_BUCKETS: Readonly<Record<AssetCollection, { bucket: string; base: string; key: RegExp }>> = {
	[WOFS_COLLECTION]: { bucket: 'deafrica-services', base: WOFS_S3_BASE, key: keyUnder('wofs_ls') },
	[S2_C1_COLLECTION]: { bucket: 'deafrica-sentinel-2-l2a-c1', base: S2_C1_S3_BASE, key: keyUnder('sentinel-2-c1-l2a') },
	[S1_RTC_COLLECTION]: { bucket: 'deafrica-sentinel-1', base: S1_S3_BASE, key: keyUnder('s1_rtc') }
};
const Printable = z.string().min(1).max(200).regex(/^[!-~]+$/);

const Item = z.object({
	id: Printable,
	collection: z.literal(WOFS_COLLECTION).optional(),
	properties: z.object({ datetime: z.string().datetime({ offset: true }) }).passthrough(),
	assets: z.object({ water: z.object({ href: z.string().max(1000) }).passthrough() }).passthrough()
});
const Page = z.object({
	type: z.literal('FeatureCollection'),
	features: z.array(z.unknown()).max(1000),
	links: z.array(z.object({ rel: z.string(), href: z.string().max(4000) }).passthrough()).optional()
});

export interface WofsScene extends SceneItem {
	/** The STAC item id (dam_observation.upstream_key). */
	itemId: string;
	/** The acquisition date (UTC), ISO. */
	date: string;
	/** The acquisition time, ISO, for ordering. */
	datetime: string;
	/** The water layer's HTTPS URL. */
	url: string;
}

/**
 * The HTTPS URL of a collection's asset, given as `s3://<its bucket>/<key>` or its bucket's HTTPS endpoint: for
 * `wofs_ls` (the default) a `wofs_ls/…tif` key in deafrica-services, for `s2_l2a_c1` a `sentinel-2-c1-l2a/…tif` key
 * in deafrica-sentinel-2-l2a-c1, for `s1_rtc` an `s1_rtc/…tif` key in deafrica-sentinel-1. Null for any other href.
 */
export function assetUrl(href: string, collection: AssetCollection = WOFS_COLLECTION): string | null {
	const at = ASSET_BUCKETS[collection];
	if (!at) return null;
	const s3 = `s3://${at.bucket}/`;
	const key = href.startsWith(s3) ? href.slice(s3.length) : href.startsWith(`${at.base}/`) ? href.slice(at.base.length + 1) : null;
	if (!key || !at.key.test(key) || key.split('/').some((p) => p === '..' || p === '.')) return null;
	return `${at.base}/${key}`;
}

/** The grid the search's box is snapped out to, degrees (~5.5 km): SEARCH_GRID_DEG = 1 / SEARCH_GRID_PER_DEG. */
export const SEARCH_GRID_PER_DEG = 20;
export const SEARCH_GRID_DEG = 1 / SEARCH_GRID_PER_DEG;

/**
 * The box sent to DE Africa: the outline's box snapped outward to the 0.05° grid, so the search never carries a
 * dam's exact position (docs/security.md, the dam observations' handover). It changes no row: the sum (sum.ts) runs
 * over the exact outline, here, so a scene over the snapped box that misses the outline (rare, a Landsat scene is
 * ~185 km across) has no pixel inside it and costs only its header read (pass.ts). Rounded to 1e-6 of a cell
 * first, so a box already on the grid stays put.
 */
export function snapSearchBox([w, s, e, n]: readonly [number, number, number, number]): [number, number, number, number] {
	const cells = (v: number) => Math.round(v * SEARCH_GRID_PER_DEG * 1e6) / 1e6;
	const out = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v.toFixed(2))));
	return [
		out(Math.floor(cells(w)) / SEARCH_GRID_PER_DEG, -180, 180),
		out(Math.floor(cells(s)) / SEARCH_GRID_PER_DEG, -90, 90),
		out(Math.ceil(cells(e)) / SEARCH_GRID_PER_DEG, -180, 180),
		out(Math.ceil(cells(n)) / SEARCH_GRID_PER_DEG, -90, 90)
	];
}

/** The search URL for one window's first page, over the outline's box snapped out (snapSearchBox), in `collection` (default wofs_ls). */
export function searchUrl(bbox: readonly [number, number, number, number], from: string, to: string, limit = PAGE_LIMIT, collection: AssetCollection = WOFS_COLLECTION): string {
	const u = new URL(WOFS_STAC_SEARCH);
	u.searchParams.set('collections', collection);
	u.searchParams.set('bbox', snapSearchBox(bbox).join(','));
	u.searchParams.set('datetime', `${from}T00:00:00Z/${to}T23:59:59Z`);
	u.searchParams.set('limit', String(limit));
	return u.href;
}

/** One search item as a scene: the item's id, acquisition date and time, and what the collection's reader needs. */
export type ItemParser<S extends SceneItem> = (raw: unknown) => S;
/** What every collection's scene carries (the pass's bookkeeping): the STAC item id, the date and time, and the URL its ETag is kept for. */
export interface SceneItem {
	itemId: string;
	date: string;
	datetime: string;
	url: string;
}

/** A wofs_ls item as a scene (FeedFormatError for any other shape, or a water asset outside the WOfS bucket). */
export function wofsItem(raw: unknown): WofsScene {
	const item = Item.safeParse(raw);
	if (!item.success) throw new FeedFormatError('a STAC item is not in the expected shape');
	const url = assetUrl(item.data.assets.water.href);
	if (!url) throw new FeedFormatError('a STAC item’s water asset is not in the WOfS bucket');
	const datetime = new Date(item.data.properties.datetime).toISOString();
	return { itemId: item.data.id, date: datetime.slice(0, 10), datetime, url };
}

/** Parses one page: its scenes (each item through `parseItem`, wofs_ls's by default) and the next page's URL (checked to be the same search), or null. */
export function parsePage(text: string): { scenes: WofsScene[]; next: string | null };
export function parsePage<S extends SceneItem>(text: string, parseItem: ItemParser<S>): { scenes: S[]; next: string | null };
export function parsePage<S extends SceneItem>(text: string, parseItem: ItemParser<S> = wofsItem as unknown as ItemParser<S>): { scenes: S[]; next: string | null } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new FeedFormatError('the STAC search did not answer JSON');
	}
	const page = Page.safeParse(raw);
	if (!page.success) throw new FeedFormatError('the STAC search did not answer a feature collection');
	const scenes = page.data.features.map((f) => parseItem(f));
	const nextHref = page.data.links?.find((l) => l.rel === 'next')?.href ?? null;
	let next: string | null = null;
	if (nextHref !== null) {
		const u = URL.parse(nextHref, WOFS_STAC_SEARCH);
		const base = new URL(WOFS_STAC_SEARCH);
		if (!u || u.origin !== base.origin || u.pathname !== base.pathname || u.username || u.password) {
			throw new FeedFormatError('the STAC search’s next page is not the same search');
		}
		next = u.href;
	}
	return { scenes, next };
}

/**
 * Every scene over `bbox` (lon/lat: west, south, east, north) from `from` to
 * `to` (ISO dates, inclusive), all pages, sorted by acquisition time then id,
 * each item once. Throws FeedFormatError for a page it can't read, and the
 * client's errors (FeedRefusedError for a 403, …) as they come.
 */
export function searchScenes(http: FeedHttp, bbox: readonly [number, number, number, number], from: string, to: string): Promise<WofsScene[]> {
	return searchItems(http, WOFS_COLLECTION, wofsItem, bbox, from, to);
}

/** searchScenes for any collection assetUrl knows: its items through `parseItem` (sentinel/s2.ts's for s2_l2a_c1). */
export async function searchItems<S extends SceneItem>(
	http: FeedHttp,
	collection: AssetCollection,
	parseItem: ItemParser<S>,
	bbox: readonly [number, number, number, number],
	from: string,
	to: string
): Promise<S[]> {
	const seen = new Map<string, S>();
	let url: string | null = searchUrl(bbox, from, to, PAGE_LIMIT, collection);
	for (let page = 0; url !== null; page++) {
		if (page === MAX_PAGES) throw new FeedFormatError(`the STAC search ran past ${MAX_PAGES} pages`);
		const text = await http.text(url);
		if (text === null) throw new FeedFormatError('the STAC search answered not found');
		const got = parsePage(text, parseItem);
		for (const s of got.scenes) seen.set(s.itemId, s);
		// An empty page ends it, whatever its links say.
		url = got.scenes.length ? got.next : null;
	}
	return [...seen.values()].sort((a, b) => (a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : a.itemId < b.itemId ? -1 : 1));
}
