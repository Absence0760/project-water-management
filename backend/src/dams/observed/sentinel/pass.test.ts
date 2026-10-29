// The Sentinel-2 pass (pass.ts, ../wofs/pass.ts runScenePass) against the
// synthetic s2_l2a_c1 search and bands (fixtures.ts): what it writes, a
// 0.3 ha dam WOfS has no pixel for, a winter day partly under cloud, the
// NDWI fallback, its pacing (one request a second per host), and a 403
// stopping it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterAll, describe, expect, it } from 'vitest';
import { FeedRefusedError, FeedThrottledError } from '../../../feeds/errors.js';
import { fixtureHttp } from '../../../feeds/fixtures.js';
import type { FeedHttp } from '../../../feeds/http.js';
import { openStore, type MirrorStore } from '../../../mirror/store.js';
import { toUtm } from '../../../raster/utm.js';
import { readObservationFile, readStatus, writeWanted, type WantedOutline } from '../handover.js';
import { readState, runWofsPass, STAC_INTERVAL_MS } from '../wofs/pass.js';
import { loadWofsFixture, wofsFixture } from '../wofs/fixtures.js';
import { S2_C1_S3_BASE, WOFS_STAC_SEARCH } from '../wofs/stac.js';
import { loadS2Fixture, s2Fixture, s2FixtureHasSwir, type S2FixtureSpec } from './fixtures.js';
import { runS2Pass, S2_BACKFILL_FROM, S2_SCENE_INTERVAL_MS, S2_STATE_KEY } from './pass.js';

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
function freshStore(): MirrorStore {
	const dir = mkdtempSync(join(tmpdir(), 'wm-s2-pass-'));
	tmp.push(dir);
	return openStore(pathToFileURL(`${dir}/`).href);
}

const TODAY = '2026-10-25';
const T0 = Date.parse(`${TODAY}T04:00:00Z`);
const day = (n: number) => fromEpochDay(toEpochDay(TODAY) + n);
/** From mid-May: the Western Cape's winter (June to August) is inside the history. */
const HISTORY = 160;
const SPEC: S2FixtureSpec = (() => {
	const s = loadS2Fixture();
	return { ...s, schedule: { ...s.schedule, historyDays: HISTORY } };
})();
const fast = { stacIntervalMs: 0, sceneIntervalMs: 0, backfillFrom: day(-HISTORY - 5) };

function clock(start = T0) {
	let t = start;
	return { now: () => t, sleep: async (ms: number) => void (t += ms), at: () => t };
}

/** The synthetic Sentinel-2 as a FeedHttp, logging each URL (and when it was asked, by `at`); `fail` may throw for a URL. */
function s2Http(opts: { fail?: (url: string) => Error | null; at?: () => number } = {}) {
	const fx = s2Fixture(() => TODAY, SPEC);
	const log: { url: string; t: number }[] = [];
	const ask = (url: string) => {
		log.push({ url, t: opts.at?.() ?? 0 });
		const e = opts.fail?.(url);
		if (e) throw e;
	};
	const http: FeedHttp = {
		range: async (url, s, e) => (ask(url), fx.scene(url)?.subarray(s, e + 1) ?? null),
		rangeTagged: async (url, s, e) => {
			ask(url);
			const b = fx.scene(url);
			return b ? { bytes: b.subarray(s, e + 1), tag: `"etag-${b.length}"` } : null;
		},
		text: async (url) => (ask(url), fx.search(url))
	};
	return { http, log };
}

/** The lon/lat of a UTM point (Newton on toUtm): the test's outlines are drawn on the grids, in metres. */
function lonLat(x: number, y: number, epsg: number): [number, number] {
	let lon = 21;
	let lat = -32;
	for (let i = 0; i < 20; i++) {
		const p = toUtm(lon, lat, epsg);
		const px = toUtm(lon + 1e-5, lat, epsg);
		const py = toUtm(lon, lat + 1e-5, epsg);
		const a = (px.x - p.x) / 1e-5;
		const b = (py.x - p.x) / 1e-5;
		const c = (px.y - p.y) / 1e-5;
		const d = (py.y - p.y) / 1e-5;
		const ex = x - p.x;
		const ey = y - p.y;
		const det = a * d - b * c;
		lon += (d * ex - b * ey) / det;
		lat += (a * ey - c * ex) / det;
	}
	return [lon, lat];
}
const ZONE34S = 32734;
/** A rectangle in zone 34 metres (south code), as an outline. */
function rect(featureId: string, x0: number, x1: number, y0: number, y1: number): WantedOutline {
	const ring = [lonLat(x0, y0, ZONE34S), lonLat(x1, y0, ZONE34S), lonLat(x1, y1, ZONE34S), lonLat(x0, y1, ZONE34S), lonLat(x0, y0, ZONE34S)];
	return { featureId, geometry: { type: 'Polygon', coordinates: [ring] }, since: '1984-01-01' };
}
/** Near the WOfS tests' dam A (22.31° E, 32.12° S), on a whole 30 m WOfS column. */
const BASE = toUtm(22.31, -32.12, ZONE34S);
const X0 = Math.floor(BASE.x / 30) * 30;
const Y0 = Math.floor(BASE.y / 30) * 30;

