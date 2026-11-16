// Data → Data feeds → Attach a feed → Weather station API (issue #784; docs/ui.md § Data feeds). The form's state as
// typed, the request body it makes, the presets that prefill it, and the sample preview's summary. Pure, so it is
// tested without a page; only StationApiFeedForm.svelte (a lazy chunk of its own) imports it, so the station format
// reader below never reaches the panel's chunk. The server checks everything again (backend/src/feeds/config.ts
// StationApiConfig); these checks only say what is wrong before anything is sent, in the form's words.
import {
	STATION_DEFAULT_MISSING,
	STATION_DEFAULT_TIME_ZONE,
	stationFormatProblem,
	timeFormatProblem,
	type StationFormat
} from '@water-management/engine/station-format';
import type { StationApiConfigBody, StationAuthBody, StationCredentialBody } from './feeds';

export type StationAuthKind = StationAuthBody['kind'];

/** One extra header the API wants, as typed (not secret: viewers can read it). */
export interface StationHeaderRow {
	name: string;
	value: string;
}

/** The form's state: text fields as typed, so a half-typed number is kept and explained, not dropped. */
export interface StationDraft {
	/** The URL template, with {station}, {start} and {end}. */
	url: string;
	station: string;
	authKind: StationAuthKind;
	/** auth 'header': the header's name and what goes before the key ("Token "). */
	headerName: string;
	headerPrefix: string;
	/** auth 'query': the parameter's name. */
	queryName: string;
	/** The key (write-only: never read back from the server). For 'basic', the password. */
	secret: string;
	/** auth 'basic': the user name. */
	user: string;
	headers: StationHeaderRow[];
	/** How {start} and {end} are written: a URL_TIME_CHOICES value, or 'custom' for urlTimeCustom. */
	urlTime: string;
	urlTimeCustom: string;
	maxDays: string;
	revisionDays: string;
	/** YYYY-MM-DD or '' (the default, 90 days back). */
	startDate: string;
	format: 'json' | 'csv';
	records: string;
	recordsKeyedByTime: boolean;
	delimiter: ',' | ';' | '\t' | '|';
	headerRow: boolean;
	skipLines: string;
	decimalComma: boolean;
	time: string;
	/** A TIME_CHOICES value, or 'custom' for timeFormatCustom. */
	timeFormat: string;
	timeFormatCustom: string;
	timeZone: string;
	value: string;
	resolution: 'daily' | 'subdaily';
	stampMarks: 'end' | 'start';
	/** '0'–'23'. */
	dayStartHour: string;
	creditDayTo: 'start' | 'end';
	valueKind: 'amount' | 'cumulative';
	scale: string;
	/** Comma-separated markers; an empty value always counts as missing. */
	missing: string;
	noReadingsMeans: 'gap' | 'zero';
}

/** The missing markers the format reads by default, as the field shows them (the empty value is always one). */
export const DEFAULT_MISSING_TEXT = STATION_DEFAULT_MISSING.filter(Boolean).join(', ');
export const DEFAULT_URL_TIME = 'YYYY-MM-DD';
export const MAX_EXTRA_HEADERS = 8;

export const emptyStationDraft = (): StationDraft => ({
	url: '',
	station: '',
	authKind: 'none',
	headerName: '',
	headerPrefix: '',
	queryName: '',
	secret: '',
	user: '',
	headers: [],
	urlTime: DEFAULT_URL_TIME,
	urlTimeCustom: '',
	maxDays: '',
	revisionDays: '',
	startDate: '',
	format: 'json',
	records: '',
	recordsKeyedByTime: false,
	delimiter: ',',
	headerRow: true,
	skipLines: '',
	decimalComma: false,
	time: '',
	timeFormat: 'YYYY-MM-DD',
	timeFormatCustom: '',
	timeZone: STATION_DEFAULT_TIME_ZONE,
	value: '',
	resolution: 'daily',
	stampMarks: 'end',
	dayStartHour: '8',
	creditDayTo: 'start',
	valueKind: 'amount',
	scale: '',
	missing: DEFAULT_MISSING_TEXT,
	noReadingsMeans: 'gap'
});

