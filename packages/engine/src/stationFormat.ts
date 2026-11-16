// How a station API feed reads whatever a rain gauge's web API answers
// (issue #784). Providers follow no standard: JSON or CSV, records under any
// path (or an object keyed by timestamp), epoch seconds or local times with no
// offset, a reading every five minutes or one a day, an amount per interval or
// a running total that resets. The owner describes their API once in a
// StationFormat; this module turns an answer into daily rain.
//
// Pure (no I/O; Intl only, which browsers and Node both have), shared by the
// fetch (backend/src/feeds/sources/station.ts) and the attach card's "Try it on
// a sample" (frontend), so the preview and the feed can never read one answer
// two ways. Exposed as `@water-management/engine/station-format`, not through
// the barrel.
//
// Rules that keep a wrong number out of a rain series:
// - A value that is neither a number nor a declared missing marker, or a time
//   that doesn't match the format, fails the whole read (StationFormatError,
//   our message): a changed API never half-lands.
// - Missing readings are gaps, never zeros. A day built from interval amounts
//   that holds a missing or negative reading is a gap: part of its rain is
//   unknown. A day with no readings at all is a gap unless the owner says
//   their logger only reports when it rains (noReadingsMeans: 'zero'), and
//   even then an answer with no readings at all writes nothing.
// - A running total's day whose first reading has nothing before it to rise
//   from (the answer starts inside the day) is a gap: its rain up to that
//   reading is unknown.
// - A day is written only once it has ended (its rain day's end has passed),
//   so today's running total never lands as a day's rain.
// - The rain day: from dayStartHour (08:00 in South African practice, SAWS)
//   to the same hour next day, credited to the day it starts on (WMO-No. 100;
//   creditDayTo 'end' for a provider that labels by the end).
import { fromEpochDay, toEpochDay } from './calendar';

export const STATION_TIME_FORMATS = ['iso', 'epoch_s', 'epoch_ms'] as const;

export interface StationFormat {
	format: 'json' | 'csv';
	/** JSON: path to the records (dot keys, [n] indexes, [key=value] picks the first element with that field); '' the root. */
	records?: string;
	/** JSON: the records are an object keyed by timestamp ({"1700000000": "1.2", …}); `time` is then ignored. */
	recordsKeyedByTime?: boolean;
	/** CSV: the delimiter (default ','). */
	delimiter?: ',' | ';' | '\t' | '|';
	/** CSV: lines to skip before the header (or before the data with no header). */
	skipLines?: number;
	/** CSV: whether the first line read is a header (default true); without one, columns are 1-based numbers. */
	headerRow?: boolean;
	/** Numbers written with a decimal comma (1,5). CSV with ',' as the delimiter can't have one. */
	decimalComma?: boolean;
	/** The time field (JSON path within a record) or CSV column (header name, or 1-based number). */
	time: string;
	/** The rain field or column. */
	value: string;
	/** 'iso', 'epoch_s', 'epoch_ms', or a pattern of YYYY MM DD HH mm ss and literal characters (DD/MM/YYYY HH:mm). */
	timeFormat: string;
	/** The IANA zone a time without an offset is in (default Africa/Johannesburg); also the zone rain days are counted in. */
	timeZone?: string;
	/** One reading a day (its day's total), or readings within the day summed into rain days. */
	resolution: 'daily' | 'subdaily';
	/** Sub-daily: whether a reading's time is the end (default) or the start of the interval it measured. */
	stampMarks?: 'end' | 'start';
	/** An amount per reading (default), or a running total (each reading's rain is the rise since the one before; a drop is a reset). */
	valueKind?: 'amount' | 'cumulative';
	/** Multiplies every value: 25.4 for inches, the mm per tip for tip counts. Default 1. */
	scale?: number;
	/** Values that mean no reading, compared after trimming (case-insensitive). Default: empty, NaN, null, -9999, -999. */
	missing?: string[];
	/** Sub-daily: the hour a rain day starts (0–23; default 8, SAWS's 08:00). */
	dayStartHour?: number;
	/** Sub-daily: the day a rain day's total is dated (default the day it starts on). */
	creditDayTo?: 'start' | 'end';
	/** A complete day with no readings: a gap (default), or 0 mm for a logger that only reports when it rains. */
	noReadingsMeans?: 'gap' | 'zero';
}

export class StationFormatError extends Error {
	override readonly name = 'StationFormatError';
}

