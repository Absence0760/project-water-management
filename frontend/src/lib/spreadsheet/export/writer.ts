// The .xlsx writer for the run export: the OOXML parts SheetJS CE 0.20.3
// wrote for this workbook, byte for byte, without shipping SheetJS (issue #9).
//
// The export only ever wrote two kinds of cell (text, and a number with an
// optional display format), column widths and nothing else, so the parts are
// few and their markup fixed: this module writes exactly what SheetJS's
// `XLSX.write(wb, { bookType: 'xlsx', compression: false })` wrote for them in
// a fresh worker, including its quirks (`t="str"` text cells, the
// `ignoredErrors` element, the theme and dynamic-array metadata parts, the
// number-format table's id 56), so a file Excel, LibreOffice and Google Sheets
// opened before opens the same way now. ./zip.ts packs the parts, in the order
// SheetJS's container listed them. workbook.test.ts pins the equivalence: it
// builds each test workbook both ways (./sheetjsReference.ts, test-only, the
// SheetJS path this replaced) and compares the zips byte for byte.
//
// SheetJS is still the tests' reader and reference; nothing the app loads
// imports it (the export worker was 88 KB gzip with it, ~7 KB without).
import { zip, type ZipEntry } from './zip';

/** A cell: text, or a finite number with an optional Excel number format code. */
export type XlsxCell = { t: 's'; v: string } | { t: 'n'; v: number; z?: string };

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_VT = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
const CT_OOXML = 'application/vnd.openxmlformats-officedocument';

// ── XML text, as SheetJS escapes and tags it ─────────────────────────────────

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' };

