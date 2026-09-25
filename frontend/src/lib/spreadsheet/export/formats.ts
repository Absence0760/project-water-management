// Display number formats for the workbook (decision D11): every numeric cell
// holds the full-precision value the CSV export has, and a per-column Excel
// format code only changes how it is shown, so rounding is visual and a
// click on the cell (or any formula) sees the unrounded number.
//
// The codes use Excel's `,` group and `.` decimal placeholders. In a format
// code these are not literal characters: Excel and LibreOffice draw them with
// the viewer's own locale separators ("1 234,5" in a South African or French
// locale, "1,234.5" in a US one). So the workbook doesn't prejudge D10 (the
// app's own thousands separator, still open): each reader sees their own.

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
