// FEED_SOURCE=fixtures for station API feeds (issue #784): a synthetic station
// API on `station.example` (a reserved name, RFC 2606), answered in this
// process, never the network, so dev, CI and e2e attach and run a station feed
// offline. The answers go through the real guarded client (stationHttp.ts,
// with this module as its requester), so a redirect, a 401 or an oversized
// answer is handled exactly as a live one would be. Invented rain, keyed to
// the date, so a feed attached today fills with recent days:
//
//   GET /v1/daily.json?station=…&start=YYYY-MM-DD&end=YYYY-MM-DD
//       {"station", "unit": "mm", "data": [{"date", "rain_mm"}]}: one total a
//       day (Africa/Johannesburg dates) through yesterday; -9999 on a missing day
//   GET /v1/5min.csv?station=…&from=<epoch s>&to=<epoch s>
//       time,rain (ISO UTC, mm per 5 minutes, stamped at the interval's end)
//       through now; the rain of a rainy day falls 06:00–12:00 UTC
//   GET /v1/keyed/daily.json?…  daily.json, only with STATION_FIXTURE_KEY sent as
//       a bearer token, an X-Api-Key header, an api_key query parameter, or
//       Basic (user STATION_FIXTURE_USER); else HTTP 401
//   GET /v1/empty.json          {"data": []}: a station with no readings (a backfill's empty stretch)
//   GET /v1/denied              HTTP 401, whatever is sent
//   GET /v1/moved               HTTP 302 to https://elsewhere.example/… (another site)
//   GET /v1/loop                HTTP 302 to itself (too many redirects)
//   GET /v1/page                HTTP 200, an HTML page (not the data)
//   GET /v1/throttled           HTTP 429, Retry-After: 60
//   anything else on the host   HTTP 404
//
// Any other host fails: in fixtures mode nothing leaves the process, and a
// real API needs FEED_SOURCE=live (a gitignored .env.development.local).
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { FeedUnavailableError } from './errors.js';
import { type Requester, type StationHttp, stationHttp } from './stationHttp.js';

export const STATION_FIXTURE_HOST = 'station.example';
export const STATION_FIXTURE_BASE = `https://${STATION_FIXTURE_HOST}`;
/** The key the keyed endpoint takes (dev-only, invented). */
export const STATION_FIXTURE_KEY = 'fixture-station-key-0001';
export const STATION_FIXTURE_USER = 'fixture';
/** The zone the daily endpoint's dates are in. */
export const STATION_FIXTURE_ZONE = 'Africa/Johannesburg';
const DAY_MS = 86_400_000;
const STEP_MS = 5 * 60_000;
/** The most rows one 5-minute answer holds (a year), like a real API's own cap; more is HTTP 400. */
const MAX_ROWS = 366 * 288;

/** Whether `day` (epoch day) is a missing day: the daily endpoint says -9999, the 5-minute one a -9999 reading at 09:00 UTC. */
export const stationFixtureMissing = (day: number) => ((day % 29) + 29) % 29 === 0;

/** The invented rain (mm) of `day` (an epoch day or ISO date): about three days in ten rain, 0.5–25 mm; null on a missing day. */
export function stationFixtureRain(day: number | string): number | null {
	const d = typeof day === 'string' ? toEpochDay(day) : day;
	if (stationFixtureMissing(d)) return null;
	const h = Math.imul(d, 2654435761) >>> 0;
	if (h % 100 >= 30) return 0;
	return Math.round((0.5 + ((h >>> 8) % 23) * 1.1) * 10) / 10;
}

/** The rain of the 5-minute interval ending at `endMs`: the day's rain spread over the 72 intervals 06:00–12:00 UTC; null for the missing reading. */
export function stationFixtureRain5(endMs: number): number | null {
	const startMs = endMs - STEP_MS;
	const day = Math.floor(startMs / DAY_MS);
	const minute = (startMs - day * DAY_MS) / 60_000;
	if (stationFixtureMissing(day) && minute === 9 * 60) return null;
	const total = stationFixtureMissing(day) ? 0 : stationFixtureRain(day)!;
	if (total === 0 || minute < 6 * 60 || minute >= 12 * 60) return 0;
	return Math.round((total / 72) * 1e4) / 1e4;
}

/** A local date in `tz` as an epoch day. */
const localDay = (ms: number, tz: string) => toEpochDay(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)));

interface Answer {
	status: number;
	headers?: Record<string, string>;
	body?: string;
}

const json = (v: unknown): Answer => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });
const bad = (why: string): Answer => ({ status: 400, headers: { 'content-type': 'text/plain' }, body: why });

