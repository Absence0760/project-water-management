import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { FeedFormatError, FeedRefusedError, FeedThrottledError, FeedUnavailableError } from '../../feeds/errors.js';
import { FEED_HOST_PATHS, FEED_HOSTS } from '../../feeds/http.js';
import { openStore } from '../../mirror/store.js';
import { SERIES_END } from '../../../scripts/waterbodies-fixture.js';
import { readObservationFile, readStatus, writeObservationFile, writeStatus, writeWanted } from './handover.js';
import { DEAFRICA_GEOSERVER_WFS, DEAFRICA_WATERBODIES_API } from './upstream.js';
import {
	fixtureWaterbodiesHttp,
	FULL_REFRESH_DAYS,
	OVERLAP_DAYS,
	parseWaterbodiesCsv,
	parseWbIds,
	runWaterbodiesPass,
	seriesUrl,
	WATERBODIES_FIXTURE_POLYGONS,
	WATERBODIES_FIXTURE_ROOT,
	WATERBODIES_HEADER,
	type WaterbodiesHttp,
	wbIdsUrl,
	WFS_BATCH
} from './waterbodies.js';

const HEAD = WATERBODIES_HEADER.join(',');
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function store() {
	const dir = mkdtempSync(join(tmpdir(), 'wm-wb-'));
	dirs.push(dir);
	return openStore(pathToFileURL(`${dir}/`).href);
}
/** The committed synthetic waterbodies, uid → wb_id, in uid order. */
const FIXTURE = (JSON.parse(readFileSync(`${WATERBODIES_FIXTURE_ROOT}${WATERBODIES_FIXTURE_POLYGONS}`, 'utf8')) as { features: { properties: { uid: string; wb_id: number } }[] }).features
	.map((f) => f.properties)
	.sort((a, b) => (a.uid < b.uid ? -1 : 1));
const UIDS = FIXTURE.map((f) => f.uid);
const ID = Object.fromEntries(FIXTURE.map((f) => [f.uid, f.wb_id]));
const NOW = Date.parse('2026-10-27T04:00:00Z');
const TODAY = '2026-10-27';
const DAY = 86_400_000;
const want = (s: ReturnType<typeof store>, uids: string[]) => writeWanted(s, { generatedAt: new Date(NOW).toISOString(), waterbodies: uids, outlines: [] });
const isWfs = (url: string) => url.startsWith(`${DEAFRICA_GEOSERVER_WFS}?`);
/** The fixture client, recording every URL asked. */
function recorded(inner: WaterbodiesHttp = fixtureWaterbodiesHttp()) {
	const asked = vi.fn(inner.textConditional);
	return { http: { textConditional: asked } as WaterbodiesHttp, urls: () => asked.mock.calls.map((c) => c[0]) };
}