export const AUTH_CHOICES: { value: StationAuthKind; label: string }[] = [
	{ value: 'none', label: 'No key' },
	{ value: 'bearer', label: 'Bearer token (Authorization: Bearer …)' },
	{ value: 'header', label: 'In a header' },
	{ value: 'query', label: 'As a parameter in the URL' },
	{ value: 'basic', label: 'User name and password' }
];

/** How {start} and {end} are written in the URL, each with an example of 15 Nov 2026. */
export const URL_TIME_CHOICES: { value: string; label: string }[] = [
	{ value: 'YYYY-MM-DD', label: 'Year-month-day: 2026-11-15' },
	{ value: 'YYYYMMDD', label: 'Year-month-day, no dashes: 20261115' },
	{ value: 'DD/MM/YYYY', label: 'Day/month/year: 15/11/2026' },
	{ value: 'iso', label: 'Date and time: 2026-11-15T00:00:00' },
	{ value: 'epoch_s', label: 'Seconds since 1970 (Unix time)' },
	{ value: 'epoch_ms', label: 'Milliseconds since 1970' },
	{ value: 'custom', label: 'Another pattern…' }
];

/** How the answer writes each reading's time. */
export const TIME_CHOICES: { value: string; label: string }[] = [
	{ value: 'YYYY-MM-DD', label: 'A day: 2026-11-15' },
	{ value: 'YYYY-MM-DD HH:mm:ss', label: 'Day and time: 2026-11-15 08:05:00' },
	{ value: 'iso', label: 'ISO date and time (2026-11-15T08:05:00, with or without a zone)' },
	{ value: 'epoch_s', label: 'Seconds since 1970 (Unix time)' },
	{ value: 'epoch_ms', label: 'Milliseconds since 1970' },
	{ value: 'custom', label: 'Another pattern…' }
];

export const DELIMITER_CHOICES: { value: StationDraft['delimiter']; label: string }[] = [
	{ value: ',', label: 'Comma (,)' },
	{ value: ';', label: 'Semicolon (;)' },
	{ value: '\t', label: 'Tab' },
	{ value: '|', label: 'Bar (|)' }
];

/** The time zones offered first; any IANA zone can be typed in the field. */
export const TIME_ZONES = ['Africa/Johannesburg', 'Africa/Windhoek', 'Africa/Maputo', 'Africa/Harare', 'Africa/Gaborone', 'Africa/Maseru', 'Africa/Mbabane', 'UTC'];

/** The field ids (suffixes after the panel's uid) a problem can be about, so the form marks and focuses that field. */
export type StationField =
	| 'name'
	| 'st-url'
	| 'st-station'
	| 'st-header-name'
	| 'st-query-name'
	| 'st-secret'
	| 'st-headers'
	| 'st-url-time'
	| 'st-max-days'
	| 'st-revision'
	| 'st-start'
	| 'st-records'
	| 'st-skip'
	| 'st-time'
	| 'st-time-format'
	| 'st-zone'
	| 'st-value'
	| 'st-scale'
	| 'st-missing';

type Problem = { error: string; field: StationField };

/** The query parameter names that carry a key (backend config.ts STATION_KEY_PARAMS): one in the typed URL is refused. */
const KEY_PARAMS = /^(api[-_]?key|apikey|key|token|access[-_]?token|auth|authorization|secret|api[-_]?secret|password|pass|pwd|sig|signature|application[-_]?key|client[-_]?secret)$/i;
/** Headers that carry a key (backend StationApiConfig): one belongs in “How the key is sent”, not the extra headers. */
const KEY_HEADERS = /^(authorization|x-api-key|x-api-secret|api-key|apikey)$/i;
/** Headers the app sets itself (backend stationUrl.ts RESERVED_HEADERS). */
const RESERVED_HEADERS = /^(host|content-length|transfer-encoding|connection|keep-alive|te|upgrade|expect|cookie|accept-encoding|user-agent|trailer|proxy-.*|sec-.*)$/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PARAM_NAME = /^[A-Za-z0-9_.-]+$/;
const STATION_ID = /^[A-Za-z0-9 _.:@-]+$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PLACEHOLDER = /\{(station|start|end)\}/g;

