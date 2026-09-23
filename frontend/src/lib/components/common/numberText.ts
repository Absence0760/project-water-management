// Text form of a grouped numeric field (NumberInput `grouped`): the app's usual
// number formatting (format/number.ts, comma thousands separators). Typed or
// pasted input is read back with parseNum, which accepts 1,500 / 1 500 / 1500.
import { fmtNum } from '$lib/format/number';

const round = (n: number) => Math.round(n * 1e9) / 1e9;

/** 300000 → "300,000"; 1234.5 → "1,234.5"; scale 100 shows a fraction as %. Missing → "". */
export function groupedText(v: number | null | undefined, scale = 1): string {
	if (v == null || !Number.isFinite(v)) return '';
	return fmtNum(round(v * scale), 9, true);
}
