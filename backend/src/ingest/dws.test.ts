// The weekly DWS pass (ingest/dws.ts): the window, the pacing, only the listed
// stations, and a 403 or the ScriptServer page stopping the run.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterAll, describe, expect, it } from 'vitest';
import { FeedFormatError, FeedRefusedError, FeedThrottledError } from '../feeds/errors.js';
import { fixtureHttp, renderDwsPage } from '../feeds/fixtures.js';
import type { FeedHttp } from '../feeds/http.js';
import { DWS_FORMAT_FAILURES, DWS_WINDOW_DAYS, dwsFailureLabel } from '../feeds/sources/dws.js';
import { openStore, type MirrorStore } from '../mirror/store.js';
import { MIRROR_LAG_METRIC, MIRROR_METRIC_NAMESPACE } from './daily.js';
import {
	dwsLagMetricLine,
	readStationFile,
	readStatus,
	REFRESH_DAYS,
	runDwsWeekly,
	STATUS_KEY,
	stationKey,
	StationFile,
	StationsFile,
	writeStations
} from './dws.js';

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
function freshStore(): MirrorStore {
	const dir = mkdtempSync(join(tmpdir(), 'wm-dws-weekly-'));
	tmp.push(dir);
	return openStore(pathToFileURL(`${dir}/`).href);
}

const TODAY = '2026-10-25';
const T0 = Date.parse(`${TODAY}T04:00:00Z`);
const day = (n: number) => fromEpochDay(toEpochDay(TODAY) + n);

/** A clock that only the pass's sleeps move (so pacing is measured, not waited for). */
function clock(start = T0) {
	let t = start;
	const sleeps: number[] = [];
	return { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)), sleeps, advance: (ms: number) => void (t += ms) };
}

/** A FeedHttp answering `text` per station (a page, null, or an error thrown), logging each URL. */
function stationsHttp(answer: (station: string, url: URL) => string | null | Error) {
	const log: URL[] = [];
	const http: FeedHttp = {
		range: async () => null,
		text: async (url) => {
			const u = new URL(url);
			log.push(u);
			const a = answer(u.searchParams.get('Station')!.replace(/100\.00$/, ''), u);
			if (a instanceof Error) throw a;
			return a;
		}
	};
	return { http, log };
}

const page = (station: string, rows: { date: string; value: number | null; quality: string }[]) => renderDwsPage(station, rows);
const list = (stations: string[], at = `${day(-30)}T00:00:00.000Z`): StationsFile => ({ v: 1, at, stations });

