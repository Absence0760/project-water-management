// Cell values as openpyxl (read_only=True, data_only=True) hands them to
// scripts/wbt-import/extract_project.py, and the Python builtins the importer
// applies to them (float(), str(), repr(), format(x, 'g'), truthiness).
//
// The TypeScript importer must write the same project.json as the Python one
// (docs/roadmap/step-1-hydrologist-tool.md WP-1.31, decision D17), so every
// place the Python stringifies or coerces a cell goes through one of these
// helpers rather than JavaScript's own String()/Number(), which differ at the
// edges (Number('') is 0, String(1e-5) is '0.00001', Python prints '1e-05').

/** A date-formatted number: openpyxl's from_excel() gives a datetime. */
export class XlDateTime {
	/** iso = 'YYYY-MM-DD'; msOfDay = milliseconds after midnight (0 ≤ msOfDay < 86 400 000). */
	constructor(
		readonly iso: string,
		readonly msOfDay: number
	) {}
}

/** A date-formatted number in [0, 1): openpyxl gives a datetime.time, which is not a date. */
export class XlTime {
	constructor(readonly msOfDay: number) {}
}

/** A number in a duration format such as [h]:mm: openpyxl gives a datetime.timedelta. */
export class XlDuration {
	constructor(readonly days: number) {}
}

/**
 * One cell's cached value. Strings include error values ('#N/A', '#REF!', …),
 * which openpyxl returns as their text. A number that openpyxl would return as
 * an int (its XML text has no '.' or exponent) is a JavaScript integer here;
 * `isPyInt` tells them apart where Python's output would differ.
 */
export type Cell = number | string | boolean | XlDateTime | XlTime | XlDuration | null;

/** Python's whitespace (str.isspace, and re's \s on str), which is not JavaScript's \s. */
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const WS_RUN = new RegExp(`[${PY_WS}]+`, 'g');
const WS_EDGES = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');

/** Python str.strip(). */
export function pyStrip(s: string): string {
	return s.replace(WS_EDGES, '');
}

/**
 * Whether openpyxl would have returned this number as an int: it does when the
 * cell's XML text has no '.' and no exponent, which Excel writes for every
 * integral value below 1e15 (it switches to 'E' notation above that).
 */
export function isPyInt(n: number): boolean {
	return Number.isInteger(n) && Math.abs(n) < 1e15;
}

/** Python truthiness: None, False, 0, 0.0, '' and a zero timedelta are falsy. */
export function pyFalsy(v: Cell): boolean {
	if (v === null || v === false || v === '' || v === 0) return true;
	return v instanceof XlDuration && v.days === 0;
}

// --- numbers -----------------------------------------------------------------

/** Round |x| to `precision` significant digits, half to even on its exact decimal value (Python's rule). */
function roundedDigits(x: number, precision: number): { digits: string; exp: number } {
	// toPrecision(100) is exact for every double whose expansion fits in 100
	// digits, which covers every exact tie (a tie needs a short expansion).
	const [mant, e] = Math.abs(x).toExponential(99).split('e') as [string, string];
	const all = mant.replace('.', '');
	let exp = Number(e);
	const head = all.slice(0, precision);
	const rest = all.slice(precision);
	let up = rest > '5'.padEnd(rest.length, '0');
	if (rest === '5'.padEnd(rest.length, '0')) up = Number(head[head.length - 1]) % 2 === 1;
	if (!up) return { digits: head, exp };
	const bumped = (BigInt(head) + 1n).toString();
	if (bumped.length > precision) {
		exp += 1;
		return { digits: bumped.slice(0, precision), exp };
	}
	return { digits: bumped, exp };
}