/** SheetJS's escapexml: the five entities, and control characters as `_xHHHH_`. */
export function escapeXml(text: string): string {
	return text
		.replace(/[&<>'"]/g, (c) => ENTITIES[c]!)
		.replace(/[\u0000-\u0008\u000b-\u001f￾-￿]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, '0')}_`);
}

/**
 * A text cell's value. Excel decodes `_xHHHH_` in cell text (ECMA-376
 * ST_Xstring), so a name typed as `_x003D_HYPERLINK(…)` would open as
 * `=HYPERLINK(…)`, past the leading-character defuse (./names.ts), and any
 * literal `_x0041_` would silently change. The spec's escape is to write the
 * underscore that starts such a sequence as `_x005F_`. SheetJS didn't; text
 * without the pattern is written exactly as it did (workbook.test.ts).
 */
export function escapeCellText(text: string): string {
	return escapeXml(text.replace(/_(?=x[0-9A-Fa-f]{4}_)/g, '_x005F_'));
}

/** SheetJS marks an element whose text starts or ends with whitespace, or holds a newline, as space-preserving. */
const PRESERVE = /(^\s|\s$|\n)/;
const space = (body: string) => (PRESERVE.test(body) ? ' xml:space="preserve"' : '');
const tag = (name: string, body: string) => `<${name}${space(body)}>${body}</${name}>`;

/** Column letters for a 0-based index: 0 → A, 26 → AA. */
export function colName(c: number): string {
	let s = '';
	for (let n = c + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(((n - 1) % 26) + 65) + s;
	return s;
}

/** The range from A1 to a 0-based last row and column, "A1" when that is A1 itself. */
export function rangeRef(lastRow: number, lastCol: number): string {
	const end = `${colName(lastCol)}${lastRow + 1}`;
	return end === 'A1' ? end : `A1:${end}`;
}

// ── Number formats and cell styles ───────────────────────────────────────────

/**
 * Excel's built-in number formats, as SheetJS's format table starts (56 is a
 * format SheetJS preloads, and so lists in every workbook's styles).
 */
const BUILTIN_FORMATS: [number, string][] = [
	[0, 'General'], [1, '0'], [2, '0.00'], [3, '#,##0'], [4, '#,##0.00'], [9, '0%'], [10, '0.00%'], [11, '0.00E+00'],
	[12, '# ?/?'], [13, '# ??/??'], [14, 'm/d/yy'], [15, 'd-mmm-yy'], [16, 'd-mmm'], [17, 'mmm-yy'], [18, 'h:mm AM/PM'],
	[19, 'h:mm:ss AM/PM'], [20, 'h:mm'], [21, 'h:mm:ss'], [22, 'm/d/yy h:mm'], [37, '#,##0 ;(#,##0)'],
	[38, '#,##0 ;[Red](#,##0)'], [39, '#,##0.00;(#,##0.00)'], [40, '#,##0.00;[Red](#,##0.00)'], [45, 'mm:ss'],
	[46, '[h]:mm:ss'], [47, 'mmss.0'], [48, '##0.0E+0'], [49, '@'], [56, '"上午/下午 "hh"時"mm"分"ss"秒 "']
];
/** Custom formats take the first free id from here, in the order cells first use them. */
const FIRST_CUSTOM_FORMAT = 60;
const FORMAT_ID_LIMIT = 392;

/**
 * The workbook's number formats and cell styles (xfs), assigned as SheetJS
 * assigns them while it writes the sheets in order: a format code gets its
 * built-in id or the next custom one, a style is one per format id, style 0
 * being General. So the style ids depend only on the order cells are written.
 */
class Styles {
	private readonly formats = new Map<string, number>(BUILTIN_FORMATS.map(([id, code]) => [code, id]));
	private readonly codes = new Map<number, string>(BUILTIN_FORMATS);
	private readonly xfs: number[] = [0];

	/** The style id of a cell with format `z` (General when absent). */
	of(z: string | undefined): number {
		const code = z ?? 'General';
		let id = this.formats.get(code);
		if (id === undefined) {
			id = FIRST_CUSTOM_FORMAT;
			while (this.codes.has(id)) id++;
			if (id >= FORMAT_ID_LIMIT) throw new Error('xlsx: too many number formats');
			this.formats.set(code, id);
			this.codes.set(id, code);
		}
		let s = this.xfs.indexOf(id);
		if (s < 0) s = this.xfs.push(id) - 1;
		return s;
	}

	/** xl/styles.xml. */
	xml(): string {
		const numFmts = [...this.codes]
			.filter(([id]) => (id >= 5 && id <= 8) || (id >= 23 && id <= 26) || (id >= 41 && id <= 44) || (id >= 50 && id <= FORMAT_ID_LIMIT))
			.sort((a, b) => a[0] - b[0])
			.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`);
		const xf = (id: number) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`;
		return (
			XML_HEADER +
			`<styleSheet xmlns="${NS_MAIN}" xmlns:vt="${NS_VT}">` +
			(numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>` : '') +
			'<fonts count="1"><font><sz val="12"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>' +
			'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
			'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
			'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
			`<cellXfs count="${this.xfs.length}">${this.xfs.map(xf).join('')}</cellXfs>` +
			'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
			'<dxfs count="0"/>' +
			'<tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleMedium4"/>' +
			'</styleSheet>'
		);
	}
}

// ── Sheets ───────────────────────────────────────────────────────────────────

/** Excel's column width for a width in characters (SheetJS's char2width at its default 6 px digit width). */
const colWidth = (chars: number) => Math.round(((chars * 6 + 5) / 6) * 256) / 256;

/** A text cell's longest length Excel accepts. */
const MAX_TEXT = 32767;

const enc = new TextEncoder();

/** A sheet's XML up to and including `<sheetData>`, and what follows the rows. */
function sheetShell(ref: string, widths: readonly number[]): [head: string, tail: string] {
	const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${colWidth(w)}" customWidth="1"/>`).join('')}</cols>` : '';
	return [
		XML_HEADER + `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><dimension ref="${ref}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>${cols}`,
		`<ignoredErrors><ignoredError numberStoredAsText="1" sqref="${ref}"/></ignoredErrors></worksheet>`
	];
}

/** One daily column: its values by day, missing days (or non-finite values) left empty. */
export interface XlsxDailyColumn {
	format: string | undefined;
	values: ArrayLike<number | null>;
}

/**
 * The workbook, built sheet by sheet. Sheets are written as they are added
 * (in order, so style ids come out as SheetJS numbered them), a daily sheet
 * straight into byte chunks: a client-size run is millions of cells, and a
 * string or an object per cell would not fit in a browser tab.
 */
