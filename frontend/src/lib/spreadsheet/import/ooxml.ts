// Just enough of the OOXML package structure (ECMA-376 Part 2) to find the
// zip entries readWorkbook() reads: the content types say where the
// workbook, shared strings and styles are, and the workbook's relationships
// say which part each sheet's r:id points at. Attribute-level scanning of
// these small parts only; ./workbookParts.ts and ./sheet.ts read the rest.

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
	// SheetJS read these without a guard when the content types listed them (the reference reader still does).
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
	/** The first styles part (number formats: how a date cell is told from a number). */
	styles: string | null;
	/** The <Types> element's namespace (SheetJS refused any but the OPC content-types one). */
	namespace: string | null;
}

/** The namespace [Content_Types].xml must be in. */
export const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';

/** Read [Content_Types].xml. */
export function packageParts(contentTypes: string): PackageParts {
	const out: PackageParts = { workbook: null, binary: false, strings: [], support: [], styles: null, namespace: null };
	const types = /<(?:([\w.-]+):)?Types\b[^>]*>/.exec(contentTypes);
	if (types) out.namespace = attributes(types[0])[types[1] ? `xmlns:${types[1]}` : 'xmlns'] ?? null;
	for (const o of tags(contentTypes, 'Override')) {
		const part = (o.PartName ?? '').replace(/^\//, '');
		if (!part) continue;
		if (o.ContentType === BINARY_WORKBOOK) out.binary = out.workbook === null;
		const role = WANTED_TYPES[o.ContentType ?? ''];
		if (role === 'workbook') out.workbook ??= part;
		else if (role === 'strings') out.strings.push(part);
		else if (role) {
			out.support.push(part);
			if (role === 'styles') out.styles ??= part;
		}
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
 * Relationship id → the part it targets, from the workbook's relationships
 * (external targets left out: a sheet can't live outside the file).
 */
export function relTargets(owner: string, relsXml: string): Map<string, string> {
	const targets = new Map<string, string>();
	for (const r of tags(relsXml, 'Relationship')) {
		if (r.Id && r.Target && r.TargetMode !== 'External') targets.set(r.Id, resolveTarget(owner, r.Target));
	}
	return targets;
}
