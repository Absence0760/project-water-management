// FEED_SOURCE=fixtures: DE Africa's STAC search and WOfS scenes answered from
// a synthetic description (backend/fixtures/feeds/wofs-sample.json), never
// the network, so the WOfS pass runs in dev, CI and e2e offline. The feeds'
// fixture client (feeds/fixtures.ts) hands these URLs here.
//
// The invented world: every UTM zone is cut into square scenes (sizePx
// pixels of pixelM metres, a new one every stepPx, so neighbours overlap and
// a dam near an edge is on two scenes the same day, as on two Landsat rows).
// Scenes are written in the zone's NORTH code (EPSG 326zz) even south of
// the equator, as DE Africa writes them. Two "paths" each pass every
// revisitDays, offset by pathOffsetsDays, from historyDays before today up to
// lagDays before it. A pixel is wet where a smooth invented field is below a
// seasonal level, so a dam's wet area rises and falls through the year;
// every everyNth day a band of cloud crosses the scenes and every
// overcastEveryNth day they're all cloud, so partly and wholly unobserved
// days occur. Scenes are real tiled DEFLATE GeoTIFFs (raster/cogWrite.ts), so the
// fixture exercises the production reader. No real scene, place or value.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { writeCog } from '../../../raster/cogWrite.js';
import { WOFS_S3_BASE, WOFS_STAC_SEARCH } from './stac.js';
import { toUtm, utmEpsgFor } from '../../../raster/utm.js';
import { WOFS_DRY, WOFS_WET } from './sum.js';

const FIXTURE = fileURLToPath(new URL('../../../../fixtures/feeds/wofs-sample.json', import.meta.url));

export interface WofsFixtureSpec {
	item: Record<string, unknown> & { properties: Record<string, unknown>; assets: { water: Record<string, unknown> } };
	scenes: { sizePx: number; stepPx: number; tilePx: number; pixelM: number };
	schedule: { historyDays: number; lagDays: number; revisitDays: number; pathOffsetsDays: number[]; pathMinutes: number[] };
	water: { wavelengthM: [number, number]; seasonal: { mean: number; amplitude: number; peakDayOfYear: number } };
	cloud: { everyNth: number; bandM: number; overcastEveryNth: number };
}

export const loadWofsFixture = (): WofsFixtureSpec => JSON.parse(readFileSync(FIXTURE, 'utf8')) as WofsFixtureSpec;

const CLOUD = 64;
const SCENE_PATH = /^\/wofs_ls\/1-0-0\/fixture\/(326\d\d)\/(-?\d+)\/(-?\d+)\/(\d)\/(\d{4})\/(\d{2})\/(\d{2})\/wofs_ls_fixture_water\.tif$/;