describe('parseWaterbodiesCsv', () => {
	it('reads the wet area and the share seen clearly (percent_observed − percent_invalid), dropping dates nothing was seen on', () => {
		const rows = parseWaterbodiesCsv(
			[
				HEAD,
				// A sample row of the live API (2026-10-30): observed stays 100 while 0.45 % is invalid.
				'2025-02-18,127800.0,64.55,69300.0,35.00,900.0,0.45,198000.0,100.00',
				'2025-03-06,0.0,0.00,0.0,0.00,198000.0,100.00,198000.0,100.00',
				// The scene's edge cut the waterbody: 80 % covered, 5 % of it clouded.
				'2025-03-22,99000.0,50.00,49500.0,25.00,9900.0,5.00,158400.0,80.00',
				'2025-04-07T08:12:00Z,19800.0,10.00,178200.0,90.00,0.0,0.00,198000.0,100.00',
				'2025-04-23,0.0,0.00,0.0,0.00,0.0,0.00,0.0,0.00',
				'2025-05-09,,,,,,0.00,0.0,50.00'
			].join('\n'),
			'zzzzza0001'
		);
		expect(rows).toEqual([
			{ date: '2025-02-18', wetAreaM2: 127800, pctObserved: 99.55, upstreamKey: 'zzzzza0001' },
			{ date: '2025-03-22', wetAreaM2: 99000, pctObserved: 75, upstreamKey: 'zzzzza0001' },
			{ date: '2025-04-07', wetAreaM2: 19800, pctObserved: 100, upstreamKey: 'zzzzza0001' }
		]);
	});

	it('keeps the clearest of two rows on one date, and sorts by date', () => {
		const rows = parseWaterbodiesCsv(
			[HEAD, '2023-02-02,18000,20,27000,30,45000,50,90000,100', '2023-01-01,900,1,900,1,88200,98,90000,100', '2023-02-02,27000,30,54000,60,9000,10,90000,100'].join('\n'),
			'zzzzza0001'
		);
		expect(rows.map((r) => [r.date, r.pctObserved])).toEqual([
			['2023-01-01', 2],
			['2023-02-02', 90]
		]);
	});

	it('reads a header with no rows (a range with no scene) as no rows', () => {
		expect(parseWaterbodiesCsv(`${HEAD}\n`, 'zzzzza0001')).toEqual([]);
	});

	it('refuses a changed layout (v0.0.2’s CSV among them) or an unreadable value, as a format failure', () => {
		const v002 = 'date,px_total,px_wet,area_wet_m2,px_dry,area_dry_m2,px_invalid,area_invalid_m2,pc_wet,pc_dry,pc_invalid';
		expect(() => parseWaterbodiesCsv('', 'zzzzza0001')).toThrow(FeedFormatError);
		expect(() => parseWaterbodiesCsv(`${v002}\n2023-01-01,1,1,900,0,0,0,0,100,0,0`, 'zzzzza0001')).toThrow(/columns changed/);
		expect(() => parseWaterbodiesCsv(`${HEAD}\nyesterday,1,1,1,1,0,0,2,100`, 'zzzzza0001')).toThrow(/no date/);
		expect(() => parseWaterbodiesCsv(`${HEAD}\n2023-02-31,1,1,1,1,0,0,2,100`, 'zzzzza0001')).toThrow(/no date/);
		expect(() => parseWaterbodiesCsv(`${HEAD}\n1975-01-01,1,1,1,1,0,0,2,100`, 'zzzzza0001')).toThrow(/no date/);
		expect(() => parseWaterbodiesCsv(`${HEAD}\n2023-01-01,1,1,1,1,0,0,2`, 'zzzzza0001')).toThrow(/columns/);
		expect(() => parseWaterbodiesCsv(`${HEAD}\n2023-01-01,-5,1,1,1,0,0,2,100`, 'zzzzza0001')).toThrow(/wet area/);
		expect(() => parseWaterbodiesCsv(`${HEAD}\n2023-01-01,5,1,1,1,0,150,2,100`, 'zzzzza0001')).toThrow(/percent_invalid/);
		expect(() => parseWaterbodiesCsv(`${HEAD}\n2023-01-01,5,1,1,1,0,0,2,`, 'zzzzza0001')).toThrow(/percent_observed/);
	});

	it(`reads every committed synthetic series, each ending on ${SERIES_END}`, async () => {
		expect(UIDS.length).toBeGreaterThan(0);
		const http = fixtureWaterbodiesHttp();
		for (const uid of UIDS) {
			const got = await http.textConditional(seriesUrl(ID[uid]!, '1984-01-01', TODAY), null);
			if (got?.status !== 'ok') throw new Error(`no fixture for ${uid}`);
			const rows = parseWaterbodiesCsv(got.text, uid);
			expect(rows.at(-1)!.date).toBe(SERIES_END);
			expect(rows.every((r) => r.pctObserved >= 70 && r.wetAreaM2 >= 0)).toBe(true);
			// Some dates clouded or cut by a scene's edge, as DE Africa's are.
			expect(rows.some((r) => r.pctObserved < 100)).toBe(true);
		}
	});
});

