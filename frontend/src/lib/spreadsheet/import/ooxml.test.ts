import { describe, expect, it } from 'vitest';
import { decodeXml, packageParts, relsPathOf, resolveTarget, sheetParts } from './ooxml';

describe('packageParts', () => {
	it('finds the workbook, shared strings and the parts SheetJS insists on', () => {
		const ct = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
			<Default Extension="xml" ContentType="application/xml"/>
			<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>
			<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
			<Override PartName='/xl/sharedStrings.xml' ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'/>
			<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
			<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>
			<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>
			<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>
		</Types>`;
		expect(packageParts(ct)).toEqual({ workbook: 'xl/workbook.xml', binary: false, strings: ['xl/sharedStrings.xml'], support: ['xl/styles.xml', 'xl/metadata.xml'] });
	});

	it('flags a binary .xlsb workbook', () => {
		const ct = '<Types><Override PartName="/xl/workbook.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>';
		expect(packageParts(ct)).toMatchObject({ workbook: null, binary: true });
	});
});

describe('sheetParts', () => {
	it('maps sheet names to parts through the relationships, entities decoded', () => {
		const wb = `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>
			<sheet name="Farm &amp; dam" sheetId="1" r:id="rId2"/>
			<sheet sheetId="2" name="It&apos;s &lt;b&gt;" r:id="rId1"/>
			<sheet name="Gone" sheetId="3" r:id="rId9"/>
		</sheets></workbook>`;
		const rels = `<Relationships>
			<Relationship Id="rId1" Type="…/worksheet" Target="worksheets/sheet1.xml"/>
			<Relationship Id="rId2" Type="…/worksheet" Target="/xl/worksheets/sheet2.xml"/>
			<Relationship Id="rId3" Type="…/hyperlink" Target="https://example.com" TargetMode="External"/>
		</Relationships>`;
		const { names, parts } = sheetParts('xl/workbook.xml', wb, rels);
		expect(names).toEqual(['Farm & dam', "It's <b>", 'Gone']);
		expect([...parts]).toEqual([
			['Farm & dam', 'xl/worksheets/sheet2.xml'],
			["It's <b>", 'xl/worksheets/sheet1.xml']
		]);
	});

	it('accepts any namespace prefix on the elements and the relationship id', () => {
		const wb = '<x:workbook><x:sheets><x:sheet name="A" sheetId="1" rel:id="r1"/></x:sheets></x:workbook>';
		const rels = '<pr:Relationships><pr:Relationship Id="r1" Target="../xl/worksheets/a.xml"/></pr:Relationships>';
		expect([...sheetParts('xl/workbook.xml', wb, rels).parts]).toEqual([['A', 'xl/worksheets/a.xml']]);
	});
});

describe('paths and entities', () => {
	it('derives the relationships part and resolves targets', () => {
		expect(relsPathOf('xl/workbook.xml')).toBe('xl/_rels/workbook.xml.rels');
		expect(resolveTarget('xl/workbook.xml', 'worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
		expect(resolveTarget('xl/workbook.xml', '/xl/worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
		expect(resolveTarget('xl/workbook.xml', './../../../etc/x.xml')).toBe('etc/x.xml');
	});

	it('decodes numeric and named entities and leaves bad ones alone', () => {
		expect(decodeXml('&#65;&#x42;&amp;&quot;&unknown;&#x110000;')).toBe('AB&"&unknown;&#x110000;');
	});
});