describe('the weekly DWS pass', () => {
	it('asks each listed station for the newest two years, today included, and writes its rows with their quality codes', async () => {
		const store = freshStore();
		await writeStations(store, list(['X0H000', 'X0H001']));
		const { http, log } = stationsHttp((s) =>
			page(s, [
				{ date: day(-100), value: 1.25, quality: '1' },
				{ date: day(-99), value: null, quality: '170' },
				{ date: day(-98), value: 2.5, quality: '50' }
			])
		);
		const c = clock();
		const r = await runDwsWeekly({ store, http, today: TODAY, now: c.now, sleep: c.sleep });
		expect(r).toMatchObject({ fetched: ['X0H000', 'X0H001'], failed: [], fresh: 0, stopped: 'done', requests: 2, error: null });
		expect(log.map((u) => [u.searchParams.get('Station'), u.searchParams.get('StartDT'), u.searchParams.get('EndDT'), u.searchParams.get('SiteType')])).toEqual([
			['X0H000100.00', day(-(DWS_WINDOW_DAYS - 1)), TODAY, 'RIV'],
			['X0H001100.00', day(-(DWS_WINDOW_DAYS - 1)), TODAY, 'RIV']
		]);
		const file = await readStationFile(store, 'X0H001');
		expect(file).toEqual({
			v: 1,
			station: 'X0H001',
			from: day(-(DWS_WINDOW_DAYS - 1)),
			to: TODAY,
			fetchedAt: expect.any(String),
			rows: [
				[day(-100), 1.25, '1'],
				[day(-99), null, '170'],
				[day(-98), 2.5, '50']
			]
		});
		const status = await readStatus(store);
		expect(status).toMatchObject({ stale: false, reason: null, stations: { X0H000: { okAt: expect.any(String) }, X0H001: { okAt: expect.any(String) } } });
		// Both fetched today: no lag.
		expect(r.lagDays).toBe(0);
	});

	it('waits a second between requests (the pacing), and none before the first', async () => {
		const store = freshStore();
		await writeStations(store, list(['X0H000', 'X0H001', 'X0H002']));
		const { http } = stationsHttp((s) => page(s, []));
		const c = clock();
		await runDwsWeekly({ store, http, today: TODAY, now: c.now, sleep: c.sleep, intervalMs: 1000 });
		expect(c.sleeps).toEqual([1000, 1000]);
	});

	it('fetches only the listed stations, and leaves a station fetched within REFRESH_DAYS until it is due', async () => {
		const store = freshStore();
		await writeStations(store, list(['X0H000', 'X0H001']));
		const first = stationsHttp((s) => page(s, []));
		const c = clock();
		await runDwsWeekly({ store, http: first.http, today: TODAY, now: c.now, sleep: c.sleep });
		// A day later, with a third station listed: only the new one is due.
		await writeStations(store, list(['X0H000', 'X0H001', 'X0H002']));
		c.advance(86_400_000);
		const second = stationsHttp((s) => page(s, []));
		const r = await runDwsWeekly({ store, http: second.http, today: day(1), now: c.now, sleep: c.sleep });
		expect(second.log.map((u) => u.searchParams.get('Station'))).toEqual(['X0H002100.00']);
		expect(r).toMatchObject({ fetched: ['X0H002'], fresh: 2 });
		// REFRESH_DAYS on, all three are due again, the oldest fetches first; a station dropped from the list drops from the status.
		await writeStations(store, list(['X0H001', 'X0H002']));
		c.advance(REFRESH_DAYS * 86_400_000);
		const third = stationsHttp((s) => page(s, []));
		await runDwsWeekly({ store, http: third.http, today: day(1 + REFRESH_DAYS), now: c.now, sleep: c.sleep });
		expect(third.log.map((u) => u.searchParams.get('Station'))).toEqual(['X0H001100.00', 'X0H002100.00']);
		expect(Object.keys((await readStatus(store))!.stations).sort()).toEqual(['X0H001', 'X0H002']);
	});

	it('does nothing without a station list (the worker has not published one yet)', async () => {
		const store = freshStore();
		const { http, log } = stationsHttp(() => page('X0H000', []));
		const r = await runDwsWeekly({ store, http, today: TODAY });
		expect(r).toMatchObject({ stopped: 'no_stations', requests: 0, lagDays: null });
		expect(log).toHaveLength(0);
		expect(await store.get(STATUS_KEY)).toBeUndefined();
	});

	for (const [what, error, reason] of [
		['an HTTP 403', new FeedRefusedError(), 'refused'],
		['throttling (HTTP 429)', new FeedThrottledError(429, 60), 'throttled']
	] as const) {
		it(`stops at ${what}, asks no other station, marks the source stale and keeps the stations already fetched`, async () => {
			const store = freshStore();
			await writeStations(store, list(['X0H000', 'X0H001', 'X0H002']));
			const { http, log } = stationsHttp((s) => (s === 'X0H001' ? error : page(s, [{ date: day(-90), value: 1, quality: '1' }])));
			const c = clock();
			const r = await runDwsWeekly({ store, http, today: TODAY, now: c.now, sleep: c.sleep });
			expect(r).toMatchObject({ fetched: ['X0H000'], stopped: reason, requests: 2 });
			expect(r.error).toBe(error);
			expect(log).toHaveLength(2);
			expect(await readStatus(store)).toMatchObject({ stale: true, reason, stations: { X0H000: { okAt: expect.any(String) }, X0H001: { okAt: null } } });
			expect(await readStationFile(store, 'X0H000')).not.toBeNull();
			expect(await readStationFile(store, 'X0H001')).toBeNull();
			// X0H001 never fetched: the lag counts from the list's date, 30 days ago.
			expect(r.lagDays).toBe(30);
		});
	}

	it('stops at DWS’s ScriptServer error page (sent with HTTP 200) the same way', async () => {
		const store = freshStore();
		await writeStations(store, list(['X0H000', 'X0H001']));
		const scriptServer = '<html><body><h1>ScriptServer error</h1><p>Unable to establish connection</p></body></html>';
		const { http, log } = stationsHttp(() => scriptServer);
		const r = await runDwsWeekly({ store, http, today: TODAY, intervalMs: 0 });
		expect(r).toMatchObject({ fetched: [], stopped: 'server_error', requests: 1 });
		expect(log).toHaveLength(1);
		expect(await readStatus(store)).toMatchObject({ stale: true, reason: 'server_error' });
	});

	it('skips a station whose page fails another way (a changed layout), and goes on with the rest', async () => {
		const store = freshStore();
		await writeStations(store, list(['X0H000', 'X0H001']));
		const { http } = stationsHttp((s) => (s === 'X0H000' ? '<html><body><p>Maintenance</p></body></html>' : page(s, [])));
		const r = await runDwsWeekly({ store, http, today: TODAY, intervalMs: 0 });
		expect(r).toMatchObject({ fetched: ['X0H001'], failed: ['X0H000'], stopped: 'done', error: null });
		expect(await readStatus(store)).toMatchObject({ stale: false, stations: { X0H000: { okAt: null }, X0H001: { okAt: expect.any(String) } } });
	});

	// A row past the store's bounds (247_gauge_record.sql) used to throw a ZodError out of the pass before the status
	// was written, losing every station fetched before it, and the bad station sorted first again the next day.
	for (const [what, row, check] of [
		['a flow of 1e9 m³/s', { date: day(-90), value: 1e9, quality: '1' }, 'flow'],
		['a quality code 1.5', { date: day(-90), value: 1, quality: '1.5' }, 'quality'],
		['a quality code 1-2', { date: day(-90), value: 1, quality: '1-2' }, 'quality'],
		['a quality code longer than 8', { date: day(-90), value: 1, quality: 'A12345678' }, 'quality']
	] as const) {
		it(`skips a station whose page lists ${what} (a format failure of that station), and loads the others`, async () => {
			const store = freshStore();
			await writeStations(store, list(['X0H000', 'X0H001', 'X0H002']));
			const good = [{ date: day(-90), value: 1.5, quality: '1' }];
			const { http } = stationsHttp((s) => page(s, s === 'X0H001' ? [row] : good));
			const r = await runDwsWeekly({ store, http, today: TODAY, intervalMs: 0 });
			expect(r).toMatchObject({ fetched: ['X0H000', 'X0H002'], failed: ['X0H001'], stopped: 'done', error: null });
			// Why, for the log: a format failure whose label names the check (never the page's text).
			expect(r.failures).toHaveLength(1);
			expect(r.failures[0]!.station).toBe('X0H001');
			expect(r.failures[0]!.error).toBeInstanceOf(FeedFormatError);
			expect(dwsFailureLabel((r.failures[0]!.error as Error).message)).toBe(DWS_FORMAT_FAILURES[check][1]);
			// Positive control: the others' files and the status are written, and the bad station's file is not.
			expect((await readStationFile(store, 'X0H000'))!.rows).toEqual([[day(-90), 1.5, '1']]);
			expect((await readStationFile(store, 'X0H002'))!.rows).toEqual([[day(-90), 1.5, '1']]);
			expect(await readStationFile(store, 'X0H001')).toBeNull();
			expect(await readStatus(store)).toMatchObject({
				stale: false,
				stations: { X0H000: { okAt: expect.any(String) }, X0H001: { okAt: null, triedAt: expect.any(String) }, X0H002: { okAt: expect.any(String) } }
			});
		});
	}

	it('writes the status even when the run stops on its own failure, so the stations fetched before it reach the worker', async () => {
		const dir = freshStore();
		await writeStations(dir, list(['X0H000', 'X0H001', 'X0H002']));
		const broken = new Error('the bucket refused the write');
		// The mirror refuses X0H001's file: ours, not DWS's, so the run throws.
		const store: MirrorStore = { ...dir, get: (k) => dir.get(k), set: async (k, v) => (k === stationKey('X0H001') ? Promise.reject(broken) : dir.set(k, v)) } as MirrorStore;
		const { http } = stationsHttp((s) => page(s, [{ date: day(-90), value: 1, quality: '1' }]));
		await expect(runDwsWeekly({ store, http, today: TODAY, intervalMs: 0 })).rejects.toBe(broken);
		const status = (await readStatus(dir))!;
		expect(status.stations.X0H000?.okAt).toEqual(expect.any(String));
		expect(status.stations.X0H001?.okAt ?? null).toBeNull();
		expect(await readStationFile(dir, 'X0H000')).not.toBeNull();
	});

	it('gives every station its turn when more keep failing than one run reaches (failures go behind the rest)', async () => {
		const store = freshStore();
		const failing = ['X0H000', 'X0H001', 'X0H002', 'X0H003'];
		const healthy = ['X0H010', 'X0H011'];
		await writeStations(store, list([...failing, ...healthy]));
		const { http, log } = stationsHttp((s) => (failing.includes(s) ? '<html><body><p>Maintenance</p></body></html>' : page(s, [])));
		const c = clock();
		// One run reaches three stations (a second a request, the deadline after the third starts).
		const run = async () => {
			const r = await runDwsWeekly({ store, http, today: TODAY, now: c.now, sleep: c.sleep, intervalMs: 1000, deadline: c.now() + 1500 });
			c.advance(86_400_000);
			return r;
		};
		const fetched: string[] = [];
		for (let i = 0; i < 3; i++) fetched.push(...(await run()).fetched);
		expect(fetched.sort()).toEqual(healthy);
		// The failing ones were each tried too, none twice before every other had its turn.
		const asked = log.map((u) => u.searchParams.get('Station')!.replace(/100\.00$/, ''));
		expect(new Set(asked.slice(0, 6)).size).toBe(6);
	});

	it('stops starting stations at the deadline; the rest go first next run', async () => {
		const store = freshStore();
		await writeStations(store, list(['X0H000', 'X0H001', 'X0H002']));
		const { http } = stationsHttp((s) => page(s, []));
		const c = clock();
		const r = await runDwsWeekly({ store, http, today: TODAY, now: c.now, sleep: c.sleep, intervalMs: 1000, deadline: T0 + 500 });
		expect(r).toMatchObject({ fetched: ['X0H000', 'X0H001'], stopped: 'deadline' });
		c.advance(3_600_000);
		const next = stationsHttp((s) => page(s, []));
		await runDwsWeekly({ store, http: next.http, today: TODAY, now: c.now, sleep: c.sleep });
		expect(next.log.map((u) => u.searchParams.get('Station'))).toEqual(['X0H002100.00']);
	});

	it('writes what the synthetic DWS page serves (the same reader as the feed), never a day outside the window', async () => {
		const store = freshStore();
		await writeStations(store, list(['X0H000']));
		await runDwsWeekly({ store, http: fixtureHttp(() => TODAY), today: TODAY, intervalMs: 0 });
		const file = (await readStationFile(store, 'X0H000'))!;
		expect(file.rows.length).toBeGreaterThan(600);
		expect(file.rows.every(([d]) => d >= file.from && d <= file.to)).toBe(true);
		expect(StationFile.safeParse(file).success).toBe(true);
	});

	it('refuses a station list or file that is not the format (a river gauge code, rows in order and inside the window)', async () => {
		expect(StationsFile.safeParse(list(['X0R000'])).success).toBe(false);
		expect(StationsFile.safeParse(list(['X0H000', 'X0H000'])).success).toBe(false);
		const ok: StationFile = { v: 1, station: 'X0H000', from: day(-10), to: TODAY, fetchedAt: `${TODAY}T04:00:00.000Z`, rows: [[day(-2), 1, '1']] };
		expect(StationFile.safeParse(ok).success).toBe(true);
		expect(StationFile.safeParse({ ...ok, rows: [[day(-20), 1, '1']] }).success).toBe(false);
		expect(StationFile.safeParse({ ...ok, rows: [[day(-1), 1, '1'], [day(-2), 1, '1']] }).success).toBe(false);
		expect(StationFile.safeParse({ ...ok, rows: [[day(-2), -1, '1']] }).success).toBe(false);
		expect(StationFile.safeParse({ ...ok, from: day(-800) }).success).toBe(false);
		const store = freshStore();
		await store.set(stationKey('X0H000'), new TextEncoder().encode('{"v":2}'));
		await expect(readStationFile(store, 'X0H000')).rejects.toThrow(/not valid/);
	});

	it('publishes its lag as MirrorLagDays for Product=dws, in the namespace the alarm reads', () => {
		const line = JSON.parse(dwsLagMetricLine(9, 1000));
		expect(line).toMatchObject({ Product: 'dws', [MIRROR_LAG_METRIC]: 9 });
		expect(line._aws.CloudWatchMetrics[0]).toMatchObject({ Namespace: MIRROR_METRIC_NAMESPACE, Dimensions: [['Product']] });
	});
});
