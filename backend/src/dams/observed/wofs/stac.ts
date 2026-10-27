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
// GeoKeys (cog.ts), not from the item.
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

/** The asset object key: under wofs_ls/, a .tif, plain path characters, no `..`. */
const ASSET_KEY = /^wofs_ls\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.tif$/;
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

export interface WofsScene {
	/** The STAC item id (dam_observation.upstream_key). */
	itemId: string;
	/** The acquisition date (UTC), ISO. */
	date: string;
	/** The acquisition time, ISO, for ordering. */
	datetime: string;
	/** The water layer's HTTPS URL. */
	url: string;
}

/** The HTTPS URL of an `s3://deafrica-services/wofs_ls/…` asset; null for any other href. */
export function assetUrl(href: string): string | null {
	const m = /^s3:\/\/deafrica-services\/(.+)$/.exec(href);
	const key = m?.[1] ?? (href.startsWith(`${WOFS_S3_BASE}/`) ? href.slice(WOFS_S3_BASE.length + 1) : null);
	if (!key || !ASSET_KEY.test(key) || key.split('/').some((p) => p === '..' || p === '.')) return null;
	return `${WOFS_S3_BASE}/${key}`;
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

/** The search URL for one window's first page, over the outline's box snapped out (snapSearchBox). */
export function searchUrl(bbox: readonly [number, number, number, number], from: string, to: string, limit = PAGE_LIMIT): string {
	const u = new URL(WOFS_STAC_SEARCH);
	u.searchParams.set('collections', WOFS_COLLECTION);
	u.searchParams.set('bbox', snapSearchBox(bbox).join(','));
	u.searchParams.set('datetime', `${from}T00:00:00Z/${to}T23:59:59Z`);
	u.searchParams.set('limit', String(limit));
	return u.href;
}

/** Parses one page: its scenes and the next page's URL (checked to be the same search), or null. */
export function parsePage(text: string): { scenes: WofsScene[]; next: string | null } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new FeedFormatError('the STAC search did not answer JSON');
	}
	const page = Page.safeParse(raw);
	if (!page.success) throw new FeedFormatError('the STAC search did not answer a feature collection');
	const scenes: WofsScene[] = [];
	for (const f of page.data.features) {
		const item = Item.safeParse(f);
		if (!item.success) throw new FeedFormatError('a STAC item is not in the expected shape');
		const url = assetUrl(item.data.assets.water.href);
		if (!url) throw new FeedFormatError('a STAC item’s water asset is not in the WOfS bucket');
		const datetime = new Date(item.data.properties.datetime).toISOString();
		scenes.push({ itemId: item.data.id, date: datetime.slice(0, 10), datetime, url });
	}
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
export async function searchScenes(http: FeedHttp, bbox: readonly [number, number, number, number], from: string, to: string): Promise<WofsScene[]> {
	const seen = new Map<string, WofsScene>();
	let url: string | null = searchUrl(bbox, from, to);
	for (let page = 0; url !== null; page++) {
		if (page === MAX_PAGES) throw new FeedFormatError(`the STAC search ran past ${MAX_PAGES} pages`);
		const text = await http.text(url);
		if (text === null) throw new FeedFormatError('the STAC search answered not found');
		const got = parsePage(text);
		for (const s of got.scenes) seen.set(s.itemId, s);
		// An empty page ends it, whatever its links say.
		url = got.scenes.length ? got.next : null;
	}
	return [...seen.values()].sort((a, b) => (a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : a.itemId < b.itemId ? -1 : 1));
}