/** The URL with its placeholders filled by a stand-in, parsed; null when it isn't a URL. */
const parsedUrl = (raw: string) => URL.parse(raw.trim().replace(PLACEHOLDER, 'x'));

/** What is wrong with a URL template, or null (the server's checks, bar the address ones it makes itself). */
export function stationUrlProblem(raw: string): string | null {
	const url = raw.trim();
	if (!url) return 'Enter the API’s URL, starting https://.';
	const unknown = url.match(/\{[^}]*\}/g)?.find((p) => !['{station}', '{start}', '{end}'].includes(p));
	if (unknown) return `${unknown} is not a placeholder: use {station}, {start} and {end}.`;
	const u = parsedUrl(url);
	if (!u) return 'That isn’t a web address: it starts https:// and names the API’s host.';
	if (u.protocol !== 'https:') return 'The URL must start with https:// (the key would travel unencrypted otherwise).';
	if (u.username || u.password) return 'Put the user name and password in the key fields, not in the URL.';
	for (const k of u.searchParams.keys()) {
		if (KEY_PARAMS.test(k)) return `The URL carries a key (${k}=…): take it out, choose “As a parameter in the URL” named ${k}, and enter the key in the key field, where it is kept sealed.`;
	}
	if (u.hash) return 'The URL has a #fragment, which is never sent: take it out.';
	return null;
}

/** A note on what the URL leaves out, under its field, or null when it asks for a station's days. */
export function urlPlaceholderNote(raw: string): string | null {
	const url = raw.trim();
	if (!url || !parsedUrl(url)) return null;
	const missing = ['{start}', '{end}'].filter((p) => !url.includes(p));
	if (missing.length === 2) return 'The URL has no {start} or {end}: every request asks for the same thing, so the API must answer with recent days on its own.';
	if (missing.length === 1) return `The URL has no ${missing[0]}: check the API wants only the ${missing[0] === '{end}' ? 'first' : 'last'} day.`;
	return null;
}

const intIn = (text: string, lo: number, hi: number): number | null | undefined => {
	const t = text.trim();
	if (t === '') return undefined;
	if (!/^\d+$/.test(t)) return null;
	const n = Number(t);
	return n >= lo && n <= hi ? n : null;
};

