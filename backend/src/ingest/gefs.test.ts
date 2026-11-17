import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterAll, describe, expect, it } from 'vitest';
import { cellCentre, chcCell } from '../feeds/cellCache.js';
import { FeedRefusedError, FeedThrottledError } from '../feeds/errors.js';
import { fixtureHttp } from '../feeds/fixtures.js';
import type { FeedHttp } from '../feeds/http.js';
import { GEFS_DAYS, gefsUrl, gridValues } from '../feeds/sources/chirps.js';
import { writeGrid } from '../feeds/sources/tiff-write.js';
import { ensureDaily, openDaily, readDailyBlock, writeDailyDays } from '../mirror/arrays.js';
import { mirrorCell } from '../mirror/grid.js';
import { readManifest } from '../mirror/manifest.js';
import { openStore, type MirrorStore } from '../mirror/store.js';
import { MIRROR_LAG_METRIC, MIRROR_METRIC_NAMESPACE, type ThrottledAttempt } from './daily.js';
import { GEFS_KEEP_ISSUES, GEFS_REFUSED_KEY, gefsLagMetricLine, gefsProduct, readGefsIndex, readGefsRefused, runGefsIngest, writeGefsIndex } from './gefs.js';

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

function freshStore(): { dir: string; store: MirrorStore } {
	const dir = mkdtempSync(join(tmpdir(), 'wm-gefs-'));
	tmp.push(dir);
	return { dir, store: openStore(pathToFileURL(`${dir}/`).href) };
}

const add = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);

// A synthetic GEFS file: a 4 × 3 grid from 25.00° E, 20.00° S (inside the region), each issue and day its own values.
const GRID = { width: 4, height: 3, originLon: 25, originLat: -20, scale: 0.05 };
/** Row r (north to south), column c of an issue's forecast day `d` (0–15). */
const valueOf = (issue: string, d: number, r: number, c: number) => Math.fround(Number(issue.slice(8, 10)) / 10 + d + r * 0.25 + c * 0.01);
const fileOf = (issue: string, d: number) => {
	const values = new Float32Array(GRID.width * GRID.height);
	for (let r = 0; r < GRID.height; r++) for (let c = 0; c < GRID.width; c++) values[r * GRID.width + c] = valueOf(issue, d, r, c);
	return writeGrid({ ...GRID, values });
};

const GEFS_URL = /\/CHIRPS-GEFS\/v3\/daily\/global\/(\d{4})\/(\d{2})\/(\d{2})\/c3g_(\d{4})\.(\d{2})\.(\d{2})\.tif$/;
type Served = Uint8Array | 'refused';
/** Files by "issue/d" (absent = 404), logging each request's URL. */
function filesHttp(files: Map<string, Served>) {
	const log: string[] = [];
	const serve = (url: string) => {
		log.push(url);
		const m = GEFS_URL.exec(url);
		if (!m) return null;
		const issue = `${m[1]}-${m[2]}-${m[3]}`;
		const d = toEpochDay(`${m[4]}-${m[5]}-${m[6]}`) - toEpochDay(issue);
		const f = files.get(`${issue}/${d}`);
		if (f === 'refused') throw new FeedRefusedError();
		return f ?? null;
	};
	const http: FeedHttp = {
		range: async (url, s, e) => serve(url)?.subarray(s, e + 1) ?? null,
		rangeTagged: async (url, s, e) => {
			const f = serve(url);
			return f ? { bytes: f.subarray(s, e + 1), tag: `"t-${url.slice(-14, -4)}"` } : null;
		},
		text: async () => null
	};
	return { http, log };
}
/** Every file of each issue. */
const issues = (...list: string[]) => new Map<string, Served>(list.flatMap((issue) => Array.from({ length: GEFS_DAYS }, (_, d): [string, Served] => [`${issue}/${d}`, fileOf(issue, d)])));

/** The copy's value of an issue's day `d` at a point. */
async function copied(store: MirrorStore, issue: string, d: number, lat: number, lon: number): Promise<number> {
	const arr = (await openDaily(store, gefsProduct(issue)))!;
	const { y, x } = mirrorCell(chcCell(lat, lon));
	return (await readDailyBlock(arr, d, d, { y0: y, x0: x, h: 1, w: 1 })).values[0]!;
}

const run = (store: MirrorStore, http: FeedHttp, today: string, over: Partial<Parameters<typeof runGefsIngest>[0]> = {}) =>
	runGefsIngest({ store, http, today, intervalMs: 0, ...over });

const TODAY = '2026-03-10';

