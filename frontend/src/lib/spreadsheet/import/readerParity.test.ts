// The streaming reader (readWorkbook) against the SheetJS reader it replaced
// (./sheetjsReference.ts), cell by cell as the parser reads them: on the
// committed synthetic b023 workbook, on workbooks SheetJS itself writes, and
// on hand-written packages full of the cell kinds and XML shapes a real file
// can hold. The local source-workbook suite runs the same comparison on the
// client workbooks (./sourceWorkbooks.test.ts).
//
// Cell text is decoded as openpyxl decodes it, not as SheetJS did (issue #22):
// _xHHHH_ escapes, a formula's cached text, CRs written as references, lone
// literal CRs, references beyond U+FFFF and "x005F_" in shared strings read
// differently. The strings here avoid those; ./stringDecoding.test.ts pins
// each one to openpyxl's committed output and lists exactly which cells differ
// from SheetJS.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { XlDateTime, XlDuration } from './cells';
import { readWorkbookWithSheetJS, readerDifference } from './sheetjsReference';
import { MAIN_NS, workbookPackage, worksheet } from './testPackage';
import { syntheticB023 } from './testWorkbook';
import { B023Workbook, readWorkbook } from './workbook';

const FIXTURE = new URL('../../../../../scripts/wbt-import/fixtures/synthetic_b023.xlsx', import.meta.url);

async function compare(bytes: Uint8Array | ArrayBuffer) {
	const file = new Uint8Array(bytes);
	const reference = await readWorkbookWithSheetJS(file);
	const streamed = await readWorkbook(file);
	return { difference: readerDifference(reference.source, streamed), reference: new B023Workbook(reference.source), streamed: new B023Workbook(streamed) };
}