/** A UUID-shaped id from text (the explorer's ids are UUIDs). */
function uuidOf(text: string): string {
	const h = createHash('sha256').update(text).digest('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The days a path passes, between two epoch days inclusive. */
function passDays(spec: WofsFixtureSpec, from: number, to: number): { day: number; path: number }[] {
	const out: { day: number; path: number }[] = [];
	const { revisitDays, pathOffsetsDays } = spec.schedule;
	for (let d = from; d <= to; d++) {
		pathOffsetsDays.forEach((off, path) => {
			if ((((d - off) % revisitDays) + revisitDays) % revisitDays === 0) out.push({ day: d, path });
		});
	}
	return out;
}

/** The water level on a day: the field's threshold, seasonal (the Sentinel-2 fixture's too, sentinel/fixtures.ts). */
export function level(spec: Pick<WofsFixtureSpec, 'water'>, day: number): number {
	const { mean, amplitude, peakDayOfYear } = spec.water.seasonal;
	const iso = fromEpochDay(day);
	const doy = day - toEpochDay(`${iso.slice(0, 4)}-01-01`);
	return mean + amplitude * Math.cos((2 * Math.PI * (doy - peakDayOfYear)) / 365.25);
}

/** The fixture's value of the pixel centred at (x, y) on `day`; `lvl` is level(spec, day), passed in so a scene works it out once. */
export function wofsFixtureValue(spec: WofsFixtureSpec, day: number, x: number, y: number, lvl = level(spec, day)): number {
	const { everyNth, bandM, overcastEveryNth } = spec.cloud;
	if (day % overcastEveryNth === 0) return CLOUD;
	if (day % everyNth === 0 && ((x % (2 * bandM)) + 2 * bandM) % (2 * bandM) < bandM) return CLOUD;
	return fixtureWet(spec, x, y, lvl) ? WOFS_WET : WOFS_DRY;
}

/** Whether the invented water field is wet at (x, y) (UTM metres, the zone's NORTH code's northing) at level `lvl`. */
export function fixtureWet(spec: Pick<WofsFixtureSpec, 'water'>, x: number, y: number, lvl: number): boolean {
	const [l1, l2] = spec.water.wavelengthM;
	return 0.5 + 0.25 * Math.sin((2 * Math.PI * x) / l1) + 0.25 * Math.cos((2 * Math.PI * y) / l2) < lvl;
}

export function wofsFixture(today: () => string, spec: WofsFixtureSpec = loadWofsFixture()) {
	const { sizePx, stepPx, tilePx, pixelM } = spec.scenes;
	const S = stepPx * pixelM;
	const SIZE = sizePx * pixelM;
	const cache = new Map<string, Uint8Array>();

	/** The scenes' blocks (bx, by) a box in metres meets. */
	const blocks = (minX: number, minY: number, maxX: number, maxY: number) => {
		const out: [number, number][] = [];
		for (let bx = Math.floor((minX - SIZE) / S) + 1; bx <= Math.floor(maxX / S); bx++) {
			for (let by = Math.floor((minY - SIZE) / S) + 1; by <= Math.floor(maxY / S); by++) out.push([bx, by]);
		}
		return out;
	};

	const sceneUrl = (epsg: number, bx: number, by: number, path: number, date: string) =>
		`${WOFS_S3_BASE}/wofs_ls/1-0-0/fixture/${epsg}/${bx}/${by}/${path}/${date.replaceAll('-', '/')}/wofs_ls_fixture_water.tif`;

	return {
		/** The search page for a STAC search URL, or null for any other URL. */
		search(url: string): string | null {
			if (!url.startsWith(`${WOFS_STAC_SEARCH}?`)) return null;
			const q = new URL(url).searchParams;
			const bbox = (q.get('bbox') ?? '').split(',').map(Number);
			const [from, to] = (q.get('datetime') ?? '').split('/').map((s) => s.slice(0, 10));
			if (q.get('collections') !== 'wofs_ls' || bbox.length !== 4 || !bbox.every(Number.isFinite) || !from || !to) return null;
			const limit = Math.min(1000, Math.max(1, Number(q.get('limit') ?? 10)));
			const offset = Math.max(0, Number(q.get('_o') ?? 0));
			const [w, s, e, n] = bbox as [number, number, number, number];
			const epsg = 32600 + (utmEpsgFor((w + e) / 2, (s + n) / 2) % 100);
			const corners = [toUtm(w, s, epsg), toUtm(w, n, epsg), toUtm(e, s, epsg), toUtm(e, n, epsg)];
			const bs = blocks(Math.min(...corners.map((c) => c.x)), Math.min(...corners.map((c) => c.y)), Math.max(...corners.map((c) => c.x)), Math.max(...corners.map((c) => c.y)));
			const t = toEpochDay(today());
			const first = Math.max(toEpochDay(from), t - spec.schedule.historyDays);
			const last = Math.min(toEpochDay(to), t - spec.schedule.lagDays);
			const all = passDays(spec, first, last).flatMap(({ day, path }) =>
				bs.map(([bx, by]) => {
					const date = fromEpochDay(day);
					const minutes = spec.schedule.pathMinutes[path] ?? 510;
					const datetime = `${date}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00.000000Z`;
					return {
						...spec.item,
						id: uuidOf(`${epsg}/${bx}/${by}/${path}/${date}`),
						properties: { ...spec.item.properties, datetime, 'proj:epsg': epsg },
						assets: { water: { ...spec.item.assets.water, href: sceneUrl(epsg, bx, by, path, date).replace(`${WOFS_S3_BASE}/`, 's3://deafrica-services/') } }
					};
				})
			);
			const features = all.slice(offset, offset + limit);
			const links: { rel: string; href: string; method?: string }[] = [{ rel: 'search', href: WOFS_STAC_SEARCH, method: 'GET' }];
			if (offset + limit < all.length) {
				const next = new URL(url);
				next.searchParams.set('_o', String(offset + limit));
				links.unshift({ rel: 'next', href: next.href, method: 'GET' });
			}
			return JSON.stringify({ type: 'FeatureCollection', features, links, numberReturned: features.length, numberMatched: all.length });
		},

		/** The scene at an S3 URL, or null (a 404) for any other URL or a day not served. */
		scene(url: string): Uint8Array | null {
			if (!url.startsWith(`${WOFS_S3_BASE}/`)) return null;
			const m = SCENE_PATH.exec(url.slice(WOFS_S3_BASE.length));
			if (!m) return null;
			const epsg = Number(m[1]);
			const bx = Number(m[2]);
			const by = Number(m[3]);
			const day = toEpochDay(`${m[5]}-${m[6]}-${m[7]}`);
			const t = toEpochDay(today());
			if (day > t - spec.schedule.lagDays || day < t - spec.schedule.historyDays) return null;
			let bytes = cache.get(url);
			if (!bytes) {
				const originX = bx * S;
				const originY = by * S + SIZE;
				const values = new Uint8Array(sizePx * sizePx);
				const lvl = level(spec, day);
				for (let r = 0; r < sizePx; r++) {
					const y = originY - (r + 0.5) * pixelM;
					for (let c = 0; c < sizePx; c++) values[r * sizePx + c] = wofsFixtureValue(spec, day, originX + (c + 0.5) * pixelM, y, lvl);
				}
				bytes = writeCog({ width: sizePx, height: sizePx, values, epsg, originX, originY, pixelSize: pixelM, tile: tilePx });
				if (cache.size >= 32) cache.clear();
				cache.set(url, bytes);
			}
			return bytes;
		}
	};
}
