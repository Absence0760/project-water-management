// A station API feed's fetch window, request schema and runFetch path (issue #784). The client and the parser
// have their own tests (stationHttp.test.ts, sources/station.test.ts, the engine's stationFormat.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { STATION_MAX_REQUESTS, StationApiConfig } from './config.js';
import { credentialBinding, generateFeedCredentialKeys, sealFeedCredential } from './credential.js';
import { FEED_KEY_PREFIX, FEED_REFUSED_PREFIX } from './errors.js';
import { fetchFailure, FetchRequestSchema, fetchWindow, runFetch, type FetchRequest } from './fetch.js';
import type { FeedHttp } from './http.js';
import { STATION_FIRST_DAYS, STATION_KEY_PROBLEMS } from './sources/station.js';
import { fixtureStationHttp, STATION_FIXTURE_KEY, stationFixtureRain } from './stationFixtures.js';

const addDays = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);
// 12:00 on 2026-03-10 in Johannesburg: yesterday there is the 9th.
const NOW = Date.parse('2026-03-10T10:00:00Z');
const TODAY = '2026-03-10';
const FEED = '7d0e9a51-7b0e-4c4a-9d55-0f5f1c3f2a10';

const config = (over: Record<string, unknown> = {}) =>
	StationApiConfig.parse({
		url: 'https://station.example/v1/daily.json?station={station}&start={start}&end={end}',
		station: 'ST-001',
		auth: { kind: 'none' },
		format: { format: 'json', records: 'data', time: 'date', value: 'rain_mm', timeFormat: 'YYYY-MM-DD', resolution: 'daily' },
		...over
	});

const win = (c: StationApiConfig, last: string | null, readThrough: string | null = null) => fetchWindow('station_api', c, last, TODAY, readThrough, null, { nowMs: NOW });

describe('fetchWindow (station_api)', () => {
	it('starts a first fetch STATION_FIRST_DAYS back, ending on the station’s last finished day', () => {
		expect(win(config(), null)).toEqual({ start: addDays('2026-03-09', 1 - STATION_FIRST_DAYS), end: '2026-03-09' });
	});

	it('ends on the last rain day whose 08:00 end has passed for sub-daily readings', () => {
		const sub = config({ format: { format: 'csv', time: 'time', value: 'rain', timeFormat: 'iso', resolution: 'subdaily' } });
		expect(fetchWindow('station_api', sub, null, TODAY, null, null, { nowMs: Date.parse('2026-03-10T05:00:00Z') }).end).toBe('2026-03-08');
	});

	it('re-reads revisionDays before the newest day once caught up', () => {
		expect(win(config(), '2026-03-08')).toEqual({ start: '2026-03-01', end: '2026-03-09' });
		expect(win(config({ revisionDays: 2 }), '2026-03-08')).toEqual({ start: '2026-03-06', end: '2026-03-09' });
	});

	it('walks a long backfill STATION_MAX_REQUESTS requests a window, moving on past days with no readings', () => {
		const c = config({ startDate: '2020-01-01', maxDaysPerRequest: 10 });
		const first = win(c, null);
		expect(first).toEqual({ start: '2020-01-01', end: addDays('2020-01-01', 10 * STATION_MAX_REQUESTS - 1) });
		// The station had nothing in that window: the next starts the day after it, not on the same days again.
		const second = win(c, null, first.end);
		expect(second.start).toBe(addDays(first.end, 1));
		// With data in it, the next starts the day after the newest day (no revision re-read mid-backfill), and reaches past the last day read.
		const third = win(c, '2020-03-01', first.end);
		expect(third.start).toBe('2020-03-02');
		expect(third.end > first.end).toBe(true);
		// Every window ends; the chain reaches the last day.
		let w = first;
		for (let i = 0; i < 20 && w.end < '2026-03-09'; i++) w = win(c, null, w.end);
		expect(w.end).toBe('2026-03-09');
	});

	it('keeps the startDate as a floor, and asks a startDate after the last day for that one day only', () => {
		expect(win(config({ startDate: '2026-03-05' }), '2026-03-06').start).toBe('2026-03-05');
		expect(win(config({ startDate: '2026-04-01' }), null)).toEqual({ start: '2026-04-01', end: '2026-04-01' });
	});
});

const request = (c: StationApiConfig, over: Partial<FetchRequest> = {}): FetchRequest => ({ source: 'station_api', config: c, start: '2026-03-01', end: '2026-03-09', today: TODAY, feedId: FEED, credential: null, ...over });

