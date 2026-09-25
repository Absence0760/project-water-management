// The two small parts the reader needs before any sheet: workbook.xml (the
// sheets, the defined names and the date system) and styles.xml (enough of
// it to give each cell style its number format, which is how a date cell is
// told from a number). Both are read the way SheetJS read them, so a sheet
// or named range resolves exactly as before.
import { decodeXml } from './ooxml';
import type { DefinedName } from './source';
import { UnreadableWorkbookError } from './errors';
import { notWellFormed, parseXmlBool, scanXml, type Tag, binary, unescapeXml, utf8read } from './xml';

/** The SpreadsheetML namespaces SheetJS accepts on <workbook> (transitional, strict and two legacy ones). */
const MAIN_NAMESPACES = [
	'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
	'http://purl.oclc.org/ooxml/spreadsheetml/main',
	'http://schemas.microsoft.com/office/excel/2006/main',
	'http://schemas.microsoft.com/office/excel/2006/2'
];

export interface WorkbookXml {
	/** Sheets in workbook order: name (decoded as SheetJS decodes it) and relationship id. */
	sheets: { name: string; rid: string | undefined }[];
	names: DefinedName[];
	date1904: boolean;
}

function qname(tag: Tag): string {
	return binary(tag.buf, tag.start + 1, tag.nameEnd);
}

/** Read xl/workbook.xml. */
export function readWorkbookXml(bytes: Uint8Array, part: string): WorkbookXml {
	const out: WorkbookXml = { sheets: [], names: [], date1904: false };
	let namespace = '';
	let name: { name: string; local: boolean; raw: string[] } | null = null;
	scanXml(bytes, part, {
		open(local, tag, selfClosing) {
			if (name) throw notWellFormed(part, 'a defined name has markup inside it');
			if (local === 'workbook') {
				const q = qname(tag);
				const c = q.indexOf(':');
				const want = c === -1 ? 'xmlns' : `xmlns:${q.slice(0, c)}`;
				namespace = tag.attributes().find(([k]) => k === want)?.[1] ?? '';
			} else if (local === 'workbookPr') {
				const v = tag.attr('date1904');
				if (v !== undefined) out.date1904 = parseXmlBool(v);
			} else if (local === 'sheet') {
				const n = tag.attr('name');
				if (n === undefined) throw new UnreadableWorkbookError('a sheet in it has no name', 'corrupt');
				const rid = tag.attr('id');
				out.sheets.push({ name: unescapeXml(utf8read(n)), rid: rid === undefined ? undefined : decodeXml(rid) });
			} else if (local === 'definedName' && !selfClosing) {
				const n = tag.attr('name');
				if (n === undefined) throw new UnreadableWorkbookError('a defined name in it has no name', 'corrupt');
				// SheetJS: Name as written (not unescaped); sheet-scoped when localSheetId is non-empty.
				name = { name: utf8read(n), local: Boolean(tag.attr('localSheetId')), raw: [] };
			}
		},
		close(local) {
			if (local === 'definedName' && name) {
				out.names.push({ name: name.name, ref: unescapeXml(utf8read(name.raw.join(''))), local: name.local });
				name = null;
			}
		},
		text(buf, start, end) {
			name?.raw.push(binary(buf, start, end));
		},
		cdata(buf, start, end) {
			name?.raw.push(`<![CDATA[${binary(buf, start, end)}]]>`);
		},
		markup(buf, start, end) {
			name?.raw.push(binary(buf, start, end));
		}
	});
	if (!MAIN_NAMESPACES.includes(namespace)) throw new UnreadableWorkbookError(`its workbook part is in an unknown namespace${namespace ? ` (${namespace})` : ''}`, 'not-workbook');
	return out;
}

/** SheetJS's built-in number formats (SSF_init_table). */
const BUILTIN_FORMATS: [number, string][] = [
	[0, 'General'],
	[1, '0'],
	[2, '0.00'],
	[3, '#,##0'],
	[4, '#,##0.00'],
	[9, '0%'],
	[10, '0.00%'],
	[11, '0.00E+00'],
	[12, '# ?/?'],
	[13, '# ??/??'],
	[14, 'm/d/yy'],
	[15, 'd-mmm-yy'],
	[16, 'd-mmm'],
	[17, 'mmm-yy'],
	[18, 'h:mm AM/PM'],
	[19, 'h:mm:ss AM/PM'],
	[20, 'h:mm'],
	[21, 'h:mm:ss'],
	[22, 'm/d/yy h:mm'],
	[37, '#,##0 ;(#,##0)'],
	[38, '#,##0 ;[Red](#,##0)'],
	[39, '#,##0.00;(#,##0.00)'],
	[40, '#,##0.00;[Red](#,##0.00)'],
	[45, 'mm:ss'],
	[46, '[h]:mm:ss'],
	[47, 'mmss.0'],
	[48, '##0.0E+0'],
	[49, '@'],
	[56, '"上午/下午 "hh"時"mm"分"ss"秒 "']
];