const SST = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${MAIN_NS}" count="13" uniqueCount="13">
<si><t>b022</t></si>
<si><t xml:space="preserve">  two  spaces </t></si>
<si><t>a &amp; b &lt;c&gt; &quot;q&quot; &apos;s&apos; &#65;&#x42; &#233;</t></si>
<si><t>line1&#10;line2\r\nline3
line4</t></si>
<si><r><rPr><b/><sz val="11"/></rPr><t>Bold</t></r><r><t xml:space="preserve"> and plain</t></r></si>
<si><r><t>Ru</t></r><rPh sb="0" eb="1"><t>phonetic</t></rPh><phoneticPr fontId="1"/></si>
<si><t>Plain</t><rPh sb="0" eb="1"><t>ph</t></rPh></si>
<si><t><![CDATA[<cdata> & raw]]></t></si>
<si><r><t><![CDATA[skipped]]></t></r><r><t>kept</t></r></si>
<si><t>Ünïcödé — 水 😀</t></si>
<si><t></t></si>
<si><phoneticPr fontId="1"/></si>
<si><t>never referenced</t></si>
</sst>`;

const STYLES = `<?xml version="1.0"?><styleSheet xmlns="${MAIN_NS}">
<numFmts count="4"><numFmt numFmtId="164" formatCode="yyyy/mm/dd;@"/><numFmt numFmtId="165" formatCode="[h]:mm"/><numFmt numFmtId="500" formatCode="0.000"/><numFmt numFmtId="166" formatCode="&quot;Day&quot; d"/></numFmts>
<fonts count="1"><font><sz val="11"/></font></fonts>
<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>
<cellXfs count="7"><xf numFmtId="0" fontId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="500"/><xf numFmtId="166"><alignment horizontal="left"/></xf><xf/></cellXfs>
</styleSheet>`;

const c = (ref: string, attrs: string, body = '') => `<c r="${ref}"${attrs}>${body}</c>`;

const EDGE = worksheet(
	[
		`<row r="1" spans="1:12">${c('A1', ' t="s"', '<v>0</v>')}</row>`,
		`<row r="2">${[
			c('B2', ' s="1"', '<v>40179</v>'),
			c('C2', ' s="2"', '<v>40179.5</v>'),
			c('D2', ' s="3"', '<v>1.25</v>'),
			c('E2', ' s="4"', '<v>3.14159</v>'),
			c('F2', ' s="5"', '<v>40180</v>'),
			c('G2', ' s="6"', '<v>7</v>'),
			c('H2', ' s="01"', '<v>40179</v>'),
			c('I2', ' s="99"', '<v>40179</v>'),
			c('J2', ' s=" 1"', '<v>40179</v>')
		].join('')}</row>`,
		`<row r="3">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '13'].map((v, i) => c(`${'ABCDEFGHIJKL'[i]}3`, ' t="s"', `<v>${v}</v>`)).join('')}</row>`,
		`<row r="4">${[
			c('A4', ' t="str"', '<f>X</f><v>a &gt; b</v>'),
			c('B4', ' t="str"', '<f>Y</f>'),
			c('C4', ' t="inlineStr"', '<is><t>inline &amp; text</t></is>'),
			c('D4', ' t="inlineStr"', '<is><r><t>in</t></r><r><rPr><i/></rPr><t>line</t></r></is>'),
			c('E4', ' t="inlineStr"', '<is/>'),
			c('F4', ' t="inlineStr"', ''),
			c('G4', ' t="str"', '<v>line1&#10;line2\r\nline3</v>')
		].join('')}</row>`,
		`<row r="5">${[c('A5', ' t="b"', '<v>1</v>'), c('B5', ' t="b"', '<v>0</v>'), c('C5', ' t="b"', '<v>true</v>'), c('D5', ' t="b"', '<v>TRUE</v>'), c('E5', ' t="b"', '')].join('')}</row>`,
		`<row r="6">${['#N/A', '#DIV/0!', '#REF!', '#NAME?', '#NUM!', '#NULL!', '#VALUE!', '#GETTING_DATA', '#WTF?', '#SPILL!']
			.map((v, i) => c(`${'ABCDEFGHIJ'[i]}6`, ' t="e"', `<v>${v}</v>`))
			.join('')}${c('K6', ' t="e"', '')}</row>`,
		`<row r="7">${[
			c('A7', '', '<v>1e-5</v>'),
			c('B7', '', '<v> 12 </v>'),
			c('C7', '', '<v>abc</v>'),
			c('D7', '', '<v>-0</v>'),
			c('E7', '', '<v>1.5E+308</v>'),
			c('F7', '', '<v></v>'),
			c('G7', '', '<v/>'),
			c('H7', '', '<f>1+1</f>'),
			c('I7', ' t="n"', ''),
			c('J7', '', '<v>&#49;&#50;</v>'),
			c('K7', '', '<v><![CDATA[42]]></v>'),
			c('L7', ' t=""', '<v>9</v>')
		].join('')}</row>`,
		`<row r="8">${[c('A8', ' t="d" s="2"', '<v>2010-01-05</v>'), c('B8', ' t="d"', '<v>2010-01-05T12:00:00</v>'), c('C8', ' t="d" s="3"', '<v>12:30</v>')].join('')}</row>`,
		`<row r="11">${c('A11', ' t="x"', '<v>5</v>')}${c('B11', '', '<v>1</v>')}${c('B11', '', '<v>2</v>')}</row>`,
		`<row r="9">${c('A9', '', '<v>9</v>')}</row>`,
		'<row r="12"><c><v>1</v></c><c><v>2</v></c><c r="E12"><v>5</v></c><c s="2"><v>40179</v></c></row>',
		'<row><c r="A13"><v>13</v></c></row>',
		'<row><c><v>14</v></c></row>'
	].join('\n'),
	'<sheetPr><outlinePr summaryBelow="0"/></sheetPr><dimension ref="A1:L20"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols><col min="1" max="3" width="9"/></cols>'
);

const NO_DIM = worksheet('<row r="2"><c r="C2"><v>1</v></c></row><row r="3"/><row r="4"><c r="B4"><v>2</v></c></row><row r="8"/><row r="9"/>');
const SINGLE_DIM = worksheet('<row r="2"><c r="B2"><v>1</v></c><c r="D2"><v>3</v></c></row>', '<dimension ref="B2"/>');
const PREFIXED = `<?xml version="1.0"?><x:worksheet xmlns:x="${MAIN_NS}"><x:dimension ref="A1:B2"/><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>1</x:v></x:c><x:c r="B1" x:t="n"><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>`;
const BOM_CRLF = `﻿<?xml version='1.0'?>\r\n<worksheet xmlns='${MAIN_NS}'>\r\n<dimension ref='A1:A2'/>\r\n<sheetData>\r\n<row r='1'>\r\n<c r='A1' t='s'>\r\n<v>3</v>\r\n</c>\r\n</row>\r\n<row r='2'><c r='A2' t='str'><v>x\r\ny</v></c></row>\r\n</sheetData>\r\n<!-- a comment -->\r\n</worksheet>\r\n`;

function edgePackage(extra: { workbookPr?: string } = {}) {
	return workbookPackage({
		sheets: [
			['Edge', EDGE],
			['NoDim', NO_DIM],
			['SingleDim', SINGLE_DIM],
			['Prefixed', PREFIXED],
			['BOM', BOM_CRLF],
			["It's & <b>", worksheet('<row r="1"><c r="A1"><v>1</v></c></row>', '<dimension ref="A1"/>')],
			['Unread', worksheet('<row r="1"><c r="A1"><v>1</v></c></row>')]
		],
		names:
			"<definedName name=\"zNetwork_ElementNameLst\">NoDim!$A$1</definedName><definedName name=\"zNetwork_ElementTypeLst\">SingleDim!$A$1</definedName>" +
			'<definedName name="zNetwork_UpstreamTbl">Prefixed!$A$1:$B$2</definedName><definedName name="zNetwork_OutflowGauge">BOM!$A$1</definedName>' +
			"<definedName name=\"zFarmSpec_FarmNameLst\">'It&apos;s &amp; &lt;b&gt;'!$A$1</definedName>" +
			'<definedName name="zLocal" localSheetId="0">Edge!$B$2</definedName><definedName name="z&amp;raw" hidden="1">Edge!$C$2</definedName>' +
			'<definedName name="zAppVer">Edge!$A$1</definedName>',
		sharedStrings: SST,
		styles: STYLES,
		...extra
	});
}

describe('streaming reader parity with SheetJS', () => {
	it('reads the committed synthetic b023 workbook cell for cell', async () => {
		expect((await compare(new Uint8Array(readFileSync(FIXTURE)))).difference).toBeNull();
	});

	it('reads workbooks SheetJS writes (formula strings, no shared strings) cell for cell', async () => {
		expect((await compare(syntheticB023().toFile())).difference).toBeNull();
		const long = syntheticB023({ rain: Array.from({ length: 800 }, (_, i) => (i % 7) * 1.5) });
		expect((await compare(long.toFile())).difference).toBeNull();
	});

	it('reads every cell kind and XML shape the same', async () => {
		const { difference, streamed } = await compare(edgePackage());
		expect(difference).toBeNull();
		// Spot checks that the comparison covered what it claims to.
		expect(streamed.cell('Edge', 1, 4)).toBe('a > b');
		expect(streamed.cell('Edge', 7, 4)).toBe('line1\nline2\nline3');
		expect(streamed.cell('Edge', 3, 3)).toBe('line1\nline2\nline3\nline4');
		expect(streamed.cell('Edge', 1, 3)).toBe('  two  spaces ');
		expect(streamed.cell('Edge', 5, 3)).toBe('Ru');
		expect(streamed.cell('Edge', 12, 3)).toBe('');
		expect(streamed.cell('Edge', 3, 2)).toEqual(new XlDateTime('2010-01-01', 43_200_000));
		expect(streamed.cell('Edge', 4, 2)).toEqual(new XlDuration(1.25));
		expect(streamed.cell('Edge', 5, 2)).toBe(3.14159); // numFmtId 500, moved below 0x188: not a date
		expect(streamed.cell('Edge', 10, 6)).toBe('#UNKNOWN!');
		expect(Number.isNaN(streamed.cell('Edge', 3, 7))).toBe(true);
		expect(streamed.cell('Edge', 6, 7)).toBeNull();
		expect(streamed.cell('Edge', 2, 11)).toBe(2); // a later duplicate wins
		expect(streamed.cell('Edge', 1, 14)).toBe(14);
		expect(streamed.lastRow('Edge')).toBe(20);
		expect(streamed.lastRow('NoDim')).toBe(9);
		expect(streamed.lastRow('SingleDim')).toBe(2);
		expect(streamed.cell('BOM', 1, 2)).toBe('x\ny');
		expect(streamed.has('zLocal')).toBe(false);
		expect(streamed.sheetOf('zFarmSpec_FarmNameLst')).toBe("It's & <b>");
	});

	it('reads the 1904 date system the same', async () => {
		const { difference, streamed } = await compare(edgePackage({ workbookPr: '<workbookPr date1904="1"/>' }));
		expect(difference).toBeNull();
		expect(streamed.cell('Edge', 2, 2)).toEqual(new XlDateTime('2014-01-02', 0));
	});
});
