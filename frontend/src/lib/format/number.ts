// Number/date formatting. Always a comma thousands separator and '.' decimal
// point (en-US rules), so figures read the same as the source workbook
// whatever the browser locale is.

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

/** 1234567.8 → "1,234,568" (digits = 0) or "1,234,567.80" (digits = 2). Null/NaN → "–". */
export function fmtNum(n: number | null | undefined, digits = 0, trim = false): string {
	if (n == null || !Number.isFinite(n)) return '–';
	const out = formatter(trim ? 0 : digits, digits).format(n);
	return out === '-0' ? '0' : out;
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
 * Parse typed or pasted numbers. Spaces are thousands separators (12 000).
 * A comma is a thousands separator only in a valid grouping (1,500 and
 * 1,234,567.8, as the app displays numbers); otherwise a single comma is a
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
