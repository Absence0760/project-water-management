// The writer's formula cells (the audit workbook's, issue #68; SheetJS's
// export never wrote any, so workbook.test.ts's byte comparison can't pin
// them): the formula escaped, its last value only when finite, and Excel told
// to recompute on open only when a formula was written. Read back with the
// import side's zip reader.
import { describe, expect, it } from 'vitest';
import { ZipArchive } from '../import/zip';
import { XlsxWorkbook } from './writer';

const part = async (book: XlsxWorkbook, name: string) => new TextDecoder().decode(await (await ZipArchive.open(await book.bytes())).read(name));

describe('XlsxWorkbook formula cells', () => {
	it('writes a row formula escaped, with its value, and asks for a recalculation on open', async () => {
		const book = new XlsxWorkbook();
		book.addRows('A', [[{ t: 's', v: 'x' }, { t: 'f', f: 'IF(B1<2,"a&b",1)', v: 1.5, z: '0.00' }]], 1, []);
		const sheet = await part(book, 'xl/worksheets/sheet1.xml');
		expect(sheet).toMatch(/<c r="B1" s="\d+"><f>IF\(B1&lt;2,&quot;a&amp;b&quot;,1\)<\/f><v>1.5<\/v><\/c>/);
		expect(await part(book, 'xl/workbook.xml')).toContain('</sheets><calcPr fullCalcOnLoad="1"/></workbook>');
	});

	it('leaves the value out when it is not finite, and a daily formula column per row', async () => {
		const book = new XlsxWorkbook();
		book.addDaily('D', ['date', 'x', 'y'], 'yyyy-mm-dd', 25569, [{ format: undefined, values: [1, 2] }, { format: undefined, values: [NaN, 4], formula: (r) => `B${r}*2` }], [11, 14, 14]);
		const sheet = await part(book, 'xl/worksheets/sheet1.xml');
		expect(sheet).toContain('<c r="C2"><f>B2*2</f></c>');
		expect(sheet).toContain('<c r="C3"><f>B3*2</f><v>4</v></c>');
		expect(await part(book, 'xl/workbook.xml')).toContain('<calcPr fullCalcOnLoad="1"/>');
	});

	it('sets no recalculation flag without a formula written: no formula column, or one with no days', async () => {
		const plain = new XlsxWorkbook();
		plain.addRows('A', [[{ t: 'n', v: 1 }]], 0, []);
		expect(await part(plain, 'xl/workbook.xml')).not.toContain('calcPr');
		const empty = new XlsxWorkbook();
		empty.addDaily('D', ['date', 'y'], 'yyyy-mm-dd', 25569, [{ format: undefined, values: [], formula: () => 'A1' }], [11, 14]);
		expect(await part(empty, 'xl/workbook.xml')).not.toContain('calcPr');
	});
});
