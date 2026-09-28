// A dam's survey curve in the node form (WP-3.5, docs/model.md §2.7a):
// reading pasted rows (from a spreadsheet or the DW789 form) and the checks
// the form shows beside the table. Pure: no Svelte, no API.
import { DAM_CURVE_CAPACITY_TOLERANCE, DAM_CURVE_MAX_ROWS, damCurveProblem, type DamCurvePoint } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

export interface ParsedCurve {
	rows: DamCurvePoint[];
	/** Why the text can't be read, or null. A readable curve may still break a rule: see curveNotes. */
	error: string | null;
}

/**
 * Rows of level (m), area (m²) and volume (m³), one per line, separated by
 * commas, semicolons, tabs or spaces. Blank lines and a header line (any line
 * whose first cell isn't a number) are skipped; thousands separators are not
 * accepted, since "1,000" is ambiguous in comma-separated text. The rows keep
 * the order they were typed in; the engine sorts them by volume.
 */
export function parseDamCurve(text: string): ParsedCurve {
	const rows: DamCurvePoint[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim();
		if (!line) continue;
		const cells = line.split(/[,;\t ]+/).filter(Boolean);
		if (!Number.isFinite(Number(cells[0]))) {
			// A header line, but only before the first row.
			if (rows.length === 0) continue;
			return { rows: [], error: `Line ${i + 1}: "${cells[0]}" is not a number.` };
		}
		if (cells.length !== 3) return { rows: [], error: `Line ${i + 1}: expected 3 values (level, area, volume), found ${cells.length}.` };
		const [levelM, areaM2, volumeM3] = cells.map(Number) as [number, number, number];
		if (![levelM, areaM2, volumeM3].every(Number.isFinite)) return { rows: [], error: `Line ${i + 1}: every value must be a number.` };
		rows.push({ levelM, areaM2, volumeM3 });
	}
	if (rows.length === 0) return { rows: [], error: 'No rows: paste level, area and volume, one row per line.' };
	if (rows.length > DAM_CURVE_MAX_ROWS) return { rows: [], error: `At most ${DAM_CURVE_MAX_ROWS} rows.` };
	return { rows, error: null };
}

/** The curve as the text the paste box starts from: one "level, area, volume" row per line. */
export function curveText(rows: readonly DamCurvePoint[] | null | undefined): string {
	return (rows ?? []).map((r) => `${r.levelM}, ${r.areaM2}, ${r.volumeM3}`).join('\n');
}

/**
 * What the form says about a dam's curve: the rule it breaks (the save
 * refuses it), a top row more than 1 % from the capacity (the run warns), or
 * that there is none and the power law is in use.
 */
export function curveNotes(rows: readonly DamCurvePoint[] | null | undefined, capacityM3: number): { error: string | null; notes: string[] } {
	if (!rows || rows.length === 0) return { error: null, notes: ['No survey curve: using the power-law area (area when full × (storage ÷ capacity)^exponent, WP-1.21).'] };
	const error = damCurveProblem(rows);
	if (error) return { error: `${error[0]!.toUpperCase()}${error.slice(1)}.`, notes: [] };
	const top = Math.max(...rows.map((r) => r.volumeM3));
	const notes: string[] = [];
	if (capacityM3 > 0 && Math.abs(top - capacityM3) > DAM_CURVE_CAPACITY_TOLERANCE * capacityM3)
		notes.push(
			`The survey's top row holds ${fmtNum(top)} m³ but the capacity is ${fmtNum(capacityM3)} m³ (more than 1 % apart). Check one against the other.`
		);
	notes.push('Using the survey curve for the dam area; the area when full and exponent are not used.');
	return { error: null, notes };
}
