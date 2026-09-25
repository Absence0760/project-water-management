// The worksheet reader on its own: storage, the used range, and the refusals.
// Cell semantics against SheetJS are compared in ./readerParity.test.ts.
import { describe, expect, it } from 'vitest';
import { UnreadableWorkbookError } from './errors';
import { type SheetCells, SheetReader } from './sheet';
import { MAIN_NS, worksheet } from './testPackage';
import { defaultStyles } from './workbookParts';
import { scanXml } from './xml';

function read(xml: string): SheetCells {
	const reader = new SheetReader('sheet1.xml', defaultStyles(), false);
	scanXml(new TextEncoder().encode(xml), 'sheet1.xml', reader);
	return reader.finish();
}

describe('SheetReader', () => {
	it('stores numbers, strings, booleans and errors compactly and finds them by address', () => {
		const cells = read(
			worksheet('<row r="1"><c r="A1"><v>1.5</v></c><c r="B1" t="s"><v>3</v></c><c r="C1" t="b"><v>1</v></c><c r="D1" t="e"><v>#N/A</v></c><c r="E1" t="str"><v>x</v></c></row>')
		);
		expect(cells.size).toBe(5);
		expect(cells.cell(1, 1)).toEqual({ t: 'n', v: 1.5, z: 'General' });
		expect(cells.cell(3, 1)).toEqual({ t: 'b', v: true });
		expect(cells.cell(4, 1)).toEqual({ t: 'e', v: 0x2a });
		expect(cells.cell(5, 1)).toEqual({ t: 's', v: 'x' });
		expect(cells.sharedIndices()).toEqual([3]);
		cells.sharedStrings = (i) => (i === 3 ? 'three' : undefined);
		expect(cells.cell(2, 1)).toEqual({ t: 's', v: 'three' });
		expect(cells.cell(6, 1)).toBeUndefined();
		expect([...cells.addresses()]).toEqual([
			[1, 1],
			[2, 1],
			[3, 1],
			[4, 1],
			[5, 1]
		]);
	});

	it('sorts cells listed out of order, a later duplicate winning', () => {
		const cells = read(worksheet('<row r="3"><c r="B3"><v>1</v></c><c r="A3"><v>2</v></c></row><row r="1"><c r="A1"><v>3</v></c></row><row r="3"><c r="B3"><v>4</v></c></row>'));
		expect([...cells.addresses()]).toEqual([
			[1, 1],
			[1, 3],
			[2, 3]
		]);
		expect(cells.cell(2, 3)?.v).toBe(4);
	});

	it('keeps a large sheet in typed arrays', () => {
		const rows = Array.from({ length: 20_000 }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}"><v>${r}</v></c><c r="B${r + 1}"><v>${r / 2}</v></c></row>`);
		const cells = read(worksheet(rows.join('')));
		expect(cells.size).toBe(40_000);
		expect(cells.cell(2, 20_000)?.v).toBe(19_999 / 2);
		expect(cells.lastRow).toBe(20_000);
	});

	it('drops cells whose address is off the grid (no column letters, row 0)', () => {
		const cells = read(worksheet('<row r="1"><c r="a1"><v>1</v></c><c r="A0"><v>2</v></c><c r="B1"><v>3</v></c></row>'));
		expect([...cells.addresses()]).toEqual([[2, 1]]);
	});

	it('takes the used range from <dimension>, else from the rows and columns seen', () => {
		expect(read(worksheet('<row r="2"><c r="A2"><v>1</v></c></row>', '<dimension ref="A1:D40"/>')).lastRow).toBe(40);
		expect(read(worksheet('<row r="2"><c r="A2"><v>1</v></c></row>', '<dimension ref="D4:A1"/>')).lastRow).toBe(2); // not a valid range
		expect(read(worksheet('<row r="7"><c r="A7"><v>1</v></c></row>', '<dimension ref="A1"/>')).lastRow).toBe(7); // a single cell is ignored, as in SheetJS
		expect(read(`<worksheet xmlns="${MAIN_NS}"><dimension ref="A1:C9"/><sheetData/></worksheet>`).lastRow).toBe(9);
		expect(read(`<worksheet xmlns="${MAIN_NS}"><sheetData/></worksheet>`).lastRow).toBe(0);
		expect(read(worksheet('<row r="5"/>')).lastRow).toBe(0); // a row with no cells has no column
	});

	it('refuses a cell value with markup in it, one longer than Excel allows, and a date cell without a value', () => {
		const refuse = (xml: string) => expect(() => read(xml)).toThrow(UnreadableWorkbookError);
		refuse(worksheet('<row r="1"><c r="A1"><v>1<b/></v></c></row>'));
		refuse(worksheet(`<row r="1"><c r="A1" t="str"><v>${'x'.repeat((1 << 20) + 1)}</v></c></row>`));
		refuse(worksheet('<row r="1"><c r="A1" t="d"></c></row>'));
	});
});
