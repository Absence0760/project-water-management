// Text form of a grouped numeric field (NumberInput `grouped`): the app's usual
// number formatting (format/number.ts, narrow no-break thousands separators). Typed or
// pasted input is read back with parseNum, which accepts 1,500 / 1 500 / 1500.
import { fmtNum } from '$lib/format/number';

const round = (n: number) => Math.round(n * 1e9) / 1e9;

/** 300000 → "300 000"; 1234.5 → "1 234.5"; scale 100 shows a fraction as %. Missing → "". */
export function groupedText(v: number | null | undefined, scale = 1): string {
	if (v == null || !Number.isFinite(v)) return '';
	return fmtNum(round(v * scale), 9, true);
}

/**
 * Text form of a plain numeric field: float noise trimmed (9 decimals), or
 * rounded to `decimals` when set, for a stored value whose exact form isn't
 * worth showing (2/3 as a percentage reads 66.7, not 66.666666667). Display
 * only: the stored value is untouched until the user edits the field.
 */
export function plainText(v: number | null | undefined, scale = 1, decimals?: number): string {
	if (v == null || !Number.isFinite(v)) return '';
	const f = 10 ** (decimals ?? 9);
	return String(Math.round(v * scale * f) / f);
}