/** The answer's format for the draft (the engine's StationFormat, defaults left out), or the first problem. */
export function stationFormatOf(d: StationDraft): { format: StationFormat } | Problem {
	const keyed = d.format === 'json' && d.recordsKeyedByTime;
	const time = d.time.trim();
	const value = d.value.trim();
	if (!keyed && !time) return { error: `Name the ${d.format === 'csv' ? 'column' : 'field'} that holds each reading’s time.`, field: 'st-time' };
	if (!value) return { error: `Name the ${d.format === 'csv' ? 'column' : 'field'} that holds the rain.`, field: 'st-value' };
	const timeFormat = d.timeFormat === 'custom' ? d.timeFormatCustom.trim() : d.timeFormat;
	if (!timeFormat) return { error: 'Write the time pattern, e.g. DD/MM/YYYY HH:mm.', field: 'st-time-format' };
	const tfp = timeFormatProblem(timeFormat);
	if (tfp) return { error: `${tfp.charAt(0).toUpperCase()}${tfp.slice(1)}.`, field: 'st-time-format' };
	const zone = d.timeZone.trim() || STATION_DEFAULT_TIME_ZONE;
	const f: StationFormat = { format: d.format, time: keyed ? '' : time, value, timeFormat, resolution: d.resolution };
	if (zone !== STATION_DEFAULT_TIME_ZONE) f.timeZone = zone;
	if (d.format === 'json') {
		f.records = d.records.trim();
		if (keyed) f.recordsKeyedByTime = true;
	} else {
		if (d.delimiter !== ',') f.delimiter = d.delimiter;
		if (!d.headerRow) f.headerRow = false;
		const skip = intIn(d.skipLines, 0, 50);
		if (skip === null) return { error: 'Lines to skip is a whole number from 0 to 50.', field: 'st-skip' };
		if (skip) f.skipLines = skip;
	}
	if (d.decimalComma) f.decimalComma = true;
	if (d.resolution === 'subdaily') {
		if (d.stampMarks !== 'end') f.stampMarks = d.stampMarks;
		const h = intIn(d.dayStartHour, 0, 23) ?? 8;
		if (h !== 8) f.dayStartHour = h;
		if (d.creditDayTo !== 'start') f.creditDayTo = d.creditDayTo;
		if (d.valueKind !== 'amount') f.valueKind = d.valueKind;
	}
	const scaleText = d.scale.trim().replace(',', '.');
	if (scaleText) {
		const s = Number(scaleText);
		if (!/^\d*\.?\d+$/.test(scaleText) || !(s > 0 && s <= 1000)) return { error: 'The scale is a number above 0 and at most 1000 (25.4 for inches).', field: 'st-scale' };
		if (s !== 1) f.scale = s;
	}
	const markers = d.missing
		.split(',')
		.map((m) => m.trim())
		.filter(Boolean);
	if (markers.length > 19) return { error: 'At most 19 missing markers.', field: 'st-missing' };
	if (markers.some((m) => m.length > 32)) return { error: 'A missing marker is at most 32 characters.', field: 'st-missing' };
	if (markers.join(', ').toLowerCase() !== DEFAULT_MISSING_TEXT) f.missing = ['', ...markers];
	if (d.noReadingsMeans === 'zero') f.noReadingsMeans = 'zero';
	const problem = stationFormatProblem(f);
	if (problem) {
		const field: StationField = /time zone/.test(problem) ? 'st-zone' : /scale/.test(problem) ? 'st-scale' : 'st-time-format';
		return { error: `${problem.charAt(0).toUpperCase()}${problem.slice(1)}.`, field };
	}
	return { format: f };
}

/** The POST body's parts for a station feed: the config, and the credential only when a key was typed. */
export interface StationBody {
	config: StationApiConfigBody;
	credential?: StationCredentialBody;
}

/**
 * The config (and credential) for the draft, or the first problem and its field. `name` is the station's series name
 * (the feed's targetName). The credential is left out when the key field is blank or no key is sent, so a body never
 * carries an empty one; attaching with a key method and no key is refused here (the feed couldn't fetch).
 */