export const STATION_DEFAULT_TIME_ZONE = 'Africa/Johannesburg';
export const STATION_DEFAULT_MISSING = ['', 'nan', 'null', 'none', 'n/a', '-9999', '-999'];
/** The most readings one answer may hold (a year of one-minute readings is 525 600). */
export const STATION_MAX_READINGS = 600_000;
/** The largest believable day's rain, mm (the world record is ~1 825 mm); above it the scale is wrong. */
export const STATION_MAX_DAY_MM = 2000;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// --- Time zones ------------------------------------------------------------------------------

const ZONES = new Map<string, Intl.DateTimeFormat>();
function zone(tz: string): Intl.DateTimeFormat {
	let f = ZONES.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
		ZONES.set(tz, f);
	}
	return f;
}

/** Whether `tz` is an IANA zone this runtime knows. */
export function isTimeZone(tz: string): boolean {
	try {
		zone(tz);
		return true;
	} catch {
		return false;
	}
}

/** The zone's offset from UTC at instant `t` (ms). */
export function zoneOffsetMs(tz: string, t: number): number {
	const p: Record<string, number> = {};
	for (const part of zone(tz).formatToParts(new Date(t))) if (part.type !== 'literal') p[part.type] = Number(part.value);
	const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
	return asUtc - Math.floor(t / 1000) * 1000;
}

/** The instant a wall-clock time in `tz` names (the earlier one in a repeated hour). */
export function localToInstant(tz: string, y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
	const wall = Date.UTC(y, mo - 1, d, h, mi, s);
	let t = wall - zoneOffsetMs(tz, wall);
	t = wall - zoneOffsetMs(tz, t);
	return t;
}

/** The epoch day of an instant's wall-clock date in `tz`, after shifting the clock back `shiftMs`. */
const localEpochDay = (tz: string, t: number, shiftMs = 0) => Math.floor((t + zoneOffsetMs(tz, t) - shiftMs) / DAY_MS);

// --- Paths -----------------------------------------------------------------------------------

const SEGMENT = /^([^[\]]*)((?:\[[^\]]*\])*)$/;

/** The value at a path (dot keys, [n] indexes, [key=value] filters); undefined when it isn't there. */
export function atPath(root: unknown, path: string): unknown {
	if (path.trim() === '') return root;
	let cur: unknown = root;
	for (const raw of path.split('.')) {
		const m = SEGMENT.exec(raw.trim());
		if (!m) return undefined;
		if (m[1] !== '') {
			if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
			cur = Object.hasOwn(cur, m[1]!) ? (cur as Record<string, unknown>)[m[1]!] : undefined;
		}
		for (const b of m[2]!.match(/\[[^\]]*\]/g) ?? []) {
			if (!Array.isArray(cur)) return undefined;
			const inner = b.slice(1, -1).trim();
			if (/^\d+$/.test(inner)) cur = cur[Number(inner)];
			else {
				const eq = inner.indexOf('=');
				if (eq < 1) return undefined;
				const k = inner.slice(0, eq).trim();
				const want = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
				cur = cur.find((el) => el !== null && typeof el === 'object' && Object.hasOwn(el, k) && String((el as Record<string, unknown>)[k]) === want);
			}
		}
	}
	return cur;
}

// --- Times -----------------------------------------------------------------------------------

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const TOKENS = /YYYY|MM|DD|HH|mm|ss/g;

interface ParsedTime {
	/** The instant, when the text named one (an offset, or an epoch); else the wall-clock fields. */
	instant?: number;
	wall?: { y: number; mo: number; d: number; h: number; mi: number; s: number; dateOnly: boolean };
}

function patternRegex(pattern: string): { re: RegExp; order: string[] } {
	const order: string[] = [];
	let src = '';
	let last = 0;
	for (const m of pattern.matchAll(TOKENS)) {
		src += pattern.slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		src += m[0] === 'YYYY' ? '(\\d{4})' : '(\\d{1,2})';
		order.push(m[0]);
		last = m.index! + m[0].length;
	}
	src += pattern.slice(last).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return { re: new RegExp(`^${src}$`), order };
}

