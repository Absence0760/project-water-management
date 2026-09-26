// Cell text decoded as openpyxl decodes it (issue #22). The Python importer
// (scripts/wbt-import/extract_project.py) is the reference the port matches,
// and it reads cells through openpyxl, so the streaming reader must give the
// same strings. scripts/wbt-import/make_string_decoding_fixture.py writes a
// small hand-made workbook of every decoding case (invented text) and commits
// what openpyxl reads from it; this reads the same workbook and compares.
//
// SheetJS, the reader this one replaced, decoded some of those cases
// differently. The second test lists exactly which cells, so any other
// difference from SheetJS is still caught (./readerParity.test.ts compares the
// rest cell for cell).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cellAddress, type Cell } from './cells';
import { explainedByDecoding, readWorkbookWithSheetJS } from './sheetjsReference';
import { B023Workbook, readWorkbook } from './workbook';

const FIXTURES = new URL('../../../../../scripts/wbt-import/fixtures/', import.meta.url);
const WORKBOOK = new Uint8Array(readFileSync(new URL('string_decoding.xlsx', FIXTURES)));
const OPENPYXL: Record<string, string | number> = JSON.parse(readFileSync(new URL('string_decoding.cells.json', FIXTURES), 'utf8'));
const SHEET = 'Strings';

/** Every stored cell of the fixture sheet, by address. */
async function cells(source: Awaited<ReturnType<typeof readWorkbook>>): Promise<Map<string, Cell>> {
	const book = new B023Workbook(source);
	const out = new Map<string, Cell>();
	for (const [col, row] of source.sheet(SHEET)!.addresses()) out.set(cellAddress(col, row), book.cell(SHEET, col, row));
	return out;
}

/** The cells whose SheetJS reading differs, and why (the comments in the generator say the same). */
const DIFFERENT_FROM_SHEETJS: Record<string, string> = {
	A2: '_xHHHH_ escapes kept as written in a shared string',
	A5: 'a CR written as &#13; stays a CR (SheetJS turned CRLF into LF after decoding)',
	A6: 'a lone literal CR becomes LF, as an XML parser normalises it',
	A7: 'references beyond U+FFFF are one character (SheetJS truncated them to 16 bits)',
	A8: '_xHHHH_ kept in a rich-text run',
	A10: '"x005F_" dropped from a shared string, as openpyxl does',
	A11: 'an upper-case _X000D_ is text (SheetJS matched it case-insensitively)',
	B2: "a formula's cached text is decoded once (SheetJS decoded it twice)",
	B3: "_xHHHH_ kept in a formula's cached text",
	B4: "a formula's cached text is decoded once",
	B5: "a CR written as &#13; stays a CR in a formula's cached text",
	B6: "a reference beyond U+FFFF in a formula's cached text (SheetJS garbled it: see below)",
	C1: '_xHHHH_ kept in an inline string',
	C2: '_xHHHH_ kept in an inline rich-text run'
};

describe('cell text decoded as openpyxl decodes it (issue #22)', () => {
	it('reads every cell of the fixture exactly as openpyxl does', async () => {
		const streamed = await cells(await readWorkbook(WORKBOOK));
		expect([...streamed.keys()].sort()).toEqual(Object.keys(OPENPYXL).sort());
		for (const [address, value] of Object.entries(OPENPYXL)) expect(streamed.get(address), address).toStrictEqual(value);
		// The two cases the issue names, spelled out.
		expect(streamed.get('A2')).toBe('Flow_x000D__x000A_(m3/day)');
		expect(streamed.get('B2')).toBe('Alpha &amp; Bravo');
	});

	it('differs from the SheetJS reader in exactly the listed cells, each only in its decoding', async () => {
		const streamed = await cells(await readWorkbook(WORKBOOK));
		const sheetjs = await cells((await readWorkbookWithSheetJS(WORKBOOK)).source);
		expect([...sheetjs.keys()].sort()).toEqual([...streamed.keys()].sort());
		const differing = [...streamed.keys()].filter((a) => !Object.is(streamed.get(a), sheetjs.get(a)));
		expect(differing.sort()).toEqual(Object.keys(DIFFERENT_FROM_SHEETJS).sort());
		// B6 aside: SheetJS decoded a formula's text before its UTF-8, so a non-ASCII reference there came
		// out as garbage, which no folding can match (Excel writes such characters as UTF-8, not references).
		for (const a of differing) expect(explainedByDecoding(sheetjs.get(a)!, streamed.get(a)!), a).toBe(a !== 'B6');
		// The tolerance is no wider than decoding: a different string or type is still a difference.
		expect(explainedByDecoding('Alpha', 'Bravo')).toBe(false);
		expect(explainedByDecoding('12', 12)).toBe(false);
	});
});
