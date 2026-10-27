import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FeedFormatError, FeedRefusedError, FeedThrottledError } from '../../feeds/errors.js';
import { openStore } from '../../mirror/store.js';
import { readObservationFile, readStatus, writeWanted } from './handover.js';
import {
	fixtureWaterbodiesHttp,
	parseWaterbodiesCsv,
	runWaterbodiesPass,
	WATERBODIES_FIXTURE_DIR,
	WATERBODIES_HEADER,
	WATERBODIES_SERIES_BASE,
	type WaterbodiesHttp,
	waterbodiesUrl
} from './waterbodies.js';

const HEAD = WATERBODIES_HEADER.join(',');
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function store() {
	const dir = mkdtempSync(join(tmpdir(), 'wm-wb-'));
	dirs.push(dir);
	return openStore(pathToFileURL(`${dir}/`).href);
}
/** The committed synthetic uids. */
const UIDS = readdirSync(WATERBODIES_FIXTURE_DIR)
	.filter((f) => f.endsWith('.csv'))
	.map((f) => f.slice(0, -4))
	.sort();
const NOW = Date.parse('2026-10-27T04:00:00Z');
const want = (s: ReturnType<typeof store>, uids: string[]) => writeWanted(s, { generatedAt: new Date(NOW).toISOString(), waterbodies: uids, outlines: [] });

describe('parseWaterbodiesCsv', () => {
	it('reads the wet area and the share seen (100 − pc_invalid), dropping dates nothing was seen on', () => {
		const rows = parseWaterbodiesCsv(
			[
				HEAD,
				'2023-01-01,100,40,36000,60,54000,0,0,40.00,60.00,0.00',
				'2023-01-17,100,0,0,0,0,100,90000,,,100.00',
				'2023-02-02,100,20,18000,30,27000,50,45000,20.00,30.00,50.00',
				'2023-02-18T08:12:00Z,100,10,9000,90,81000,0,0,10.00,90.00,0'
			].join('\n'),
			'zzzzza0001'
		);
		expect(rows).toEqual([
			{ date: '2023-01-01', wetAreaM2: 36000, pctObserved: 100, upstreamKey: 'zzzzza0001' },
			{ date: '2023-02-02', wetAreaM2: 18000, pctObserved: 50, upstreamKey: 'zzzzza0001' },
			{ date: '2023-02-18', wetAreaM2: 9000, pctObserved: 100, upstreamKey: 'zzzzza0001' }
		]);
	});

	it('keeps the clearest of two rows on one date, and sorts by date', () => {
		const rows = parseWaterbodiesCsv([HEAD, '2023-02-02,100,20,18000,30,27000,50,45000,20,30,50', '2023-01-01,100,1,900,1,900,98,1,1,1,98', '2023-02-02,100,30,27000,60,54000,10,9000,30,60,10'].join('\n'), 'zzzzza0001');
		expect(rows.map((r) => [r.date, r.pctObserved])).toEqual([
			['2023-01-01', 2],
			['2023-02-02', 90]
		]);
	});

	it('refuses a changed layout or an unreadable value, as a format failure', () => {
		expect(() => parseWaterbodiesCsv('', 'zzzzza0001')).toThrow(FeedFormatError);
		expect(() => parseWaterbodiesCsv('date,area_wet_m2\n2023-01-01,1', 'zzzzza0001')).toThrow(/columns changed/);
		expect(() => parseWaterbodiesCsv(`${HEAD}\nyesterday,1,1,1,1,1,0,0,1,1,0`, 'zzzzza0001')).toThrow(/no date/);
		expect(() => parseWaterbodiesCsv(`${HEAD}\n2023-01-01,1,1,1,1,1,0,0,1,1`, 'zzzzza0001')).toThrow(/columns/);
		expect(() => parseWaterbodiesCsv(`${HEAD}\n2023-01-01,1,1,-5,1,1,0,0,1,1,0`, 'zzzzza0001')).toThrow(/wet area/);
		expect(() => parseWaterbodiesCsv(`${HEAD}\n2023-01-01,1,1,5,1,1,0,0,1,1,150`, 'zzzzza0001')).toThrow(/share invalid/);
	});

	it('reads every committed synthetic series, each ending on 2023-09-17 as the public ones do', () => {
		expect(UIDS.length).toBeGreaterThan(0);
		const http = fixtureWaterbodiesHttp();
		return Promise.all(
			UIDS.map(async (uid) => {
				const got = await http.textConditional(waterbodiesUrl(uid), null);
				if (got?.status !== 'ok') throw new Error(`no fixture for ${uid}`);
				const rows = parseWaterbodiesCsv(got.text, uid);
				expect(rows.at(-1)!.date).toBe('2023-09-17');
				expect(rows.every((r) => r.pctObserved > 0 && r.wetAreaM2 >= 0)).toBe(true);
			})
		);
	});
});