/** Why a time format can't be used, or null. */
export function timeFormatProblem(f: string): string | null {
	if ((STATION_TIME_FORMATS as readonly string[]).includes(f)) return null;
	if (f.length > 40) return 'a time pattern is at most 40 characters';
	const { order } = patternRegex(f);
	for (const t of ['YYYY', 'MM', 'DD']) if (!order.includes(t)) return `a time pattern needs ${t} (e.g. DD/MM/YYYY HH:mm)`;
	if (new Set(order).size !== order.length) return 'a time pattern names each part once';
	if (order.includes('mm') && !order.includes('HH')) return 'a time pattern with minutes (mm) needs hours (HH)';
	return null;
}

function parseTime(raw: unknown, f: string): ParsedTime | null {
	if (f === 'epoch_s' || f === 'epoch_ms') {
		const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN;
		if (!Number.isFinite(n)) return null;
		const t = f === 'epoch_s' ? n * 1000 : n;
		return t > 0 && t < 8.64e15 ? { instant: Math.round(t) } : null;
	}
	if (typeof raw !== 'string') return null;
	const s = raw.trim();
	if (f === 'iso') {
		const m = ISO.exec(s);
		if (!m) return null;
		const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number) as number[];
		if (!validWall(y!, mo!, d!, h!, mi!, sec!)) return null;
		if (m[7]) {
			const z = m[7].toUpperCase();
			const off = z === 'Z' ? 0 : (z[0] === '-' ? -1 : 1) * (Number(z.slice(1, 3)) * 60 + Number(z.slice(-2))) * 60_000;
			const sub = /\.(\d{1,3})/.exec(s);
			return { instant: Date.UTC(y!, mo! - 1, d!, h!, mi!, sec!) - off + (sub ? Number(sub[1]!.padEnd(3, '0')) : 0) };
		}
		return { wall: { y: y!, mo: mo!, d: d!, h: h!, mi: mi!, s: sec!, dateOnly: m[4] === undefined } };
	}
	const { re, order } = patternRegex(f);
	const m = re.exec(s);
	if (!m) return null;
	const v: Record<string, number> = { HH: 0, mm: 0, ss: 0 };
	order.forEach((t, i) => (v[t] = Number(m[i + 1])));
	if (!validWall(v.YYYY!, v.MM!, v.DD!, v.HH!, v.mm!, v.ss!)) return null;
	return { wall: { y: v.YYYY!, mo: v.MM!, d: v.DD!, h: v.HH!, mi: v.mm!, s: v.ss!, dateOnly: !order.includes('HH') } };
}

function validWall(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
	if (y < 1850 || y > 2200 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 60) return false;
	return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// --- Values ----------------------------------------------------------------------------------

function parseValue(raw: unknown, missing: ReadonlySet<string>, decimalComma: boolean): number | null | undefined {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === 'number') return Number.isFinite(raw) && !missing.has(String(raw)) ? raw : null;
	if (typeof raw !== 'string') return undefined;
	const s = raw.trim();
	if (missing.has(s.toLowerCase())) return null;
	const t = decimalComma ? s.replace(/\./g, '').replace(',', '.') : s;
	return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : undefined;
}

// --- CSV -------------------------------------------------------------------------------------

/** One CSV line's fields (RFC 4180 quoting: "a,b", "" inside quotes). */
function csvFields(line: string, delim: string): string[] {
	const out: string[] = [];
	let cur = '';
	let q = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (q) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				} else q = false;
			} else cur += c;
		} else if (c === '"' && cur.trim() === '') {
			q = true;
			cur = '';
		} else if (c === delim) {
			out.push(cur);
			cur = '';
		} else cur += c;
	}
	out.push(cur);
	return out;
}

// --- Reading an answer -----------------------------------------------------------------------

export interface StationReading {
	/** The instant (ms) for a sub-daily reading; for a daily one, the epoch day it is the total of. */
	at: number;
	/** mm after the scale; null for a missing reading. */
	value: number | null;
}

export interface StationReadings {
	readings: StationReading[];
	/** How many records the answer held (missing readings included). */
	records: number;
}

