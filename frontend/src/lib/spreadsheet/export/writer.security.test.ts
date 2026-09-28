// The .xlsx run export keeps user text inert and intact (docs/security.md §
// CSV exports defuse spreadsheet formulas). Names, labels and notes reach the
// workbook's cells; each must come back as the text typed, never as a
// formula, and every part must stay well-formed XML whatever the text holds.
// Excel reads a cell's text as ECMA-376 says (XML entities, then `_xHHHH_`
// escapes), which is what `excelText` below does; SheetJS's reader decodes
// `_x005F_` differently, so it can't be the judge here.
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx/dist/xlsx.mini.min';
import type { RunSummary } from '@water-management/engine';
import { buildWorkbook } from './workbook';
import { escapeCellText, XlsxWorkbook } from './writer';

/** The text Excel shows for a cell's `<v>` body: entities, then a single pass of `_xHHHH_`. */
const excelText = (xml: string) =>
	xml
		.replace(/&(lt|gt|amp|apos|quot);/g, (_, e: string) => ({ lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' })[e]!)
		.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** Characters XML 1.0 forbids anywhere in a document. */
const NOT_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u;
/** A formula trigger at the start of a text cell (OWASP CSV injection). */
const TRIGGER = /^[=+\-@\t\r]/;

/** The zip's parts by name, as text. */
function partsOf(bytes: Uint8Array): Map<string, string> {
	const cfb = XLSX.CFB.read(bytes, { type: 'array' });
	const out = new Map<string, string>();
	cfb.FullPaths.forEach((p: string, i: number) => {
		const f = cfb.FileIndex[i];
		if (f.type === 2 && f.content?.length) out.set(p.slice(cfb.FullPaths[0].length), new TextDecoder().decode(f.content));
	});
	return out;
}

/** Every text cell of every sheet as Excel reads it. */
function textCells(parts: Map<string, string>): string[] {
	const out: string[] = [];
	for (const [name, xml] of parts) {
		if (!name.startsWith('xl/worksheets/')) continue;
		for (const m of xml.matchAll(/<c r="[A-Z]+\d+"([^>]*)><v[^>]*>([\s\S]*?)<\/v><\/c>/g)) if (m[1]!.includes('t="str"')) out.push(excelText(m[2]!));
	}
	return out;
}

/** Synthetic text a person could type into a name, label or note. */
const TEXTS = [
	'Plain farm, "north"',
	'Élandsbaai dam — m³ 🌊',
	'_x0041_',
	'_x003D_HYPERLINK("http://example.invalid")',
	'already _x005F_ escaped',
	'_X0041_ upper',
	'_x12_ short',
	'a <b> & c \'d\' "e" ]]>',
	'bell\u0007 nul\u0000 esc\u001b',
	'line\nbreak\ttab',
	' lead and trail '
];

describe('xlsx cell text', () => {
	it('round-trips any text exactly as Excel reads it', async () => {
		const book = new XlsxWorkbook();
		book.addRows('Text', TEXTS.map((v) => [{ t: 's' as const, v }]), 0, []);
		const parts = partsOf(await book.bytes());
		expect(textCells(parts)).toEqual(TEXTS);
		for (const [name, xml] of parts) expect(NOT_XML.test(xml), name).toBe(false);
	});

	it('escapes only an underscore that starts an escape, and leaves ordinary text as SheetJS wrote it', () => {
		expect(escapeCellText('_x0041_')).toBe('_x005F_x0041_');
		expect(escapeCellText('a_b _x12_ _xZZZZ_')).toBe('a_b _x12_ _xZZZZ_');
		expect(escapeCellText('bell\u0007')).toBe('bell_x0007_');
		expect(escapeCellText('Plain farm, "north"')).toBe('Plain farm, &quot;north&quot;');
	});

	it('never lets a name open as a formula, even spelled with _xHHHH_ escapes', async () => {
		// Each name leads a cell somewhere: a farm's EWR grid row, the Inputs
		// table, a daily sheet's column header, a summary CSV row (which the
		// backend has already defused, export/csv.ts textCell).
		const evil = ['=cmd', '_x003D_cmd', '_x002B_SUM(1)', '_x0040_A1', '_x002D_2', '_x0009_tab'];
		const csv = ['Project,Synthetic', '', 'Farm summary', 'Farm,Average supplied (m³/day)', ...evil.map((e, i) => `${TRIGGER.test(e) ? `'${e}` : e},${i}`), ''].join('\r\n');
		const summary = {
			farms: [],
			warnings: [],
			ewrCompliance: {
				waterYears: [2021],
				days: [[31, 30, 31, 31, 28, 31, 30, 31, 30, 31, 31, 30]],
				outlet: { nodeId: null, name: 'Outlet', daysNotMet: [new Array(12).fill(0)], shortfallM3: [new Array(12).fill(0)] },
				farms: evil.map((name, i) => ({ nodeId: `f${i}`, name, daysNotMet: [new Array(12).fill(0)], shortfallM3: [new Array(12).fill(0)] }))
			}
		} as unknown as RunSummary;
		const bytes = await buildWorkbook({
			summaryCsv: csv,
			summary,
			settings: { note: evil[1] },
			model: { nodes: evil.map((name, i) => ({ id: `f${i}`, name })) },
			catchment: null,
			nodes: [{ name: 'Farm', startDate: '2021-10-01', columns: evil.map((e) => ({ header: `${e} (mm)`, unit: 'mm', values: [1] })) }]
		});
		const parts = partsOf(bytes);
		const cells = textCells(parts);
		// Positive control: every name reached the workbook as typed, the
		// formula-looking one apostrophe-first, the escaped-looking ones literal.
		for (const e of evil) {
			const shown = TRIGGER.test(e) ? `'${e}` : e;
			expect(cells.some((c) => c === shown || c.startsWith(`${shown} `)), e).toBe(true);
		}
		expect(cells.filter((c) => TRIGGER.test(c))).toEqual([]);
		// And no formula element anywhere: text is only ever a value.
		for (const [name, xml] of parts) expect(/<f[\s>]/.test(xml), name).toBe(false);
	});
});
