import { describe, expect, it } from 'vitest';
import { UnreadableWorkbookError } from './errors';
import { MAIN_NS } from './testPackage';
import { readStyles, readWorkbookXml } from './workbookParts';

const enc = new TextEncoder();
const wb = (body: string, root = `<workbook xmlns="${MAIN_NS}" xmlns:r="urn:r">`, end = '</workbook>') => readWorkbookXml(enc.encode(`${root}${body}${end}`), 'xl/workbook.xml');

describe('readWorkbookXml', () => {
	it('reads the sheets in order, names decoded, with their relationship ids', () => {
		const out = wb('<sheets><sheet name="Farm &amp; dam" sheetId="1" r:id="rId2"/><sheet sheetId="2" name="It&apos;s &lt;b&gt; _x0041_" r:id="rId1"/><sheet name="Gone" sheetId="3"/></sheets>');
		expect(out.sheets).toEqual([
			{ name: 'Farm & dam', rid: 'rId2' },
			{ name: "It's <b> A", rid: 'rId1' },
			{ name: 'Gone', rid: undefined }
		]);
	});

	it('reads defined names as SheetJS did: the name as written, the reference decoded, sheet scope from localSheetId', () => {
		const out = wb(
			'<definedNames><definedName name="zA">\'It&apos;s\'!$A$1</definedName><definedName name="zLocal" localSheetId="0">S!$B$2</definedName>' +
				'<definedName name="z&amp;raw" localSheetId="">S!$C$3</definedName><definedName name="zSelf"/><definedName name="zC"><![CDATA[S!$D$4]]></definedName></definedNames>'
		);
		expect(out.names).toEqual([
			{ name: 'zA', ref: "'It's'!$A$1", local: false },
			{ name: 'zLocal', ref: 'S!$B$2', local: true },
			{ name: 'z&amp;raw', ref: 'S!$C$3', local: false },
			{ name: 'zC', ref: 'S!$D$4', local: false }
		]);
	});

	it('reads the 1904 date system', () => {
		expect(wb('<workbookPr date1904="1"/>').date1904).toBe(true);
		expect(wb('<workbookPr date1904="false"/>').date1904).toBe(false);
		expect(wb('<workbookPr/>').date1904).toBe(false);
	});

	it('accepts the SpreadsheetML namespaces under any prefix, and refuses others', () => {
		expect(wb('', `<x:workbook xmlns:x="${MAIN_NS}">`, '</x:workbook>').sheets).toEqual([]);
		expect(wb('', '<workbook xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main">').sheets).toEqual([]);
		for (const root of ['<workbook>', '<workbook xmlns="urn:other">', `<x:workbook xmlns="${MAIN_NS}" xmlns:x="urn:other">`]) {
			expect(() => wb('', root, root.startsWith('<x:') ? '</x:workbook>' : '</workbook>')).toThrow(UnreadableWorkbookError);
		}
	});

	it('refuses a sheet or defined name without a name, and markup inside a defined name', () => {
		expect(() => wb('<sheets><sheet sheetId="1"/></sheets>')).toThrow(UnreadableWorkbookError);
		expect(() => wb('<definedNames><definedName>S!$A$1</definedName></definedNames>')).toThrow(UnreadableWorkbookError);
		expect(() => wb('<definedNames><definedName name="z">S!<b/>$A$1</definedName></definedNames>')).toThrow(UnreadableWorkbookError);
	});
});

describe('readStyles', () => {
	const styles = (body: string) => readStyles(enc.encode(`<styleSheet xmlns="${MAIN_NS}">${body}</styleSheet>`), 'xl/styles.xml');

	it("gives each cell style its number format, built-in or the workbook's own", () => {
		const s = styles(
			'<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy/mm/dd;@"/><numFmt numFmtId="14" formatCode="dd&quot;/&quot;mm"/></numFmts>' +
				'<cellStyleXfs count="1"><xf numFmtId="22"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="4"/><xf/></cellXfs>'
		);
		expect([s.format('0'), s.format('1'), s.format('2'), s.format('3'), s.format('4')]).toEqual(['General', 'yyyy/mm/dd;@', 'dd"/"mm', '#,##0.00', 'General']);
		// No s, an unknown style, or an s that isn't a plain index: General, as SheetJS read CellXf[s].
		expect([s.format(undefined), s.format('9'), s.format('01'), s.format(' 1')]).toEqual(['General', 'General', 'General', 'General']);
	});

	it('moves format ids past 0x188 into the free slots below, and applies the Google Sheets fix', () => {
		const s = styles('<numFmts><numFmt numFmtId="500" formatCode="0.000"/><numFmt numFmtId="170" formatCode="d.m"/></numFmts><cellXfs><xf numFmtId="500"/><xf numFmtId="170"/><xf numFmtId=""/><xf numFmtId="23"/></cellXfs>');
		expect([s.format('0'), s.format('1'), s.format('2'), s.format('3')]).toEqual(['0.000', 'd\\.m', undefined, undefined]);
	});

	it('reads everything as General without a <cellXfs>, and refuses a number format without a code', () => {
		expect(styles('<numFmts><numFmt numFmtId="164" formatCode="yyyy"/></numFmts>').format('1')).toBe('General');
		expect(() => styles('<numFmts><numFmt numFmtId="164"/></numFmts>')).toThrow(UnreadableWorkbookError);
	});

	it('caches one index per distinct style', () => {
		const s = styles('<cellXfs><xf numFmtId="14"/><xf numFmtId="14"/><xf numFmtId="0"/></cellXfs>');
		expect(s.zIndex('0')).toBe(s.zIndex('1'));
		expect(s.formats[s.zIndex('2')]).toBe('General');
	});
});
