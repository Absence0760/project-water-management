// A station API feed's fetch (issue #784): ask the owner's station API for a
// window of rain days and turn its answers into daily rain.
//
// The window [start, end] is cut into requests of at most maxDaysPerRequest
// days (STATION_MAX_REQUESTS of them at most: fetch.ts fetchWindow never asks
// for more), each URL built from the template with {station}, {start} and
// {end} filled in (every value URL-encoded; {start} and {end} the instants
// that cover the rain days, engine stationRange, written in urlTimeFormat in
// the format's zone). The key goes on at request time, never into the stored
// URL: a bearer or named header, a query parameter appended to the URL, or
// Basic. The requests go one after another, at most one a second to a host
// (http.ts hostPacer), through the guarded client (stationHttp.ts), and each
// answer is read with the engine's readStationAnswer, the same parser the
// attach card's "Try it on a sample" uses. Readings from all the answers are
// merged (a reading two answers both carry counts once; two that disagree
// fail the fetch) and summed into rain days over the whole window
// (stationDays), so a day split across two requests is still one day.
//
// Messages: ours, or the parser's naming the field that didn't fit, with the
// key scrubbed from anything that could have echoed it. Never the URL's
// query, the key or an answer's body (docs/security.md § Data feeds).
import {
	type StationFormat,
	type StationReading,
	type StationReadings,
	STATION_DEFAULT_TIME_ZONE,
	StationFormatError,
	formatStationTime,
	readStationAnswer,
	stationDays,
	stationRange
} from '@water-management/engine/station-format';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { StationApiConfig } from '../config.js';
import { STATION_MAX_REQUESTS } from '../config.js';
import type { FeedCredential } from '../credential.js';
import { FeedFormatError, FeedKeyError } from '../errors.js';
import { hostPacer, type Pacer } from '../http.js';
import type { StationHttp } from '../stationHttp.js';

export const STATION_DEFAULT_MAX_DAYS = 31;
export const STATION_DEFAULT_REVISION_DAYS = 7;
export const STATION_DEFAULT_URL_TIME_FORMAT = 'YYYY-MM-DD';
/** A first fetch with no startDate reaches this many days back. */
export const STATION_FIRST_DAYS = 90;

/** A key problem's fixed texts (errors.ts FeedKeyError), each with the label the fetcher logs as its detail. */
export const STATION_KEY_PROBLEMS = {
	missing: ['no key is saved: add one (Replace key)', 'no key saved'],
	unopened: ['the saved key could not be opened: enter it again (Replace key)', 'key not opened'],
	noUser: ['Basic sign-in needs a user name with the key: enter both again (Replace key)', 'no user name']
} as const satisfies Record<string, readonly [string, string]>;

const addDays = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);

/** The days one fetch may cover: STATION_MAX_REQUESTS requests of maxDaysPerRequest days. */
export const stationWindowDays = (config: Pick<StationApiConfig, 'maxDaysPerRequest'>) => (config.maxDaysPerRequest ?? STATION_DEFAULT_MAX_DAYS) * STATION_MAX_REQUESTS;

/**
 * The newest rain day a station can have finished by `nowMs`: a daily total once its date is past in the format's
 * zone, a sub-daily rain day once its end (dayStartHour the next morning) has passed. Never after `utcToday`, the
 * newest day the ingest accepts (ingest.ts latestDay). fetchWindow ends its window here and the ingest counts a
 * feed caught up from here, so the two never disagree about whether a backfill has more to read.
 */
export function stationLastDay(format: StationFormat, nowMs: number, utcToday: string): string {
	const tz = format.timeZone ?? STATION_DEFAULT_TIME_ZONE;
	const localDay = (t: number) => {
		const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
		return toEpochDay(parts);
	};
	let last: number;
	if (format.resolution === 'daily') last = localDay(nowMs) - 1;
	else {
		// The rain day an instant falls in: the local date after shifting back to the day's start hour, plus one when
		// the provider credits a rain day to the date it ends on (the engine's rainDay).
		const shift = (format.dayStartHour ?? 8) * 3_600_000;
		last = localDay(nowMs - shift) + (format.creditDayTo === 'end' ? 1 : 0) - 1;
	}
	const cap = toEpochDay(utcToday);
	return fromEpochDay(Math.min(last, cap));
}