export function stationDraftToBody(d: StationDraft, name: string): { body: StationBody } | Problem {
	if (!name.trim()) return { error: 'Name the station: its rainfall series is called that.', field: 'name' };
	const urlProblem = stationUrlProblem(d.url);
	if (urlProblem) return { error: urlProblem, field: 'st-url' };
	const url = d.url.trim();
	const station = d.station.trim();
	if (url.includes('{station}') && !station) return { error: 'The URL has {station}: enter the station’s ID.', field: 'st-station' };
	if (station && (station.length > 100 || !STATION_ID.test(station))) return { error: 'A station ID is letters, digits, spaces and . _ : @ - (at most 100).', field: 'st-station' };

	let auth: StationAuthBody;
	if (d.authKind === 'header') {
		const n = d.headerName.trim();
		if (!n) return { error: 'Name the header the key goes in, e.g. X-Api-Key.', field: 'st-header-name' };
		if (!HEADER_NAME.test(n) || n.length > 64) return { error: `“${n.slice(0, 40)}” is not a header name: letters, digits and - only.`, field: 'st-header-name' };
		if (RESERVED_HEADERS.test(n)) return { error: `The ${n} header is set by the app, not the feed.`, field: 'st-header-name' };
		if (d.headerPrefix.length > 32) return { error: 'What goes before the key is at most 32 characters.', field: 'st-header-name' };
		auth = { kind: 'header', name: n, prefix: d.headerPrefix };
	} else if (d.authKind === 'query') {
		const n = d.queryName.trim();
		if (!n) return { error: 'Name the URL parameter the key goes in, e.g. apiKey.', field: 'st-query-name' };
		if (!PARAM_NAME.test(n) || n.length > 64) return { error: 'A parameter name is letters, digits and _ . - only.', field: 'st-query-name' };
		if (parsedUrl(url)?.searchParams.has(n)) return { error: `The URL already has a ${n} parameter: take it out, the key is added when the request is made.`, field: 'st-query-name' };
		auth = { kind: 'query', name: n };
	} else auth = { kind: d.authKind } as StationAuthBody;

	const secret = d.secret.trim();
	if (d.authKind !== 'none' && !secret) return { error: d.authKind === 'basic' ? 'Enter the password.' : 'Enter the key.', field: 'st-secret' };
	if (secret && secret.length < 8) return { error: d.authKind === 'basic' ? 'The password is at least 8 characters.' : 'The key is at least 8 characters.', field: 'st-secret' };
	if (secret.length > 4096) return { error: 'The key is too long (at most 4096 characters).', field: 'st-secret' };

	const rows = d.headers.map((h) => ({ name: h.name.trim(), value: h.value })).filter((h) => h.name || h.value.trim());
	if (rows.length > MAX_EXTRA_HEADERS) return { error: `At most ${MAX_EXTRA_HEADERS} extra headers.`, field: 'st-headers' };
	const headers: Record<string, string> = {};
	for (const h of rows) {
		if (!h.name) return { error: 'An extra header needs a name.', field: 'st-headers' };
		if (!HEADER_NAME.test(h.name) || h.name.length > 64) return { error: `“${h.name.slice(0, 40)}” is not a header name: letters, digits and - only.`, field: 'st-headers' };
		if (KEY_HEADERS.test(h.name)) return { error: `The ${h.name} header carries a key: choose “In a header” as how the key is sent, and enter the key in the key field.`, field: 'st-headers' };
		if (RESERVED_HEADERS.test(h.name)) return { error: `The ${h.name} header is set by the app, not the feed.`, field: 'st-headers' };
		if (Object.keys(headers).some((k) => k.toLowerCase() === h.name.toLowerCase())) return { error: `The ${h.name} header is listed twice.`, field: 'st-headers' };
		if (auth.kind === 'header' && auth.name.toLowerCase() === h.name.toLowerCase()) return { error: `The ${h.name} header is the one the key goes in: take it out of the extra headers.`, field: 'st-headers' };
		if (h.value.length > 1024) return { error: `The ${h.name} header’s value is too long.`, field: 'st-headers' };
		headers[h.name] = h.value;
	}

	const urlTime = d.urlTime === 'custom' ? d.urlTimeCustom.trim() : d.urlTime;
	if (!urlTime) return { error: 'Write how the dates go in the URL, e.g. DD-MM-YYYY.', field: 'st-url-time' };
	const utp = timeFormatProblem(urlTime);
	if (utp) return { error: `${utp.charAt(0).toUpperCase()}${utp.slice(1)}.`, field: 'st-url-time' };
	const maxDays = intIn(d.maxDays, 1, 366);
	if (maxDays === null) return { error: 'Days per request is a whole number from 1 to 366.', field: 'st-max-days' };
	const revisionDays = intIn(d.revisionDays, 0, 60);
	if (revisionDays === null) return { error: 'Days to read again is a whole number from 0 to 60.', field: 'st-revision' };
	const start = d.startDate.trim();
	if (start && !ISO_DAY.test(start)) return { error: 'The start date should be a day.', field: 'st-start' };

	const fmt = stationFormatOf(d);
	if ('error' in fmt) return fmt;

	const config: StationApiConfigBody = {
		url,
		...(station ? { station } : {}),
		auth,
		...(rows.length ? { headers } : {}),
		...(urlTime !== DEFAULT_URL_TIME ? { urlTimeFormat: urlTime } : {}),
		...(maxDays !== undefined ? { maxDaysPerRequest: maxDays } : {}),
		...(revisionDays !== undefined ? { revisionDays } : {}),
		...(start ? { startDate: start } : {}),
		format: fmt.format
	};
	const user = d.user.trim();
	if (user.length > 256) return { error: 'The user name is at most 256 characters.', field: 'st-secret' };
	// The user name only for Basic, and only when typed (the API takes none rather than an empty one).
	const credential = d.authKind !== 'none' && secret ? (d.authKind === 'basic' && user ? { secret, user } : { secret }) : undefined;
	return { body: credential ? { config, credential } : { config } };
}

