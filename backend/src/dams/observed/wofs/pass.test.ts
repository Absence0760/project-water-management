// The WOfS pass (wofs/pass.ts) against the synthetic STAC and scenes
// (wofs/fixtures.ts): what it writes, resuming under the deadline, the
// re-scanned tail, a changed outline, and a 403 or a failure stopping it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterAll, describe, expect, it } from 'vitest';
import { FeedRefusedError, FeedThrottledError, FeedUnavailableError } from '../../../feeds/errors.js';
import type { FeedHttp } from '../../../feeds/http.js';
import { fixtureHttp } from '../../../feeds/fixtures.js';
import { openStore, type MirrorStore } from '../../../mirror/store.js';
import { readObservationFile, readStatus, writeWanted, type WantedOutline } from '../handover.js';
import { loadWofsFixture, wofsFixture, type WofsFixtureSpec } from './fixtures.js';
import { better, outlineBbox, outlineHash, readState, runWofsPass, STAC_INTERVAL_MS, SCENE_INTERVAL_MS, WOFS_BACKFILL_FROM } from './pass.js';
import { WOFS_S3_BASE, WOFS_STAC_SEARCH, type WofsScene } from './stac.js';

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
function freshStore(): MirrorStore {
	const dir = mkdtempSync(join(tmpdir(), 'wm-wofs-pass-'));
	tmp.push(dir);
	return openStore(pathToFileURL(`${dir}/`).href);
}

const TODAY = '2026-10-25';
const T0 = Date.parse(`${TODAY}T04:00:00Z`);
const day = (n: number) => fromEpochDay(toEpochDay(TODAY) + n);

/** The committed fixture with a shorter history, so a full scan is a few dozen scenes. */
const SPEC: WofsFixtureSpec = (() => {
	const s = loadWofsFixture();
	return { ...s, schedule: { ...s.schedule, historyDays: 120 } };
})();

/** A clock only the pass's sleeps (and `step` per request) move. */
function clock(start = T0) {
	let t = start;
	const sleeps: number[] = [];
	return { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)), sleeps, advance: (ms: number) => void (t += ms) };
}