/** One request's rain days, inclusive. */
export interface StationChunk {
	from: string;
	to: string;
}

/** The window cut into requests of at most `maxDays` days, in order. */
export function stationChunks(start: string, end: string, maxDays: number): StationChunk[] {
	const out: StationChunk[] = [];
	for (let a = toEpochDay(start), b = toEpochDay(end); a <= b; a += maxDays) out.push({ from: fromEpochDay(a), to: fromEpochDay(Math.min(b, a + maxDays - 1)) });
	return out;
}

/** The URL for one request: the template's placeholders filled in, each value URL-encoded. No key: that goes on in authorise. */
export function stationRequestUrl(config: StationApiConfig, chunk: StationChunk): string {
	const range = stationRange(config.format, chunk.from, chunk.to);
	const tz = config.format.timeZone ?? STATION_DEFAULT_TIME_ZONE;
	const fmt = config.urlTimeFormat ?? STATION_DEFAULT_URL_TIME_FORMAT;
	// {end}: the last instant the window covers. A date pattern names the last day itself (the range's end is the next
	// day's start, exclusive); a time names the end instant, which every API we know of reads as up to.
	const dateOnly = !/HH|iso|epoch/.test(fmt);
	const endMs = dateOnly ? range.endMs - 1 : range.endMs;
	const values: Record<string, string> = {
		'{station}': config.station ?? '',
		'{start}': formatStationTime(range.startMs, fmt, tz),
		'{end}': formatStationTime(endMs, fmt, tz)
	};
	return config.url.replace(/\{(station|start|end)\}/g, (p) => encodeURIComponent(values[p]!));
}

/** A request with the key on: the URL (a query key appended) and the headers to send. */
export function authorise(config: StationApiConfig, url: string, credential: FeedCredential | null): { url: string; headers: Record<string, string> } {
	const headers: Record<string, string> = { ...(config.headers ?? {}) };
	const auth = config.auth;
	if (auth.kind === 'none') return { url, headers };
	if (!credential) throw new FeedKeyError(STATION_KEY_PROBLEMS.missing[0]);
	switch (auth.kind) {
		case 'bearer':
			headers.authorization = `Bearer ${credential.secret}`;
			return { url, headers };
		case 'header':
			headers[auth.name] = `${auth.prefix}${credential.secret}`;
			return { url, headers };
		case 'query': {
			const u = new URL(url);
			u.searchParams.append(auth.name, credential.secret);
			return { url: u.href, headers };
		}
		case 'basic':
			if (!credential.user) throw new FeedKeyError(STATION_KEY_PROBLEMS.noUser[0]);
			headers.authorization = `Basic ${Buffer.from(`${credential.user}:${credential.secret}`, 'utf8').toString('base64')}`;
			return { url, headers };
	}
}

/** Merge readings from several answers: one per instant (or day); two that disagree fail the fetch. */
export function mergeReadings(parts: StationReadings[], format: StationFormat): StationReadings {
	const out = new Map<number, number | null>();
	let records = 0;
	for (const p of parts) {
		records += p.records;
		for (const r of p.readings) {
			if (!out.has(r.at)) {
				out.set(r.at, r.value);
				continue;
			}
			const prev = out.get(r.at)!;
			const same = prev === r.value || (prev !== null && r.value !== null && Math.abs(prev - r.value) < 1e-9);
			if (!same) {
				const when = format.resolution === 'daily' ? fromEpochDay(r.at) : new Date(r.at).toISOString().replace('.000Z', 'Z');
				throw new StationFormatError(`two answers disagree about the reading at ${when} (${prev ?? 'missing'} and ${r.value ?? 'missing'})`);
			}
		}
	}
	const readings: StationReading[] = [...out].map(([at, value]) => ({ at, value })).sort((a, b) => a.at - b.at);
	return { readings, records };
}

