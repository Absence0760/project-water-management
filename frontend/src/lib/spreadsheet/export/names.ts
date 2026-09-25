// Names in the workbook are user-controlled (farm, crop and run names), and
// the file is opened by other members of the project, so they get the same
// treatment as the CSV exports (docs/security.md "CSV exports defuse
// spreadsheet formulas") and fit Excel's sheet-name rules.

/**
 * Text that a spreadsheet would treat as a formula (leading `= + - @`, tab or
 * CR) gets a leading apostrophe, exactly like backend/src/export/csv.ts
 * `textCell`. The workbook writes every name as a string cell, which Excel
 * never evaluates; the apostrophe keeps it inert if someone edits the cell or
 * copies it into a CSV.
 */
export function defuse(text: string): string {
	return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** Longest sheet name Excel accepts. */
export const SHEET_NAME_MAX = 31;

/**
 * A sheet-name allocator: each call returns a name Excel accepts for `wanted`
 * (at most 31 characters, none of `[ ] : * ? / \`, no control characters, no
 * leading or trailing apostrophe, not the reserved "History") and unique
 * within the workbook, ignoring case as Excel does ("Farm", "Farm (2)", …).
 */
export function sheetNamer(): (wanted: string) => string {
	const taken = new Set<string>();
	return (wanted) => {
		let base = wanted
			.replace(/[[\]:*?/\\]/g, '_')
			.replace(/[\u0000-\u001f\u007f]/g, ' ')
			.trim()
			.replace(/^'+|'+$/g, '')
			.trim();
		if (!base) base = 'Sheet';
		if (base.toLowerCase() === 'history') base = 'History_';
		for (let n = 1; ; n++) {
			const suffix = n === 1 ? '' : ` (${n})`;
			const name = cut(base, SHEET_NAME_MAX - suffix.length).replace(/'+$/, '') + suffix;
			if (!taken.has(name.toLowerCase())) {
				taken.add(name.toLowerCase());
				return name;
			}
		}
	};
}

/** The first `max` UTF-16 units of `s`, never splitting a surrogate pair. */
function cut(s: string, max: number): string {
	let out = '';
	for (const ch of s) {
		if (out.length + ch.length > max) break;
		out += ch;
	}
	return out;
}
