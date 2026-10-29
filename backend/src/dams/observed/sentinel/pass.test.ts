// The Sentinel-2 pass (pass.ts, ../wofs/pass.ts runScenePass) against the
// synthetic s2_l2a_c1 search and bands (fixtures.ts): what it writes, a
// 0.3 ha dam WOfS has no pixel for, a winter day partly under cloud, the
// NDWI fallback, its pacing (one request a second per host), and a 403
// stopping it. Then the Sentinel-1 pass against the synthetic s1_rtc
// (s1Fixtures.ts): the same, radar through Landsat's cloud, the RTC mask's
// shadow, wind-roughened water, its agreement with Sentinel-2, and a dam
// across a tile edge joined from both tiles (../wofs/merge.ts).
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
import { S1_S3_BASE, S2_C1_S3_BASE, WOFS_STAC_SEARCH } from '../wofs/stac.js';
import { outlineMask } from '../../../raster/mask.js';
import { s1Agreement, agreementPairs } from './agreement.js';
import { loadS2Fixture, s2Fixture, s2FixtureHasSwir, type S2FixtureSpec } from './fixtures.js';
import { runS1Pass, runS2Pass, S1_BACKFILL_FROM, S1_SCENE_INTERVAL_MS, S1_STATE_KEY, S2_BACKFILL_FROM, S2_SCENE_INTERVAL_MS, S2_STATE_KEY } from './pass.js';
import { loadS1Fixture, s1Fixture, s1FixtureShadow, s1FixtureWindy, type S1FixtureSpec } from './s1Fixtures.js';
import { geometryAreaM2 } from '../../../geo/area.js';

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

const S1_SPEC: S1FixtureSpec = (() => {
	const s = loadS1Fixture();
	return { ...s, schedule: { ...s.schedule, historyDays: HISTORY } };
})();

