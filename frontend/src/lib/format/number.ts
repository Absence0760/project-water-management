// Number/date formatting. The app's one thousands separator, a narrow
// no-break space (THOUSANDS_SEP, D10: "300 000"), and a '.' decimal point,
// whatever the browser locale is. Formatted with en-US rules, then regrouped.
import { regroup } from '@water-management/engine/format';

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

/** 1234567.8 → "1 234 568" (digits = 0) or "1 234 567.80" (digits = 2), narrow no-break spaces. Null/NaN → "–". */
export function fmtNum(n: number | null | undefined, digits = 0, trim = false): string {
	if (n == null || !Number.isFinite(n)) return '–';
	const out = regroup(formatter(trim ? 0 : digits, digits).format(n));
	return out === '-0' ? '0' : out;
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
	if (a < 1e-6) return n.toExponential(sig - 1).replace(/\.?0+e/, 'e').replace('e+', 'e');
	return regroup(sigFormatter(sig).format(n));
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

/**
 * Today's calendar date where the viewer is (YYYY-MM-DD). Series dates are
 * calendar days, so a data age is counted against the viewer's local date,
 * never the UTC one (which is a day off around local midnight).
 */
export function localIsoDate(now: Date = new Date()): string {
	const pad = (x: number) => String(x).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const GROUPED = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
const DECIMAL_COMMA = /^-?\d*,\d+$/;

/**
 * Parse typed or pasted numbers. Spaces (any: plain, no-break, and the
 * narrow no-break space the app displays numbers with) are thousands
 * separators (12 000). A comma is a thousands separator only in a valid
 * grouping (1,500 and 1,234,567.8); otherwise a single comma is a
 * decimal comma, as typed in South Africa and much of the world (1,5 → 1.5).
 * Anything else ambiguous (1,2,3; 1,5.2) is rejected rather than guessed.
 * Empty → null.
 */
export function parseNum(input: string): number | null {
	let s = input.replace(/\s/g, '');
	if (s === '') return null;
	if (s.includes(',')) {
		if (GROUPED.test(s)) s = s.replace(/,/g, '');
		else if (DECIMAL_COMMA.test(s)) s = s.replace(',', '.');
		else return null;
	}
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}
