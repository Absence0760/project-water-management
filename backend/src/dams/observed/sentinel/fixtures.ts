// FEED_SOURCE=fixtures: DE Africa's STAC search for s2_l2a_c1 and its
// Sentinel-2 bands answered from a synthetic description
// (backend/fixtures/feeds/s2-sample.json), never the network, so the
// Sentinel-2 pass runs in dev, CI and e2e offline. The feeds' fixture client
// (feeds/fixtures.ts) hands these URLs here.
//
// The invented world is the WOfS fixture's (wofs/fixtures.ts), seen at 10 m:
// every UTM zone is cut into overlapping square tiles (as MGRS tiles
// overlap), written in the zone's SOUTH code (EPSG 327zz) as DE Africa's
// Collection 1 is (checked 2026-10-29); the water field and its season are
// WOfS's, at the same ground point, so the two sources agree on a clear day
// up to their pixel sizes. One pass every revisitDays. Per pixel:
//   B03, B08 (10 m) and B11 (20 m): the spec's water or land reflectance, as
//     DN with Collection 1's +1000 (the item's offset is −1000);
//   SCL (20 m): 6 (water) or 4 (vegetation), except every cloud.everyNth day,
//     when a band of cloud (9) bandM wide crosses every 2 × bandM eastward,
//     with a strip of cloud shadow (3) shadowM wide on its east side, and
//     every overcastEveryNth day, all cloud;
// and every noSwirEveryNth day the item lists no swir16 (B11) asset, so the
// pass falls back to NDWI from B08. Scenes are real tiled DEFLATE GeoTIFFs
// (raster/cogWrite.ts), so the fixture exercises the production reader. No
// real scene, place or value.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { writeCog } from '../../../raster/cogWrite.js';
import { toUtm, utmEpsgFor } from '../../../raster/utm.js';
import { level, loadWofsFixture, type WofsFixtureSpec } from '../wofs/fixtures.js';
import { S2_C1_COLLECTION, S2_C1_S3_BASE, WOFS_STAC_SEARCH } from '../wofs/stac.js';

const FIXTURE = fileURLToPath(new URL('../../../../fixtures/feeds/s2-sample.json', import.meta.url));

type Reflectance = { green: number; nir: number; swir: number };
export interface S2FixtureSpec {
	item: Record<string, unknown> & { properties: Record<string, unknown>; assets: Record<string, Record<string, unknown>> };
	scenes: { sizePx: number; stepPx: number; tilePx: number; pixelM: number };
	schedule: { historyDays: number; lagDays: number; revisitDays: number; pathOffsetsDays: number[]; pathMinutes: number[] };
	reflectance: { water: Reflectance; land: Reflectance };
	cloud: { everyNth: number; bandM: number; shadowM: number; overcastEveryNth: number };
	noSwirEveryNth: number;
}

export const loadS2Fixture = (): S2FixtureSpec => JSON.parse(readFileSync(FIXTURE, 'utf8')) as S2FixtureSpec;

/** SCL classes the fixture writes. */
export const SCL = { vegetation: 4, water: 6, shadow: 3, cloud: 9 } as const;
/** The bands a scene serves; the spec's reflectances are already DN (Collection 1's r × 10 000 + 1000). */
type BandName = 'B03' | 'B08' | 'B11' | 'SCL';
const SCENE_PATH = /^\/sentinel-2-c1-l2a\/fixture\/(327\d\d)\/(-?\d+)\/(-?\d+)\/(\d{4})\/(\d{2})\/(\d{2})\/(B03|B08|B11|SCL)\.tif$/;
const FALSE_NORTHING = 10_000_000;