describe('the fixture client', () => {
	it('answers the series URLs with an ETag, 304 on that ETag, and 404 for anything else', async () => {
		const http = fixtureWaterbodiesHttp();
		const url = waterbodiesUrl(UIDS[0]!);
		expect(url).toBe(`${WATERBODIES_SERIES_BASE}${UIDS[0]!.slice(0, 4)}/${UIDS[0]}.csv`);
		const got = await http.textConditional(url, null);
		expect(got).toMatchObject({ status: 'ok', etag: expect.stringMatching(/^"fx-[0-9a-f]{16}"$/) });
		expect(await http.textConditional(url, got?.status === 'ok' ? got.etag : null)).toEqual({ status: 'not-modified' });
		expect(await http.textConditional(waterbodiesUrl('zzzzzzzzzz'), null)).toBeNull();
		expect(await http.textConditional(`${WATERBODIES_SERIES_BASE}aaaa/${UIDS[0]}.csv`, null)).toBeNull();
		expect(await http.textConditional('https://example.com/x.csv', null)).toBeNull();
	});
});

describe('runWaterbodiesPass', () => {
	const run = (s: ReturnType<typeof store>, http: WaterbodiesHttp, o: { now?: number; deadline?: number; refreshDays?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}) => {
		let t = o.now ?? NOW;
		return runWaterbodiesPass({
			store: s,
			http,
			today: '2026-10-27',
			now: () => t,
			sleep: o.sleep ?? (async (ms) => void (t += ms)),
			intervalMs: o.intervalMs ?? 0,
			refreshDays: o.refreshDays,
			deadline: o.deadline
		});
	};

	it('without a wanted list, fetches nothing', async () => {
		expect(await run(store(), fixtureWaterbodiesHttp())).toMatchObject({ stopped: 'no_list', fetched: [], requests: 0, recencyDays: null });
	});

	it('fetches each wanted uid into its file and the status, then asks with the ETag and keeps the file on a 304', async () => {
		const s = store();
		await want(s, UIDS.slice(0, 2));
		const first = await run(s, fixtureWaterbodiesHttp());
		expect(first).toMatchObject({ fetched: UIDS.slice(0, 2), unchanged: [], failed: [], stopped: 'done', requests: 2 });
		// 2026-10-27 back to 2023-09-17.
		expect(first.recencyDays).toBe(1136);
		const file = await readObservationFile(s, 'waterbodies', UIDS[0]!);
		expect(file).toMatchObject({ source: 'waterbodies', key: UIDS[0], fetchedAt: new Date(NOW).toISOString(), upstream: [{ url: waterbodiesUrl(UIDS[0]!), etag: expect.any(String) }] });
		expect(file!.rows.length).toBeGreaterThan(100);
		const status = await readStatus(s, 'waterbodies');
		expect(status).toMatchObject({ source: 'waterbodies', stopped: false, perKey: { [UIDS[0]!]: { lastGood: new Date(NOW).toISOString(), newest: '2023-09-17' } } });
		// A week later: due again, unchanged upstream.
		const spy = vi.fn(fixtureWaterbodiesHttp().textConditional);
		const second = await run(s, { textConditional: spy }, { now: NOW + 7 * 86_400_000 });
		expect(second).toMatchObject({ fetched: [], unchanged: UIDS.slice(0, 2), requests: 2 });
		expect(spy.mock.calls[0]![1]).toBe(file!.upstream[0]!.etag);
		expect((await readObservationFile(s, 'waterbodies', UIDS[0]!))!.fetchedAt).toBe(file!.fetchedAt);
		expect((await readStatus(s, 'waterbodies'))!.perKey[UIDS[0]!]!.lastGood).toBe(new Date(NOW + 7 * 86_400_000).toISOString());
	});

	it('leaves a uid fetched within the week alone, and drops one no longer wanted from the status', async () => {
		const s = store();
		await want(s, UIDS.slice(0, 2));
		await run(s, fixtureWaterbodiesHttp());
		await want(s, UIDS.slice(1, 3));
		const r = await run(s, fixtureWaterbodiesHttp(), { now: NOW + 86_400_000 });
		expect(r).toMatchObject({ fetched: [UIDS[2]], fresh: 1 });
		expect(Object.keys((await readStatus(s, 'waterbodies'))!.perKey).sort()).toEqual(UIDS.slice(1, 3));
	});

	it('records a missing or unreadable series and goes on', async () => {
		const s = store();
		await want(s, ['zzzzzzzzzz', UIDS[0]!]);
		const r = await run(s, fixtureWaterbodiesHttp());
		expect(r).toMatchObject({ failed: ['zzzzzzzzzz'], fetched: [UIDS[0]], stopped: 'done' });
		expect((await readStatus(s, 'waterbodies'))!.perKey.zzzzzzzzzz).toEqual({ error: 'HTTP 404' });
		const bad = await run(store(), { textConditional: async () => ({ status: 'ok', text: 'nope', etag: null, lastModified: null }) });
		expect(bad.stopped).toBe('no_list');
		const s2 = store();
		await want(s2, [UIDS[0]!]);
		expect(await run(s2, { textConditional: async () => ({ status: 'ok', text: 'nope', etag: null, lastModified: null }) })).toMatchObject({ failed: [UIDS[0]] });
		expect((await readStatus(s2, 'waterbodies'))!.perKey[UIDS[0]!]).toEqual({ error: 'format' });
	});

	it('stops at once on an HTTP 403 or throttling, says so in the status, and keeps the last good fetch', async () => {
		for (const [err, reason] of [
			[new FeedRefusedError(), 'refused'],
			[new FeedThrottledError(429, 60), 'throttled']
		] as const) {
			const s = store();
			await want(s, UIDS.slice(0, 2));
			await run(s, fixtureWaterbodiesHttp());
			const asked = vi.fn(async () => {
				throw err;
			});
			const r = await run(s, { textConditional: asked }, { now: NOW + 7 * 86_400_000 });
			expect(r).toMatchObject({ stopped: reason, fetched: [], requests: 1 });
			expect(r.error).toBe(err);
			expect(asked).toHaveBeenCalledTimes(1);
			const status = (await readStatus(s, 'waterbodies'))!;
			expect(status).toMatchObject({ stopped: true, reason });
			expect(status.perKey[UIDS[0]!]).toMatchObject({ lastGood: new Date(NOW).toISOString(), error: reason });
		}
	});

	it('waits a second between requests, and starts no uid past the deadline', async () => {
		const s = store();
		await want(s, UIDS.slice(0, 3));
		const slept: number[] = [];
		let t = NOW;
		const r = await runWaterbodiesPass({
			store: s,
			http: fixtureWaterbodiesHttp(),
			today: '2026-10-27',
			now: () => t,
			sleep: async (ms) => {
				slept.push(ms);
				t += ms;
			},
			deadline: NOW + 500
		});
		expect(slept).toEqual([1000]);
		expect(r).toMatchObject({ stopped: 'deadline', fetched: UIDS.slice(0, 2), requests: 2 });
	});
});