describe('the daily GEFS pass', () => {
	it('copies today’s complete issue, the 16th day first, about 3 requests a file, with its manifest and the index', async () => {
		const { store } = freshStore();
		const { http, log } = filesHttp(issues(TODAY));
		const r = await run(store, http, TODAY);
		expect(r).toMatchObject({ copied: TODAY, partial: null, held: [TODAY], deleted: [], lagDays: 0, stopped: 'copied', error: null });
		// Header, image directory, one range over the rows, per file.
		expect(r.requests).toBe(GEFS_DAYS * 3);
		expect(log[0]).toBe(gefsUrl(TODAY, add(TODAY, GEFS_DAYS - 1)));
		expect(log.at(-1)).toBe(gefsUrl(TODAY, add(TODAY, GEFS_DAYS - 2)));
		const m = (await readManifest(store, gefsProduct(TODAY)))!;
		expect(m).toMatchObject({ product: `gefs/${TODAY}`, revision: 1, finalThrough: null, prelimThrough: null, years: { first: 2026, last: 2026 }, changes: [] });
		// The files in day order, whatever order they were read in.
		expect(m.files.map((f) => f.url)).toEqual(Array.from({ length: GEFS_DAYS }, (_, d) => gefsUrl(TODAY, add(TODAY, d))));
		expect(m.files.every((f) => /^[0-9a-f]{64}$/.test(f.valuesSha256) && f.revision === 1 && f.etag?.startsWith('"t-'))).toBe(true);
		expect(new Set(m.files.map((f) => f.valuesSha256)).size).toBe(GEFS_DAYS);
		expect(await readGefsIndex(store)).toEqual([TODAY]);
		const arr = (await openDaily(store, gefsProduct(TODAY)))!;
		expect(arr.firstDay).toBe(TODAY);
		expect(arr.arr.shape).toEqual([GEFS_DAYS, 550, 620]);
	});

	it('writes the region’s rows south to north: the file’s first (northernmost) row is the copy’s higher y', async () => {
		const { store } = freshStore();
		await run(store, filesHttp(issues(TODAY)).http, TODAY);
		expect(await copied(store, TODAY, 7, -20.025, 25.025)).toBe(valueOf(TODAY, 7, 0, 0));
		expect(await copied(store, TODAY, 7, -20.125, 25.175)).toBe(valueOf(TODAY, 7, 2, 3));
		const north = mirrorCell(chcCell(-20.025, 25.025));
		const south = mirrorCell(chcCell(-20.125, 25.025));
		expect(north.y).toBe(south.y + 2);
		expect(north.x).toBe(south.x);
		// Outside the file: NaN.
		expect(Number.isNaN(await copied(store, TODAY, 7, -20.175, 25.025))).toBe(true);
	});

	it('takes yesterday’s issue when today’s is not out (its 16th day missing): one request for today', async () => {
		const { store } = freshStore();
		const { http, log } = filesHttp(issues(add(TODAY, -1)));
		const r = await run(store, http, TODAY);
		expect(r).toMatchObject({ copied: add(TODAY, -1), partial: null, held: [add(TODAY, -1)], lagDays: 1, stopped: 'copied' });
		expect(log[0]).toBe(gefsUrl(TODAY, add(TODAY, GEFS_DAYS - 1)));
		expect(log.filter((u) => u.includes(`/${TODAY.replaceAll('-', '/')}/`))).toHaveLength(1);
	});

	it('never copies a partly published issue: a missing day leaves it unlisted, and yesterday’s complete one is used', async () => {
		const { store } = freshStore();
		const files = issues(TODAY, add(TODAY, -1));
		files.delete(`${TODAY}/5`);
		const r = await run(store, filesHttp(files).http, TODAY);
		expect(r).toMatchObject({ copied: add(TODAY, -1), partial: TODAY, held: [add(TODAY, -1)], stopped: 'copied' });
		expect(await readManifest(store, gefsProduct(TODAY))).toBeNull();
		expect(await readGefsIndex(store)).toEqual([add(TODAY, -1)]);
		// Its chunks stay (it is newer than the newest held, so no sweep reaches it): the next run of that issue overwrites them and lists it.
		const done = issues(TODAY);
		const again = await run(store, filesHttp(done).http, TODAY);
		expect(again).toMatchObject({ copied: TODAY, held: [TODAY, add(TODAY, -1)] });
		expect(await copied(store, TODAY, 5, -20.025, 25.025)).toBe(valueOf(TODAY, 5, 0, 0));
	});

	it('neither today’s nor yesterday’s complete: nothing published, not_published, no lag without an issue held', async () => {
		const { store } = freshStore();
		const r = await run(store, filesHttp(new Map()).http, TODAY);
		expect(r).toMatchObject({ copied: null, held: [], lagDays: null, stopped: 'not_published', requests: 2 });
		expect(await readGefsIndex(store)).toBeNull();
	});

	it('an issue already held ends the run with no request', async () => {
		const { store } = freshStore();
		await run(store, filesHttp(issues(TODAY)).http, TODAY);
		const { http, log } = filesHttp(issues(TODAY));
		const r = await run(store, http, TODAY);
		expect(r).toMatchObject({ copied: null, stopped: 'up_to_date', requests: 0, lagDays: 0 });
		expect(log).toEqual([]);
		// The next morning before the new issue: yesterday's is held, one request for today's.
		const next = await run(store, filesHttp(issues(TODAY)).http, add(TODAY, 1));
		expect(next).toMatchObject({ copied: null, stopped: 'up_to_date', requests: 1, lagDays: 1 });
	});

	it('stops at an HTTP 403 with no request after it, and publishes nothing', async () => {
		const { store } = freshStore();
		const files = issues(TODAY, add(TODAY, -1));
		files.set(`${TODAY}/3`, 'refused');
		const { http, log } = filesHttp(files);
		const r = await run(store, http, TODAY);
		expect(r.stopped).toBe('error');
		expect(r.error).toBeInstanceOf(FeedRefusedError);
		expect(r.copied).toBeNull();
		expect(log.at(-1)).toBe(gefsUrl(TODAY, add(TODAY, 3)));
		expect(log.filter((u) => u === gefsUrl(TODAY, add(TODAY, 3)))).toHaveLength(1);
		// Not on to yesterday's: the run is over.
		expect(log.some((u) => u.includes(`/${add(TODAY, -1).replaceAll('-', '/')}/`))).toBe(false);
		expect(await readGefsIndex(store)).toBeNull();
		expect(await readManifest(store, gefsProduct(TODAY))).toBeNull();
	});

	// The rule runs hourly 08:38–11:38 UTC, each run a fresh invocation: a 403 must not be asked again within the hour.
	it('after an HTTP 403, writes the refusal marker; later runs that UTC day ask CHC nothing, and the next day tries again', async () => {
		const { store } = freshStore();
		const refusedAt = Date.parse(`${TODAY}T08:38:05Z`);
		const refused = new Map<string, Served>([[`${TODAY}/${GEFS_DAYS - 1}`, 'refused']]);
		const first = await run(store, filesHttp(refused).http, TODAY, { now: () => refusedAt });
		expect(first).toMatchObject({ stopped: 'error', requests: 1, refusedAt: new Date(refusedAt).toISOString(), markerError: null });
		expect(await readGefsRefused(store)).toBe(new Date(refusedAt).toISOString());

		// 09:38 and 11:38 the same day: nothing asked, reported as refused_today (the lag still measured).
		for (const hour of ['09:38', '11:38']) {
			const { http, log } = filesHttp(issues(TODAY));
			const r = await run(store, http, TODAY, { now: () => Date.parse(`${TODAY}T${hour}:00Z`) });
			expect(r, hour).toMatchObject({ stopped: 'refused_today', requests: 0, error: null, copied: null, refusedAt: new Date(refusedAt).toISOString(), lagDays: null });
			expect(log, hour).toEqual([]);
		}

		// The next UTC day's first run asks again (positive control), and copies.
		const tomorrow = add(TODAY, 1);
		const { http, log } = filesHttp(issues(tomorrow));
		const next = await run(store, http, tomorrow, { now: () => Date.parse(`${tomorrow}T08:38:00Z`) });
		expect(next).toMatchObject({ stopped: 'copied', copied: tomorrow, refusedAt: null, error: null });
		expect(log.length).toBeGreaterThan(0);
	});

	it('a refusal marker that isn’t one never blocks a run', async () => {
		const { store } = freshStore();
		await store.set(GEFS_REFUSED_KEY, new TextEncoder().encode('{"v":2}'));
		expect(await readGefsRefused(store)).toBeNull();
		const r = await run(store, filesHttp(issues(TODAY)).http, TODAY, { now: () => Date.parse(`${TODAY}T09:38:00Z`) });
		expect(r.stopped).toBe('copied');
	});

	it('reports a refusal marker it could not write beside the 403, which stays the failure reported', async () => {
		const { store: inner } = freshStore();
		const broken = new Error('the bucket refused the write');
		const store = { get: (k: never) => inner.get(k), set: async (k: string, v: Uint8Array) => (k === GEFS_REFUSED_KEY ? Promise.reject(broken) : inner.set(k as never, v)) } as unknown as MirrorStore;
		const r = await run(store, filesHttp(new Map<string, Served>([[`${TODAY}/${GEFS_DAYS - 1}`, 'refused']])).http, TODAY);
		expect(r.error).toBeInstanceOf(FeedRefusedError);
		expect(r.markerError).toBe(broken);
	});

	it('keeps the newest 7 issues and deletes the older ones’ arrays, and sweeps an unlisted array a cut-short run left', async () => {
		const { dir, store } = freshStore();
		// Seven issues held, the days before today.
		const older = Array.from({ length: GEFS_KEEP_ISSUES }, (_, i) => add(TODAY, -2 - i));
		for (const issue of older) await run(store, filesHttp(issues(issue)).http, issue);
		expect(await readGefsIndex(store)).toEqual(older);
		// A cut-short run's array: an unlisted issue between them.
		const orphan = add(TODAY, -1);
		const arr = await ensureDaily(store, gefsProduct(orphan), orphan, GEFS_DAYS);
		await writeDailyDays(arr, 0, { y0: 0, x0: 0, h: 1, w: 1 }, new Float32Array([1]));
		expect(existsSync(join(dir, 'gefs', orphan, 'zarr.json'))).toBe(true);

		const r = await run(store, filesHttp(issues(TODAY)).http, TODAY);
		expect(r.held).toEqual([TODAY, ...older.slice(0, GEFS_KEEP_ISSUES - 1)]);
		expect(r.deleted.sort()).toEqual([older.at(-1)!, orphan].sort());
		expect(await readGefsIndex(store)).toEqual(r.held);
		for (const gone of [older.at(-1)!, orphan]) {
			expect(existsSync(join(dir, 'gefs', gone, 'zarr.json'))).toBe(false);
			expect(existsSync(join(dir, 'gefs', gone, 'manifest.json'))).toBe(false);
			expect(existsSync(join(dir, 'gefs', gone, 'c', '0', '0', '0'))).toBe(false);
		}
		// A kept issue is untouched.
		expect(await copied(store, older[0]!, 2, -20.025, 25.025)).toBe(valueOf(older[0]!, 2, 0, 0));
	});

	it('paces every request at least a second after the one before', async () => {
		const { store } = freshStore();
		let clock = 0;
		const starts: number[] = [];
		const inner = filesHttp(issues(TODAY)).http;
		const http: FeedHttp = { ...inner, rangeTagged: async (u, s, e) => (starts.push(clock), inner.rangeTagged!(u, s, e)) };
		const r = await runGefsIngest({ store, http, today: TODAY, intervalMs: 1000, now: () => clock, sleep: async (ms) => void (clock += ms) });
		expect(r.stopped).toBe('copied');
		expect(starts).toHaveLength(GEFS_DAYS * 3);
		expect(starts.slice(1).every((t, i) => t - starts[i]! >= 1000)).toBe(true);
	});

	it('waits out a 429 and asks the same file again, copying the issue (CHC, 2026-11-10)', async () => {
		const { store } = freshStore();
		let clock = 0;
		const sleeps: number[] = [];
		const events: ThrottledAttempt[] = [];
		const inner = filesHttp(issues(TODAY));
		const target = gefsUrl(TODAY, add(TODAY, 4));
		let left = 1;
		const http: FeedHttp = {
			...inner.http,
			rangeTagged: async (u, s, e) => {
				if (u === target && left-- > 0) throw new FeedThrottledError(429, 12);
				return inner.http.rangeTagged!(u, s, e);
			}
		};
		const r = await run(store, http, TODAY, {
			intervalMs: 1000,
			now: () => clock,
			sleep: async (ms) => void (sleeps.push(ms), (clock += ms)),
			deadline: 10 * 60_000,
			onThrottled: (t) => events.push(t)
		});
		expect(r).toMatchObject({ stopped: 'copied', copied: TODAY, error: null, refusedAt: null });
		expect(r.requests).toBe(GEFS_DAYS * 3 + 1);
		expect(events).toEqual([{ url: target, status: 429, attempt: 1, of: 4, retryAfterSeconds: 12, waitSeconds: 12, retrying: true }]);
		expect(sleeps).toContain(12_000);
		expect(await readGefsIndex(store)).toEqual([TODAY]);
	});

	it('a 429 that outlasts 3 retries ends the run: nothing published, no refusal marker', async () => {
		const { store } = freshStore();
		const inner = filesHttp(issues(TODAY, add(TODAY, -1)));
		const target = gefsUrl(TODAY, add(TODAY, GEFS_DAYS - 1));
		let asked = 0;
		const http: FeedHttp = {
			...inner.http,
			rangeTagged: async (u, s, e) => {
				if (u === target) {
					asked++;
					throw new FeedThrottledError(503);
				}
				return inner.http.rangeTagged!(u, s, e);
			}
		};
		const events: ThrottledAttempt[] = [];
		const r = await run(store, http, TODAY, { sleep: async () => {}, onThrottled: (t) => events.push(t) });
		expect(r.stopped).toBe('error');
		expect(r.error).toBeInstanceOf(FeedThrottledError);
		expect(asked).toBe(4);
		expect(events.map((e) => e.retrying)).toEqual([true, true, true, false]);
		expect(r.requests).toBe(4);
		expect(await readGefsIndex(store)).toBeNull();
		expect(await readGefsRefused(store)).toBeNull();
	});

	it('does not retry a 429 when the deadline leaves no room for the wait', async () => {
		const { store } = freshStore();
		let clock = 0;
		const inner = filesHttp(issues(TODAY));
		let asked = 0;
		const http: FeedHttp = { ...inner.http, rangeTagged: async () => (asked++, Promise.reject(new FeedThrottledError(429))) };
		const events: ThrottledAttempt[] = [];
		const r = await run(store, http, TODAY, { now: () => clock, sleep: async (ms) => void (clock += ms), deadline: 30_000, onThrottled: (t) => events.push(t) });
		expect(r.stopped).toBe('error');
		expect(asked).toBe(1);
		expect(events).toMatchObject([{ waitSeconds: 60, retrying: false }]);
	});

	it('never retries a 403', async () => {
		const { store } = freshStore();
		const events: ThrottledAttempt[] = [];
		const { http, log } = filesHttp(new Map<string, Served>([[`${TODAY}/${GEFS_DAYS - 1}`, 'refused']]));
		const r = await run(store, http, TODAY, { onThrottled: (t) => events.push(t) });
		expect(r.error).toBeInstanceOf(FeedRefusedError);
		expect([log.length, r.requests]).toEqual([1, 1]);
		expect(events).toEqual([]);
	});

	it('stops at the deadline before a file, publishing nothing', async () => {
		const { store } = freshStore();
		let clock = 0;
		const r = await runGefsIngest({
			store,
			http: filesHttp(issues(TODAY)).http,
			today: TODAY,
			intervalMs: 1000,
			now: () => clock,
			sleep: async (ms) => void (clock += ms),
			deadline: 20_000
		});
		expect(r).toMatchObject({ stopped: 'deadline', copied: null, held: [] });
		expect(await readGefsIndex(store)).toBeNull();
	});

	it('in fixtures mode copies the synthetic files the per-feed fetch reads, value for value', async () => {
		const { store } = freshStore();
		const http = fixtureHttp(() => TODAY);
		const r = await run(store, http, TODAY);
		expect(r).toMatchObject({ copied: TODAY, stopped: 'copied' });
		const pt = cellCentre(chcCell(-20.12, 25.17));
		for (const d of [0, 9, 15]) {
			const [want] = (await gridValues(http, gefsUrl(TODAY, add(TODAY, d)), [pt]))!;
			expect(await copied(store, TODAY, d, pt.lat, pt.lon)).toBe(want);
		}
		// A cell of the cover outside the grid, and the sea cell (NaN).
		const far = cellCentre(chcCell(-30.02, 22.03));
		expect(await copied(store, TODAY, 4, far.lat, far.lon)).toBe((await gridValues(http, gefsUrl(TODAY, add(TODAY, 4)), [far]))![0]);
		expect(Number.isNaN(await copied(store, TODAY, 4, -20.275, 25.375))).toBe(true);
	});

	it('refuses an index that isn’t newest first', async () => {
		const { store } = freshStore();
		await expect(writeGefsIndex(store, ['2026-01-01', '2026-01-02'])).rejects.toThrow();
		await writeGefsIndex(store, ['2026-01-02', '2026-01-01']);
		expect(await readGefsIndex(store)).toEqual(['2026-01-02', '2026-01-01']);
	});

	it('publishes its lag as MirrorLagDays{Product=gefs} in the namespace the alarm reads', () => {
		const line = JSON.parse(gefsLagMetricLine(1, 1_700_000_000_000));
		expect(line).toEqual({
			_aws: { Timestamp: 1_700_000_000_000, CloudWatchMetrics: [{ Namespace: MIRROR_METRIC_NAMESPACE, Dimensions: [['Product']], Metrics: [{ Name: MIRROR_LAG_METRIC, Unit: 'None' }] }] },
			Product: 'gefs',
			[MIRROR_LAG_METRIC]: 1
		});
		expect(MIRROR_METRIC_NAMESPACE).toBe('water-management/Mirror');
	});
});
