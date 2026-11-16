import { describe, expect, it } from 'vitest';
import { StationApiConfig } from '../config.js';
import { feedErrorMessage, FeedFormatError, FeedKeyError, FeedKeyRefusedError, FeedUnavailableError } from '../errors.js';
import type { StationHttp, StationRequest } from '../stationHttp.js';
import { fixtureStationHttp, STATION_FIXTURE_KEY, stationFixtureRain } from '../stationFixtures.js';
import { authorise, fetchStation, mergeReadings, STATION_KEY_PROBLEMS, stationChunks, stationLastDay, stationRequestUrl, type StationClient } from './station.js';

// 2026-03-10 12:00 in Johannesburg (UTC+2).
const NOW = Date.parse('2026-03-10T10:00:00Z');
const SECRET = 'sk_live_0123456789abcdefXYZ';

const daily = (over: Record<string, unknown> = {}) =>
	StationApiConfig.parse({
		url: 'https://api.example.com/v1/rain?station={station}&from={start}&to={end}',
		station: 'ST 1:a',
		auth: { kind: 'none' },
		format: { format: 'json', records: 'data', time: 'date', value: 'mm', timeFormat: 'YYYY-MM-DD', resolution: 'daily' },
		...over
	});

/** A StationHttp that records each request and answers from `answer`. */
function recorder(answer: (req: StationRequest) => string | Error): { client: StationClient; seen: StationRequest[] } {
	const seen: StationRequest[] = [];
	const http: StationHttp = {
		async get(req) {
			seen.push(req);
			const a = answer(req);
			if (a instanceof Error) throw a;
			return { text: a, contentType: 'application/json' };
		}
	};
	return { client: { http, pacer: null }, seen };
}