/** A ~700 m dam. */
const DAM: WantedOutline = rect('00000000-0000-4000-8000-0000000000a1', X0, X0 + 600, Y0, Y0 + 500);
/**
 * A narrow farm dam of 0.3 ha, 24 m by 125 m, between two of WOfS's 30 m pixel-centre columns (x ≡ 15 mod 30):
 * no WOfS pixel centre is inside it, while two 10 m columns of Sentinel-2's are.
 */
const SMALL: WantedOutline = rect('00000000-0000-4000-8000-0000000000a2', X0 + 18, X0 + 42, Y0, Y0 + 125);
/** A dam across a cloud band's east edge (x ≡ bandM mod 2·bandM): cloud on its west, then shadow, then clear. */
const EDGE_X = Math.floor(BASE.x / (2 * SPEC.cloud.bandM)) * 2 * SPEC.cloud.bandM + SPEC.cloud.bandM;
const EDGE: WantedOutline = rect('00000000-0000-4000-8000-0000000000a3', EDGE_X - 150, EDGE_X + 350, Y0, Y0 + 300);

async function listed(store: MirrorStore, outlines: WantedOutline[]) {
	await writeWanted(store, { generatedAt: `${TODAY}T03:00:00Z`, waterbodies: [], outlines });
}
const isWinter = (d: string) => ['06', '07', '08'].includes(d.slice(5, 7));