/** Why a format can't be used, or null. The backend's schema checks the shapes; this checks what they mean together. */
export function stationFormatProblem(f: StationFormat): string | null {
	const tf = timeFormatProblem(f.timeFormat);
	if (tf && !f.recordsKeyedByTime) return tf;
	if (f.recordsKeyedByTime && !['epoch_s', 'epoch_ms', 'iso'].includes(f.timeFormat) && tf) return tf;
	if (f.timeZone !== undefined && !isTimeZone(f.timeZone)) return `“${clip(f.timeZone)}” is not a time zone (e.g. Africa/Johannesburg)`;
	if (f.format === 'csv' && f.recordsKeyedByTime) return 'only JSON records can be keyed by time';
	if (f.format === 'csv' && f.decimalComma && (f.delimiter ?? ',') === ',') return 'numbers with a decimal comma need another delimiter (; or tab)';
	if (f.resolution === 'daily' && f.valueKind === 'cumulative') return 'a running total needs readings within the day (sub-daily)';
	if (f.scale !== undefined && !(f.scale > 0 && f.scale <= 1000)) return 'the scale must be above 0 and at most 1000';
	if (f.dayStartHour !== undefined && !(Number.isInteger(f.dayStartHour) && f.dayStartHour >= 0 && f.dayStartHour <= 23)) return 'a rain day starts at a whole hour, 0–23';
	return null;
}

/** Read an answer's records into readings (scaled, sorted, de-duplicated). Throws StationFormatError naming what didn't fit. */
export function readStationAnswer(text: string, f: StationFormat): StationReadings {
	const problem = stationFormatProblem(f);
	if (problem) throw new StationFormatError(problem);
	const tz = f.timeZone ?? STATION_DEFAULT_TIME_ZONE;
	const missing = new Set((f.missing ?? STATION_DEFAULT_MISSING).map((m) => m.trim().toLowerCase()));
	const scale = f.scale ?? 1;
	const pairs: { time: unknown; value: unknown; where: string }[] = [];

	if (f.format === 'json') {
		let root: unknown;
		try {
			root = JSON.parse(text);
		} catch {
			throw new StationFormatError(text.trimStart().startsWith('<') ? 'the answer is a web page (HTML), not JSON: check the URL and the key' : 'the answer is not valid JSON');
		}
		const recs = atPath(root, f.records ?? '');
		if (f.recordsKeyedByTime) {
			if (recs === null || typeof recs !== 'object' || Array.isArray(recs)) throw new StationFormatError(`no object keyed by time at “${clip(f.records ?? '(the root)')}”`);
			for (const [k, v] of Object.entries(recs)) pairs.push({ time: f.timeFormat === 'iso' ? k : k, value: f.value ? (v !== null && typeof v === 'object' ? atPath(v, f.value) : v) : v, where: `key ${clip(k, 20)}` });
		} else {
			if (!Array.isArray(recs)) throw new StationFormatError(`no list of records at “${clip(f.records || '(the root)')}”`);
			recs.forEach((r, i) => pairs.push({ time: atPath(r, f.time), value: atPath(r, f.value), where: `record ${i + 1}` }));
		}
	} else {
		const delim = f.delimiter ?? ',';
		const lines = text.replace(/^﻿/, '').split(/\r?\n/);
		let i = Math.max(0, f.skipLines ?? 0);
		const colOf = (name: string, header: string[] | null): number => {
			if (/^\d+$/.test(name.trim())) return Number(name) - 1;
			if (!header) throw new StationFormatError(`with no header row, name columns by number (1, 2, …), not “${clip(name)}”`);
			const at = header.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
			if (at < 0) throw new StationFormatError(`the answer has no “${clip(name)}” column (it has ${clip(header.map((h) => h.trim()).join(', '), 120)})`);
			return at;
		};
		let header: string[] | null = null;
		if (f.headerRow !== false) {
			while (i < lines.length && lines[i]!.trim() === '') i++;
			if (i >= lines.length) throw new StationFormatError('the answer has no header row');
			header = csvFields(lines[i]!, delim);
			i++;
		}
		const tc = colOf(f.time, header);
		const vc = colOf(f.value, header);
		for (; i < lines.length; i++) {
			const line = lines[i]!;
			if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
			const cells = csvFields(line, delim);
			pairs.push({ time: cells[tc], value: cells[vc] ?? '', where: `line ${i + 1}` });
		}
	}

	if (pairs.length > STATION_MAX_READINGS) throw new StationFormatError(`the answer holds ${pairs.length} readings, more than a feed reads (${STATION_MAX_READINGS}): ask for fewer days a request`);

	const out = new Map<number, number | null>();
	for (const p of pairs) {
		const t = parseTime(p.time, f.timeFormat);
		if (!t) throw new StationFormatError(`${p.where}: the time “${clip(String(p.time ?? ''))}” doesn’t match the time format (${clip(f.timeFormat)})`);
		const v = parseValue(p.value, missing, !!f.decimalComma);
		if (v === undefined) throw new StationFormatError(`${p.where}: the value “${clip(String(typeof p.value === 'object' ? JSON.stringify(p.value) : p.value))}” is not a number (add it to the missing markers if it means no reading)`);
		let at: number;
		if (f.resolution === 'daily') {
			at = t.wall ? toEpochDay(fromEpochDay(Math.floor(Date.UTC(t.wall.y, t.wall.mo - 1, t.wall.d) / DAY_MS))) : localEpochDay(tz, t.instant!);
		} else {
			if (t.wall?.dateOnly) throw new StationFormatError(`${p.where}: the time “${clip(String(p.time))}” has no hour, but the readings are sub-daily`);
			at = t.instant ?? localToInstant(tz, t.wall!.y, t.wall!.mo, t.wall!.d, t.wall!.h, t.wall!.mi, t.wall!.s);
		}
		const value = v === null ? null : v * scale;
		if (out.has(at)) {
			const prev = out.get(at);
			if (prev !== value && !(prev != null && value !== null && Math.abs(prev - value) < 1e-9)) {
				throw new StationFormatError(`${p.where}: two readings at the same ${f.resolution === 'daily' ? 'day' : 'time'} disagree (${prev ?? 'missing'} and ${value ?? 'missing'})`);
			}
			continue;
		}
		out.set(at, value);
	}
	const readings = [...out].map(([at, value]) => ({ at, value })).sort((a, b) => a.at - b.at);
	return { readings, records: pairs.length };
}

