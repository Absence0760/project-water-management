// Model settings → Demand → "Where the A-pan row comes from" (docs/ui.md §
// Demand, docs/maps.md § WR2012 evaporation by quaternary): the choice of source, and the typed
// or pasted S-pan's parsing. S-pan becomes A-pan only by the inverted
// equation the user picks (engine spanToApan.ts); the server converts again
// on Use and records the months, the note and the equation in the revision.

/**
 * Where the A-pan row can come from. The WR2012 configurations, the typed S-pan and the CCWR A-pan grid (pinned to
 * `Atlas-Apan-2007`, averaged over the catchment boundary, ./ccwrApan.ts) are proposed here (each a lazy panel); the
 * stations and any other evaporation grid (a PenPan A-pan, a reference-ET grid for GR4J's PE) stay on Calibration, and
 * the choice links to them.
 */
export const APAN_SOURCES = [
	{ id: 'typed', label: 'Typed or pasted A-pan (the row below)' },
	{ id: 'wr2012', label: 'WR2012 Pitman configuration, per quaternary' },
	{ id: 'span', label: 'Typed or pasted S-pan, converted (WR90 / Taljaard)' },
	{ id: 'station', label: 'A DWS evaporation station', href: '?tab=calibration#set-evaporation-station', where: 'Evaporation stations' },
	{ id: 'ccwr', label: 'CCWR A-pan grid (catchment average)' },
	{ id: 'grid', label: 'An evaporation grid (A-pan from the map)', href: '?tab=calibration#set-evaporation', where: 'Evaporation from the map' }
] as const;
export type ApanSourceId = (typeof APAN_SOURCES)[number]['id'];

/**
 * 12 numbers from a pasted spreadsheet row (or column), October first: split
 * on tabs or line breaks when there are any (a comma is then a decimal
 * comma), else on semicolons or spaces, else on commas. Why not, otherwise.
 */
export function parseSpanRow(text: string): { ok: true; values: number[] } | { ok: false; reason: string } {
	const t = text.trim();
	if (!t) return { ok: false, reason: 'paste the 12 months, October first' };
	const cells = /[\t\n]/.test(t)
		? t.split(/[\t\r\n]+/).map((c) => c.trim().replace(',', '.'))
		: /[; ]/.test(t)
			? t.split(/[;\s]+/).map((c) => c.trim().replace(',', '.'))
			: t.split(',').map((c) => c.trim());
	const values = cells.filter((c) => c !== '').map((c) => Number(c.replace(/\s/g, '')));
	if (values.length !== 12) return { ok: false, reason: `that is ${values.length} value${values.length === 1 ? '' : 's'}, not 12 (October to September)` };
	const bad = values.findIndex((v) => !Number.isFinite(v) || v < 0 || v > 1000);
	if (bad >= 0) return { ok: false, reason: `value ${bad + 1} is not a number of mm from 0 to 1000` };
	return { ok: true, values };
}
