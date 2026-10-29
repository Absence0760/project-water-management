// FEED_SOURCE=fixtures: DE Africa's STAC search for s1_rtc and its
// Sentinel-1 bands answered from a synthetic description
// (backend/fixtures/feeds/s1-sample.json), never the network, so the
// Sentinel-1 pass runs in dev, CI and e2e offline. The feeds' fixture client
// (feeds/fixtures.ts) hands these URLs here.
//
// The invented world is the WOfS fixture's (wofs/fixtures.ts) water field and
// season, seen on s1_rtc's 0.0002° geographic grid: each pixel centre is
// taken into its tile's UTM zone (the NORTH code's northing, as WOfS's field
// reads it) and wetted there, so radar, WOfS and Sentinel-2 agree on a calm
// day up to their pixel sizes. Tiles are sizePx square and don't overlap
// (s1_rtc's own are 1° squares; the fixture's are smaller so a scene is
// cheap to write). One pass every revisitDays per path (an ascending and a
// descending one). Per pixel:
//   VV (float32, linear gamma0, no-data NaN): backscatter.water on water,
//     backscatter.land on land, and on every wind.everyNth day
//     backscatter.windWater on water: wind-roughened, above −18 dB, so the
//     radar reads it dry (the case the S1/S2 agreement report exists for);
//   MASK (uint8): 1 valid, except 2 (shadow or layover) in a strip widthDeg
//     wide every periodDeg of longitude.
// Scenes are real tiled DEFLATE GeoTIFFs (raster/cogWrite.ts), so the
// fixture exercises the production reader. No real scene, place or value.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { S1_MASK_LAYOUT, S1_VV_LAYOUT } from '../../../raster/cogLayouts.js';
import { writeCog } from '../../../raster/cogWrite.js';
import { toUtm, utmEpsgFor } from '../../../raster/utm.js';
import { level, loadWofsFixture, type WofsFixtureSpec } from '../wofs/fixtures.js';
import { S1_RTC_COLLECTION, S1_S3_BASE, WOFS_STAC_SEARCH } from '../wofs/stac.js';

const FIXTURE = fileURLToPath(new URL('../../../../fixtures/feeds/s1-sample.json', import.meta.url));

export interface S1FixtureSpec {
	item: Record<string, unknown> & { properties: Record<string, unknown>; assets: Record<string, Record<string, unknown>> };
	scenes: { sizePx: number; tilePx: number; pixelDeg: number };
	schedule: { historyDays: number; lagDays: number; revisitDays: number; pathOffsetsDays: number[]; pathMinutes: number[] };
	backscatter: { water: number; land: number; windWater: number };
	wind: { everyNth: number };
	shadow: { periodDeg: number; widthDeg: number };
}

export const loadS1Fixture = (): S1FixtureSpec => JSON.parse(readFileSync(FIXTURE, 'utf8')) as S1FixtureSpec;

/** The RTC mask values the fixture writes. */
export const S1_FIXTURE_MASK = { valid: 1, shadow: 2 } as const;
type BandName = 'VV' | 'MASK';
const SCENE_PATH = /^\/s1_rtc\/fixture\/(-?\d+)\/(-?\d+)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d)\/s1_rtc_fixture_(VV|MASK)\.tif$/;

