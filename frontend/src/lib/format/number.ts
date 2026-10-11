// Number/date formatting. The app's one thousands separator, a narrow
// no-break space (THOUSANDS_SEP, D10: "300 000"), a '.' decimal point and a
// true minus sign (U+2212), whatever the browser locale is. Formatted with
// en-US rules, then regrouped and signed.
//
// The minus: Inter's tabular figures (`tnum`, on table cells and inputs) set a
// hyphen-minus a digit wide with the dash centred, so "-2.26" read "- 2.26".
// U+2212 is drawn to fill that width, as print sets it. Display only: exports
// (CSV, xlsx) write raw numbers, never these strings, and parseNum reads both
// signs back, so a grouped field's own text still parses.
import { regroup } from '@water-management/engine/format';

/** The minus sign every displayed number carries (U+2212), not the hyphen-minus. */
export const MINUS = '\u2212';

/** A formatted en-US number, regrouped, with a true minus; a value that rounds to zero ("-0", "-0.00") loses its sign. */
function signed(enUs: string): string {
	if (!enUs.startsWith('-')) return regroup(enUs);
	const body = regroup(enUs.slice(1));
	return /[1-9]/.test(body) ? MINUS + body : body;
}

const cache = new Map<string, Intl.NumberFormat>();

function formatter(min: number, max: number): Intl.NumberFormat {
	const k = `${min}:${max}`;
	let f = cache.get(k);
	if (!f) {
		f = new Intl.NumberFormat('en-US', {
			minimumFractionDigits: min,
			maximumFractionDigits: max,
			useGrouping: true
		});
		cache.set(k, f);
	}
	return f;
}

/**
 * 1234567.8 → "1 234 568" (digits = 0) or "1 234 567.80" (digits = 2), narrow
 * no-break spaces; -2.26 → "−2.26" (U+2212); -0.001 → "0". Null/NaN → "–".
 */
export function fmtNum(n: number | null | undefined, digits = 0, trim = false): string {
	if (n == null || !Number.isFinite(n)) return '–';
	return signed(formatter(trim ? 0 : digits, digits).format(n));
}

const sigCache = new Map<number, Intl.NumberFormat>();

/** At most `sig` significant figures, trailing zeros dropped. */
function sigFormatter(sig: number): Intl.NumberFormat {
	let f = sigCache.get(sig);
	if (!f) {
		f = new Intl.NumberFormat('en-US', { maximumSignificantDigits: sig, useGrouping: true });
		sigCache.set(sig, f);
	}
	return f;
}

/**
 * A flow or volume: fmtNum's fixed decimals, except that a non-zero value
 * below 1 which those decimals would show with fewer than `sig` significant
 * figures gets `sig` significant figures instead, so a small flow never reads
 * as 0.000 (issue #45): fmtQty(0.00042, 3) → "0.00042", fmtQty(0.0123, 3) →
 * "0.012" (unchanged), fmtQty(0.4, 0) → "0.4". Zero stays "0", 1 and above
 * are exactly fmtNum. Below 1e-6 (float noise, not a flow) it is written in
 * exponent form ("2.3e-9"). Null/NaN → "–".
 */
export function fmtQty(n: number | null | undefined, digits = 0, trim = false, sig = 2): string {
	if (n == null || !Number.isFinite(n)) return '–';
	const a = Math.abs(n);
	if (a === 0 || a >= 1 || a >= 10 ** (sig - 1 - digits)) return fmtNum(n, digits, trim);
	if (a < 1e-6) return signed(n.toExponential(sig - 1).replace(/\.?0+e/, 'e').replace('e+', 'e'));
	return signed(sigFormatter(sig).format(n));
}

/**
 * One day's reading (a chart's hover value, a daily table's cell) with the
 * decimals its size needs: 1234 → "1 234", 12.345 → "12.35", 0.0123 → "0.012",
 * 0.00012 → "0.0001". Null/NaN → "–".
 */
export function fmtReading(v: number | null | undefined): string {
	if (v == null || !Number.isFinite(v)) return '–';
	const a = Math.abs(v);
	return fmtNum(v, a >= 100 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 3 : 4);
}

