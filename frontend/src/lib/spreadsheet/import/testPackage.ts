// Test support: a workbook package written by hand, part by part, for the
// reader tests that need XML no spreadsheet program would write (edge cases
// and hostile input). Invented values only. Not imported by app code.
import { crc32 } from '../export/zip';
import { storedZip } from './zip';

export const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export interface PackageSpec {
	/** Sheet name → worksheet XML (the whole part). */
	sheets: [string, string][];
	/** Extra workbook.xml children before <sheets> (e.g. a workbookPr). */
	workbookPr?: string;
	/** definedName elements; a zAppVer on the first sheet is added so readWorkbook() parses it. */
	names?: string;
	sharedStrings?: string;
	styles?: string;
	/** Replace the workbook part entirely. */
	workbook?: string;
	/** Replace [Content_Types].xml. */
	contentTypes?: string;
	/** Leave these parts out of the zip. */
	omit?: string[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** A worksheet part around the given <sheetData> content (and anything before it). */
export function worksheet(sheetData: string, before = ''): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">${before}<sheetData>${sheetData}</sheetData></worksheet>`;
}

/** The package's bytes, as a stored zip. */
export function workbookPackage(spec: PackageSpec): Uint8Array<ArrayBuffer> {
	const enc = new TextEncoder();
	const parts: [string, string][] = [];
	const overrides = [
		`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`,
		...spec.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
		...(spec.sharedStrings !== undefined ? ['<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'] : []),
		...(spec.styles !== undefined ? ['<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'] : [])
	];
	parts.push([
		'[Content_Types].xml',
		spec.contentTypes ??
			`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join('')}</Types>`
	]);
	parts.push([
		'_rels/.rels',
		`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
	]);
	const first = spec.sheets[0]?.[0] ?? 'Sheet1';
	const quoted = `'${first.replace(/'/g, "''")}'`;
	parts.push([
		'xl/workbook.xml',
		spec.workbook ??
			`<?xml version="1.0"?><workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">${spec.workbookPr ?? ''}<sheets>${spec.sheets
				.map(([name], i) => `<sheet name="${esc(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
				.join('')}</sheets><definedNames><definedName name="zAppVer">${esc(quoted)}!$A$1</definedName>${spec.names ?? ''}</definedNames></workbook>`
	]);
	parts.push([
		'xl/_rels/workbook.xml.rels',
		`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${spec.sheets
			.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
			.join('')}<Relationship Id="rS" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rY" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`
	]);
	spec.sheets.forEach(([, xml], i) => parts.push([`xl/worksheets/sheet${i + 1}.xml`, xml]));
	if (spec.sharedStrings !== undefined) parts.push(['xl/sharedStrings.xml', spec.sharedStrings]);
	if (spec.styles !== undefined) parts.push(['xl/styles.xml', spec.styles]);
	return storedZip(
		parts
			.filter(([name]) => !spec.omit?.includes(name))
			.map(([name, text]) => {
				const data = enc.encode(text);
				return { name, data, crc: crc32(data) };
			})
	);
}
