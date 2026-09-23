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

/** Parse user input that may contain thousands separators or spaces. Empty → null. */
export function parseNum(input: string): number | null {
	const s = input.replace(/[\s,]/g, '');
	if (s === '') return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}