export class XlsxWorkbook {
	private readonly styles = new Styles();
	private readonly names: string[] = [];
	private readonly sheets: Uint8Array[] = [];

	private addName(name: string): void {
		if (!name || name.length > 31 || /[\\/?*[\]:]/.test(name) || this.names.includes(name)) throw new Error(`xlsx: bad or repeated sheet name ${JSON.stringify(name)}`);
		this.names.push(name);
	}

	private cell(c: XlsxCell, ref: string): string {
		let attrs = ` r="${ref}"`;
		let v: string;
		if (c.t === 'n') {
			v = tag('v', String(c.v));
			const s = this.styles.of(c.z);
			if (s) attrs += ` s="${s}"`;
		} else {
			if (c.v.length > MAX_TEXT) throw new Error('Text length must not exceed 32767 characters');
			v = tag('v', escapeCellText(c.v));
			attrs += ' t="str"';
		}
		return `<c${attrs}${space(v)}>${v}</c>`;
	}

	private row(cells: readonly (XlsxCell | undefined)[], r: number): string {
		let body = '';
		cells.forEach((c, i) => {
			if (c) body += this.cell(c, `${colName(i)}${r}`);
		});
		return body ? `<row r="${r}"${space(body)}>${body}</row>` : '';
	}

	/** A sheet of rows (a missing cell is left empty); `lastCol` is the range's last column, 0-based. */
	addRows(name: string, rows: readonly (readonly (XlsxCell | undefined)[])[], lastCol: number, widths: readonly number[]): void {
		this.addName(name);
		const [head, tail] = sheetShell(rangeRef(Math.max(0, rows.length - 1), lastCol), widths);
		const body = rows.map((r, i) => this.row(r, i + 1)).join('');
		this.sheets.push(enc.encode(head + (body ? `<sheetData>${body}</sheetData>` : '<sheetData/>') + tail));
	}

	/**
	 * A daily sheet: a header row, then one row per day, the first column the
	 * day's Excel date serial (from `day0`) in `dateFormat`, then each
	 * column's value in its format.
	 */
	addDaily(name: string, header: readonly string[], dateFormat: string, day0: number, columns: readonly XlsxDailyColumn[], widths: readonly number[]): void {
		this.addName(name);
		const days = Math.max(0, ...columns.map((c) => c.values.length));
		const headerRow = this.row(header.map((v): XlsxCell => ({ t: 's', v })), 1);
		// Style ids in column order, as SheetJS met the formats: it was given the
		// header and, when there were days, one probe row of every column's format.
		const style = days === 0 ? [] : [dateFormat, ...columns.map((c) => c.format)].map((z) => {
			const s = this.styles.of(z);
			return s ? ` s="${s}"` : '';
		});
		const [head, tail] = sheetShell(rangeRef(days, columns.length), widths);
		const chunks: Uint8Array[] = [enc.encode(head + '<sheetData>' + headerRow)];
		const letters = columns.map((_, i) => colName(i + 1));
		let buf = '';
		for (let d = 0; d < days; d++) {
			const R = d + 2;
			buf += `<row r="${R}"><c r="A${R}"${style[0]}><v>${day0 + d}</v></c>`;
			for (let i = 0; i < columns.length; i++) {
				const v = columns[i]!.values[d];
				if (typeof v === 'number' && Number.isFinite(v)) buf += `<c r="${letters[i]}${R}"${style[i + 1]}><v>${v}</v></c>`;
			}
			buf += '</row>';
			if (buf.length > 1 << 20) {
				chunks.push(enc.encode(buf));
				buf = '';
			}
		}
		chunks.push(enc.encode(buf + '</sheetData>' + tail));
		this.sheets.push(concat(chunks));
	}