/** The synthetic Sentinel-1 as a FeedHttp, logging each URL (and when it was asked, by `at`); `fail` may throw for a URL. */
function s1Http(opts: { fail?: (url: string) => Error | null; at?: () => number } = {}) {
	const fx = s1Fixture(() => TODAY, S1_SPEC);
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

/** A lon/lat box as an outline. */
function box(featureId: string, w: number, s: number, e: number, n: number): WantedOutline {
	return { featureId, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, since: '1984-01-01' };
}
/** A dam across a shadow strip's east edge (22.400–22.403° E): its west third in shadow. */
const SHADOWED: WantedOutline = box('00000000-0000-4000-8000-0000000000a4', 22.4015, -32.12, 22.4060, -32.116);

describe('runS1Pass', () => {
	it('writes a row per date a radar scene saw the dam, to its own file, status and state, from Sentinel-1 hosts only', async () => {
		const store = freshStore();
		await listed(store, [DAM]);
		const { http, log } = s1Http();
		const r = await runS1Pass({ store, http, today: TODAY, ...fast });
		expect(r).toMatchObject({ stopped: 'done', written: [DAM.featureId], failures: [], sceneFailures: [], error: null });
		expect(log.every(({ url }) => url.startsWith(WOFS_STAC_SEARCH) || url.startsWith(`${S1_S3_BASE}/s1_rtc/`))).toBe(true);
		expect(log.filter(({ url }) => url.startsWith(WOFS_STAC_SEARCH)).every(({ url }) => new URL(url).searchParams.get('collections') === 's1_rtc')).toBe(true);
		// VV and the mask only: never VH.
		expect(log.some(({ url }) => url.endsWith('_VH.tif'))).toBe(false);

		const f = (await readObservationFile(store, 's1', DAM.featureId))!;
		expect(f.source).toBe('s1');
		// Two paths, each every 6 days, over the history less the lag.
		expect(f.rows.length).toBeGreaterThan(45);
		const cell = outlineMask(DAM.geometry, { epsg: 4326, originX: 22.3, originY: -32.1, pixelSizeX: S1_SPEC.scenes.pixelDeg, pixelSizeY: S1_SPEC.scenes.pixelDeg });
		for (const row of f.rows) {
			expect(f.upstream.find((u) => u.itemId === row.upstreamKey)!.url).toMatch(/_VV\.tif$/);
			// Whole 0.0002° cells at the outline's latitude (the same tile grid's cell area within a hair).
			const px = row.wetAreaM2 / cell.pixelAreaM2;
			expect(Math.abs(px - Math.round(px))).toBeLessThan(0.01);
		}
		// Radar sees through cloud: every view is clear, and calm days see water.
		expect(f.rows.every((x) => x.pctObserved === 100)).toBe(true);
		expect(f.rows.filter((x) => !s1FixtureWindy(S1_SPEC, toEpochDay(x.date))).every((x) => x.wetAreaM2 > 0)).toBe(true);
		expect((await readStatus(store, 's1'))!.perKey[DAM.featureId]!.newest).toBe(f.rows.at(-1)!.date);
		expect((await readState(store, S1_STATE_KEY))!.dams[DAM.featureId]!.backfilledFrom).toBe(fast.backfillFrom);
		expect(await readStatus(store, 's2')).toBeNull();
	});

	it('still sees a dam on a winter day Landsat is wholly clouded', async () => {
		const store = freshStore();
		await listed(store, [DAM]);
		await runS1Pass({ store, http: s1Http().http, today: TODAY, ...fast });
		const f = (await readObservationFile(store, 's1', DAM.featureId))!;
		const wofsSpec = loadWofsFixture();
		const clouded = f.rows.filter((x) => isWinter(x.date) && toEpochDay(x.date) % wofsSpec.cloud.overcastEveryNth === 0);
		expect(clouded.length).toBeGreaterThan(0);
		for (const x of clouded) expect(x.pctObserved).toBe(100);
	});

	it('reads wind-roughened water as dry: a windy day sees none of a dam a calm day sees wet', async () => {
		const store = freshStore();
		await listed(store, [DAM]);
		await runS1Pass({ store, http: s1Http().http, today: TODAY, ...fast });
		const f = (await readObservationFile(store, 's1', DAM.featureId))!;
		const windy = f.rows.filter((x) => s1FixtureWindy(S1_SPEC, toEpochDay(x.date)));
		expect(windy.length).toBeGreaterThan(0);
		for (const x of windy) expect(x).toMatchObject({ pctObserved: 100, wetAreaM2: 0 });
	});

	it('counts the RTC mask’s shadow and layover as not seen clearly', async () => {
		const store = freshStore();
		await listed(store, [SHADOWED]);
		await runS1Pass({ store, http: s1Http().http, today: TODAY, ...fast });
		const f = (await readObservationFile(store, 's1', SHADOWED.featureId))!;
		expect(s1FixtureShadow(S1_SPEC, 22.4016)).toBe(true);
		expect(s1FixtureShadow(S1_SPEC, 22.4031)).toBe(false);
		// 22.4015–22.4030 of 22.4015–22.4060 in shadow: a third.
		expect(f.rows.length).toBeGreaterThan(20);
		for (const x of f.rows) {
			expect(x.pctObserved).toBeGreaterThan(60);
			expect(x.pctObserved).toBeLessThan(72);
		}
	});

	it('agrees with Sentinel-2’s clear views of the same dam on calm days, and not on windy ones', async () => {
		const store = freshStore();
		await listed(store, [DAM]);
		await runS2Pass({ store, http: s2Http().http, today: TODAY, ...fast });
		await runS1Pass({ store, http: s1Http().http, today: TODAY, ...fast });
		const s1 = (await readObservationFile(store, 's1', DAM.featureId))!.rows;
		const s2 = (await readObservationFile(store, 's2', DAM.featureId))!.rows;
		const full = geometryAreaM2(DAM.geometry)!;
		const pairs = agreementPairs(s1, s2, full);
		expect(pairs.length).toBeGreaterThan(10);
		for (const p of pairs) {
			expect(Math.abs(toEpochDay(p.s1Date) - toEpochDay(p.s2Date))).toBeLessThanOrEqual(1);
			// Calm: the same water field at 10 m and ~20 m. Windy: radar reads none of it, and the dam holds more than 0.1 F.
			if (!s1FixtureWindy(S1_SPEC, toEpochDay(p.s1Date))) expect(p.within, p.s1Date).toBe(true);
			else if (p.s2Share > 0.1) expect(p.within, p.s1Date).toBe(false);
		}
		const a = s1Agreement(s1, s2, full);
		expect(a.pairs).toBe(pairs.length);
		expect(a.within).toBe(pairs.filter((p) => p.within).length);
	});

	it('asks each host at most once a second', async () => {
		const store = freshStore();
		await listed(store, [DAM]);
		const c = clock();
		const { http, log } = s1Http({ at: c.at });
		const r = await runS1Pass({ store, http, today: TODAY, backfillFrom: day(-40), now: c.now, sleep: c.sleep });
		expect(r.sceneRequests).toBeGreaterThan(10);
		for (const host of [WOFS_STAC_SEARCH, S1_S3_BASE]) {
			const ts = log.filter(({ url }) => url.startsWith(host)).map(({ t }) => t);
			for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBeGreaterThanOrEqual(host === WOFS_STAC_SEARCH ? STAC_INTERVAL_MS : S1_SCENE_INTERVAL_MS);
		}
		expect(S1_SCENE_INTERVAL_MS).toBe(1000);
	});

	it('stops on a 403 or throttling from the bucket, keeping what it read, and pauses the source', async () => {
		for (const err of [new FeedRefusedError(), new FeedThrottledError(429)]) {
			const store = freshStore();
			await listed(store, [DAM, SHADOWED]);
			let reads = 0;
			const { http } = s1Http({ fail: (url) => (url.startsWith(S1_S3_BASE) && ++reads > 40 ? err : null) });
			const r = await runS1Pass({ store, http, today: TODAY, ...fast, now: () => T0 });
			expect(r.stopped).toBe(err instanceof FeedRefusedError ? 'refused' : 'throttled');
			expect(r.error).toBe(err);
			expect(await readStatus(store, 's1')).toMatchObject({ source: 's1', stopped: true, reason: r.stopped });
			const again = s1Http();
			expect((await runS1Pass({ store, http: again.http, today: TODAY, ...fast, now: () => T0 + 3_600_000 })).stopped).toBe('paused');
			expect(again.log).toEqual([]);
		}
	});

	it('starts from the worker’s sinceBy.s1, never from WOfS’s since or Sentinel-2’s', async () => {
		const store = freshStore();
		await listed(store, [{ ...DAM, since: day(-2), sinceBy: { s2: day(-5), s1: day(-20) } }]);
		const { http, log } = s1Http();
		await runS1Pass({ store, http, today: TODAY, ...fast, lookbackDays: 45 });
		const first = new URL(log.find(({ url }) => url.startsWith(WOFS_STAC_SEARCH))!.url).searchParams.get('datetime');
		expect(first).toBe(`${day(-20)}T00:00:00Z/${TODAY}T23:59:59Z`);
		expect(S1_BACKFILL_FROM).toBe(S2_BACKFILL_FROM);
	});

	// The fixture's tiles are 0.05° squares (s1_rtc's are 1°): the edges at 22.35° E and 32.10° S. The boxes' sides
	// are a quarter pixel off any pixel centre, so both tiles' masks agree on which pixels are inside (a side through a
	// centre is decided by rounding, differently on each tile's origin).
	const STRADDLE: WantedOutline = box('00000000-0000-4000-8000-0000000000a5', 22.34855, -32.11905, 22.35145, -32.11605);
	const CORNER: WantedOutline = box('00000000-0000-4000-8000-0000000000a6', 22.34855, -32.10145, 22.35145, -32.09855);
	/** The VV URLs in a file's upstream list, by the date in their path. */
	const vvByDate = (f: { upstream: { url: string }[] }) => {
		const out = new Map<string, string[]>();
		for (const { url } of f.upstream) {
			const m = /\/(\d{4})\/(\d{2})\/(\d{2})\/\d\/s1_rtc_fixture_VV\.tif$/.exec(url)!;
			const d = `${m[1]}-${m[2]}-${m[3]}`;
			out.set(d, [...(out.get(d) ?? []), url]);
		}
		return out;
	};

	it('joins a dam across a tile edge from both tiles’ views of a date: every view whole, not half', async () => {
		const store = freshStore();
		await listed(store, [STRADDLE, CORNER]);
		const r = await runS1Pass({ store, http: s1Http().http, today: TODAY, ...fast });
		expect(r).toMatchObject({ stopped: 'done', failures: [], sceneFailures: [] });
		for (const [dam, tiles] of [
			[STRADDLE, 2],
			[CORNER, 4]
		] as const) {
			const f = (await readObservationFile(store, 's1', dam.featureId))!;
			expect(f.rows.length).toBeGreaterThan(45);
			// Radar sees through cloud and no shadow strip crosses these dams: each joined view is the whole dam.
			for (const x of f.rows) expect(x.pctObserved, x.date).toBe(100);
			expect(f.rows.filter((x) => !s1FixtureWindy(S1_SPEC, toEpochDay(x.date))).every((x) => x.wetAreaM2 > 0)).toBe(true);
			// Each row is keyed by one tile's item, and the file keeps every tile that filled it.
			const urls = vvByDate(f);
			for (const x of f.rows) {
				expect(urls.get(x.date), x.date).toHaveLength(tiles);
				expect(f.upstream.find((u) => u.itemId === x.upstreamKey)).toBeDefined();
			}
		}
	});

	it('keeps the scenes that filled a row in the file when a later run rewrites it', async () => {
		const store = freshStore();
		await listed(store, [STRADDLE]);
		let today = TODAY;
		const fx = s1Fixture(() => today, S1_SPEC);
		const http: FeedHttp = { range: async (u, s, e) => fx.scene(u)?.subarray(s, e + 1) ?? null, text: async (u) => fx.search(u) };
		await runS1Pass({ store, http, today, ...fast });
		const before = (await readObservationFile(store, 's1', STRADDLE.featureId))!;
		// A week on: new passes, so the file is written again, its earlier rows untouched.
		today = day(7);
		const r = await runS1Pass({ store, http, today, ...fast });
		expect(r.written).toEqual([STRADDLE.featureId]);
		const after = (await readObservationFile(store, 's1', STRADDLE.featureId))!;
		expect(after.rows.length).toBeGreaterThan(before.rows.length);
		const urls = vvByDate(after);
		for (const x of after.rows) expect(urls.get(x.date), x.date).toHaveLength(2);
		expect(after.rows.slice(0, before.rows.length)).toEqual(before.rows);
	});

	it('runs through the feeds’ fixture client (FEED_SOURCE=fixtures)', async () => {
		const store = freshStore();
		await listed(store, [DAM]);
		const r = await runS1Pass({ store, http: fixtureHttp(() => TODAY), today: TODAY, ...fast, backfillFrom: day(-30) });
		expect(r).toMatchObject({ stopped: 'done', written: [DAM.featureId] });
		expect((await readObservationFile(store, 's1', DAM.featureId))!.rows.length).toBeGreaterThan(0);
	});
});