// --- Days ------------------------------------------------------------------------------------

export interface StationRange {
	/** The first instant to ask for (ms; for a daily feed, the first day's local midnight). */
	startMs: number;
	/** The end of the last rain day (ms, exclusive). */
	endMs: number;
}

/**
 * The instants that cover rain days `from`..`to` (ISO dates, inclusive): what the URL's {start} and {end} name.
 * A running total asks from an hour before, so the first interval of the first day has a reading to rise from.
 */
export function stationRange(f: StationFormat, from: string, to: string): StationRange {
	const tz = f.timeZone ?? STATION_DEFAULT_TIME_ZONE;
	const at = (epochDay: number, hour: number) => {
		const [y, m, d] = fromEpochDay(epochDay).split('-').map(Number) as [number, number, number];
		return localToInstant(tz, y, m, d, hour);
	};
	const a = toEpochDay(from);
	const b = toEpochDay(to);
	if (f.resolution === 'daily') return { startMs: at(a, 0), endMs: at(b + 1, 0) };
	const shift = f.creditDayTo === 'end' ? -1 : 0;
	const h = f.dayStartHour ?? 8;
	return { startMs: at(a + shift, h) - (f.valueKind === 'cumulative' ? HOUR_MS : 0), endMs: at(b + 1 + shift, h) };
}

export interface StationDays {
	/** The first day (ISO) and one value per day through the last complete day asked for; null a gap. Empty when none ended. */
	startDate: string;
	values: (number | null)[];
	/** Days with rain data, and gaps among them. */
	daysWithData: number;
	gaps: number;
}

/**
 * Daily rain for days `from`..`to` (inclusive) from an answer's readings, cut at the last day that has ended by `nowMs`.
 * Sub-daily readings are summed into rain days (or, for a running total, its rises).
 */
