// Display number formats for the workbook (decision D11): every numeric cell
// holds the full-precision value the CSV export has, and a per-column Excel
// format code only changes how it is shown, so rounding is visual and a
// click on the cell (or any formula) sees the unrounded number.
//
// The codes use Excel's `,` group and `.` decimal placeholders. In a format
// code these are not literal characters: Excel and LibreOffice draw them with
// the viewer's own locale separators ("1 234,5" in a South African or French
// locale, "1,234.5" in a US one). So the workbook doesn't follow D10 (the
// app's own thousands separator, a narrow no-break space): each reader sees
// their own.

/** The unit in a header's last bracket, e.g. "Irrigation supplied [G] (m³/day)" → "m³/day". */
export function unitOf(header: string): string | null {
	const m = /\(([^()]*)\)\s*$/.exec(header);
	return m ? m[1]!.trim() : null;
}

/** Calendar dates (the daily sheets' first column holds Excel date serials). */
export const DATE_FORMAT = 'yyyy-mm-dd';

/**
 * The display format for a column of `unit`, or undefined for Excel's General
 * (which shows up to ~10 significant digits). Volumes and flows get two
 * decimals and a thousands group; depths one; percentages (the exports write
 * shares as 0–100, not fractions, so no `%` code that would multiply by 100)
 * one; ratios three.
 */
export function numberFormat(unit: string | null | undefined): string | undefined {
	if (!unit) return undefined;
	const u = unit.trim();
	if (u.startsWith('%')) return '0.0';
	if (/^Mm³/.test(u)) return '#,##0.000';
	if (/^(m³\/s|l\/s)$/.test(u)) return '#,##0.000';
	if (/^(m³|m³\/day|m³\/d|m²|km²)$/.test(u)) return '#,##0.00';
	if (/^mm(\/yr)?$/.test(u)) return '#,##0.0';
	if (u === '×') return '0.000';
	if (u === 'flag') return '0';
	return undefined;
}

/** The format of flows in m³/s or l/s and volumes in Mm³: three decimals. */
const THREE_DECIMALS = '#,##0.000';

/**
 * The display format for one summary-sheet cell `v` in a column of `unit`:
 * numberFormat's, except that a small non-zero flow or volume, which three
 * decimals would show as 0.000, gets the decimals for two significant
 * figures (0.00042 → "0.00042"; issue #45, as the app's fmtQty). The value
 * itself is unrounded either way.
 */
export function cellFormat(unit: string | null | undefined, v: number): string | undefined {
	const z = numberFormat(unit);
	const a = Math.abs(v);
	if (z !== THREE_DECIMALS || a === 0 || a >= 0.01) return z;
	const decimals = Math.min(12, 1 - Math.floor(Math.log10(a)));
	return `#,##0.${'0'.repeat(decimals)}`;
}
