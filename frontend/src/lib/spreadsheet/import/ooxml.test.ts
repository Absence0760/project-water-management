import { describe, expect, it } from 'vitest';
import { CONTENT_TYPES_NAMESPACE, decodeXml, packageParts, relTargets, relsPathOf, resolveTarget } from './ooxml';

describe('packageParts', () => {
	it('finds the workbook, shared strings, styles and the namespace', () => {
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
		expect(packageParts(ct)).toEqual({
			workbook: 'xl/workbook.xml',
			binary: false,
			strings: ['xl/sharedStrings.xml'],
			support: ['xl/styles.xml', 'xl/metadata.xml'],
			styles: 'xl/styles.xml',
			namespace: CONTENT_TYPES_NAMESPACE
		});
	});

	it('reads a prefixed <Types> namespace, and none when it is missing', () => {
		expect(packageParts(`<ct:Types xmlns:ct="${CONTENT_TYPES_NAMESPACE}"/>`).namespace).toBe(CONTENT_TYPES_NAMESPACE);
		expect(packageParts('<Types/>').namespace).toBeNull();
		expect(packageParts('<Types xmlns="urn:other"/>').namespace).toBe('urn:other');
	});

	it('flags a binary .xlsb workbook', () => {
		const ct = '<Types><Override PartName="/xl/workbook.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>';
		expect(packageParts(ct)).toMatchObject({ workbook: null, binary: true });
	});
});

describe('relTargets', () => {
	it('maps relationship ids to parts, resolved against the workbook, external targets left out', () => {
		const rels = `<Relationships>
			<Relationship Id="rId1" Type="…/worksheet" Target="worksheets/sheet1.xml"/>
			<Relationship Id="rId2" Type="…/worksheet" Target="/xl/worksheets/sheet2.xml"/>
			<Relationship Id="rId3" Type="…/hyperlink" Target="https://example.com" TargetMode="External"/>
		</Relationships>`;
		expect([...relTargets('xl/workbook.xml', rels)]).toEqual([
			['rId1', 'xl/worksheets/sheet1.xml'],
			['rId2', 'xl/worksheets/sheet2.xml']
		]);
	});

	it('accepts any namespace prefix on the elements', () => {
		const rels = '<pr:Relationships><pr:Relationship Id="r1" Target="../xl/worksheets/a.xml"/></pr:Relationships>';
		expect([...relTargets('xl/workbook.xml', rels)]).toEqual([['r1', 'xl/worksheets/a.xml']]);
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