export function stationDays(r: StationReadings, f: StationFormat, from: string, to: string, nowMs: number): StationDays {
	const tz = f.timeZone ?? STATION_DEFAULT_TIME_ZONE;
	const a = toEpochDay(from);
	let b = toEpochDay(to);
	// The last day that has ended: a daily total once its date is past in the zone; a rain day once its end has passed.
	const lastEnded = f.resolution === 'daily' ? localEpochDay(tz, nowMs) - 1 : rainDay(nowMs, f, tz) - 1;
	b = Math.min(b, lastEnded);
	const n = Math.max(0, b - a + 1);
	const sums = new Array<number>(n).fill(0);
	const counts = new Array<number>(n).fill(0);
	const broken = new Array<boolean>(n).fill(false);

	if (f.resolution === 'daily') {
		for (const x of r.readings) {
			const i = x.at - a;
			if (i < 0 || i >= n) continue;
			counts[i]!++;
			if (x.value === null || x.value < 0) broken[i] = true;
			else sums[i] = x.value;
		}
	} else if (f.valueKind === 'cumulative') {
		let prev: number | null = null;
		for (const x of r.readings) {
			if (x.value === null) continue;
			if (x.value < 0) {
				prev = null;
				const i = rainDay(x.at, f, tz) - a;
				if (i >= 0 && i < n) broken[i] = true;
				continue;
			}
			const rise = prev === null ? null : x.value >= prev ? x.value - prev : x.value;
			prev = x.value;
			const i = rainDay(x.at, f, tz) - a;
			if (i < 0 || i >= n) continue;
			counts[i]!++;
			// No reading before it to rise from (the answer starts inside this day, e.g. 3-hourly readings and the hour
			// asked before the window): the rain up to it is unknown, so the day is a gap, never a short total that a
			// re-read would write over a complete one.
			if (rise === null) {
				broken[i] = true;
				continue;
			}
			sums[i]! += rise;
		}
	} else {
		for (const x of r.readings) {
			const i = rainDay(x.at, f, tz) - a;
			if (i < 0 || i >= n) continue;
			counts[i]!++;
			if (x.value === null || x.value < 0) broken[i] = true;
			else sums[i]! += x.value;
		}
	}

	const anyReadings = r.readings.length > 0;
	const values: (number | null)[] = [];
	let daysWithData = 0;
	let gaps = 0;
	for (let i = 0; i < n; i++) {
		let v: number | null;
		if (broken[i]) v = null;
		else if (counts[i] === 0) v = f.noReadingsMeans === 'zero' && anyReadings ? 0 : null;
		else v = Math.round(sums[i]! * 1e4) / 1e4;
		if (v !== null && v > STATION_MAX_DAY_MM) {
			throw new StationFormatError(`${fromEpochDay(a + i)} adds up to ${Math.round(v)} mm, more than any day’s rain: check the scale and whether the values are a running total`);
		}
		if (v === null) gaps++;
		else daysWithData++;
		values.push(v);
	}
	return { startDate: fromEpochDay(a), values, daysWithData, gaps };
}

/** The rain day (epoch day, as credited) an instant's reading belongs to. */
function rainDay(t: number, f: StationFormat, tz: string): number {
	// A reading stamped at its interval's end measured the moment before.
	const at = (f.stampMarks ?? 'end') === 'end' ? t - 1 : t;
	return localEpochDay(tz, at, (f.dayStartHour ?? 8) * HOUR_MS) + (f.creditDayTo === 'end' ? 1 : 0);
}

/** The text {start} or {end} becomes in the URL, in the format the API wants it. */
export function formatStationTime(ms: number, format: string, tz: string): string {
	if (format === 'epoch_s') return String(Math.floor(ms / 1000));
	if (format === 'epoch_ms') return String(ms);
	const local = new Date(ms + zoneOffsetMs(tz, ms));
	const pad = (x: number, w = 2) => String(x).padStart(w, '0');
	const parts: Record<string, string> = {
		YYYY: pad(local.getUTCFullYear(), 4),
		MM: pad(local.getUTCMonth() + 1),
		DD: pad(local.getUTCDate()),
		HH: pad(local.getUTCHours()),
		mm: pad(local.getUTCMinutes()),
		ss: pad(local.getUTCSeconds())
	};
	if (format === 'iso') return `${parts.YYYY}-${parts.MM}-${parts.DD}T${parts.HH}:${parts.mm}:${parts.ss}`;
	return format.replace(TOKENS, (t) => parts[t]!);
}

/**
 * The attach card's "Try it on a sample": read a pasted answer and give its days, from the first reading's day
 * to the last day ended by `nowMs`, at most 400 days (the latest). Throws StationFormatError as the feed would.
 */
export function previewStationAnswer(text: string, f: StationFormat, nowMs: number): StationDays & { records: number; readings: number } {
	const r = readStationAnswer(text, f);
	const tz = f.timeZone ?? STATION_DEFAULT_TIME_ZONE;
	if (r.readings.length === 0) return { startDate: fromEpochDay(localEpochDay(tz, nowMs)), values: [], daysWithData: 0, gaps: 0, records: r.records, readings: 0 };
	const dayOf = (x: StationReading) => (f.resolution === 'daily' ? x.at : rainDay(x.at, f, tz));
	const first = dayOf(r.readings[0]!);
	const last = dayOf(r.readings[r.readings.length - 1]!);
	const from = Math.max(first, last - 399);
	const days = stationDays(r, f, fromEpochDay(from), fromEpochDay(last), nowMs);
	return { ...days, records: r.records, readings: r.readings.length };
}