/** The synthetic WOfS as a FeedHttp, logging each URL; `fail` may throw for a URL. */
function wofsHttp(opts: { spec?: WofsFixtureSpec; fail?: (url: string, n: number) => Error | null; onRequest?: () => void; today?: string } = {}) {
	const fx = wofsFixture(() => opts.today ?? TODAY, opts.spec ?? SPEC);
	const log: string[] = [];
	const ask = (url: string) => {
		log.push(url);
		opts.onRequest?.();
		const e = opts.fail?.(url, log.length);
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

/** An invented dam outline (~700 m across), lon/lat. */
const ring = (lon: number, lat: number): [number, number][] => [
	[lon - 0.004, lat - 0.003],
	[lon + 0.003, lat - 0.004],
	[lon + 0.004, lat + 0.002],
	[lon - 0.001, lat + 0.004],
	[lon - 0.004, lat - 0.003]
];
const DAM_A: WantedOutline = { featureId: '00000000-0000-4000-8000-00000000000a', geometry: { type: 'Polygon', coordinates: [ring(22.31, -32.12)] }, since: '1984-01-01' };
const DAM_B: WantedOutline = { featureId: '00000000-0000-4000-8000-00000000000b', geometry: { type: 'Polygon', coordinates: [ring(22.52, -32.27)] }, since: '1984-01-01' };

async function listed(store: MirrorStore, outlines: WantedOutline[]) {
	await writeWanted(store, { generatedAt: `${TODAY}T03:00:00Z`, waterbodies: [], outlines });
}

const fast = { stacIntervalMs: 0, sceneIntervalMs: 0 };

describe('runWofsPass', () => {
	it('does nothing without a wanted list', async () => {
		const { http, log } = wofsHttp();
		const r = await runWofsPass({ store: freshStore(), http, today: TODAY, ...fast });
		expect(r.stopped).toBe('no_list');
		expect(log).toEqual([]);
	});

	it('writes a row per date a scene saw the dam, with its item, URL and ETag, and the status and state', async () => {
		const store = freshStore();
		await listed(store, [DAM_A]);
		const { http, log } = wofsHttp();
		const r = await runWofsPass({ store, http, today: TODAY, ...fast });
		expect(r).toMatchObject({ stopped: 'done', written: [DAM_A.featureId], failures: [], sceneFailures: [], error: null });
		// The newest weeks first, then a year at a time back to the backfill's start.
		const searches = log.filter((u) => u.startsWith(WOFS_STAC_SEARCH)).map((u) => new URL(u).searchParams.get('datetime'));
		expect(searches[0]).toBe(`${day(-45)}T00:00:00Z/${TODAY}T23:59:59Z`);
		expect(searches[1]).toBe(`${day(-411)}T00:00:00Z/${day(-46)}T23:59:59Z`);
		expect(searches.at(-1)).toMatch(new RegExp(`^${WOFS_BACKFILL_FROM}T00:00:00Z/`));
		expect(log.every((u) => u.startsWith(WOFS_STAC_SEARCH) || u.startsWith(WOFS_S3_BASE))).toBe(true);

		const f = (await readObservationFile(store, 'wofs', DAM_A.featureId))!;
		expect(f.source).toBe('wofs');
		expect(f.rows.length).toBeGreaterThan(5);
		const dates = f.rows.map((x) => x.date);
		expect(dates).toEqual([...new Set(dates)].sort());
		expect(dates[0]! >= day(-SPEC.schedule.historyDays)).toBe(true);
		expect(dates.at(-1)! <= day(-SPEC.schedule.lagDays)).toBe(true);
		for (const row of f.rows) {
			const u = f.upstream.find((x) => x.itemId === row.upstreamKey)!;
			expect(u.url.startsWith(`${WOFS_S3_BASE}/wofs_ls/`)).toBe(true);
			expect(u.etag).toMatch(/^"etag-\d+"$/);
		}
		// Overcast days: seen, nothing clear; clear days: all of it seen, some of it wet.
		const overcast = f.rows.filter((x) => toEpochDay(x.date) % SPEC.cloud.overcastEveryNth === 0);
		const clear = f.rows.filter((x) => toEpochDay(x.date) % SPEC.cloud.overcastEveryNth !== 0 && toEpochDay(x.date) % SPEC.cloud.everyNth !== 0);
		expect(clear.length).toBeGreaterThan(0);
		for (const x of overcast) expect(x).toMatchObject({ pctObserved: 0, wetAreaM2: 0 });
		for (const x of clear) expect(x.pctObserved).toBe(100);
		expect(clear.some((x) => x.wetAreaM2 > 0)).toBe(true);

		const status = (await readStatus(store, 'wofs'))!;
		expect(status).toMatchObject({ source: 'wofs', stopped: false });
		expect(status.perKey[DAM_A.featureId]).toEqual({ lastGood: expect.any(String), newest: dates.at(-1) });
		expect(status.perKey[DAM_A.featureId]!.lastGood! <= status.ranAt).toBe(true);
		expect(r.recencyDays).toBe(toEpochDay(TODAY) - toEpochDay(dates.at(-1)!));
		const state = (await readState(store))!;
		expect(state.dams[DAM_A.featureId]).toMatchObject({ outline: outlineHash(DAM_A), scannedThrough: TODAY, backfilledFrom: WOFS_BACKFILL_FROM });
	});

	it('writes one row for a date two overlapping scenes both saw', async () => {
		// Move the dam east until the fixture puts it on two neighbouring scenes.
		const fx = wofsFixture(() => TODAY, SPEC);
		let dam = DAM_A;
		for (let lon = 22.31; ; lon += 0.002) {
			dam = { ...DAM_A, geometry: { type: 'Polygon', coordinates: [ring(lon, -32.12)] } };
			const bbox = outlineBbox(dam).join(',');
			const page = JSON.parse(fx.search(`${WOFS_STAC_SEARCH}?collections=wofs_ls&bbox=${bbox}&datetime=${day(-30)}T00:00:00Z/${TODAY}T23:59:59Z&limit=100`)!);
			if (page.features.length > new Set(page.features.map((f: { properties: { datetime: string } }) => f.properties.datetime)).size) break;
			expect(lon).toBeLessThan(23);
		}
		const store = freshStore();
		await listed(store, [{ ...dam, since: day(-30) }]);
		const { http, log } = wofsHttp();
		const r = await runWofsPass({ store, http, today: TODAY, backfillFrom: day(-30), ...fast });
		const f = (await readObservationFile(store, 'wofs', DAM_A.featureId))!;
		expect(r.scenesRead).toBeGreaterThan(f.rows.length);
		expect(new Set(log.filter((u) => u.startsWith(WOFS_S3_BASE))).size).toBe(r.scenesRead);
		// The fixture's scenes agree where they overlap, so each date's row is the whole dam, seen as well as either saw it.
		for (const row of f.rows.filter((x) => toEpochDay(x.date) % SPEC.cloud.overcastEveryNth !== 0 && toEpochDay(x.date) % SPEC.cloud.everyNth !== 0)) {
			expect(row.pctObserved).toBe(100);
		}
	});

	it('paces STAC at one request a second and the bucket at five', async () => {
		const store = freshStore();
		await listed(store, [DAM_A]);
		const c = clock();
		const { http } = wofsHttp({ spec: { ...SPEC, schedule: { ...SPEC.schedule, historyDays: 30 } } });
		await runWofsPass({ store, http, today: TODAY, backfillFrom: day(-40), now: c.now, sleep: c.sleep });
		expect(c.sleeps.length).toBeGreaterThan(0);
		expect(Math.max(...c.sleeps)).toBeLessThanOrEqual(STAC_INTERVAL_MS);
		expect(c.sleeps).toContain(SCENE_INTERVAL_MS);
	});

	it('checks a dam’s newest scenes at most once a UTC day, and re-scans the tail the next day', async () => {
		const store = freshStore();
		await listed(store, [DAM_A]);
		await runWofsPass({ store, http: wofsHttp().http, today: TODAY, ...fast });
		expect((await readState(store))!.dams[DAM_A.featureId]!.checkedOn).toBe(TODAY);
		// The next hourly run, the same day, with no history left: nothing asked, but the status (the heartbeat's recency) is written.
		const again = wofsHttp();
		const r = await runWofsPass({ store, http: again.http, today: TODAY, ...fast });
		expect(r).toMatchObject({ fresh: 1, written: [], turns: 0, stopped: 'done' });
		expect(r.recencyDays).not.toBeNull();
		expect(again.log).toEqual([]);
		expect((await readStatus(store, 'wofs'))!.ranAt).toBeDefined();
		// The next day: only the tail is searched, and unchanged rows don't rewrite the file.
		const later = wofsHttp();
		const r2 = await runWofsPass({ store, http: later.http, today: day(1), ...fast });
		expect(r2.fresh).toBe(0);
		const searched = later.log.filter((u) => u.startsWith(WOFS_STAC_SEARCH)).map((u) => new URL(u).searchParams.get('datetime')!);
		expect(searched).toEqual([`${day(1 - 45)}T00:00:00Z/${day(1)}T23:59:59Z`]);
		// The fixture's "today" is still TODAY, so nothing new was published: nothing to write, and no scene read again
		// (a STAC item id is one processing of one scene: the ones read keep their rows).
		expect(r2.written).toEqual([]);
		expect(later.log.filter((u) => u.startsWith(WOFS_S3_BASE))).toEqual([]);
		expect(r2).toMatchObject({ sceneRequests: 0, scenesRead: 0 });
		expect((await readState(store))!.dams[DAM_A.featureId]!.checkedOn).toBe(day(1));
	});

	it('reads only the scenes published since in the tail window, and keeps the rows already read', async () => {
		const store = freshStore();
		await listed(store, [DAM_A]);
		const first = wofsHttp();
		await runWofsPass({ store, http: first.http, today: TODAY, ...fast });
		const before = (await readObservationFile(store, 'wofs', DAM_A.featureId))!;
		const readBefore = new Set(first.log.filter((u) => u.startsWith(WOFS_S3_BASE)));
		// Ten days later the fixture has published the scenes taken since: only those are read.
		const later = wofsHttp({ today: day(10) });
		const r = await runWofsPass({ store, http: later.http, today: day(10), ...fast });
		const read = new Set(later.log.filter((u) => u.startsWith(WOFS_S3_BASE)));
		expect(read.size).toBeGreaterThan(0);
		expect([...read].filter((u) => readBefore.has(u))).toEqual([]);
		expect(r.written).toEqual([DAM_A.featureId]);
		const after = (await readObservationFile(store, 'wofs', DAM_A.featureId))!;
		// Every row read before is kept as it was; the new dates come after it.
		expect(after.rows.slice(0, before.rows.length)).toEqual(before.rows);
		expect(after.rows.length).toBeGreaterThan(before.rows.length);
		expect(after.rows.at(-1)!.date > before.rows.at(-1)!.date).toBe(true);
		// The tail's items are kept for the lookback only.
		const tailItems = (await readState(store))!.dams[DAM_A.featureId]!.tailItems ?? [];
		expect(tailItems.length).toBeGreaterThan(0);
		expect(tailItems.every(([d]) => d >= day(10 - 45))).toBe(true);
		// The next day, with nothing newer published: still nothing read.
		const again = wofsHttp({ today: day(10) });
		await runWofsPass({ store, http: again.http, today: day(11), ...fast });
		expect(again.log.filter((u) => u.startsWith(WOFS_S3_BASE))).toEqual([]);
	});

	it('goes on with a forward turn the deadline cut, in the next run the same day', async () => {
		const store = freshStore();
		await listed(store, [DAM_A]);
		const c = clock();
		// Every request takes a second; the first run gets three.
		const first = wofsHttp({ onRequest: () => c.advance(1000) });
		const r1 = await runWofsPass({ store, http: first.http, today: TODAY, deadline: c.now() + 3000, now: c.now, sleep: c.sleep, ...fast });
		expect(r1.stopped).toBe('deadline');
		expect((await readState(store))!.dams[DAM_A.featureId]!.checkedOn).toBeUndefined();
		const r2 = await runWofsPass({ store, http: wofsHttp().http, today: TODAY, ...fast });
		expect(r2.fresh).toBe(0);
		expect(r2.stopped).toBe('done');
		expect((await readState(store))!.dams[DAM_A.featureId]!.checkedOn).toBe(TODAY);
	});

	it('resumes across runs under the deadline, newest first, ending with what one long run writes', async () => {
		// Two years of scenes and a backfill to 600 days back: the newest year forward, then the year before it backward.
		const spec: WofsFixtureSpec = { ...SPEC, schedule: { ...SPEC.schedule, historyDays: 700 } };
		const backfillFrom = day(-600);
		const whole = freshStore();
		await listed(whole, [DAM_A]);
		await runWofsPass({ store: whole, http: wofsHttp({ spec }).http, today: TODAY, backfillFrom, ...fast });
		const want = (await readObservationFile(whole, 'wofs', DAM_A.featureId))!.rows;
		expect(want[0]!.date < day(-365)).toBe(true);

		const store = freshStore();
		await listed(store, [DAM_A]);
		let runs = 0;
		let checked = false;
		let stopped = 'deadline';
		const spans: [string, string][] = [];
		while (stopped === 'deadline') {
			runs++;
			expect(runs).toBeLessThan(60);
			const c = clock(T0 + runs * 86_400_000);
			// Every request takes a second; a run gets twenty.
			const { http } = wofsHttp({ spec, onRequest: () => c.advance(1000) });
			const r = await runWofsPass({ store, http, today: TODAY, backfillFrom, deadline: c.now() + 20_000, now: c.now, sleep: c.sleep, ...fast });
			stopped = r.stopped;
			// Once the newest scenes were checked today, every later (hourly) run spends its time on the backfill.
			if (checked) expect(r.fresh).toBe(1);
			const st = (await readState(store))!.dams[DAM_A.featureId]!;
			checked ||= st.checkedOn === TODAY;
			spans.push([st.backfilledFrom ?? '', st.scannedThrough ?? '']);
			if (runs === 1) {
				// The first run reads the newest scenes first: the dam is current before any history comes in.
				const f = (await readObservationFile(store, 'wofs', DAM_A.featureId))!;
				expect(f.rows.at(-1)!.date).toBe(want.at(-1)!.date);
				expect(r.recencyDays).toBe(toEpochDay(TODAY) - toEpochDay(want.at(-1)!.date));
			}
		}
		expect(runs).toBeGreaterThan(2);
		expect(stopped).toBe('done');
		// Each run went on from the one before: forward up to today, then back toward the backfill's start.
		expect(spans.map(([, to]) => to)).toEqual([...spans.map(([, to]) => to)].sort());
		expect(spans.map(([from]) => from)).toEqual([...spans.map(([from]) => from)].sort().reverse());
		expect(spans.at(-1)![0]).toBe(backfillFrom);
		expect((await readObservationFile(store, 'wofs', DAM_A.featureId))!.rows).toEqual(want);
	});

	it('starts a dam from the worker’s since when that is later, and backfills the rest; the file keeps every row', async () => {
		const store = freshStore();
		await listed(store, [{ ...DAM_A, since: day(-20) }]);
		const { http, log } = wofsHttp();
		await runWofsPass({ store, http, today: TODAY, ...fast });
		const searches = log.filter((u) => u.startsWith(WOFS_STAC_SEARCH)).map((u) => new URL(u).searchParams.get('datetime')!);
		expect(searches[0]).toBe(`${day(-20)}T00:00:00Z/${TODAY}T23:59:59Z`);
		expect(searches[1]).toBe(`${day(-386)}T00:00:00Z/${day(-21)}T23:59:59Z`);
		// The newest rows reach the worker first, so its since says nothing of the history: none is dropped.
		const f = (await readObservationFile(store, 'wofs', DAM_A.featureId))!;
		expect(f.rows[0]!.date < day(-60)).toBe(true);
	});

	it('starts a changed outline again, its old rows gone', async () => {
		const store = freshStore();
		await listed(store, [DAM_A]);
		await runWofsPass({ store, http: wofsHttp().http, today: TODAY, ...fast });
		const before = (await readObservationFile(store, 'wofs', DAM_A.featureId))!;
		const moved: WantedOutline = { ...DAM_A, geometry: { type: 'Polygon', coordinates: [ring(22.36, -32.12)] } };
		await listed(store, [moved]);
		// Refused at once: the new outline's file is written empty, so the old rows can't be loaded again.
		const r = await runWofsPass({ store, http: wofsHttp({ fail: () => new FeedRefusedError() }).http, today: TODAY, ...fast });
		expect(r.stopped).toBe('refused');
		const after = (await readObservationFile(store, 'wofs', DAM_A.featureId))!;
		expect(after.rows).toEqual([]);
		expect(before.rows.length).toBeGreaterThan(0);
		expect((await readStatus(store, 'wofs'))!.perKey[DAM_A.featureId]!.newest).toBeUndefined();
		expect((await readState(store))!.dams[DAM_A.featureId]).toMatchObject({ outline: outlineHash(moved) });
		expect((await readState(store))!.dams[DAM_A.featureId]!.scannedThrough).toBeUndefined();
	});

	it('stops the run on a 403, keeping what it read, and says so in the status', async () => {
		const store = freshStore();
		await listed(store, [DAM_A, DAM_B]);
		let scenes = 0;
		const { http, log } = wofsHttp({ fail: (url) => (url.startsWith(WOFS_S3_BASE) && ++scenes > 10 ? new FeedRefusedError() : null) });
		const r = await runWofsPass({ store, http, today: TODAY, ...fast });
		expect(r.stopped).toBe('refused');
		expect(r.error).toBeInstanceOf(FeedRefusedError);
		// Nothing asked after the 403.
		expect(log.filter((u) => u.startsWith(WOFS_S3_BASE)).length).toBe(11);
		const status = (await readStatus(store, 'wofs'))!;
		expect(status).toMatchObject({ stopped: true, reason: 'refused' });
		// The dam whose turn met it says so; what was read before it is written.
		expect(Object.values(status.perKey).filter((k) => k.error === 'refused')).toHaveLength(1);
		expect(r.written.length).toBeGreaterThan(0);
		for (const id of r.written) expect((await readObservationFile(store, 'wofs', id))!.rows.length).toBeGreaterThan(0);
	});

	it('stops on throttling too', async () => {
		const store = freshStore();
		await listed(store, [DAM_A]);
		const r = await runWofsPass({ store, http: wofsHttp({ fail: () => new FeedThrottledError(429, 60) }).http, today: TODAY, ...fast });
		expect(r.stopped).toBe('throttled');
		expect((await readStatus(store, 'wofs'))!).toMatchObject({ stopped: true, reason: 'throttled' });
	});

	it('leaves the source alone for a day after a 403: no request, no status written, then the run goes on', async () => {
		const store = freshStore();
		await listed(store, [DAM_A]);
		const c = clock();
		const r1 = await runWofsPass({ store, http: wofsHttp({ fail: () => new FeedRefusedError() }).http, today: TODAY, now: c.now, sleep: c.sleep, ...fast });
		expect(r1.stopped).toBe('refused');
		const stoppedStatus = (await readStatus(store, 'wofs'))!;
		// Twenty-three hours on (a later UTC day, so the dam is due again): paused.
		c.advance(23 * 3_600_000);
		const paused = wofsHttp();
		const r2 = await runWofsPass({ store, http: paused.http, today: day(1), now: c.now, sleep: c.sleep, ...fast });
		expect(r2).toMatchObject({ stopped: 'paused', pausedUntil: new Date(Date.parse(stoppedStatus.ranAt) + 24 * 3_600_000).toISOString(), turns: 0, written: [], stacRequests: 0, sceneRequests: 0, error: null });
		expect(paused.log).toEqual([]);
		// The stopped status stands, so the pause does too.
		expect(await readStatus(store, 'wofs')).toEqual(stoppedStatus);
		// A day after the stop: the pass runs again.
		c.advance(2 * 3_600_000);
		const resumed = wofsHttp();
		const r3 = await runWofsPass({ store, http: resumed.http, today: day(1), now: c.now, sleep: c.sleep, ...fast });
		expect(r3.stopped).toBe('done');
		expect(resumed.log.length).toBeGreaterThan(0);
		expect((await readStatus(store, 'wofs'))!.stopped).toBe(false);
	});

	it('honours a Retry-After longer than the day after throttling', async () => {
		const store = freshStore();
		await listed(store, [DAM_A]);
		const c = clock();
		await runWofsPass({ store, http: wofsHttp({ fail: () => new FeedThrottledError(503, 2 * 86_400) }).http, today: TODAY, now: c.now, sleep: c.sleep, ...fast });
		expect((await readStatus(store, 'wofs'))!).toMatchObject({ stopped: true, reason: 'throttled', retryAfterSeconds: 2 * 86_400 });
		c.advance(47 * 3_600_000);
		const paused = wofsHttp();
		expect((await runWofsPass({ store, http: paused.http, today: day(2), now: c.now, sleep: c.sleep, ...fast })).stopped).toBe('paused');
		expect(paused.log).toEqual([]);
		c.advance(2 * 3_600_000);
		expect((await runWofsPass({ store, http: wofsHttp().http, today: day(2), now: c.now, sleep: c.sleep, ...fast })).stopped).toBe('done');
	});

	it('ends a dam’s turn on a bad search or a timeout, and goes on with the next', async () => {
		const store = freshStore();
		await listed(store, [DAM_A, DAM_B]);
		const bboxA = outlineBbox(DAM_A).map((v) => Number(v.toFixed(6))).join(',');
		const { http } = wofsHttp({
			fail: (url) => (url.startsWith(WOFS_STAC_SEARCH) && new URL(url).searchParams.get('bbox') === bboxA ? new FeedUnavailableError('it did not answer in time') : null)
		});
		const r = await runWofsPass({ store, http, today: TODAY, ...fast });
		expect(r.stopped).toBe('done');
		expect(r.failures.map((f) => [f.featureId, f.code])).toEqual([[DAM_A.featureId, 'unavailable']]);
		expect(r.written).toEqual([DAM_B.featureId]);
		const status = (await readStatus(store, 'wofs'))!;
		expect(status.perKey[DAM_A.featureId]).toEqual({ error: 'unavailable' });
		expect(status.perKey[DAM_B.featureId]!.lastGood).toBeDefined();

		// The next hourly run doesn't ask about the failed dam again the same day.
		const same = wofsHttp();
		const r1 = await runWofsPass({ store, http: same.http, today: TODAY, ...fast });
		expect(r1).toMatchObject({ fresh: 2, written: [] });
		expect(same.log.filter((u) => u.startsWith(WOFS_STAC_SEARCH) && new URL(u).searchParams.get('bbox') === bboxA)).toEqual([]);

		// The next day: the failed dam's error clears once its turn goes cleanly.
		const r2 = await runWofsPass({ store, http: wofsHttp().http, today: day(1), ...fast });
		expect(r2.written).toEqual([DAM_A.featureId]);
		expect((await readStatus(store, 'wofs'))!.perKey[DAM_A.featureId]!.error).toBeUndefined();
	});

	it('skips a scene it can’t read, and reads the rest', async () => {
		const store = freshStore();
		await listed(store, [DAM_A]);
		let n = 0;
		const fx = wofsHttp();
		const http: FeedHttp = {
			...fx.http,
			// The first scene answers HTML instead of a TIFF.
			rangeTagged: async (url, s, e) => (url.startsWith(WOFS_S3_BASE) && n++ === 0 ? { bytes: new TextEncoder().encode('<html>oops</html>'), tag: null } : fx.http.rangeTagged!(url, s, e))
		};
		const r = await runWofsPass({ store, http, today: TODAY, ...fast });
		expect(r.sceneFailures).toHaveLength(1);
		expect(String(r.sceneFailures[0]!.error)).toMatch(/not a TIFF/);
		expect(r.written).toEqual([DAM_A.featureId]);
		expect((await readStatus(store, 'wofs'))!.perKey[DAM_A.featureId]!.error).toBe('scene_format');
	});

	it('drops a dam no longer listed from the status and state', async () => {
		const store = freshStore();
		await listed(store, [DAM_A, DAM_B]);
		await runWofsPass({ store, http: wofsHttp().http, today: TODAY, ...fast });
		await listed(store, [DAM_B]);
		await runWofsPass({ store, http: wofsHttp().http, today: TODAY, ...fast });
		expect(Object.keys((await readStatus(store, 'wofs'))!.perKey)).toEqual([DAM_B.featureId]);
		expect(Object.keys((await readState(store))!.dams)).toEqual([DAM_B.featureId]);
	});

	it('runs through the feeds’ fixture client (FEED_SOURCE=fixtures)', async () => {
		const store = freshStore();
		await listed(store, [{ ...DAM_A, since: day(-50) }]);
		const r = await runWofsPass({ store, http: fixtureHttp(() => TODAY), today: TODAY, ...fast });
		expect(r.stopped).toBe('done');
		expect((await readObservationFile(store, 'wofs', DAM_A.featureId))!.rows.length).toBeGreaterThan(0);
	});
});

describe('better', () => {
	const view = (itemId: string, clearPx: number, coveredPx: number) => ({
		scene: { itemId, date: '2026-01-01', datetime: '2026-01-01T08:00:00.000Z', url: 'u' } as WofsScene,
		wetAreaM2: 0,
		pctObserved: 0,
		clearPx,
		coveredPx
	});
	it('takes the scene that saw most clearly, then most, then the lower id', () => {
		expect(better(view('b', 10, 50), view('a', 9, 90)).scene.itemId).toBe('b');
		expect(better(view('b', 10, 50), view('a', 10, 90)).scene.itemId).toBe('a');
		expect(better(view('b', 10, 90), view('a', 10, 90)).scene.itemId).toBe('a');
		expect(better(view('a', 10, 90), view('b', 10, 90)).scene.itemId).toBe('a');
	});
});
