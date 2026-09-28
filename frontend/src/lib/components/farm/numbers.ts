// Numbers, units and dates for the farmer view (docs/design/farmer-view.md §8).
// This module holds the rules that need no words, so the /share page can use
// them without loading the message catalogue; ./format.ts adds the few that
// do ("m³ a day", counted nouns, "07:42 on …", "A and B") and re-exports
// all of this.
// Pure: no DOM, no storage. Every visible figure on the farm pages goes through
// these, so the rules below live in one tested place.
//
// - Volumes in the farmer's unit: m³ whole with a space between thousands
//   ("324 247 m³"); ML to one decimal with a trailing ".0" trimmed ("350 ML",
//   "83.6 ML").
// - Rates in "m³ a day"; l/s in brackets only from 1 l/s, judged on the
//   unrounded value (§8, §11 F9, F17).
// - Percentages whole, with "<1 %" and ">99 %" instead of rounding to 0 or 100.
// - Dates as "12 Jan 2024" (Intl en-ZA, dateStyle medium; af-ZA once the
//   Afrikaans words are in, WP-2.5), never ISO. Calendar days are formatted in
//   UTC so no time zone can move them; timestamps (when something was
//   published or saved) in the viewer's own zone.
//
// The thousands separator is the app's (THOUSANDS_SEP, a narrow no-break
// space, D10) and the gap before a unit a no-break space (U+00A0), so
// "324 247 m³" never wraps across two lines on a phone. The
// decimal follows the chosen language (D8, WP-2.5), from the engine's
// language table: a point in English, as in the design's boards, and a comma
// in Afrikaans ("83,6 ML"), as af-ZA writes it. Written by hand rather than through Intl so the result doesn't depend
// on the browser's ICU data. Dates follow the language the words are in
// (wordsLang, in the table's Intl locale), so an English sentence never
// carries Afrikaans month names.
import { M3_PER_DAY_PER_LS } from '@water-management/engine';
import { groupDigits } from '@water-management/engine/format';
import { localIsoDate, zonedIsoDate } from '$lib/format/number';
import { i18n, language, wordsLang } from '$lib/i18n/state.svelte';

/** No-break space: between a figure and its unit. */
export const NBSP = ' ';

export type VolumeUnit = 'm3' | 'ML';


/** The decimal mark in the chosen language (the language table's: a comma in Afrikaans, a point in English). */
export const decimalMark = () => language(i18n.locale).decimalMark;

/** A number with `digits` decimals (trimmed when `trim`), grouped. */
export function fmtNumber(n: number, digits = 0, trim = false): string {
	if (!Number.isFinite(n)) return '–';
	let s = Math.abs(n).toFixed(digits);
	if (trim && s.includes('.')) s = s.replace(/\.?0+$/, '');
	const [i, d] = s.split('.');
	const out = groupDigits(i!) + (d ? `${decimalMark()}${d}` : '');
	return n < 0 && /[1-9]/.test(out) ? `−${out}` : out;
}

/** A volume in m³ in the chosen unit: "324 247 m³" or "324.2 ML". */
export function fmtVolume(m3: number, unit: VolumeUnit): string {
	if (unit === 'ML') return `${fmtNumber(m3 / 1000, 1, true)}${NBSP}ML`;
	return `${fmtNumber(Math.round(m3))}${NBSP}m³`;
}

/**
 * Round to two significant figures, for the "about …" figures that are per
 * charged day (design §3 Q2: 220.8 → 220, 119.1 → 120). Under 10, whole.
 */
export function roundAbout(x: number): number {
	if (!Number.isFinite(x)) return x;
	const a = Math.abs(x);
	if (a < 10) return Math.round(x);
	const p = 10 ** (Math.floor(Math.log10(a)) - 1);
	// toFixed guards float noise such as 119.99999 → 120.
	return Number((Math.round(x / p) * p).toFixed(0));
}

/** l/s of a daily volume, to one decimal; null under 1 l/s (a fraction of a litre a second means nothing on a farm pump). */
export function litresPerSecond(m3Day: number): string | null {
	const ls = m3Day / M3_PER_DAY_PER_LS;
	if (!(ls >= 1)) return null;
	return `${fmtNumber(ls, 1)}${NBSP}l/s`;
}

/** A fraction as a whole percentage: "86 %", "<1 %", ">99 %", "100 %", "0 %". */
export function fmtPct(fraction: number): string {
	if (!Number.isFinite(fraction)) return '–';
	if (fraction <= 0) return `0${NBSP}%`;
	if (fraction >= 1) return `100${NBSP}%`;
	const p = Math.round(fraction * 100);
	if (p < 1) return `<1${NBSP}%`;
	if (p > 99) return `>99${NBSP}%`;
	return `${p}${NBSP}%`;
}