describe('parseWbIds and the URLs', () => {
	it('asks the WFS for the uids’ wb_id only, as the live service answered on 2026-10-30', () => {
		expect(wbIdsUrl(['k3vr8rw8f3', 'zzzzzzzzzz'])).toBe(
			'https://geoserver.digitalearth.africa/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature&typeName=waterbodies%3ADEAfrica_Waterbodies_v0_0_3&outputFormat=application%2Fjson&propertyName=uid%2Cwb_id&cql_filter=uid%20IN%20(\'k3vr8rw8f3\'%2C\'zzzzzzzzzz\')'
		);
		expect(() => wbIdsUrl(["x') OR (1=1"])).toThrow(/checked uids/);
		expect(() => wbIdsUrl([])).toThrow(/checked uids/);
		expect(seriesUrl(89768, '1984-01-01', '2026-10-30')).toBe('https://api.digitalearth.africa/waterbodies/waterbody/89768/observations/csv?start_date=1984-01-01&end_date=2026-10-30');
	});

	it('keeps a live fetch to those two services’ own paths', () => {
		expect(FEED_HOSTS).toEqual(expect.arrayContaining(['api.digitalearth.africa', 'geoserver.digitalearth.africa']));
		expect(FEED_HOST_PATHS).toMatchObject({ 'api.digitalearth.africa': ['/waterbodies/'], 'geoserver.digitalearth.africa': ['/geoserver/wfs'] });
		expect(new URL(DEAFRICA_WATERBODIES_API).pathname).toBe('/waterbodies/');
	});

	it('reads the WFS answer (the live one’s shape), and refuses anything else as a format failure', () => {
		const live =
			'{"type":"FeatureCollection","features":[{"type":"Feature","id":"DEAfrica_Waterbodies_v0_0_3.89850","geometry":null,"properties":{"uid":"k3vr8rw8f3","wb_id":89768},"bbox":[-33.8,18.64,-33.79,18.65]}],"totalFeatures":1,"numberMatched":1,"numberReturned":1,"timeStamp":"2026-10-30T13:40:53.221Z","crs":null}';
		expect(parseWbIds(live)).toEqual(new Map([['k3vr8rw8f3', 89768]]));
		expect(parseWbIds('{"type":"FeatureCollection","features":[]}')).toEqual(new Map());
		for (const bad of [
			'<html>',
			'null',
			'{"features":{}}',
			'{"features":[{"properties":{"uid":"k3vr8rw8f3"}}]}',
			'{"features":[{"properties":{"uid":"k3vr8rw8f3","wb_id":"89768"}}]}',
			'{"features":[{"properties":{"uid":"k3vr8rw8f3","wb_id":-1}}]}',
			'{"features":[{"properties":{"uid":"K3VR8RW8F3","wb_id":1}}]}',
			'{"features":[{"properties":{"uid":"k3vr8rw8f3","wb_id":1}},{"properties":{"uid":"k3vr8rw8f3","wb_id":2}}]}'
		]) {
			expect(() => parseWbIds(bad), bad).toThrow(FeedFormatError);
		}
	});
});

describe('the fixture client', () => {
	it('answers the WFS for the fixture’s uids, leaving an unknown one out', async () => {
		const got = await fixtureWaterbodiesHttp().textConditional(wbIdsUrl([UIDS[0]!, 'zzzzzzzzzz']), null);
		expect(got).toMatchObject({ status: 'ok', etag: null });
		expect(parseWbIds(got?.status === 'ok' ? got.text : '')).toEqual(new Map([[UIDS[0]!, ID[UIDS[0]!]]]));
		await expect(fixtureWaterbodiesHttp().textConditional(`${DEAFRICA_GEOSERVER_WFS}?request=GetFeature`, null)).rejects.toThrow(new FeedUnavailableError('HTTP 400'));
	});

	it('answers the series between start_date and end_date, a 404 for an unknown wb_id, and nothing for any other URL', async () => {
		const http = fixtureWaterbodiesHttp();
		const id = ID[UIDS[0]!]!;
		const part = await http.textConditional(seriesUrl(id, '2026-01-01', '2026-06-30'), null);
		const rows = parseWaterbodiesCsv(part?.status === 'ok' ? part.text : '', UIDS[0]!);
		expect(rows.length).toBeGreaterThan(5);
		expect(rows.every((r) => r.date >= '2026-01-01' && r.date <= '2026-06-30')).toBe(true);
		expect(await http.textConditional(seriesUrl(id, '2026-10-20', TODAY), null)).toEqual({ status: 'ok', text: `${HEAD}\n`, etag: null, lastModified: null });
		expect(await http.textConditional(seriesUrl(999_999_999, '1984-01-01', TODAY), null)).toBeNull();
		await expect(http.textConditional(`${DEAFRICA_WATERBODIES_API}waterbody/${id}/observations/csv?start_date=x&end_date=y`, null)).rejects.toThrow(new FeedUnavailableError('HTTP 422'));
		expect(await http.textConditional(`${DEAFRICA_WATERBODIES_API}waterbody/../x`, null)).toBeNull();
		expect(await http.textConditional('https://example.com/x.csv', null)).toBeNull();
	});
});