function uuidOf(text: string): string {
	const h = createHash('sha256').update(text).digest('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The SCL class at (x, y) on `day`, from the cloud schedule; `wet` is the ground's. */
export function s2FixtureScl(spec: S2FixtureSpec, day: number, x: number, wet: boolean): number {
	const { everyNth, bandM, shadowM, overcastEveryNth } = spec.cloud;
	if (day % overcastEveryNth === 0) return SCL.cloud;
	if (day % everyNth === 0) {
		const at = ((x % (2 * bandM)) + 2 * bandM) % (2 * bandM);
		if (at < bandM) return SCL.cloud;
		if (at < bandM + shadowM) return SCL.shadow;
	}
	return wet ? SCL.water : SCL.vegetation;
}

/** Whether the item of `day` lists B11. */
export const s2FixtureHasSwir = (spec: S2FixtureSpec, day: number) => day % spec.noSwirEveryNth !== 0;

export function s2Fixture(today: () => string, spec: S2FixtureSpec = loadS2Fixture(), water: Pick<WofsFixtureSpec, 'water'> = loadWofsFixture()) {
	const { sizePx, stepPx, tilePx, pixelM } = spec.scenes;
	const S = stepPx * pixelM;
	const SIZE = sizePx * pixelM;
	const cache = new Map<string, Uint8Array>();

	const blocks = (minX: number, minY: number, maxX: number, maxY: number) => {
		const out: [number, number][] = [];
		for (let bx = Math.floor((minX - SIZE) / S) + 1; bx <= Math.floor(maxX / S); bx++) {
			for (let by = Math.floor((minY - SIZE) / S) + 1; by <= Math.floor(maxY / S); by++) out.push([bx, by]);
		}
		return out;
	};
	const key = (epsg: number, bx: number, by: number, date: string, band: BandName) => `sentinel-2-c1-l2a/fixture/${epsg}/${bx}/${by}/${date.replaceAll('-', '/')}/${band}.tif`;
	const passDays = (from: number, to: number) => {
		const out: number[] = [];
		const { revisitDays, pathOffsetsDays } = spec.schedule;
		for (let d = from; d <= to; d++) if (pathOffsetsDays.some((off) => (((d - off) % revisitDays) + revisitDays) % revisitDays === 0)) out.push(d);
		return out;
	};
	const served = (day: number) => {
		const t = toEpochDay(today());
		return day <= t - spec.schedule.lagDays && day >= t - spec.schedule.historyDays;
	};

	return {
		/** The search page for an s2_l2a_c1 STAC search URL, or null for any other URL. */
		search(url: string): string | null {
			if (!url.startsWith(`${WOFS_STAC_SEARCH}?`)) return null;
			const q = new URL(url).searchParams;
			const bbox = (q.get('bbox') ?? '').split(',').map(Number);
			const [from, to] = (q.get('datetime') ?? '').split('/').map((s) => s.slice(0, 10));
			if (q.get('collections') !== S2_C1_COLLECTION || bbox.length !== 4 || !bbox.every(Number.isFinite) || !from || !to) return null;
			const limit = Math.min(1000, Math.max(1, Number(q.get('limit') ?? 10)));
			const offset = Math.max(0, Number(q.get('_o') ?? 0));
			const [w, s, e, n] = bbox as [number, number, number, number];
			const north = utmEpsgFor((w + e) / 2, (s + n) / 2) % 100;
			const epsg = 32700 + north;
			const corners = [toUtm(w, s, epsg), toUtm(w, n, epsg), toUtm(e, s, epsg), toUtm(e, n, epsg)];
			const bs = blocks(Math.min(...corners.map((c) => c.x)), Math.min(...corners.map((c) => c.y)), Math.max(...corners.map((c) => c.x)), Math.max(...corners.map((c) => c.y)));
			const t = toEpochDay(today());
			const first = Math.max(toEpochDay(from), t - spec.schedule.historyDays);
			const last = Math.min(toEpochDay(to), t - spec.schedule.lagDays);
			const minutes = spec.schedule.pathMinutes[0] ?? 520;
			const all = passDays(first, last).flatMap((day) =>
				bs.map(([bx, by]) => {
					const date = fromEpochDay(day);
					const datetime = `${date}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00.000000Z`;
					const asset = (name: string, band: BandName) => ({ ...spec.item.assets[name], href: `s3://deafrica-sentinel-2-l2a-c1/${key(epsg, bx, by, date, band)}` });
					const assets: Record<string, unknown> = { green: asset('green', 'B03'), nir: asset('nir', 'B08'), scl: asset('scl', 'SCL') };
					if (s2FixtureHasSwir(spec, day)) assets.swir16 = asset('swir16', 'B11');
					return { ...spec.item, id: uuidOf(`s2/${epsg}/${bx}/${by}/${date}`), properties: { ...spec.item.properties, datetime, 'proj:epsg': epsg }, assets };
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

		/** One band of a scene at an S3 URL, or null (a 404) for any other URL, a day not served, or B11 on a day without it. */
		scene(url: string): Uint8Array | null {
			if (!url.startsWith(`${S2_C1_S3_BASE}/`)) return null;
			const m = SCENE_PATH.exec(url.slice(S2_C1_S3_BASE.length));
			if (!m) return null;
			const epsg = Number(m[1]);
			const bx = Number(m[2]);
			const by = Number(m[3]);
			const day = toEpochDay(`${m[4]}-${m[5]}-${m[6]}`);
			const band = m[7] as BandName;
			if (!served(day) || (band === 'B11' && !s2FixtureHasSwir(spec, day))) return null;
			let bytes = cache.get(url);
			if (!bytes) {
				const coarse = band === 'B11' || band === 'SCL';
				const px = coarse ? pixelM * 2 : pixelM;
				const n = coarse ? sizePx / 2 : sizePx;
				const originX = bx * S;
				const originY = by * S + SIZE;
				const lvl = level(water, day);
				const values = band === 'SCL' ? new Uint8Array(n * n) : new Uint16Array(n * n);
				const field = band === 'B03' ? 'green' : band === 'B08' ? 'nir' : 'swir';
				// fixtureWet's field is a sine of x plus a cosine of y: each worked out once a column and once a row,
				// in fixtureWet's own expression, so the scene is the same to the bit (a per-pixel call was most of a run's time).
				const [l1, l2] = water.water.wavelengthM;
				const sinX = Float64Array.from({ length: n }, (_, c) => Math.sin((2 * Math.PI * (originX + (c + 0.5) * px)) / l1));
				for (let r = 0; r < n; r++) {
					const y = originY - (r + 0.5) * px;
					// WOfS's field reads the NORTH code's northing.
					const cosY = Math.cos((2 * Math.PI * (y - FALSE_NORTHING)) / l2);
					for (let c = 0; c < n; c++) {
						const x = originX + (c + 0.5) * px;
						const wet = 0.5 + 0.25 * sinX[c]! + 0.25 * cosY < lvl;
						values[r * n + c] = band === 'SCL' ? s2FixtureScl(spec, day, x, wet) : spec.reflectance[wet ? 'water' : 'land'][field];
					}
				}
				bytes = writeCog({ width: n, height: n, values, epsg, originX, originY, pixelSize: px, tile: coarse ? tilePx / 2 : tilePx, nodata: '0' });
				if (cache.size >= 64) cache.clear();
				cache.set(url, bytes);
			}
			return bytes;
		}
	};
}