describe('runS2Pass', () => {
	it('writes a row per date a scene saw the dam, to its own file, status and state, from Sentinel-2 hosts only', async () => {
		const store = freshStore();
		await listed(store, [DAM]);
		const { http, log } = s2Http();
		const r = await runS2Pass({ store, http, today: TODAY, ...fast });
		expect(r).toMatchObject({ stopped: 'done', written: [DAM.featureId], failures: [], sceneFailures: [], error: null });
		expect(log.every(({ url }) => url.startsWith(WOFS_STAC_SEARCH) || url.startsWith(`${S2_C1_S3_BASE}/sentinel-2-c1-l2a/`))).toBe(true);
		expect(log.filter(({ url }) => url.startsWith(WOFS_STAC_SEARCH)).every(({ url }) => new URL(url).searchParams.get('collections') === 's2_l2a_c1')).toBe(true);

		const f = (await readObservationFile(store, 's2', DAM.featureId))!;
		expect(f.source).toBe('s2');
		// One pass every 5 days over the history, less the lag.
		expect(f.rows.length).toBeGreaterThan(25);
		for (const row of f.rows) {
			expect(f.upstream.find((u) => u.itemId === row.upstreamKey)!.url).toMatch(/\/B03\.tif$/);
			// 10 m pixels: the wet area is whole 100 m² pixels (÷ k², k at the outline's first vertex, within 1e-6 of BASE's).
			const px = row.wetAreaM2 / (100 / BASE.k ** 2);
			expect(Math.abs(px - Math.round(px))).toBeLessThan(0.01);
		}
		// Clear days see all of it and some water; overcast days nothing.
		const clear = f.rows.filter((x) => x.pctObserved === 100);
		expect(clear.length).toBeGreaterThan(0);
		expect(clear.some((x) => x.wetAreaM2 > 0)).toBe(true);
		for (const x of f.rows.filter((x) => toEpochDay(x.date) % SPEC.cloud.overcastEveryNth === 0)) expect(x).toMatchObject({ pctObserved: 0, wetAreaM2: 0 });
		expect((await readStatus(store, 's2'))!.perKey[DAM.featureId]!.newest).toBe(f.rows.at(-1)!.date);
		expect((await readState(store, S2_STATE_KEY))!.dams[DAM.featureId]!.backfilledFrom).toBe(fast.backfillFrom);
		// WOfS's own files are untouched.
		expect(await readStatus(store, 'wofs')).toBeNull();
	});

	it('observes a 0.3 ha dam that WOfS has no pixel for', async () => {
		const store = freshStore();
		await listed(store, [SMALL]);
		const wofs = wofsFixture(() => TODAY, { ...loadWofsFixture(), schedule: { ...loadWofsFixture().schedule, historyDays: HISTORY } });
		const wofsHttp: FeedHttp = { range: async (u, s, e) => wofs.scene(u)?.subarray(s, e + 1) ?? null, text: async (u) => wofs.search(u) };
		const w = await runWofsPass({ store, http: wofsHttp, today: TODAY, stacIntervalMs: 0, sceneIntervalMs: 0, backfillFrom: fast.backfillFrom });
		expect(w.scenesRead).toBeGreaterThan(0);
		expect(w.written).toEqual([]);
		expect(await readObservationFile(store, 'wofs', SMALL.featureId)).toBeNull();

		const r = await runS2Pass({ store, http: s2Http().http, today: TODAY, ...fast });
		expect(r.written).toEqual([SMALL.featureId]);
		const f = (await readObservationFile(store, 's2', SMALL.featureId))!;
		const full = f.rows.filter((x) => x.pctObserved === 100);
		expect(full.length).toBeGreaterThan(0);
		// 2 columns × 12 or 13 rows of 10 m pixels inside 24 m × 125 m: about 0.25–0.26 ha when all wet.
		expect(Math.max(...full.map((x) => x.wetAreaM2))).toBeGreaterThan(2000);
		expect(Math.max(...full.map((x) => x.wetAreaM2))).toBeLessThanOrEqual(3000);
	});

	it('still sees a dam on a winter day that clouds part of it and Landsat not at all', async () => {
		const store = freshStore();
		await listed(store, [EDGE]);
		await runS2Pass({ store, http: s2Http().http, today: TODAY, ...fast });
		const f = (await readObservationFile(store, 's2', EDGE.featureId))!;
		const wofsSpec = loadWofsFixture();
		const partly = f.rows.filter((x) => isWinter(x.date) && toEpochDay(x.date) % SPEC.cloud.everyNth === 0 && toEpochDay(x.date) % SPEC.cloud.overcastEveryNth !== 0);
		expect(partly.length).toBeGreaterThan(0);
		for (const x of partly) {
			// The west 150 m under cloud and the next 200 m under its shadow: about 150 / 500 of it clear.
			expect(x.pctObserved).toBeGreaterThan(20);
			expect(x.pctObserved).toBeLessThan(40);
		}
		// A winter day WOfS's fixture is wholly overcast, and Sentinel-2 saw some of the dam.
		const landsatClouded = f.rows.filter((x) => isWinter(x.date) && toEpochDay(x.date) % wofsSpec.cloud.overcastEveryNth === 0 && x.pctObserved > 0);
		expect(landsatClouded.length).toBeGreaterThan(0);
	});

	it('falls back to NDWI from B08 on a day the item lists no B11, and reads B08 only then', async () => {
		const store = freshStore();
		await listed(store, [DAM]);
		const { http, log } = s2Http();
		await runS2Pass({ store, http, today: TODAY, ...fast });
		const f = (await readObservationFile(store, 's2', DAM.featureId))!;
		const dateOf = (url: string) => url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\/B0[38]\.tif$|\/(\d{4})\/(\d{2})\/(\d{2})\/(?:B11|SCL)\.tif$/)!;
		const b08 = log.filter(({ url }) => url.endsWith('/B08.tif')).map(({ url }) => dateOf(url).slice(1, 4).join('-'));
		const b11 = log.filter(({ url }) => url.endsWith('/B11.tif'));
		expect(b08.length).toBeGreaterThan(0);
		for (const d of new Set(b08)) expect(s2FixtureHasSwir(SPEC, toEpochDay(d))).toBe(false);
		for (const { url } of b11) expect(s2FixtureHasSwir(SPEC, toEpochDay(dateOf(url).slice(4, 7).join('-')))).toBe(true);
		// The NDWI days read water as the MNDWI days do: a clear one sees water.
		const ndwiDays = f.rows.filter((x) => !s2FixtureHasSwir(SPEC, toEpochDay(x.date)) && x.pctObserved === 100);
		expect(ndwiDays.length).toBeGreaterThan(0);
		expect(ndwiDays.some((x) => x.wetAreaM2 > 0)).toBe(true);
	});

	it('asks each host at most once a second', async () => {
		const store = freshStore();
		await listed(store, [DAM]);
		const c = clock();
		const { http, log } = s2Http({ at: c.at });
		const r = await runS2Pass({ store, http, today: TODAY, backfillFrom: day(-40), now: c.now, sleep: c.sleep });
		expect(r.sceneRequests).toBeGreaterThan(10);
		for (const host of [WOFS_STAC_SEARCH, S2_C1_S3_BASE]) {
			const ts = log.filter(({ url }) => url.startsWith(host)).map(({ t }) => t);
			for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBeGreaterThanOrEqual(host === WOFS_STAC_SEARCH ? STAC_INTERVAL_MS : S2_SCENE_INTERVAL_MS);
		}
		expect(S2_SCENE_INTERVAL_MS).toBe(1000);
	});

	it('shares the explorer’s pacer with the WOfS pass before it', async () => {
		const { pacedHttp } = await import('../../../ingest/daily.js');
		const store = freshStore();
		await listed(store, [DAM]);
		const c = clock();
		const { http, log } = s2Http({ at: c.at });
		const stac = pacedHttp(http, STAC_INTERVAL_MS, c.now, c.sleep);
		// WOfS's last search just now.
		await stac.http.text(`${WOFS_STAC_SEARCH}?collections=s2_l2a_c1&bbox=0,0,0,0&datetime=2000-01-01T00:00:00Z/2000-01-01T23:59:59Z&limit=1`);
		const before = c.at();
		const r = await runS2Pass({ store, http, stac, today: TODAY, backfillFrom: day(-10), now: c.now, sleep: c.sleep });
		const first = log.filter(({ url }) => url.startsWith(WOFS_STAC_SEARCH))[1]!;
		expect(first.t - before).toBeGreaterThanOrEqual(STAC_INTERVAL_MS);
		expect(r.stacRequests).toBe(log.filter(({ url }) => url.startsWith(WOFS_STAC_SEARCH)).length - 1);
	});

	it('stops on a 403 or throttling from the bucket, keeping what it read, and pauses the source', async () => {
		for (const err of [new FeedRefusedError(), new FeedThrottledError(429)]) {
			const store = freshStore();
			await listed(store, [DAM, SMALL]);
			let reads = 0;
			const { http } = s2Http({ fail: (url) => (url.startsWith(S2_C1_S3_BASE) && ++reads > 40 ? err : null) });
			const r = await runS2Pass({ store, http, today: TODAY, ...fast, now: () => T0 });
			expect(r.stopped).toBe(err instanceof FeedRefusedError ? 'refused' : 'throttled');
			expect(r.error).toBe(err);
			const status = (await readStatus(store, 's2'))!;
			expect(status).toMatchObject({ source: 's2', stopped: true, reason: r.stopped });
			// The next run within the day asks nothing.
			const again = s2Http();
			expect((await runS2Pass({ store, http: again.http, today: TODAY, ...fast, now: () => T0 + 3_600_000 })).stopped).toBe('paused');
			expect(again.log).toEqual([]);
		}
	});

	it('starts from the worker’s sinceBy.s2, never from WOfS’s since', async () => {
		const store = freshStore();
		await listed(store, [{ ...DAM, since: day(-2), sinceBy: { s2: day(-20) } }]);
		const { http, log } = s2Http();
		await runS2Pass({ store, http, today: TODAY, ...fast, lookbackDays: 45 });
		const first = new URL(log.find(({ url }) => url.startsWith(WOFS_STAC_SEARCH))!.url).searchParams.get('datetime');
		expect(first).toBe(`${day(-20)}T00:00:00Z/${TODAY}T23:59:59Z`);
		expect(S2_BACKFILL_FROM).toBe('2019-01-01');
	});

	it('runs through the feeds’ fixture client (FEED_SOURCE=fixtures)', async () => {
		const store = freshStore();
		await listed(store, [DAM]);
		const r = await runS2Pass({ store, http: fixtureHttp(() => TODAY), today: TODAY, ...fast, backfillFrom: day(-30) });
		expect(r).toMatchObject({ stopped: 'done', written: [DAM.featureId] });
		expect((await readObservationFile(store, 's2', DAM.featureId))!.rows.length).toBeGreaterThan(0);
	});
});