function daily(q: URLSearchParams, now: number): Answer {
	const station = q.get('station');
	const start = q.get('start') ?? '';
	const end = q.get('end') ?? '';
	if (!station) return bad('station is required');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return bad('start and end are YYYY-MM-DD');
	const last = Math.min(toEpochDay(end), localDay(now, STATION_FIXTURE_ZONE) - 1);
	const data: { date: string; rain_mm: number }[] = [];
	for (let d = toEpochDay(start); d <= last; d++) data.push({ date: fromEpochDay(d), rain_mm: stationFixtureRain(d) ?? -9999 });
	return json({ station, unit: 'mm', data });
}

function fiveMinute(q: URLSearchParams, now: number): Answer {
	const station = q.get('station');
	const from = Number(q.get('from'));
	const to = Number(q.get('to'));
	if (!station) return bad('station is required');
	if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return bad('from and to are epoch seconds');
	const first = Math.floor((from * 1000) / STEP_MS) * STEP_MS + STEP_MS;
	const last = Math.min(to * 1000, now);
	if ((last - first) / STEP_MS > MAX_ROWS) return bad('at most a year a request');
	const rows = ['time,rain'];
	for (let t = first; t <= last; t += STEP_MS) {
		const v = stationFixtureRain5(t);
		rows.push(`${new Date(t).toISOString().replace('.000Z', 'Z')},${v === null ? '-9999' : v}`);
	}
	return { status: 200, headers: { 'content-type': 'text/csv' }, body: `${rows.join('\n')}\n` };
}

/** Whether a request to the keyed endpoint carries the fixture key, in any of the four ways a feed sends one. */
function keyed(url: URL, headers: Record<string, unknown>): boolean {
	const h = (n: string) => {
		const v = Object.entries(headers).find(([k]) => k.toLowerCase() === n)?.[1];
		return typeof v === 'string' ? v : null;
	};
	const auth = h('authorization');
	if (auth === `Bearer ${STATION_FIXTURE_KEY}`) return true;
	if (auth === `Basic ${Buffer.from(`${STATION_FIXTURE_USER}:${STATION_FIXTURE_KEY}`).toString('base64')}`) return true;
	if (h('x-api-key') === STATION_FIXTURE_KEY) return true;
	return url.searchParams.get('api_key') === STATION_FIXTURE_KEY;
}

/** The synthetic API's answer to one GET. */
export function stationFixtureAnswer(url: URL, headers: Record<string, unknown>, now: number): Answer {
	const q = url.searchParams;
	switch (url.pathname) {
		case '/v1/daily.json':
			return daily(q, now);
		case '/v1/5min.csv':
			return fiveMinute(q, now);
		case '/v1/keyed/daily.json':
			return keyed(url, headers) ? daily(q, now) : { status: 401, headers: { 'www-authenticate': 'Bearer' }, body: '{"error":"unauthorised"}' };
		case '/v1/empty.json':
			return json({ station: q.get('station'), unit: 'mm', data: [] });
		case '/v1/denied':
			return { status: 401, body: '{"error":"unauthorised"}' };
		case '/v1/moved':
			return { status: 302, headers: { location: `https://elsewhere.example/v1/daily.json${url.search}` } };
		case '/v1/loop':
			return { status: 302, headers: { location: '/v1/loop' } };
		case '/v1/page':
			return { status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><title>Sign in</title><p>Please sign in.</p>' };
		case '/v1/throttled':
			return { status: 429, headers: { 'retry-after': '60' } };
		default:
			return { status: 404, body: 'not found' };
	}
}

/** The answer as the response node's https.request would give: a readable body with a status and headers. */
function message(a: Answer): IncomingMessage {
	const body = Buffer.from(a.body ?? '', 'utf8');
	const res = Readable.from(body.length ? [body] : []) as unknown as IncomingMessage;
	res.statusCode = a.status;
	res.headers = { 'content-length': String(body.length), ...(a.headers ?? {}) };
	return res;
}

/** The requester stationHttp asks through in fixtures mode: station.example answered here, anything else refused. */
export function fixtureRequester(now: () => number = Date.now): Requester {
	return async (url, opts) => {
		if (url.hostname !== STATION_FIXTURE_HOST) {
			throw new FeedUnavailableError(
				`with FEED_SOURCE=fixtures a station feed can only ask the synthetic API on ${STATION_FIXTURE_HOST}: set FEED_SOURCE=live (in backend/.env.development.local) to ask ${url.hostname}`
			);
		}
		return message(stationFixtureAnswer(url, (opts.headers ?? {}) as Record<string, unknown>, now()));
	};
}

/** The fixtures' station client: the real guarded client, answered by the synthetic API. */
export function fixtureStationHttp(now: () => number = Date.now): StationHttp {
	return stationHttp({ requester: fixtureRequester(now) });
}