function uuidOf(text: string): string {
	const h = createHash('sha256').update(text).digest('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Whether `day` is a windy one (open water reads dry on radar). */
export const s1FixtureWindy = (spec: Pick<S1FixtureSpec, 'wind'>, day: number) => day % spec.wind.everyNth === 0;

/** Whether longitude `lon` is in a shadow strip (the RTC mask's 2). */
export function s1FixtureShadow(spec: Pick<S1FixtureSpec, 'shadow'>, lon: number): boolean {
	const { periodDeg, widthDeg } = spec.shadow;
	// The position inside the period, from the quotient (a float % of 0.1 drifts: 22.3 % 0.1 is 0.0999…).
	const k = lon / periodDeg;
	return (k - Math.floor(k)) * periodDeg < widthDeg;
}

export function s1Fixture(today: () => string, spec: S1FixtureSpec = loadS1Fixture(), water: Pick<WofsFixtureSpec, 'water'> = loadWofsFixture()) {
	const { sizePx, tilePx, pixelDeg } = spec.scenes;
	const tileDeg = sizePx * pixelDeg;
	const cache = new Map<string, Uint8Array>();
	// Per tile, each pixel centre's UTM easting and northing (north code), worked out once: a day only re-levels them.
	const utmCache = new Map<string, { xs: Float64Array; ys: Float64Array }>();

	/** Tile (tx, ty) covers lon [tx, tx + 1) × tileDeg and lat [ty, ty + 1) × tileDeg; its corner is its north-west one. */
	const corner = (tx: number, ty: number) => ({ originX: tx * sizePx * pixelDeg, originY: (ty + 1) * sizePx * pixelDeg });
	const key = (tx: number, ty: number, date: string, path: number, band: BandName) => `s1_rtc/fixture/${tx}/${ty}/${date.replaceAll('-', '/')}/${path}/s1_rtc_fixture_${band}.tif`;
	const passDays = (from: number, to: number) => {
		const out: { day: number; path: number }[] = [];
		const { revisitDays, pathOffsetsDays } = spec.schedule;
		for (let d = from; d <= to; d++) {
			pathOffsetsDays.forEach((off, path) => {
				if ((((d - off) % revisitDays) + revisitDays) % revisitDays === 0) out.push({ day: d, path });
			});
		}
		return out;
	};
	const served = (day: number) => {
		const t = toEpochDay(today());
		return day <= t - spec.schedule.lagDays && day >= t - spec.schedule.historyDays;
	};
	const utmOf = (tx: number, ty: number) => {
		const k = `${tx}/${ty}`;
		let got = utmCache.get(k);
		if (!got) {
			const { originX, originY } = corner(tx, ty);
			const epsg = 32600 + (utmEpsgFor(originX + tileDeg / 2, originY - tileDeg / 2) % 100);
			const xs = new Float64Array(sizePx * sizePx);
			const ys = new Float64Array(sizePx * sizePx);
			for (let r = 0; r < sizePx; r++) {
				const lat = originY - (r + 0.5) * pixelDeg;
				for (let c = 0; c < sizePx; c++) {
					const p = toUtm(originX + (c + 0.5) * pixelDeg, lat, epsg);
					xs[r * sizePx + c] = p.x;
					ys[r * sizePx + c] = p.y;
				}
			}
			got = { xs, ys };
			if (utmCache.size >= 64) utmCache.clear();
			utmCache.set(k, got);
		}
		return got;
	};

	return {
		/** The search page for an s1_rtc STAC search URL, or null for any other URL. */
		search(url: string): string | null {
			if (!url.startsWith(`${WOFS_STAC_SEARCH}?`)) return null;
			const q = new URL(url).searchParams;
			const bbox = (q.get('bbox') ?? '').split(',').map(Number);
			const [from, to] = (q.get('datetime') ?? '').split('/').map((s) => s.slice(0, 10));
			if (q.get('collections') !== S1_RTC_COLLECTION || bbox.length !== 4 || !bbox.every(Number.isFinite) || !from || !to) return null;
			const limit = Math.min(1000, Math.max(1, Number(q.get('limit') ?? 10)));
			const offset = Math.max(0, Number(q.get('_o') ?? 0));
			const [w, s, e, n] = bbox as [number, number, number, number];
			const tiles: [number, number][] = [];
			for (let tx = Math.floor(w / tileDeg); tx * tileDeg < e; tx++) for (let ty = Math.floor(s / tileDeg); ty * tileDeg < n; ty++) tiles.push([tx, ty]);
			const t = toEpochDay(today());
			const first = Math.max(toEpochDay(from), t - spec.schedule.historyDays);
			const last = Math.min(toEpochDay(to), t - spec.schedule.lagDays);
			const all = passDays(first, last).flatMap(({ day, path }) =>
				tiles.map(([tx, ty]) => {
					const date = fromEpochDay(day);
					const minutes = spec.schedule.pathMinutes[path] ?? 1053;
					const datetime = `${date}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:11Z`;
					const asset = (name: string, band: string) => ({ ...spec.item.assets[name], href: `s3://deafrica-sentinel-1/${key(tx, ty, date, path, band as BandName)}` });
					return {
						...spec.item,
						id: uuidOf(`s1/${tx}/${ty}/${date}/${path}`),
						properties: { ...spec.item.properties, datetime, start_datetime: datetime, end_datetime: datetime },
						assets: { vv: asset('vv', 'VV'), vh: asset('vh', 'VH'), mask: asset('mask', 'MASK') }
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

		/** One band of a scene at an S3 URL, or null (a 404) for any other URL (VH among them: the pass never reads it) or a day not served. */
		scene(url: string): Uint8Array | null {
			if (!url.startsWith(`${S1_S3_BASE}/`)) return null;
			const m = SCENE_PATH.exec(url.slice(S1_S3_BASE.length));
			if (!m) return null;
			const tx = Number(m[1]);
			const ty = Number(m[2]);
			const day = toEpochDay(`${m[3]}-${m[4]}-${m[5]}`);
			const band = m[7] as BandName;
			if (!served(day)) return null;
			let bytes = cache.get(url);
			if (!bytes) {
				const { originX, originY } = corner(tx, ty);
				const n = sizePx;
				if (band === 'MASK') {
					const values = new Uint8Array(n * n);
					for (let c = 0; c < n; c++) {
						const v = s1FixtureShadow(spec, originX + (c + 0.5) * pixelDeg) ? S1_FIXTURE_MASK.shadow : S1_FIXTURE_MASK.valid;
						for (let r = 0; r < n; r++) values[r * n + c] = v;
					}
					bytes = writeCog({ ...S1_MASK_LAYOUT, width: n, height: n, values, epsg: 4326, originX, originY, pixelSize: pixelDeg, tile: tilePx });
				} else {
					const { xs, ys } = utmOf(tx, ty);
					const lvl = level(water, day);
					const [l1, l2] = water.water.wavelengthM;
					const wet = s1FixtureWindy(spec, day) ? spec.backscatter.windWater : spec.backscatter.water;
					const values = new Float32Array(n * n);
					for (let i = 0; i < n * n; i++) {
						// wofs/fixtures.ts fixtureWet, inlined.
						const isWet = 0.5 + 0.25 * Math.sin((2 * Math.PI * xs[i]!) / l1) + 0.25 * Math.cos((2 * Math.PI * ys[i]!) / l2) < lvl;
						values[i] = isWet ? wet : spec.backscatter.land;
					}
					bytes = writeCog({ ...S1_VV_LAYOUT, width: n, height: n, values, epsg: 4326, originX, originY, pixelSize: pixelDeg, tile: tilePx });
				}
				if (cache.size >= 64) cache.clear();
				cache.set(url, bytes);
			}
			return bytes;
		}
	};
}
