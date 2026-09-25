// Just enough of the OOXML package structure (ECMA-376 Part 2) to pick the
// zip entries readWorkbook() hands SheetJS: the content types say where the
// workbook, shared strings and styles are, and the workbook and its
// relationships say which worksheet part holds which sheet. Attribute-level
// scanning only; SheetJS does the real parsing of the parts it's given.

/** One XML element's attributes (prefixes kept, values entity-decoded). */
function attributes(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!] = decodeXml(m[2] ?? m[3] ?? '');
	return out;
}

/** Every start tag of the local name `local` (any namespace prefix). */
function tags(xml: string, local: string): Record<string, string>[] {
	return [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${local}\\b[^>]*>`, 'g'))].map((m) => attributes(m[0]));
}

export function decodeXml(s: string): string {
	return s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (all, hex: string, dec: string, named: string) => {
		if (named) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named]!;
		const cp = hex ? parseInt(hex, 16) : Number(dec);
		return cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
	});
}

/** The content types of the parts the importer needs, by the role SheetJS gives them. */
const WANTED_TYPES: Record<string, 'workbook' | 'strings' | 'styles' | 'other'> = {
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml': 'workbook',
	'application/vnd.ms-excel.sheet.macroEnabled.main+xml': 'workbook',
	'application/vnd.ms-excel.addin.macroEnabled.main+xml': 'workbook',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml': 'workbook',
	'application/vnd.ms-excel.template.macroEnabled.main+xml': 'workbook',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml': 'strings',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml': 'styles',
	// SheetJS reads these without a guard when the content types list them, so they must be present.
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml': 'other',
	'application/vnd.ms-excel.person+xml': 'other'
};

const BINARY_WORKBOOK = 'application/vnd.ms-excel.sheet.binary.macroEnabled.main';

export interface PackageParts {
	/** The workbook part, no leading slash ("xl/workbook.xml"); null if the content types name none. */
	workbook: string | null;
	/** True when the workbook is the binary .xlsb kind. */
	binary: boolean;
	/** Shared strings, if any. */
	strings: string[];
	/** Styles, metadata and people parts. */
	support: string[];
}

/** Read [Content_Types].xml. */
export function packageParts(contentTypes: string): PackageParts {
	const out: PackageParts = { workbook: null, binary: false, strings: [], support: [] };
	for (const o of tags(contentTypes, 'Override')) {
		const part = (o.PartName ?? '').replace(/^\//, '');
		if (!part) continue;
		if (o.ContentType === BINARY_WORKBOOK) out.binary = out.workbook === null;
		const role = WANTED_TYPES[o.ContentType ?? ''];
		if (role === 'workbook') out.workbook ??= part;
		else if (role === 'strings') out.strings.push(part);
		else if (role) out.support.push(part);
	}
	return out;
}

/** "xl/workbook.xml" → "xl/_rels/workbook.xml.rels". */
export function relsPathOf(part: string): string {
	const i = part.lastIndexOf('/');
	return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

/** Resolve a relationship target against the part that owns it. */
export function resolveTarget(owner: string, target: string): string {
	const base = target.startsWith('/') ? [] : owner.split('/').slice(0, -1);
	for (const seg of target.replace(/^\//, '').split('/')) {
		if (seg === '..') base.pop();
		else if (seg !== '.' && seg !== '') base.push(seg);
	}
	return base.join('/');
}

/**
 * Sheet name → its part in the zip, from workbook.xml's <sheet name r:id>
 * and the workbook's relationships. Sheets whose relationship is missing or
 * external are left out (SheetJS can't read them either).
 */
export function sheetParts(workbookPart: string, workbookXml: string, relsXml: string): { names: string[]; parts: Map<string, string> } {
	const targets = new Map<string, string>();
	for (const r of tags(relsXml, 'Relationship')) {
		if (r.Id && r.Target && r.TargetMode !== 'External') targets.set(r.Id, resolveTarget(workbookPart, r.Target));
	}
	const names: string[] = [];
	const parts = new Map<string, string>();
	for (const s of tags(workbookXml, 'sheet')) {
		if (s.name === undefined) continue;
		names.push(s.name);
		const idKey = Object.keys(s).find((k) => /(^|:)id$/.test(k) && k !== 'sheetId');
		const target = idKey ? targets.get(s[idKey]!) : undefined;
		if (target) parts.set(s.name, target);
	}
	return { names, parts };
}