/** Shared by every station fetch in one process (a warm fetcher Lambda keeps its pace across invocations), apart from CHC's. */
const PACER: Pacer = hostPacer();

/** How a station fetch reaches its API: the client, and the pacer (null for the in-process fixtures, which need none). */
export interface StationClient {
	http: StationHttp;
	pacer: Pacer | null;
}

/** The client for FEED_SOURCE: the guarded live client at a polite pace, or the synthetic API on station.example. */
export async function stationClient(mode: 'fixtures' | 'live'): Promise<StationClient> {
	if (mode === 'live') {
		const { stationHttp } = await import('../stationHttp.js');
		return { http: stationHttp(), pacer: PACER };
	}
	const { fixtureStationHttp } = await import('../stationFixtures.js');
	return { http: fixtureStationHttp(), pacer: null };
}

export interface StationFetch {
	startDate: string | null;
	values: (number | null)[];
	meta: Record<string, string | number>;
}

/** Every form of the key an error message could carry it in, to scrub (the raw secret, URL-encoded, and Basic's). */
function scrubber(credential: FeedCredential | null): (s: string) => string {
	if (!credential) return (s) => s;
	const forms = [credential.secret, encodeURIComponent(credential.secret), credential.user ? Buffer.from(`${credential.user}:${credential.secret}`).toString('base64') : '']
		.filter((f) => f.length >= 4)
		.sort((a, b) => b.length - a.length);
	return (s) => forms.reduce((acc, f) => acc.split(f).join('…'), s);
}

/**
 * Fetch rain days `start`..`end` (inclusive) of a station API feed. `credential` is the opened key (null when none is
 * saved), `nowMs` the clock that decides which days have ended. Throws the feed errors (errors.ts) with our messages.
 */
export async function fetchStation(
	config: StationApiConfig,
	window: { start: string; end: string },
	credential: FeedCredential | null,
	client: StationClient,
	nowMs: number
): Promise<StationFetch> {
	const maxDays = config.maxDaysPerRequest ?? STATION_DEFAULT_MAX_DAYS;
	const chunks = stationChunks(window.start, window.end, maxDays);
	// fetchWindow and the request schema keep a window to STATION_MAX_REQUESTS requests: more is a bug, never cut quietly
	// (the ingest records the whole window as read).
	if (chunks.length > STATION_MAX_REQUESTS) throw new Error(`a station window of ${chunks.length} requests is more than one fetch makes (${STATION_MAX_REQUESTS})`);
	const scrub = scrubber(credential);
	const parts: StationReadings[] = [];
	try {
		for (const chunk of chunks) {
			const req = authorise(config, stationRequestUrl(config, chunk), credential);
			const host = new URL(req.url).host;
			const release = client.pacer ? await client.pacer.acquire(host) : () => {};
			let text: string;
			try {
				({ text } = await client.http.get(req));
			} finally {
				release();
			}
			parts.push(readStationAnswer(text, config.format));
		}
		const merged = mergeReadings(parts, config.format);
		const days = stationDays(merged, config.format, window.start, window.end, nowMs);
		const meta: Record<string, string | number> = { days: days.values.length, daysWithData: days.daysWithData, gaps: days.gaps, requests: chunks.length, readings: merged.readings.length };
		return days.values.length === 0 ? { startDate: null, values: [], meta } : { startDate: days.startDate, values: days.values, meta };
	} catch (err) {
		if (err instanceof StationFormatError) throw new FeedFormatError(scrub(`the station API’s answer: ${err.message}`));
		if (err instanceof Error && /^Feed/.test(err.name)) {
			// Ours already, but the key may sit in a message only by accident: scrub it all the same, keeping the class.
			const clean = scrub(err.message);
			if (clean !== err.message) err.message = clean;
		}
		throw err;
	}
}

/** The day a station feed's first fetch starts with no startDate: STATION_FIRST_DAYS before its last day. */
export const stationFirstDay = (last: string) => addDays(last, 1 - STATION_FIRST_DAYS);