/** Drop trailing zeros after a decimal point, then the point itself. */
function stripZeros(s: string): string {
	return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** Python format(x, 'g'): 6 significant digits, trailing zeros removed, exponent below 1e-4 or from 1e6. */
export function pyFormatG(x: number): string {
	if (Number.isNaN(x)) return 'nan';
	if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
	const sign = x < 0 || Object.is(x, -0) ? '-' : '';
	if (x === 0) return `${sign}0`;
	const { digits, exp } = roundedDigits(x, 6);
	if (exp >= -4 && exp < 6) {
		const s = exp >= 0 ? `${digits.slice(0, exp + 1).padEnd(exp + 1, '0')}.${digits.slice(exp + 1)}` : `0.${'0'.repeat(-exp - 1)}${digits}`;
		return sign + stripZeros(s);
	}
	const m = stripZeros(`${digits[0]}.${digits.slice(1)}`);
	return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
}

/** Python repr(float) (= str(float)): the shortest round-trip digits, exponent below 1e-4 or from 1e16. */
export function pyFloatRepr(x: number): string {
	if (Number.isNaN(x)) return 'nan';
	if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
	const sign = x < 0 || Object.is(x, -0) ? '-' : '';
	if (x === 0) return `${sign}0.0`;
	// toExponential() with no argument gives the shortest digits that round-trip, as Python's repr does.
	const [mant, e] = Math.abs(x).toExponential().split('e') as [string, string];
	const digits = mant.replace('.', '');
	const exp = Number(e);
	if (exp >= -4 && exp < 16) {
		if (exp >= 0) {
			const int = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
			const frac = digits.slice(exp + 1);
			return `${sign}${int}.${frac || '0'}`;
		}
		return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
	}
	const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
	return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
}

function pyNumberStr(n: number): string {
	return isPyInt(n) ? (Object.is(n, -0) ? '0' : n.toFixed(0)) : pyFloatRepr(n);
}

const PY_FLOAT = /^[+-]?(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const PY_FLOAT_SPECIAL = /^[+-]?(?:inf|infinity|nan)$/i;

/** Python float(s) for a str, or null where it raises ValueError. */
export function pyFloat(s: string): number | null {
	const t = pyStrip(s);
	if (PY_FLOAT_SPECIAL.test(t)) {
		const neg = t.startsWith('-');
		if (/nan/i.test(t)) return NaN;
		return neg ? -Infinity : Infinity;
	}
	if (!PY_FLOAT.test(t)) return null;
	return Number(t.replace(/_/g, ''));
}

// --- dates and times as Python prints them ------------------------------------

function hms(ms: number): { h: number; m: number; s: number; us: number } {
	const totalS = Math.floor(ms / 1000);
	return { h: Math.floor(totalS / 3600), m: Math.floor((totalS % 3600) / 60), s: totalS % 60, us: (ms % 1000) * 1000 };
}

const two = (n: number) => String(n).padStart(2, '0');

function timeStr(ms: number): string {
	const t = hms(ms);
	return `${two(t.h)}:${two(t.m)}:${two(t.s)}${t.us ? `.${String(t.us).padStart(6, '0')}` : ''}`;
}

function timeReprArgs(ms: number): string {
	const t = hms(ms);
	const parts = [t.h, t.m];
	if (t.s || t.us) parts.push(t.s);
	if (t.us) parts.push(t.us);
	return parts.join(', ');
}

/** Python str(timedelta(days=d)) for the millisecond-rounded value openpyxl makes. */
function durationStr(days: number): string {
	const totalMs = Math.round(days * 86_400_000);
	const d = Math.floor(totalMs / 86_400_000);
	const rest = totalMs - d * 86_400_000;
	const t = timeStr(rest).replace(/^0(\d):/, '$1:');
	return d ? `${d} day${Math.abs(d) === 1 ? '' : 's'}, ${t}` : t;
}

function durationRepr(days: number): string {
	const totalMs = Math.round(days * 86_400_000);
	const d = Math.floor(totalMs / 86_400_000);
	const restMs = totalMs - d * 86_400_000;
	const s = Math.floor(restMs / 1000);
	const us = (restMs % 1000) * 1000;
	const parts: string[] = [];
	if (d) parts.push(`days=${d}`);
	if (s) parts.push(`seconds=${s}`);
	if (us) parts.push(`microseconds=${us}`);
	return `datetime.timedelta(${parts.join(', ') || '0'})`;
}

// --- str() and repr() -------------------------------------------------------------

/** Python str(v). */
export function pyStr(v: Cell): string {
	if (v === null) return 'None';
	if (typeof v === 'boolean') return v ? 'True' : 'False';
	if (typeof v === 'number') return pyNumberStr(v);
	if (typeof v === 'string') return v;
	if (v instanceof XlDateTime) return `${v.iso} ${timeStr(v.msOfDay)}`;
	if (v instanceof XlTime) return timeStr(v.msOfDay);
	return durationStr(v.days);
}

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function strRepr(s: string): string {
	const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
	let out = '';
	for (const ch of s) {
		if (ch === '\\') out += '\\\\';
		else if (ch === quote) out += `\\${quote}`;
		else if (ch === '\n') out += '\\n';
		else if (ch === '\r') out += '\\r';
		else if (ch === '\t') out += '\\t';
		else if (ch !== ' ' && NON_PRINTABLE.test(ch)) {
			const cp = ch.codePointAt(0)!;
			if (cp < 0x100) out += `\\x${cp.toString(16).padStart(2, '0')}`;
			else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, '0')}`;
			else out += `\\U${cp.toString(16).padStart(8, '0')}`;
		} else out += ch;
	}
	return quote + out + quote;
}

/** Python repr(v) for a cell value, or a list of them / of ints. */
export function pyRepr(v: Cell | readonly (Cell | number)[]): string {
	if (Array.isArray(v)) return `[${v.map((x) => pyRepr(x as Cell)).join(', ')}]`;
	const c = v as Cell;
	if (typeof c === 'string') return strRepr(c);
	if (c instanceof XlDateTime) {
		const [y, m, d] = c.iso.split('-').map(Number) as [number, number, number];
		return `datetime.datetime(${y}, ${m}, ${d}, ${timeReprArgs(c.msOfDay)})`;
	}
	if (c instanceof XlTime) return `datetime.time(${timeReprArgs(c.msOfDay)})`;
	if (c instanceof XlDuration) return durationRepr(c.days);
	return pyStr(c);
}

// --- the importer's own coercions (extract_project.py num / clean / is_name) ----

/** extract_project.py num(): Excel treats blanks as 0 in arithmetic; anything unreadable becomes `fallback`. */
export function num(v: Cell, fallback = 0): number {
	if (v === null || v === '') return fallback;
	if (typeof v === 'boolean') return v ? 1 : 0;
	if (typeof v === 'number') return v;
	return pyFloat(pyStr(v)) ?? fallback;
}

/** Whether num() read a real number from the cell (not a blank, and not text or an error it replaced). */
export function isNumeric(v: Cell): boolean {
	if (typeof v === 'number' || typeof v === 'boolean') return true;
	if (v === null || v === '') return false;
	return pyFloat(pyStr(v)) !== null;
}

/** extract_project.py clean(): str(v or ''), whitespace runs collapsed to one space, stripped. */
export function clean(v: Cell): string {
	return pyStrip((pyFalsy(v) ? '' : pyStr(v)).replace(WS_RUN, ' '));
}

/** extract_project.py is_name(): a non-blank label that isn't a '|' separator or a '--' sentinel. */
export function isName(v: Cell): boolean {
	const s = clean(v);
	return s !== '' && s !== '|' && !s.startsWith('--');
}

/** openpyxl.utils.get_column_letter(). */
export function columnLetter(col: number): string {
	let s = '';
	for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
	return s;
}

/** openpyxl.utils.column_index_from_string(). */
export function columnIndex(letters: string): number {
	let n = 0;
	for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n;
}

/** A1-style address (1-based column and row). */
export function cellAddress(col: number, row: number): string {
	return `${columnLetter(col)}${row}`;
}