// --- Presets ---------------------------------------------------------------------------------

export interface StationPreset {
	id: string;
	label: string;
	/** What the preset fills in, under the select. */
	note: string;
	/** The draft with the preset's fields set: the format reset to its defaults first; the name, station and key kept. */
	apply: (d: StationDraft) => StationDraft;
}

/** The format fields back at their defaults, everything else (URL, station, key, request settings) kept. */
const formatReset = (d: StationDraft): StationDraft => {
	const e = emptyStationDraft();
	return {
		...d,
		format: e.format,
		records: e.records,
		recordsKeyedByTime: e.recordsKeyedByTime,
		delimiter: e.delimiter,
		headerRow: e.headerRow,
		skipLines: e.skipLines,
		decimalComma: e.decimalComma,
		time: e.time,
		timeFormat: e.timeFormat,
		timeFormatCustom: e.timeFormatCustom,
		value: e.value,
		resolution: e.resolution,
		stampMarks: e.stampMarks,
		dayStartHour: e.dayStartHour,
		creditDayTo: e.creditDayTo,
		valueKind: e.valueKind,
		scale: e.scale,
		missing: e.missing,
		noReadingsMeans: e.noReadingsMeans
	};
};

/**
 * Known answer shapes. They only prefill: providers change their APIs, so each says to check it against the
 * provider's documentation. Ecowitt's history API is left out: it takes two keys (an application key and an API
 * key), and a feed sends one.
 */
export const STATION_PRESETS: StationPreset[] = [
	{
		id: 'json-daily',
		label: 'Generic JSON (daily totals)',
		note: 'A list of days under “data”, each with “date” (2026-11-15) and “rain_mm”.',
		apply: (d) => ({ ...formatReset(d), format: 'json', records: 'data', time: 'date', timeFormat: 'YYYY-MM-DD', value: 'rain_mm', resolution: 'daily' })
	},
	{
		id: 'csv-5min',
		label: 'Generic CSV (5-minute readings, Campbell-style TIMESTAMP / Rain_mm_Tot)',
		note: 'A header row with TIMESTAMP (2026-11-15 08:05:00, the end of each interval) and Rain_mm_Tot (mm in each interval), summed into rain days from 08:00.',
		apply: (d) => ({
			...formatReset(d),
			format: 'csv',
			delimiter: ',',
			headerRow: true,
			time: 'TIMESTAMP',
			timeFormat: 'YYYY-MM-DD HH:mm:ss',
			value: 'Rain_mm_Tot',
			resolution: 'subdaily',
			stampMarks: 'end',
			dayStartHour: '8',
			valueKind: 'amount'
		})
	},
	{
		id: 'wu-pws-daily',
		label: 'Weather Underground PWS (daily)',
		note: 'The daily history of a personal weather station, in metric units; the key goes in the apiKey parameter. Days dated by the station’s own clock (obsTimeLocal).',
		apply: (d) => ({
			...formatReset(d),
			url: 'https://api.weather.com/v2/pws/history/daily?stationId={station}&format=json&units=m&startDate={start}&endDate={end}',
			urlTime: 'YYYYMMDD',
			urlTimeCustom: '',
			maxDays: '31',
			authKind: 'query',
			queryName: 'apiKey',
			format: 'json',
			records: 'observations',
			time: 'obsTimeLocal',
			timeFormat: 'YYYY-MM-DD HH:mm:ss',
			value: 'metric.precipTotal',
			resolution: 'daily'
		})
	}
];