describe('runWaterbodiesPass', () => {
	const run = (s: ReturnType<typeof store>, http: WaterbodiesHttp, o: { now?: number; deadline?: number; refreshDays?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}) => {
		let t = o.now ?? NOW;
		return runWaterbodiesPass({
			store: s,
			http,
			today: new Date(t).toISOString().slice(0, 10),
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

	it('looks the uids’ wb_id up once, in one WFS request, then fetches each whole series into its file and the status', async () => {
		const s = store();
		await want(s, UIDS.slice(0, 2));
		const { http, urls } = recorded();
		const first = await run(s, http);
		expect(first).toMatchObject({ fetched: UIDS.slice(0, 2), unchanged: [], failed: [], stopped: 'done', requests: 3 });
		expect(urls()).toEqual([wbIdsUrl(UIDS.slice(0, 2)), seriesUrl(ID[UIDS[0]!]!, '1984-01-01', TODAY), seriesUrl(ID[UIDS[1]!]!, '1984-01-01', TODAY)]);
		// 2026-10-27 back to the series' end.
		expect(first.recencyDays).toBe(16);
		const file = await readObservationFile(s, 'waterbodies', UIDS[0]!);
		expect(file).toMatchObject({ source: 'waterbodies', key: UIDS[0], fetchedAt: new Date(NOW).toISOString(), upstream: [{ url: seriesUrl(ID[UIDS[0]!]!, '1984-01-01', TODAY) }] });
		expect(file!.upstream[0]).not.toHaveProperty('etag');
		expect(file!.rows.length).toBeGreaterThan(200);
		const status = await readStatus(s, 'waterbodies');
		const at = new Date(NOW).toISOString();
		expect(status).toMatchObject({ source: 'waterbodies', stopped: false, perKey: { [UIDS[0]!]: { wbId: ID[UIDS[0]!], lastGood: at, triedAt: at, fullAt: at, newest: SERIES_END } } });
	});

	it('a week later asks only from OVERLAP_DAYS before the newest date held, no WFS, and writes nothing when nothing changed', async () => {
		const s = store();
		await want(s, UIDS.slice(0, 2));
		await run(s, fixtureWaterbodiesHttp());
		const file = (await readObservationFile(s, 'waterbodies', UIDS[0]!))!;
		const { http, urls } = recorded();
		const week = NOW + 7 * DAY;
		const today = new Date(week).toISOString().slice(0, 10);
		const second = await run(s, http, { now: week });
		expect(second).toMatchObject({ fetched: [], unchanged: UIDS.slice(0, 2), requests: 2 });
		expect(urls()[0]).toBe(seriesUrl(ID[UIDS[0]!]!, '2026-08-12', today));
		expect(OVERLAP_DAYS).toBe(60);
		expect(await readObservationFile(s, 'waterbodies', UIDS[0]!)).toEqual(file);
		expect((await readStatus(s, 'waterbodies'))!.perKey[UIDS[0]!]).toEqual({ wbId: ID[UIDS[0]!], lastGood: new Date(week).toISOString(), triedAt: new Date(week).toISOString(), fullAt: new Date(NOW).toISOString(), newest: SERIES_END });
	});

	it('merges a week’s new and revised rows into the file it holds, keeping the older history', async () => {
		const s = store();
		const uid = UIDS[0]!;
		await want(s, [uid]);
		await run(s, fixtureWaterbodiesHttp());
		const before = (await readObservationFile(s, 'waterbodies', uid))!;
		// Upstream now: one new scene, and the newest one revised.
		const fixture = fixtureWaterbodiesHttp();
		const later: WaterbodiesHttp = {
			async textConditional(url, etag) {
				const got = await fixture.textConditional(url, etag);
				if (got?.status !== 'ok' || isWfs(url)) return got;
				const lines = got.text.trimEnd().split('\n');
				lines[lines.length - 1] = `${SERIES_END},1000.0,1.00,99000.0,99.00,0.0,0.00,100000.0,100.00`;
				return { ...got, text: `${[...lines, '2026-10-27,5000.0,5.00,95000.0,95.00,0.0,0.00,100000.0,100.00'].join('\n')}\n` };
			}
		};
		const week = NOW + 7 * DAY;
		expect(await run(s, later, { now: week })).toMatchObject({ fetched: [uid], unchanged: [], requests: 1 });
		const after = (await readObservationFile(s, 'waterbodies', uid))!;
		expect(after.rows.length).toBe(before.rows.length + 1);
		expect(after.rows.slice(0, -2)).toEqual(before.rows.slice(0, -1));
		expect(after.rows.slice(-2)).toEqual([
			{ date: SERIES_END, wetAreaM2: 1000, pctObserved: 100, upstreamKey: uid },
			{ date: '2026-10-27', wetAreaM2: 5000, pctObserved: 100, upstreamKey: uid }
		]);
		expect(after.upstream[0]!.url).toBe(seriesUrl(ID[uid]!, '2026-08-12', '2026-11-03'));
		// Still the first fetch's whole series.
		expect((await readStatus(s, 'waterbodies'))!.perKey[uid]).toMatchObject({ newest: '2026-10-27', fullAt: new Date(NOW).toISOString(), lastGood: new Date(week).toISOString() });
	});

	it('keeps every date it holds when a weekly answer is empty or short (a date withdrawn upstream goes at the next whole fetch)', async () => {
		const s = store();
		const uid = UIDS[0]!;
		await want(s, [uid]);
		await run(s, fixtureWaterbodiesHttp());
		const before = (await readObservationFile(s, 'waterbodies', uid))!;
		const empty: WaterbodiesHttp = { textConditional: async () => ({ status: 'ok', text: `${HEAD}\n`, etag: null, lastModified: null }) };
		const week = NOW + 7 * DAY;
		expect(await run(s, empty, { now: week })).toMatchObject({ unchanged: [uid], fetched: [] });
		expect(await readObservationFile(s, 'waterbodies', uid)).toEqual(before);
		expect((await readStatus(s, 'waterbodies'))!.perKey[uid]).toMatchObject({ newest: SERIES_END });
	});

	it('asks the whole series again a quarter after the last whole fetch', async () => {
		const s = store();
		await want(s, [UIDS[0]!]);
		await run(s, fixtureWaterbodiesHttp());
		const { http, urls } = recorded();
		const later = NOW + FULL_REFRESH_DAYS * DAY;
		await run(s, http, { now: later });
		expect(urls()).toEqual([seriesUrl(ID[UIDS[0]!]!, '1984-01-01', new Date(later).toISOString().slice(0, 10))]);
		expect((await readStatus(s, 'waterbodies'))!.perKey[UIDS[0]!]!.fullAt).toBe(new Date(later).toISOString());
	});

	it('fetches a uid the v0.0.2 CSVs gave a file at once and whole, whatever its last good fetch', async () => {
		const s = store();
		const uid = UIDS[0]!;
		await want(s, [uid]);
		const csvAt = new Date(NOW - DAY).toISOString();
		const v002 = `https://deafrica-services.s3.af-south-1.amazonaws.com/waterbodies/v0.0.2/surface_area_change/${uid.slice(0, 4)}/${uid}.csv`;
		await writeObservationFile(s, { source: 'waterbodies', key: uid, fetchedAt: csvAt, upstream: [{ url: v002, etag: '"v2"' }], rows: [{ date: '2023-09-17', wetAreaM2: 1, pctObserved: 100, upstreamKey: uid }] });
		await writeStatus(s, { source: 'waterbodies', ranAt: csvAt, stopped: false, perKey: { [uid]: { lastGood: csvAt, triedAt: csvAt, newest: '2023-09-17' } } });
		const { http, urls } = recorded();
		expect(await run(s, http)).toMatchObject({ fetched: [uid], fresh: 0, recencyDays: 16 });
		expect(urls()).toEqual([wbIdsUrl([uid]), seriesUrl(ID[uid]!, '1984-01-01', TODAY)]);
		expect((await readObservationFile(s, 'waterbodies', uid))!.rows.at(-1)!.date).toBe(SERIES_END);
	});

	it('leaves a uid fetched within the week alone, and drops one no longer wanted from the status', async () => {
		const s = store();
		await want(s, UIDS.slice(0, 2));
		await run(s, fixtureWaterbodiesHttp());
		await want(s, UIDS.slice(1, 3));
		const r = await run(s, fixtureWaterbodiesHttp(), { now: NOW + DAY });
		expect(r).toMatchObject({ fetched: [UIDS[2]], fresh: 1, requests: 2 });
		expect(Object.keys((await readStatus(s, 'waterbodies'))!.perKey).sort()).toEqual(UIDS.slice(1, 3));
	});

	it('asks a uid again a week after its last good fetch, not an hour sooner, under the hourly schedule', async () => {
		const s = store();
		await want(s, [UIDS[0]!]);
		await run(s, fixtureWaterbodiesHttp());
		const { http, urls } = recorded();
		// Every hour of the week but the last: nothing asked.
		for (const h of [1, 24, 6 * 24, 7 * 24 - 1]) {
			expect(await run(s, http, { now: NOW + h * 3_600_000 })).toMatchObject({ fresh: 1, requests: 0 });
		}
		expect(urls()).toEqual([]);
		expect(await run(s, http, { now: NOW + 7 * DAY })).toMatchObject({ unchanged: [UIDS[0]], requests: 1 });
	});

	it('records a uid the WFS doesn’t know (no v0.0.3 waterbody), asks it again a day later and not every hour, and goes on', async () => {
		const s = store();
		await want(s, ['zzzzzzzzzz', UIDS[0]!]);
		const { http, urls } = recorded();
		expect(await run(s, http)).toMatchObject({ failed: ['zzzzzzzzzz'], fetched: [UIDS[0]], stopped: 'done', requests: 2 });
		expect((await readStatus(s, 'waterbodies'))!.perKey.zzzzzzzzzz).toEqual({ error: 'no_waterbody', triedAt: new Date(NOW).toISOString() });
		expect(await run(s, http, { now: NOW + 3_600_000 })).toMatchObject({ failed: [], fresh: 2, requests: 0 });
		expect(await run(s, http, { now: NOW + 23 * 3_600_000 })).toMatchObject({ requests: 0 });
		expect(await run(s, http, { now: NOW + DAY })).toMatchObject({ failed: ['zzzzzzzzzz'], requests: 1 });
		expect(urls().slice(2)).toEqual([wbIdsUrl(['zzzzzzzzzz'])]);
	});

	it('drops the newest date of a uid the WFS no longer knows, so the recency counts only uids kept up', async () => {
		const s = store();
		const uid = UIDS[0]!;
		await want(s, [uid]);
		const csvAt = new Date(NOW - 8 * DAY).toISOString();
		// A uid the v0.0.2 CSVs gave a 2023 series, which isn't a v0.0.3 waterbody.
		await writeStatus(s, { source: 'waterbodies', ranAt: csvAt, stopped: false, perKey: { [uid]: { lastGood: csvAt, triedAt: csvAt, newest: '2023-09-17' } } });
		const unknown: WaterbodiesHttp = { textConditional: async () => ({ status: 'ok', text: '{"type":"FeatureCollection","features":[]}', etag: null, lastModified: null }) };
		expect(await run(s, unknown)).toMatchObject({ failed: [uid], recencyDays: null });
		expect((await readStatus(s, 'waterbodies'))!.perKey[uid]).toEqual({ lastGood: csvAt, error: 'no_waterbody', triedAt: new Date(NOW).toISOString() });
	});

	it('forgets the wb_id the API answers 404 for, so the next ask looks it up again', async () => {
		const s = store();
		const uid = UIDS[0]!;
		await want(s, [uid]);
		await run(s, fixtureWaterbodiesHttp());
		const gone: WaterbodiesHttp = { textConditional: async (url, etag) => (isWfs(url) ? fixtureWaterbodiesHttp().textConditional(url, etag) : null) };
		expect(await run(s, gone, { now: NOW + 7 * DAY })).toMatchObject({ failed: [uid], requests: 1 });
		const status = (await readStatus(s, 'waterbodies'))!.perKey[uid]!;
		expect(status).toMatchObject({ error: 'HTTP 404', lastGood: new Date(NOW).toISOString() });
		expect(status).not.toHaveProperty('wbId');
		expect(status).not.toHaveProperty('newest');
		const { http, urls } = recorded();
		// The same id again: the file held is still its own, so only the recent part is asked.
		expect(await run(s, http, { now: NOW + 8 * DAY })).toMatchObject({ unchanged: [uid], failed: [] });
		expect(urls()).toEqual([wbIdsUrl([uid]), seriesUrl(ID[uid]!, '2026-08-12', '2026-11-04')]);
		expect((await readStatus(s, 'waterbodies'))!.perKey[uid]).toMatchObject({ wbId: ID[uid] });
		expect((await readStatus(s, 'waterbodies'))!.perKey[uid]).not.toHaveProperty('error');
	});

	it('records an unreadable WFS answer or series against each uid it was for, and goes on', async () => {
		const s = store();
		await want(s, UIDS.slice(0, 2));
		const nope = { status: 'ok' as const, text: 'nope', etag: null, lastModified: null };
		expect(await run(s, { textConditional: async () => nope })).toMatchObject({ failed: UIDS.slice(0, 2), requests: 1 });
		expect((await readStatus(s, 'waterbodies'))!.perKey[UIDS[0]!]).toEqual({ error: 'format', triedAt: new Date(NOW).toISOString() });
		const s2 = store();
		await want(s2, UIDS.slice(0, 2));
		const badSeries: WaterbodiesHttp = { textConditional: async (url, etag) => (isWfs(url) ? fixtureWaterbodiesHttp().textConditional(url, etag) : nope) };
		expect(await run(s2, badSeries)).toMatchObject({ failed: UIDS.slice(0, 2), requests: 3 });
		expect((await readStatus(s2, 'waterbodies'))!.perKey[UIDS[0]!]).toEqual({ wbId: ID[UIDS[0]!], error: 'format', triedAt: new Date(NOW).toISOString() });
	});

	it(`looks up at most ${WFS_BATCH} uids a WFS request`, async () => {
		const s = store();
		const many = Array.from({ length: WFS_BATCH + 1 }, (_, i) => `zzzz${String(i).padStart(6, '0')}`);
		await want(s, many);
		const { http, urls } = recorded();
		expect(await run(s, http)).toMatchObject({ requests: 2, failed: many });
		expect(urls()).toEqual([wbIdsUrl(many.slice(0, WFS_BATCH)), wbIdsUrl(many.slice(WFS_BATCH))]);
	});

	it('stops at once on an HTTP 403 or throttling, from the WFS or the API, says so in the status, and keeps the last good fetch', async () => {
		for (const [err, reason] of [
			[new FeedRefusedError(), 'refused'],
			[new FeedThrottledError(429, 60), 'throttled']
		] as const) {
			// The API refuses, a week on.
			const s = store();
			await want(s, UIDS.slice(0, 2));
			await run(s, fixtureWaterbodiesHttp());
			const asked = vi.fn(async () => {
				throw err;
			});
			const r = await run(s, { textConditional: asked }, { now: NOW + 7 * DAY });
			expect(r).toMatchObject({ stopped: reason, fetched: [], requests: 1 });
			expect(r.error).toBe(err);
			expect(asked).toHaveBeenCalledTimes(1);
			const status = (await readStatus(s, 'waterbodies'))!;
			expect(status).toMatchObject({ stopped: true, reason });
			expect(status.perKey[UIDS[0]!]).toMatchObject({ lastGood: new Date(NOW).toISOString(), wbId: ID[UIDS[0]!], error: reason });
			// The WFS refuses, on the first run: no series asked.
			const s2 = store();
			await want(s2, UIDS.slice(0, 2));
			const wfs = vi.fn(async () => {
				throw err;
			});
			expect(await run(s2, { textConditional: wfs })).toMatchObject({ stopped: reason, failed: [], requests: 1 });
			expect((await readStatus(s2, 'waterbodies'))!.perKey[UIDS[1]!]).toEqual({ error: reason, triedAt: new Date(NOW).toISOString() });
		}
	});

	it('leaves the source alone for a day after a 403 or throttling (longer on a longer Retry-After): no request, the status kept', async () => {
		for (const [err, pauseH] of [
			[new FeedRefusedError(), 24],
			[new FeedThrottledError(429, 60), 24],
			[new FeedThrottledError(503, 3 * 86_400), 72]
		] as const) {
			const s = store();
			await want(s, UIDS.slice(0, 2));
			const stoppedAt = NOW;
			await run(s, { textConditional: async () => { throw err; } }, { now: stoppedAt });
			const stoppedStatus = (await readStatus(s, 'waterbodies'))!;
			expect(stoppedStatus.retryAfterSeconds).toBe(err instanceof FeedThrottledError ? err.retryAfterSeconds! : undefined);
			const { http, urls } = recorded();
			// Every hour of the pause: nothing asked, nothing written.
			for (const h of [1, pauseH - 1]) {
				const r = await run(s, http, { now: stoppedAt + h * 3_600_000 });
				expect(r).toMatchObject({ stopped: 'paused', pausedUntil: new Date(stoppedAt + pauseH * 3_600_000).toISOString(), requests: 0, error: null });
			}
			expect(urls()).toEqual([]);
			expect(await readStatus(s, 'waterbodies')).toEqual(stoppedStatus);
			// Then the run goes on.
			expect(await run(s, http, { now: stoppedAt + pauseH * 3_600_000 })).toMatchObject({ stopped: 'done', requests: 3 });
			expect((await readStatus(s, 'waterbodies'))!.stopped).toBe(false);
		}
	});

	it('keeps the status of what it fetched before the mirror failed, then fails', async () => {
		const s = store();
		await want(s, UIDS.slice(0, 2));
		let writes = 0;
		const failing = Object.assign(Object.create(Object.getPrototypeOf(s)), s, {
			set: async (k: Parameters<typeof s.set>[0], v: Uint8Array) => {
				if (String(k).startsWith('/dams/waterbodies/') && ++writes === 2) throw new Error('bucket down');
				return s.set(k, v);
			}
		});
		await expect(run(failing, fixtureWaterbodiesHttp())).rejects.toThrow('bucket down');
		const perKey = (await readStatus(s, 'waterbodies'))!.perKey;
		expect(perKey[UIDS[0]!]).toMatchObject({ lastGood: new Date(NOW).toISOString() });
		// Looked up, never fetched: its id is kept, so the next run asks only its series.
		expect(perKey[UIDS[1]!]).toEqual({ wbId: ID[UIDS[1]!] });
	});

	it('waits a second between requests, the WFS lookup included, and starts no request past the deadline', async () => {
		const s = store();
		await want(s, UIDS.slice(0, 3));
		const slept: number[] = [];
		let t = NOW;
		const r = await runWaterbodiesPass({
			store: s,
			http: fixtureWaterbodiesHttp(),
			today: TODAY,
			now: () => t,
			sleep: async (ms) => {
				slept.push(ms);
				t += ms;
			},
			deadline: NOW + 1500
		});
		expect(slept).toEqual([1000, 1000]);
		expect(r).toMatchObject({ stopped: 'deadline', fetched: UIDS.slice(0, 2), requests: 3 });
	});
});

// CLAUDE.md rule 7: a row's date is its UTC day, and the pass's times are UTC,
// whatever the server's zone. The clock is pinned late in the UTC day.
describe.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago'])('under a skewed TZ (%s)', (tz) => {
	const zone = process.env.TZ;
	afterEach(() => {
		vi.useRealTimers();
		process.env.TZ = zone;
	});
	const LATE = Date.parse('2026-10-27T23:30:00Z');

	it('reads a timestamped row as its UTC date', () => {
		vi.useFakeTimers({ toFake: ['Date'], now: LATE });
		process.env.TZ = tz;
		const rows = parseWaterbodiesCsv([HEAD, '2023-02-18T23:30:00Z,9000,10,81000,90,0,0,90000,100', '2023-02-19T00:30:00Z,9000,10,81000,90,0,0,90000,100'].join('\n'), 'zzzzza0001');
		expect(rows.map((r) => r.date)).toEqual(['2023-02-18', '2023-02-19']);
	});

	it('stamps the status in UTC, counts the recency and the overlap in UTC days, and is due a week on to the hour', async () => {
		vi.useFakeTimers({ toFake: ['Date'], now: LATE });
		process.env.TZ = tz;
		const s = store();
		await want(s, [UIDS[0]!]);
		let t = LATE;
		const { http, urls } = recorded();
		const run = (at: number, today: string) => ((t = at), runWaterbodiesPass({ store: s, http, today, now: () => t, sleep: async () => {}, intervalMs: 0 }));
		const first = await run(LATE, '2026-10-27');
		expect(first.recencyDays).toBe(16);
		expect((await readStatus(s, 'waterbodies'))!.perKey[UIDS[0]!]).toMatchObject({ lastGood: '2026-10-27T23:30:00.000Z', triedAt: '2026-10-27T23:30:00.000Z', newest: SERIES_END });
		expect(await run(LATE + 7 * DAY - 3_600_000, '2026-11-03')).toMatchObject({ fresh: 1, requests: 0 });
		expect(await run(LATE + 7 * DAY, '2026-11-03')).toMatchObject({ unchanged: [UIDS[0]], requests: 1 });
		expect(urls().at(-1)).toBe(seriesUrl(ID[UIDS[0]!]!, '2026-08-12', '2026-11-03'));
	});
});