/** A daily JSON answer for the URL's from..to (YYYY-MM-DD), `mm(day)` each day. */
const dailyAnswer = (mm: (day: string) => number | null) => (req: StationRequest) => {
	const u = new URL(req.url);
	const out: { date: string; mm: number | null }[] = [];
	for (let d = u.searchParams.get('from')!; d <= u.searchParams.get('to')!; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push({ date: d, mm: mm(d) });
	return JSON.stringify({ data: out });
};

describe('stationChunks', () => {
	it('cuts a window into requests of at most maxDays days', () => {
		expect(stationChunks('2026-01-01', '2026-01-10', 4)).toEqual([
			{ from: '2026-01-01', to: '2026-01-04' },
			{ from: '2026-01-05', to: '2026-01-08' },
			{ from: '2026-01-09', to: '2026-01-10' }
		]);
		expect(stationChunks('2026-01-01', '2026-01-01', 31)).toEqual([{ from: '2026-01-01', to: '2026-01-01' }]);
	});
});

describe('stationRequestUrl', () => {
	it('fills each placeholder URL-encoded, {end} naming the last day for a date pattern', () => {
		const url = stationRequestUrl(daily(), { from: '2026-03-01', to: '2026-03-05' });
		expect(url).toBe('https://api.example.com/v1/rain?station=ST%201%3Aa&from=2026-03-01&to=2026-03-05');
	});

	it('writes epoch seconds for the instants covering sub-daily rain days (08:00 local to 08:00)', () => {
		const c = daily({
			urlTimeFormat: 'epoch_s',
			format: { format: 'csv', time: 'time', value: 'rain', timeFormat: 'iso', resolution: 'subdaily' }
		});
		const u = new URL(stationRequestUrl(c, { from: '2026-03-01', to: '2026-03-01' }));
		expect(Number(u.searchParams.get('from')) * 1000).toBe(Date.parse('2026-03-01T06:00:00Z'));
		expect(Number(u.searchParams.get('to')) * 1000).toBe(Date.parse('2026-03-02T06:00:00Z'));
	});

	it('cannot be steered by a station ID: & and = stay inside the value', () => {
		const c = { ...daily(), station: 'a&key=x' };
		expect(new URL(stationRequestUrl(c, { from: '2026-03-01', to: '2026-03-01' })).searchParams.get('key')).toBeNull();
	});
});

describe('authorise', () => {
	const url = 'https://api.example.com/v1/rain?station=1';
	it('sends nothing for none, and refuses a needed key that is missing', () => {
		expect(authorise(daily(), url, null)).toEqual({ url, headers: {} });
		expect(() => authorise(daily({ auth: { kind: 'bearer' } }), url, null)).toThrow(FeedKeyError);
		expect(() => authorise(daily({ auth: { kind: 'bearer' } }), url, null)).toThrow(STATION_KEY_PROBLEMS.missing[0]);
	});
	it('bearer, a named header with its prefix, Basic, and extra headers', () => {
		expect(authorise(daily({ auth: { kind: 'bearer' } }), url, { secret: SECRET }).headers).toEqual({ authorization: `Bearer ${SECRET}` });
		expect(authorise(daily({ auth: { kind: 'header', name: 'X-Api-Key', prefix: 'Token ' }, headers: { Accept: 'application/json' } }), url, { secret: SECRET }).headers).toEqual({
			Accept: 'application/json',
			'X-Api-Key': `Token ${SECRET}`
		});
		const basic = authorise(daily({ auth: { kind: 'basic' } }), url, { secret: SECRET, user: 'me' });
		expect(basic.headers.authorization).toBe(`Basic ${Buffer.from(`me:${SECRET}`).toString('base64')}`);
		expect(() => authorise(daily({ auth: { kind: 'basic' } }), url, { secret: SECRET })).toThrow(STATION_KEY_PROBLEMS.noUser[0]);
	});
	it('appends a query key to the request URL, never to the config', () => {
		const c = daily({ auth: { kind: 'query', name: 'apikey' } });
		const r = authorise(c, url, { secret: 'a b&c' });
		expect(new URL(r.url).searchParams.get('apikey')).toBe('a b&c');
		expect(r.headers).toEqual({});
		expect(c.url).not.toContain('apikey');
	});
});

describe('stationLastDay', () => {
	const f = daily().format;
	it('is yesterday in the zone for daily totals', () => {
		expect(stationLastDay(f, NOW, '2026-03-10')).toBe('2026-03-09');
		// 23:30 UTC on the 9th is already the 10th in Johannesburg.
		expect(stationLastDay(f, Date.parse('2026-03-09T23:30:00Z'), '2026-03-09')).toBe('2026-03-09');
	});
	it('is the last rain day whose end (08:00 the next morning) has passed for sub-daily readings', () => {
		const sub = { ...f, resolution: 'subdaily' as const };
		expect(stationLastDay(sub, Date.parse('2026-03-10T05:59:00Z'), '2026-03-10')).toBe('2026-03-08');
		expect(stationLastDay(sub, Date.parse('2026-03-10T06:00:00Z'), '2026-03-10')).toBe('2026-03-09');
	});
	it('never passes the UTC day the ingest accepts', () => {
		const ahead = { ...f, resolution: 'subdaily' as const, creditDayTo: 'end' as const, timeZone: 'Pacific/Kiritimati' };
		expect(stationLastDay(ahead, Date.parse('2026-03-10T23:00:00Z'), '2026-03-10') <= '2026-03-10').toBe(true);
	});
});

describe('mergeReadings', () => {
	const f = daily().format;
	it('counts a reading two answers carry once, and fails when they disagree', () => {
		const a = { readings: [{ at: 1, value: 2 }, { at: 2, value: 3 }], records: 2 };
		expect(mergeReadings([a, { readings: [{ at: 2, value: 3 }, { at: 3, value: null }], records: 2 }], f)).toEqual({
			readings: [{ at: 1, value: 2 }, { at: 2, value: 3 }, { at: 3, value: null }],
			records: 4
		});
		expect(() => mergeReadings([a, { readings: [{ at: 2, value: 4 }], records: 1 }], f)).toThrow(/disagree/);
	});
});

describe('fetchStation', () => {
	it('asks one request per maxDaysPerRequest days and merges them into one run of days', async () => {
		const { client, seen } = recorder(dailyAnswer((d) => (d === '2026-03-03' ? null : Number(d.slice(-2)))));
		const r = await fetchStation(daily({ maxDaysPerRequest: 3 }), { start: '2026-03-01', end: '2026-03-08' }, null, client, NOW);
		expect(seen.map((s) => new URL(s.url).searchParams.get('from'))).toEqual(['2026-03-01', '2026-03-04', '2026-03-07']);
		expect(r.startDate).toBe('2026-03-01');
		expect(r.values).toEqual([1, 2, null, 4, 5, 6, 7, 8]);
		expect(r.meta).toMatchObject({ days: 8, daysWithData: 7, gaps: 1, requests: 3 });
		expect(JSON.stringify(r.meta)).not.toContain('example.com');
	});

	it('writes only days that have ended', async () => {
		const { client } = recorder(dailyAnswer(() => 1));
		const r = await fetchStation(daily(), { start: '2026-03-08', end: '2026-03-12' }, null, client, NOW);
		expect(r.values).toEqual([1, 1]);
	});

	it('answers no days when nothing has ended', async () => {
		const { client } = recorder(dailyAnswer(() => 1));
		expect(await fetchStation(daily(), { start: '2026-03-10', end: '2026-03-10' }, null, client, NOW)).toMatchObject({ startDate: null, values: [] });
	});

	it('refuses a window of more requests than one fetch makes', async () => {
		const { client } = recorder(dailyAnswer(() => 1));
		await expect(fetchStation(daily({ maxDaysPerRequest: 1 }), { start: '2026-01-01', end: '2026-03-01' }, null, client, NOW)).rejects.toThrow(/more than one fetch/);
	});

	it('words a format failure as the answer’s, and scrubs a key the answer echoed', async () => {
		const { client } = recorder(() => JSON.stringify({ data: [{ date: '2026-03-01', mm: `bad ${SECRET}` }] }));
		const err = await fetchStation(daily({ auth: { kind: 'bearer' } }), { start: '2026-03-01', end: '2026-03-01' }, { secret: SECRET }, client, NOW).catch((e) => e);
		expect(err).toBeInstanceOf(FeedFormatError);
		expect(err.message).toMatch(/^the station API’s answer: record 1: the value/);
		expect(feedErrorMessage(err)).not.toContain(SECRET);
		expect(feedErrorMessage(err)).not.toContain(SECRET.slice(0, 20));
	});

	it('passes the client’s refusals through, with no key or query in the stored message', async () => {
		for (const thrown of [new FeedKeyRefusedError(401), new FeedUnavailableError('the station API didn’t answer in time')]) {
			const { client } = recorder(() => thrown);
			const err = await fetchStation(daily({ auth: { kind: 'query', name: 'token' } }), { start: '2026-03-01', end: '2026-03-01' }, { secret: SECRET }, client, NOW).catch((e) => e);
			expect(err).toBe(thrown);
			expect(feedErrorMessage(err)).not.toContain(SECRET);
			expect(feedErrorMessage(err)).not.toContain('token=');
		}
	});

	it('paces requests to one host through the pacer', async () => {
		const hosts: string[] = [];
		const { client } = recorder(dailyAnswer(() => 0));
		client.pacer = { acquire: async (h) => (hosts.push(h), () => {}) };
		await fetchStation(daily({ maxDaysPerRequest: 2 }), { start: '2026-03-01', end: '2026-03-04' }, null, client, NOW);
		expect(hosts).toEqual(['api.example.com', 'api.example.com']);
	});
});

describe('fetchStation on the fixtures (station.example)', () => {
	const now = () => NOW;
	const fx: StationClient = { http: fixtureStationHttp(now), pacer: null };
	const base = { start: '2026-02-20', end: '2026-03-09' };

	it('reads the daily JSON endpoint', async () => {
		const c = daily({ url: 'https://station.example/v1/daily.json?station={station}&start={start}&end={end}', format: { format: 'json', records: 'data', time: 'date', value: 'rain_mm', timeFormat: 'YYYY-MM-DD', resolution: 'daily' } });
		const r = await fetchStation(c, base, null, fx, NOW);
		expect(r.startDate).toBe('2026-02-20');
		expect(r.values).toHaveLength(18);
		expect(r.values[0]).toBe(stationFixtureRain('2026-02-20'));
		expect(r.values.at(-1)).toBe(stationFixtureRain('2026-03-09'));
	});

	it('sums the 5-minute CSV endpoint into rain days that match the daily totals', async () => {
		const c = daily({
			url: 'https://station.example/v1/5min.csv?station={station}&from={start}&to={end}',
			urlTimeFormat: 'epoch_s',
			maxDaysPerRequest: 7,
			format: { format: 'csv', time: 'time', value: 'rain', timeFormat: 'iso', resolution: 'subdaily', dayStartHour: 0, timeZone: 'UTC' }
		});
		const r = await fetchStation(c, base, null, fx, NOW);
		expect(r.meta.requests).toBe(3);
		r.values.forEach((v, i) => {
			const day = new Date(Date.parse(`${base.start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
			const want = stationFixtureRain(day);
			if (want === null) expect(v).toBeNull();
			else expect(v).toBeCloseTo(want, 1);
		});
	});

	it('takes the keyed endpoint only with the key, and maps a refusal to the key', async () => {
		const c = daily({ url: 'https://station.example/v1/keyed/daily.json?station={station}&start={start}&end={end}', auth: { kind: 'bearer' }, format: { format: 'json', records: 'data', time: 'date', value: 'rain_mm', timeFormat: 'YYYY-MM-DD', resolution: 'daily' } });
		expect((await fetchStation(c, base, { secret: STATION_FIXTURE_KEY }, fx, NOW)).values).toHaveLength(18);
		const err = await fetchStation(c, base, { secret: 'wrong-key-wrong-key' }, fx, NOW).catch((e) => e);
		expect(err).toBeInstanceOf(FeedKeyRefusedError);
		expect(feedErrorMessage(err)).not.toContain('wrong-key');
	});

	it('refuses a redirect to another site, naming the site but never the key', async () => {
		const c = daily({ url: 'https://station.example/v1/moved?station={station}', auth: { kind: 'query', name: 'api_key' } });
		const err = await fetchStation(c, base, { secret: STATION_FIXTURE_KEY }, fx, NOW).catch((e) => e);
		expect(err).toBeInstanceOf(FeedFormatError);
		expect(err.message).toContain('https://elsewhere.example');
		expect(feedErrorMessage(err)).not.toContain(STATION_FIXTURE_KEY);
	});

	it('says a web page is not the data', async () => {
		const err = await fetchStation(daily({ url: 'https://station.example/v1/page?s={station}' }), base, null, fx, NOW).catch((e) => e);
		expect(err.message).toMatch(/web page \(HTML\)/);
	});

	it('refuses any other host offline, saying FEED_SOURCE=live is needed', async () => {
		const err = await fetchStation(daily(), base, null, fx, NOW).catch((e) => e);
		expect(err).toBeInstanceOf(FeedUnavailableError);
		expect(err.message).toMatch(/FEED_SOURCE=live/);
	});
});