/** Formats SheetJS rewrites on load (a Google Sheets quirk). */
const BAD_FORMATS: Record<string, string> = { 'd.m': 'd\\.m' };

const MAX_FMT_ID = 0x188;
const CANONICAL_INDEX = /^(?:0|[1-9]\d*)$/;

/** Cell style → number format, as SheetJS resolved it (cellNF). */
export class Styles {
	private readonly cache = new Map<string, number>();
	/** Distinct format strings (undefined = SheetJS had none), indexed by zIndex(). */
	readonly formats: (string | undefined)[] = [];
	private readonly formatIndex = new Map<string | undefined, number>();

	constructor(
		private readonly table: Map<number, string>,
		/** Each cellXfs <xf>'s numFmtId after SheetJS's processing (a number, NaN, '' or undefined); null without a <cellXfs>. */
		private readonly xfs: (number | string | undefined)[] | null
	) {}

	/** The number format of a cell whose s attribute is `s` (raw), or undefined. */
	format(s: string | undefined): string | undefined {
		let id: number | string = 0;
		if (s !== undefined && this.xfs && CANONICAL_INDEX.test(s)) {
			const i = Number(s);
			if (i < this.xfs.length) id = this.xfs[i] ?? 0;
		}
		return typeof id === 'number' ? this.table.get(id) : undefined;
	}

	/** format(s) as an index into `formats`, cached per distinct s. */
	zIndex(s: string | undefined): number {
		const key = s ?? '\u0000';
		let i = this.cache.get(key);
		if (i === undefined) {
			const z = this.format(s);
			i = this.formatIndex.get(z);
			if (i === undefined) {
				i = this.formats.length;
				this.formats.push(z);
				this.formatIndex.set(z, i);
			}
			this.cache.set(key, i);
		}
		return i;
	}
}

/** No styles part: every cell is General, as in SheetJS. */
export function defaultStyles(): Styles {
	return new Styles(new Map(BUILTIN_FORMATS), null);
}

/**
 * Read xl/styles.xml: the first <numFmts> block's custom formats and the
 * first <cellXfs> block's <xf numFmtId>, with SheetJS's handling of ids past
 * 0x188 (moved into the free slots below it) and its Google Sheets fix.
 */
export function readStyles(bytes: Uint8Array, part: string): Styles {
	const numFmts: { id: string | undefined; code: string | undefined }[] = [];
	const xfIds: (string | undefined)[] = [];
	let hasNumFmts = false;
	let hasXfs = false;
	let seenNumFmts = false;
	let seenXfs = false;
	let inNumFmts = -1;
	let inXfs = -1;
	let depth = 0;
	scanXml(bytes, part, {
		open(local, tag, selfClosing) {
			if (local === 'numFmts' && !seenNumFmts) {
				seenNumFmts = true;
				if (!selfClosing) {
					hasNumFmts = true;
					inNumFmts = depth;
				}
			} else if (local === 'cellXfs' && !seenXfs) {
				seenXfs = true;
				if (!selfClosing) {
					hasXfs = true;
					inXfs = depth;
				}
			} else if (local === 'numFmt' && inNumFmts >= 0) numFmts.push({ id: tag.attr('numFmtId'), code: tag.attr('formatCode') });
			else if (local === 'xf' && inXfs >= 0) xfIds.push(tag.attr('numFmtId'));
			depth++;
		},
		close() {
			depth--;
			if (depth === inNumFmts) inNumFmts = -1;
			if (depth === inXfs) inXfs = -1;
		},
		text() {},
		cdata() {}
	});

	const table = new Map(BUILTIN_FORMATS);
	let numberFmt: Map<number, string> | null = null;
	if (hasNumFmts) {
		numberFmt = new Map(table);
		for (const f of numFmts) {
			if (f.code === undefined) throw new UnreadableWorkbookError('a number format in it has no format code', 'corrupt');
			const code = unescapeXml(utf8read(f.code));
			let j = parseInt(f.id ?? '', 10);
			numberFmt.set(j, code);
			if (j > 0) {
				if (j > MAX_FMT_ID) {
					for (j = MAX_FMT_ID; j > 0x3c; --j) if (numberFmt.get(j) == null) break;
					numberFmt.set(j, code);
				}
				table.set(j, Object.hasOwn(BAD_FORMATS, code) ? BAD_FORMATS[code]! : code);
			}
		}
	}
	let xfs: (number | string | undefined)[] | null = null;
	if (hasXfs) {
		xfs = xfIds.map((raw) => {
			let id: number | string | undefined = raw ? parseInt(raw, 10) : raw;
			if (numberFmt && typeof id === 'number' && id > MAX_FMT_ID) {
				for (let i = MAX_FMT_ID; i > 0x3c; --i) {
					if (numberFmt.get(id) == numberFmt.get(i)) {
						id = i;
						break;
					}
				}
			}
			return id;
		});
	}
	return new Styles(table, xfs);
}