/** The Intl locale for dates: the words' language, as South Africa writes it. */
export const dateLocale = () => language(wordsLang()).intl;

const formatters = new Map<string, Intl.DateTimeFormat>();
/** A cached UTC formatter for the current date locale. */
function utcFormat(name: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${dateLocale()}:${name}`;
	let f = formatters.get(key);
	if (!f) formatters.set(key, (f = new Intl.DateTimeFormat(dateLocale(), { ...options, timeZone: 'UTC' })));
	return f;
}
const MEDIUM_UTC = () => utcFormat('medium', { dateStyle: 'medium' });
const DAY_MONTH_UTC = () => utcFormat('dayMonth', { day: 'numeric', month: 'short' });
const MONTH_SHORT_UTC = () => utcFormat('monthShort', { month: 'short' });
const MONTH_LONG_UTC = () => utcFormat('monthLong', { month: 'long' });
const MONTH_YEAR_UTC = () => utcFormat('monthYear', { month: 'short', year: 'numeric' });
const MONTH_LONG_YEAR_UTC = () => utcFormat('monthLongYear', { month: 'long', year: 'numeric' });

/** 'YYYY-MM-DD' or 'YYYY-MM' → a UTC Date (midnight of that day, or of the 1st). */
function utc(isoDay: string): Date | null {
	const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(isoDay);
	if (!m) return null;
	return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1));
}

/** Format with Intl, but write the day without a leading zero: en-ZA's ICU data gives "01 Oct 2023", the design "1 Oct 2023". */
export function fmt(f: Intl.DateTimeFormat, d: Date): string {
	return f
		.formatToParts(d)
		.map((p) => (p.type === 'day' ? String(Number(p.value)) : p.value))
		.join('');
}

const via = (f: () => Intl.DateTimeFormat, iso: string) => {
	const d = utc(iso);
	return d ? fmt(f(), d) : iso;
};

/** A calendar day → "12 Jan 2024". */
export const fmtDay = (isoDay: string) => via(MEDIUM_UTC, isoDay);
/** A calendar day → "1 Oct" (no year). */
export const fmtDayMonth = (isoDay: string) => via(DAY_MONTH_UTC, isoDay);
/** 'YYYY-MM' → "Nov". */
export const fmtMonthShort = (isoMonth: string) => via(MONTH_SHORT_UTC, isoMonth);
/** 'YYYY-MM' → "November". */
export const fmtMonthLong = (isoMonth: string) => via(MONTH_LONG_UTC, isoMonth);
/** 'YYYY-MM' → "Nov 2023". */
export const fmtMonthYear = (isoMonth: string) => via(MONTH_YEAR_UTC, isoMonth);
/** 'YYYY-MM' → "November 2023". */
export const fmtMonthLongYear = (isoMonth: string) => via(MONTH_LONG_YEAR_UTC, isoMonth);

/** A timestamp → its date where the viewer is: "12 Jan 2024". The formatter is made per call, so it follows the current zone. */
export function fmtStampDay(ts: string | number | Date): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return String(ts);
	return fmt(new Intl.DateTimeFormat(dateLocale(), { dateStyle: 'medium' }), d);
}

/** Whole days from calendar day `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
	const da = utc(a);
	const db = utc(b);
	if (!da || !db) return NaN;
	return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

/** The last calendar day of month 'YYYY-MM' ('YYYY-MM-DD'). */
export function monthEnd(isoMonth: string): string {
	const d = utc(isoMonth)!;
	const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
	return last.toISOString().slice(0, 10);
}

/**
 * Today where the catchment is (the project's zone, as the backend counts
 * staleness), worked out now from this device's clock, so a saved copy on
 * the phone and a tab left open past midnight move on with the day, and a
 * phone set to the wrong zone, or a visitor abroad, count the same days as
 * the server (issue #51). A zone the browser doesn't know falls back to the
 * server's `today` at the response, and a saved copy from before either
 * field existed to the phone's own date.
 */
export function farmToday(view: { today?: string; project: { timeZone?: string } }, now: Date = new Date()): string {
	const tz = view.project.timeZone;
	if (tz) {
		try {
			return zonedIsoDate(now, tz);
		} catch {
			// An unknown zone: the server's day below.
		}
	}
	return view.today ?? localIsoDate(now);
}