	/** The workbook as .xlsx bytes. */
	async bytes(): Promise<Uint8Array> {
		const n = this.names.length;
		const override = (part: string, type: string) => `<Override PartName="/${part}" ContentType="${type}"/>`;
		const rel = (id: number, type: string, target: string) => `<Relationship Id="rId${id}" Type="${type}" Target="${target}"/>`;
		const sheetPath = (i: number) => `worksheets/sheet${i + 1}.xml`;
		const text = (s: string) => enc.encode(s);
		const parts: ZipEntry[] = [
			{ name: 'docProps/core.xml', data: text(CORE_XML) },
			{
				name: 'docProps/app.xml',
				data: text(
					XML_HEADER +
						`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="${NS_VT}"><Application>SheetJS</Application>` +
						`<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${n}</vt:i4></vt:variant></vt:vector></HeadingPairs>` +
						`<TitlesOfParts><vt:vector size="${n}" baseType="lpstr">${this.names.map((s) => `<vt:lpstr>${escapeXml(s)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts></Properties>`
				)
			},
			...this.sheets.map((data, i) => ({ name: `xl/${sheetPath(i)}`, data })),
			{
				name: 'xl/workbook.xml',
				data: text(
					XML_HEADER +
						`<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><workbookPr codeName="ThisWorkbook"/><sheets>` +
						this.names.map((s, i) => `<sheet name="${escapeXml(s)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
						'</sheets></workbook>'
				)
			},
			{ name: 'xl/theme/theme1.xml', data: text(XML_HEADER + THEME_XML) },
			{ name: 'xl/styles.xml', data: text(this.styles.xml()) },
			{ name: 'xl/metadata.xml', data: text(XML_HEADER + METADATA_XML) },
			{
				name: '[Content_Types].xml',
				data: text(
					XML_HEADER +
						'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
						CONTENT_TYPE_DEFAULTS.map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('') +
						override('xl/workbook.xml', `${CT_OOXML}.spreadsheetml.sheet.main+xml`) +
						this.names.map((_, i) => override(`xl/${sheetPath(i)}`, `${CT_OOXML}.spreadsheetml.worksheet+xml`)).join('') +
						override('xl/theme/theme1.xml', `${CT_OOXML}.theme+xml`) +
						override('xl/styles.xml', `${CT_OOXML}.spreadsheetml.styles+xml`) +
						override('docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml') +
						override('docProps/app.xml', `${CT_OOXML}.extended-properties+xml`) +
						override('xl/metadata.xml', `${CT_OOXML}.spreadsheetml.sheetMetadata+xml`) +
						'</Types>'
				)
			},
			{
				name: '_rels/.rels',
				data: text(
					XML_HEADER +
						`<Relationships xmlns="${NS_PKG_REL}">` +
						rel(2, `${NS_PKG_REL}/metadata/core-properties`, 'docProps/core.xml') +
						rel(3, `${NS_REL}/extended-properties`, 'docProps/app.xml') +
						rel(1, `${NS_REL}/officeDocument`, 'xl/workbook.xml') +
						'</Relationships>'
				)
			},
			{
				name: 'xl/_rels/workbook.xml.rels',
				data: text(
					XML_HEADER +
						`<Relationships xmlns="${NS_PKG_REL}">` +
						this.names.map((_, i) => rel(i + 1, `${NS_REL}/worksheet`, sheetPath(i))).join('') +
						rel(n + 1, `${NS_REL}/theme`, 'theme/theme1.xml') +
						rel(n + 2, `${NS_REL}/styles`, 'styles.xml') +
						rel(n + 3, `${NS_REL}/sheetMetadata`, 'metadata.xml') +
						'</Relationships>'
				)
			}
		];
		return zip(parts.sort((a, b) => partOrder(a.name, b.name)));
	}
}

/**
 * The order SheetJS's container lists parts in (its `namecmp`): path segment
 * by segment, a shorter segment first, then by code unit. So xl/ comes before
 * _rels/ and docProps/, and sheet10.xml after sheet9.xml.
 */
export function partOrder(l: string, r: string): number {
	const L = l.split('/');
	const R = r.split('/');
	for (let i = 0; i < Math.min(L.length, R.length); i++) {
		const d = L[i]!.length - R[i]!.length;
		if (d) return d;
		if (L[i] !== R[i]) return L[i]! < R[i]! ? -1 : 1;
	}
	return L.length - R.length;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}

// ── The fixed parts ──────────────────────────────────────────────────────────

const CORE_XML =
	XML_HEADER +
	'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>';

const CONTENT_TYPE_DEFAULTS: [string, string][] = [
	['xml', 'application/xml'],
	['bin', 'application/vnd.ms-excel.sheet.binary.macroEnabled.main'],
	['vml', `${CT_OOXML}.vmlDrawing`],
	['data', `${CT_OOXML}.model+data`],
	['bmp', 'image/bmp'],
	['png', 'image/png'],
	['gif', 'image/gif'],
	['emf', 'image/x-emf'],
	['wmf', 'image/x-wmf'],
	['jpg', 'image/jpeg'],
	['jpeg', 'image/jpeg'],
	['tif', 'image/tiff'],
	['tiff', 'image/tiff'],
	['pdf', 'application/pdf'],
	['rels', 'application/vnd.openxmlformats-package.relationships+xml']
];

const METADATA_XML =
	'<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray">\n  <metadataTypes count="1">\n    <metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/>\n  </metadataTypes>\n  <futureMetadata name="XLDAPR" count="1">\n    <bk>\n      <extLst>\n        <ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}">\n          <xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/>\n        </ext>\n      </extLst>\n    </bk>\n  </futureMetadata>\n  <cellMetadata count="1">\n    <bk>\n      <rc t="1" v="0"/>\n    </bk>\n  </cellMetadata>\n</metadata>';

/** The default Office theme SheetJS writes (styles.xml's font colour refers to it). */
const THEME_XML =
	'<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office">' +
	'<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2>' +
	'<a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2>' +
	'<a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4>' +
	'<a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink>' +
	'<a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Cambria"/>' +
	'<a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="ＭＳ Ｐゴシック"/><a:font script="Hang" typeface="맑은 고딕"/>' +
	'<a:font script="Hans" typeface="宋体"/><a:font script="Hant" typeface="新細明體"/><a:font script="Arab" typeface="Times New Roman"/>' +
	'<a:font script="Hebr" typeface="Times New Roman"/><a:font script="Thai" typeface="Tahoma"/><a:font script="Ethi" typeface="Nyala"/>' +
	'<a:font script="Beng" typeface="Vrinda"/><a:font script="Gujr" typeface="Shruti"/><a:font script="Khmr" typeface="MoolBoran"/>' +
	'<a:font script="Knda" typeface="Tunga"/><a:font script="Guru" typeface="Raavi"/><a:font script="Cans" typeface="Euphemia"/>' +
	'<a:font script="Cher" typeface="Plantagenet Cherokee"/><a:font script="Yiii" typeface="Microsoft Yi Baiti"/>' +
	'<a:font script="Tibt" typeface="Microsoft Himalaya"/><a:font script="Thaa" typeface="MV Boli"/><a:font script="Deva" typeface="Mangal"/>' +
	'<a:font script="Telu" typeface="Gautami"/><a:font script="Taml" typeface="Latha"/><a:font script="Syrc" typeface="Estrangelo Edessa"/>' +
	'<a:font script="Orya" typeface="Kalinga"/><a:font script="Mlym" typeface="Kartika"/><a:font script="Laoo" typeface="DokChampa"/>' +
	'<a:font script="Sinh" typeface="Iskoola Pota"/><a:font script="Mong" typeface="Mongolian Baiti"/>' +
	'<a:font script="Viet" typeface="Times New Roman"/><a:font script="Uigh" typeface="Microsoft Uighur"/>' +
	'<a:font script="Geor" typeface="Sylfaen"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/>' +
	'<a:font script="Jpan" typeface="ＭＳ Ｐゴシック"/><a:font script="Hang" typeface="맑은 고딕"/><a:font script="Hans" typeface="宋体"/>' +
	'<a:font script="Hant" typeface="新細明體"/><a:font script="Arab" typeface="Arial"/><a:font script="Hebr" typeface="Arial"/>' +
	'<a:font script="Thai" typeface="Tahoma"/><a:font script="Ethi" typeface="Nyala"/><a:font script="Beng" typeface="Vrinda"/>' +
	'<a:font script="Gujr" typeface="Shruti"/><a:font script="Khmr" typeface="DaunPenh"/><a:font script="Knda" typeface="Tunga"/>' +
	'<a:font script="Guru" typeface="Raavi"/><a:font script="Cans" typeface="Euphemia"/><a:font script="Cher" typeface="Plantagenet Cherokee"/>' +
	'<a:font script="Yiii" typeface="Microsoft Yi Baiti"/><a:font script="Tibt" typeface="Microsoft Himalaya"/>' +
	'<a:font script="Thaa" typeface="MV Boli"/><a:font script="Deva" typeface="Mangal"/><a:font script="Telu" typeface="Gautami"/>' +
	'<a:font script="Taml" typeface="Latha"/><a:font script="Syrc" typeface="Estrangelo Edessa"/><a:font script="Orya" typeface="Kalinga"/>' +
	'<a:font script="Mlym" typeface="Kartika"/><a:font script="Laoo" typeface="DokChampa"/><a:font script="Sinh" typeface="Iskoola Pota"/>' +
	'<a:font script="Mong" typeface="Mongolian Baiti"/><a:font script="Viet" typeface="Arial"/><a:font script="Uigh" typeface="Microsoft Uighur"/>' +
	'<a:font script="Geor" typeface="Sylfaen"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill>' +
	'<a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/>' +
	'<a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="35000"><a:schemeClr val="phClr"><a:tint val="37000"/><a:satMod val="300000"/>' +
	'</a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="15000"/><a:satMod val="350000"/></a:schemeClr></a:gs></a:gsLst>' +
	'<a:lin ang="16200000" scaled="1"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr">' +
	'<a:tint val="100000"/><a:shade val="100000"/><a:satMod val="130000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr">' +
	'<a:tint val="50000"/><a:shade val="100000"/><a:satMod val="350000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="0"/>' +
	'</a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr">' +
	'<a:shade val="95000"/><a:satMod val="105000"/></a:schemeClr></a:solidFill><a:prstDash val="solid"/></a:ln>' +
	'<a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
	'<a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
	'</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="5400000" rotWithShape="0">' +
	'<a:srgbClr val="000000"><a:alpha val="38000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle><a:effectStyle><a:effectLst>' +
	'<a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr>' +
	'</a:outerShdw></a:effectLst></a:effectStyle><a:effectStyle><a:effectLst>' +
	'<a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr>' +
	'</a:outerShdw></a:effectLst><a:scene3d><a:camera prst="orthographicFront"><a:rot lat="0" lon="0" rev="0"/></a:camera>' +
	'<a:lightRig rig="threePt" dir="t"><a:rot lat="0" lon="0" rev="1200000"/></a:lightRig></a:scene3d><a:sp3d><a:bevelT w="63500" h="25400"/>' +
	'</a:sp3d></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
	'<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="40000"/><a:satMod val="350000"/></a:schemeClr>' +
	'</a:gs><a:gs pos="40000"><a:schemeClr val="phClr"><a:tint val="45000"/><a:shade val="99000"/><a:satMod val="350000"/></a:schemeClr></a:gs>' +
	'<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="20000"/><a:satMod val="255000"/></a:schemeClr></a:gs></a:gsLst>' +
	'<a:path path="circle"><a:fillToRect l="50000" t="-80000" r="50000" b="180000"/></a:path></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst>' +
	'<a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="80000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="100000">' +
	'<a:schemeClr val="phClr"><a:shade val="30000"/><a:satMod val="200000"/></a:schemeClr></a:gs></a:gsLst><a:path path="circle">' +
	'<a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements>' +
	'<a:objectDefaults><a:spDef><a:spPr/><a:bodyPr/><a:lstStyle/><a:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef>' +
	'<a:fillRef idx="3"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="2"><a:schemeClr val="accent1"/></a:effectRef>' +
	'<a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></a:style></a:spDef><a:lnDef><a:spPr/><a:bodyPr/><a:lstStyle/><a:style>' +
	'<a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="1">' +
	'<a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></a:style></a:lnDef></a:objectDefaults>' +
	'<a:extraClrSchemeLst/></a:theme>';