/** 0.953 → "95.3%". */
export function fmtPct(fraction: number | null | undefined, digits = 1): string {
	if (fraction == null || !Number.isFinite(fraction)) return '–';
	return `${fmtNum(fraction * 100, digits)}%`;
}

/** ISO timestamp or date → "2026-09-23" or "2026-09-23 14:05". */
export function fmtDate(iso: string | null | undefined, withTime = false): string {
	if (!iso) return '–';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const pad = (x: number) => String(x).padStart(2, '0');
	const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	return withTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A calendar day (YYYY-MM-DD, e.g. a series or run date) → "1 Oct 2021".
 * Read from the string, never through Date, so no time zone can shift it.
 * Anything that isn't a calendar day is returned unchanged.
 */
export function fmtDay(iso: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
	const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
	return m && month ? `${Number(m[3])} ${month} ${m[1]}` : iso;
}

const MONTHS_LONG = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_NUMBER = new Map(MONTHS.map((m, i) => [m.toLowerCase(), i + 1]));

/**
 * A typed calendar day → YYYY-MM-DD, or null when it isn't one. Day first,
 * as fmtDay shows it: "15 Nov 2021", "15 November 2021", "15/11/2021",
 * "15-11-2021", "15.11.2021", and the ISO "2021-11-15" (year first is never
 * ambiguous). Never month first, so "11/15/2021" is no day. The day must
 * exist (no 31 Nov, 29 Feb only in a leap year). Read from the string, never
 * through Date, so no time zone can shift it.
 */
export function parseDay(input: string): string | null {
	const s = input.trim().replace(/\s+/g, ' ');
	let y: number, m: number, d: number;
	let x = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
	if (x) [y, m, d] = [Number(x[1]), Number(x[2]), Number(x[3])];
	else if ((x = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) [d, m, y] = [Number(x[1]), Number(x[2]), Number(x[3])];
	else if ((x = /^(\d{1,2}) ([A-Za-z]{3,9})\.?,? (\d{4})$/.exec(s))) {
		const word = x[2]!.toLowerCase();
		const n = MONTH_NUMBER.get(word.slice(0, 3));
		// The month's short name or its full name ("Sept" too), never any word that starts like one.
		if (!n || !(word.length === 3 || MONTHS_LONG[n - 1]!.startsWith(word))) return null;
		[d, m, y] = [Number(x[1]), n, Number(x[3])];
	} else return null;
	if (m < 1 || m > 12 || d < 1) return null;
	const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
	if (d > days) return null;
	return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The words a typed day's field and its message use: what parseDay reads. */
export const DAY_FIRST_EXAMPLES = '15 Nov 2021, 15/11/2021 or 2021-11-15';

/**
 * A typed day's text as the field shows it once read: "2021-11-15" or
 * "15/11/2021" → "15 Nov 2021" (fmtDay); text parseDay can't read stays as
 * typed, so the field can say what's wrong with it. For a field's blur.
 */
export function tidyDay(text: string): string {
	const iso = parseDay(text);
	return iso ? fmtDay(iso) : text;
}

/**
 * A date search box's query → the ISO prefix it names, so a table that shows
 * its days day first ("15 Nov 2021") finds them as they read. A whole day as
 * parseDay reads it ("15 Nov 2021", "15/11/2021", "2021-11-15"), a month day
 * first or year first ("Nov 2021", "November 2021", "11/2021", "2021-11"), or
 * a year ("2021"). Anything else is returned trimmed and unchanged, so a
 * partly typed ISO prefix ("2021-1") still narrows as before. Read from the
 * string, never through Date.
 */
export function dayPrefix(query: string): string {
	const s = query.trim().replace(/\s+/g, ' ');
	const day = parseDay(s);
	if (day) return day;
	const ym = (y: string, m: number) => (m >= 1 && m <= 12 ? `${y}-${String(m).padStart(2, '0')}` : null);
	// Year first only with a two-digit month: "2021-1" is "2021-1…" half typed (Oct to Dec), never January.
	let x = /^(\d{4})[-/.](\d{2})$/.exec(s);
	if (x) return ym(x[1]!, Number(x[2])) ?? s;
	if ((x = /^(\d{1,2})[-/.](\d{4})$/.exec(s))) return ym(x[2]!, Number(x[1])) ?? s;
	if ((x = /^([A-Za-z]{3,9})\.?,? (\d{4})$/.exec(s))) {
		const word = x[1]!.toLowerCase();
		const n = MONTH_NUMBER.get(word.slice(0, 3));
		if (n && (word.length === 3 || MONTHS_LONG[n - 1]!.startsWith(word))) return ym(x[2]!, n)!;
	}
	return s;
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * A moment (an ISO timestamp) day first, in the viewer's time zone: "11 Oct
 * 2026 14:05". What a person reads; fmtDate's ISO form is for file names and
 * codes. Anything that isn't a timestamp is returned unchanged.
 */
export function fmtStamp(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return `${fmtDay(localIsoDate(d))} ${hhmm(d)}`;
}

/**
 * A moment as a list or a status line says it: "today 14:05", "yesterday
 * 09:30", otherwise fmtStamp's "3 Sep 2026 14:05". Not after "on" in a
 * sentence ("on today 14:05"): use fmtStamp there.
 */
export function fmtWhen(iso: string, now: Date = new Date()): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const day = localIsoDate(d);
	const y = new Date(now);
	y.setDate(y.getDate() - 1);
	const label = day === localIsoDate(now) ? 'today' : day === localIsoDate(y) ? 'yesterday' : fmtDay(day);
	return `${label} ${hhmm(d)}`;
}

/**
 * Today's calendar date where the viewer is (YYYY-MM-DD). Series dates are
 * calendar days, so a data age is counted against the viewer's local date,
 * never the UTC one (which is a day off around local midnight).
 */
export function localIsoDate(now: Date = new Date()): string {
	const pad = (x: number) => String(x).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The moment to send for a day picked in a "when did this happen" field
 * (YYYY-MM-DD, at most the viewer's today). A bare day reaches the server as
 * UTC midnight, which is still in the future for the first hours of a day
 * east of Greenwich (00:00–02:00 in South Africa), so today goes as the
 * current moment; an earlier day goes as itself.
 */
export function pastDayMoment(day: string, now: Date = new Date()): string {
	return day === localIsoDate(now) ? now.toISOString() : day;
}

const zoned = new Map<string, Intl.DateTimeFormat>();

/**
 * Today's calendar date in an IANA zone (YYYY-MM-DD), whatever zone the
 * device is set to. Throws a RangeError for a zone Intl doesn't know.
 */
export function zonedIsoDate(now: Date, timeZone: string): string {
	let f = zoned.get(timeZone);
	if (!f) zoned.set(timeZone, (f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })));
	const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
	return `${p.year}-${p.month}-${p.day}`;
}

const GROUPED = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
const DECIMAL_COMMA = /^-?\d*,\d+$/;

/**
 * Parse typed or pasted numbers. A leading minus may be the hyphen-minus or
 * the true minus the app displays (U+2212, also what a report or a word
 * processor pastes). Spaces (any: plain, no-break, and the
 * narrow no-break space the app displays numbers with) are thousands
 * separators (12 000). A comma is a thousands separator only in a valid
 * grouping (1,500 and 1,234,567.8); otherwise a single comma is a
 * decimal comma, as typed in South Africa and much of the world (1,5 → 1.5).
 * Anything else ambiguous (1,2,3; 1,5.2) is rejected rather than guessed.
 * Empty → null.
 */
export function parseNum(input: string): number | null {
	let s = input.replace(/\s/g, '').replace(/^\u2212/, '-');
	if (s === '') return null;
	if (s.includes(',')) {
		if (GROUPED.test(s)) s = s.replace(/,/g, '');
		else if (DECIMAL_COMMA.test(s)) s = s.replace(',', '.');
		else return null;
	}
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}
