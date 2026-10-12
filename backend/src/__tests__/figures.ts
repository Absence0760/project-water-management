/**
 * Does an API answer carry a registered volume as a figure? The canary sweep's check (issue #523 G1, G1c), and the
 * volume-hiding tests' (holdsFigure). A test helper, not app code.
 *
 * A volume v (m³ a year) is "carried" when the answer holds, as a number of either sign (Math.abs):
 * - v itself, within 0.5 (the API serves it whole);
 * - one of its shares, by closeness: v in megalitres (÷ 1000), its share of a day (÷ 365 or ÷ 366, in m³ or ML),
 *   of a second (÷ 31 536 000, the maximum rate's m³/s), or of a partial water year (× days ÷ 365 or 366). A share
 *   matches when it agrees with the target to the precision it is printed with (half a unit of its last digit, or
 *   a part in ten million), and is printed with 6 or more significant digits: a share rounded shorter is too short
 *   to tell from any other number in a daily series.
 *
 * What it reads: every number of a JSON answer, and every number token in its strings (digits grouped by spaces,
 * commas, apostrophes or no-break spaces, a sign, decimals); a non-JSON answer (CSV, text) as one string. Never
 * the values under an id key (id, …Id, …Ids, …_id, a hash), nor the digits of a uuid or a hex run.
 */

/** A share must be printed with this many significant digits to count. */
const SHARE_DIGITS = 6;
/** Relative closeness a full-precision share must reach (float noise in a sum of daily shares is far below it). */
const SHARE_TOLERANCE = 1e-7;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A hex run of 8 or more holding a letter and a digit: a hash, a token, a key (not a plain number). */
const HEX_RUN = /(?<![0-9a-z])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,}(?![0-9a-z])/gi;
const SEPARATORS = /[ ,'  ]/g;
/** A number token: a sign, digits (grouped by thousands or not), decimals; never part of a word, an id or a date. */
const GROUPED = /(?<![\w.\-])-?(?:\d{1,3}(?:[ ,'  ]\d{3})+|\d+)(?:\.\d+)?(?![\d\-]|\.\d)/g;
/** The same, digits only: so "12,345" in a CSV row is read as 12 and 345 as well as 12345. */
const PLAIN = /(?<![\w.\-])-?\d+(?:\.\d+)?(?![\d\-]|\.\d)/g;
const ID_KEY = /^(id|.*(Id|Ids|_id|_ids)|.*(sha256|Sha256|hash|Hash|digest|Digest|token|Token))$/;

/** Significant digits and half a unit of the last digit, as `printed` writes the number. */
function precisionOf(printed: string): { digits: number; halfUnit: number } {
	const [mantissa = '', exp = '0'] = printed.replace(/^-/, '').toLowerCase().split('e');
	const [whole = '', frac = ''] = mantissa.split('.');
	const digits = (whole + frac).replace(/^0+/, '').length;
	return { digits, halfUnit: 0.5 * 10 ** (Number(exp) - frac.length) };
}

/** The forms v takes: m³ a year (whole, within 0.5) and its shares (matched by closeness). */
function formsOf(v: number, partialDays: number[]) {
	const shares = [v / 1000, v / 31_536_000];
	for (const year of [365, 366]) {
		shares.push(v / year, v / year / 1000);
		for (const d of partialDays) shares.push((v * d) / year);
	}
	return { whole: Math.abs(v), shares: shares.map(Math.abs) };
}

/** Each place `text` carries v (m³ a year) as a figure, as "path = value" or "path ~ token in string". */
export function figuresAt(text: string, v: number, opts: { partialDays?: number[] } = {}): string[] {
	const { whole, shares } = formsOf(v, opts.partialDays ?? []);
	const hit = (n: number, printed: string) => {
		const a = Math.abs(n);
		if (Math.abs(a - whole) < 0.5) return true;
		const { digits, halfUnit } = precisionOf(printed);
		return digits >= SHARE_DIGITS && shares.some((t) => Math.abs(a - t) <= Math.max(halfUnit, t * SHARE_TOLERANCE));
	};
	const out: string[] = [];
	const inString = (s: string, at: string) => {
		const clean = s.replace(UUID, ' ').replace(HEX_RUN, ' ');
		const tokens = new Set([...clean.matchAll(GROUPED), ...clean.matchAll(PLAIN)].map((m) => m[0]));
		for (const tok of tokens) {
			const printed = tok.replace(SEPARATORS, '');
			if (hit(Number(printed), printed)) out.push(`${at} ~ "${tok}" in "${s.length > 120 ? `${s.slice(0, 120)}…` : s}"`);
		}
	};
	const walk = (x: unknown, at: string) => {
		if (typeof x === 'number') {
			if (Number.isFinite(x) && hit(x, String(x))) out.push(`${at} = ${x}`);
		} else if (typeof x === 'string') inString(x, at);
		else if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${at}[${i}]`));
		else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) if (!ID_KEY.test(k)) walk(y, `${at}.${k}`);
	};
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		inString(text, '$text');
		return out;
	}
	walk(body, '$');
	return out;
}

export const holdsFigure = (text: string, v: number, opts?: { partialDays?: number[] }) => figuresAt(text, v, opts).length > 0;