describe('FetchRequestSchema (station_api)', () => {
	const raw = (over: Record<string, unknown> = {}) => ({ source: 'station_api', config: config(), start: '2026-03-01', end: '2026-03-09', today: TODAY, feedId: FEED, credential: null, ...over });

	it('accepts a station request with its feed id and sealed key', () => {
		expect(FetchRequestSchema.safeParse(raw({ credential: 'AQID' })).success).toBe(true);
		expect(FetchRequestSchema.safeParse(raw()).success).toBe(true);
	});

	it('refuses one with no feed id, a key that is not base64 or too long, or a window past its config’s requests', () => {
		expect(FetchRequestSchema.safeParse(raw({ feedId: undefined })).success).toBe(false);
		expect(FetchRequestSchema.safeParse(raw({ credential: 'not base64!' })).success).toBe(false);
		expect(FetchRequestSchema.safeParse(raw({ credential: 'A'.repeat(6004) })).success).toBe(false);
		const c = config({ maxDaysPerRequest: 2 });
		expect(FetchRequestSchema.safeParse(raw({ config: c, start: '2026-01-01', end: addDays('2026-01-01', 2 * STATION_MAX_REQUESTS - 1) })).success).toBe(true);
		expect(FetchRequestSchema.safeParse(raw({ config: c, start: '2026-01-01', end: addDays('2026-01-01', 2 * STATION_MAX_REQUESTS) })).success).toBe(false);
	});

	it('refuses a feed id or key on any other source', () => {
		const dws = { source: 'dws', config: { station: 'A2H012' }, start: '2026-03-01', end: '2026-03-09', today: TODAY };
		expect(FetchRequestSchema.safeParse(dws).success).toBe(true);
		expect(FetchRequestSchema.safeParse({ ...dws, credential: 'AQID' }).success).toBe(false);
		expect(FetchRequestSchema.safeParse({ ...dws, feedId: FEED }).success).toBe(false);
	});
});

describe('runFetch (station_api) on the fixtures', () => {
	const noHttp = {} as FeedHttp;
	const station = { http: fixtureStationHttp(() => NOW), pacer: null };
	const budget = { now: () => NOW };
	const keys = generateFeedCredentialKeys();
	afterEach(() => vi.unstubAllEnvs());
	const sealed = (secret: string, feedId = FEED, target: StationApiConfig = keyed) => sealFeedCredential({ secret }, credentialBinding(feedId, target), { FEED_CREDENTIAL_PUBLIC_KEY: keys.publicKey });
	const withKeys = () => {
		vi.stubEnv('FEED_CREDENTIAL_PUBLIC_KEY', keys.publicKey);
		vi.stubEnv('FEED_CREDENTIAL_PRIVATE_KEY', keys.privateKey);
	};
	const keyed = config({ url: 'https://station.example/v1/keyed/daily.json?station={station}&start={start}&end={end}', auth: { kind: 'bearer' } });

	it('reads the days, as a FetchResult', async () => {
		const r = await runFetch(request(config()), noHttp, budget, { station });
		expect(r).toMatchObject({ ok: true, startDate: '2026-03-01', meta: { days: 9, requests: 1 } });
		expect((r as { values: unknown[] }).values[0]).toBe(stationFixtureRain('2026-03-01'));
	});

	it('opens the sealed key and sends it', async () => {
		withKeys();
		expect(await runFetch(request(keyed, { credential: sealed(STATION_FIXTURE_KEY) }), noHttp, budget, { station })).toMatchObject({ ok: true });
	});

	it('a key sealed for another feed doesn’t open: the owner is told to enter it again', async () => {
		withKeys();
		const r = await runFetch(request(keyed, { credential: sealed(STATION_FIXTURE_KEY, '00000000-0000-4000-8000-000000000000') }), noHttp, budget, { station });
		expect(r).toEqual({ ok: false, error: `${FEED_KEY_PREFIX}: ${STATION_KEY_PROBLEMS.unopened[0]}` });
	});

	it('a key sealed for another site doesn’t open on this one', async () => {
		withKeys();
		const elsewhere = config({ url: 'https://other.example/v1/daily.json?station={station}&start={start}&end={end}', auth: { kind: 'bearer' } });
		const r = await runFetch(request(keyed, { credential: sealed(STATION_FIXTURE_KEY, FEED, elsewhere) }), noHttp, budget, { station });
		expect(r).toEqual({ ok: false, error: `${FEED_KEY_PREFIX}: ${STATION_KEY_PROBLEMS.unopened[0]}` });
	});

	it('no key saved for an API that needs one', async () => {
		expect(await runFetch(request(keyed), noHttp, budget, { station })).toEqual({ ok: false, error: `${FEED_KEY_PREFIX}: ${STATION_KEY_PROBLEMS.missing[0]}` });
	});

	it('a refused key backs off as a refusal, naming no key', async () => {
		withKeys();
		const r = await runFetch(request(keyed, { credential: sealed('a-wrong-key-a-wrong-key') }), noHttp, budget, { station });
		expect(r.ok).toBe(false);
		const error = (r as { error: string }).error;
		expect(error.startsWith(FEED_REFUSED_PREFIX)).toBe(true);
		expect(error).not.toContain('a-wrong-key');
	});

	it('a URL error is logged by name and code, never with the URL or key it carries', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const err = Object.assign(new TypeError(`Invalid URL: https://x.example/?token=${STATION_FIXTURE_KEY}`), { code: 'ERR_INVALID_URL' });
		expect(fetchFailure(err, config())).toEqual({ ok: false, error: 'the fetch failed with an internal error' });
		const logged = spy.mock.calls.map((c) => c.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')).join('\n');
		spy.mockRestore();
		expect(logged).toContain('ERR_INVALID_URL');
		expect(logged).not.toContain(STATION_FIXTURE_KEY);
		expect(logged).not.toContain('x.example');
	});
});