// --- The sample preview ----------------------------------------------------------------------

/** What previewStationAnswer gives (engine station-format), as the summary reads it. */
export interface StationPreviewResult {
	startDate: string;
	values: (number | null)[];
	daysWithData: number;
	gaps: number;
	records: number;
	readings: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-ZA')} ${n === 1 ? one : many}`;

/** "Read 288 records: 3 days, 2 with rain data and 1 gap." */
export function previewSummary(p: StationPreviewResult): string {
	const read = `Read ${plural(p.records, 'record')}`;
	if (p.readings === 0) return `${read}, but none held a reading: nothing would be written.`;
	const days = p.values.length;
	if (days === 0) return `${read}, but no day in it has ended yet: the feed writes a day once it is over.`;
	return `${read}: ${plural(days, 'day')}, ${p.daysWithData} with rain data and ${plural(p.gaps, 'gap')}.`;
}

/** The last `n` days of the preview, newest first: day (YYYY-MM-DD) and mm, or null for a gap. */
export function previewRows(p: Pick<StationPreviewResult, 'startDate' | 'values'>, n = 14): { day: string; mm: number | null }[] {
	const start = Date.parse(`${p.startDate}T00:00:00Z`);
	const rows: { day: string; mm: number | null }[] = [];
	for (let i = p.values.length - 1; i >= 0 && rows.length < n; i--) {
		rows.push({ day: new Date(start + i * 86_400_000).toISOString().slice(0, 10), mm: p.values[i]! });
	}
	return rows;
}

// --- The folds' lines ------------------------------------------------------------------------

/** The Requests fold's line: how dates are written, the days a request, the days read again, the start, the headers. */
export function requestLine(d: StationDraft): string {
	const named: Record<string, string> = { iso: 'date and time', epoch_s: 'Unix seconds', epoch_ms: 'Unix milliseconds' };
	const dates = d.urlTime === 'custom' ? d.urlTimeCustom.trim() || 'a pattern' : (named[d.urlTime] ?? d.urlTime);
	const max = d.maxDays.trim() || '31';
	const again = d.revisionDays.trim() || '7';
	const start = d.startDate.trim() ? `from ${d.startDate.trim()}` : 'from 90 days back';
	const headers = d.headers.filter((h) => h.name.trim()).length;
	return `dates as ${dates}, ${max} days a request, the last ${again} read again, ${start}${headers ? `, ${headers} extra ${headers === 1 ? 'header' : 'headers'}` : ''}`;
}

/** The Values fold's line: the scale, the missing markers, and what a day with no readings is. */
export function moreLine(d: StationDraft): string {
	const scale = d.scale.trim() && d.scale.trim() !== '1' ? `values × ${d.scale.trim()}` : 'values as written';
	const missing = d.missing.trim().toLowerCase() === DEFAULT_MISSING_TEXT ? 'the usual missing markers' : 'your own missing markers';
	return `${scale}, ${missing}, a day with no readings is ${d.noReadingsMeans === 'zero' ? '0 mm' : 'a gap'}`;
}
