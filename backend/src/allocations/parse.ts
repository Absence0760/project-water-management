// Reading an allocations table: a WARMS-shaped extract or the app's own CSV
// template (WP-3.10, docs/allocations.md § Importing). Pure: no I/O, so every
// rule here is unit-tested in parse.test.ts.
//
// WARMS has no public API and its extract layout varies by who ran it, so
// columns are found by header name through an alias table (pending a real
// extract from the client: followups.md). Unknown columns are ignored and
// listed. A file carrying ID numbers, phone numbers or email addresses is
// refused outright (POPIA minimisation, docs/security.md): the app has no use
// for them, so they never reach the database.

export type AllocationSourceKind = 'warms_extract' | 'csv';
export type Authorisation = 'registration' | 'licence' | 'general_authorisation' | 'existing_lawful_use';
export type Purpose = 'irrigation' | 'domestic' | 'livestock' | 'industry' | 'mining' | 'municipal' | 'other';
export type WaterSource = 'surface' | 'groundwater';

export const AUTHORISATIONS: readonly Authorisation[] = ['registration', 'licence', 'general_authorisation', 'existing_lawful_use'];
export const PURPOSES: readonly Purpose[] = ['irrigation', 'domestic', 'livestock', 'industry', 'mining', 'municipal', 'other'];
export const WATER_SOURCES: readonly WaterSource[] = ['surface', 'groundwater'];

/** Longest file text accepted (UTF-8 characters); inside the API's 4 MB body cap. */
export const IMPORT_MAX_CHARS = 2 * 1024 * 1024;
/** Most data rows in one file. */
export const IMPORT_MAX_ROWS = 5000;
/**
 * Most columns in a row. A WARMS extract has a few dozen; without a cap a
 * 2 MB header of a million empty columns took 300 ms to map and came back
 * as a 4 MB ignored-columns list.
 */
export const IMPORT_MAX_COLUMNS = 200;

/** A column the importer reads. */
export type Field =
	| 'registrationNo'
	| 'propertyRef'
	| 'farm'
	| 'holder'
	| 'authorisation'
	| 'purpose'
	| 'waterSource'
	| 'volumeM3PerYear'
	| 'storageM3'
	| 'validFrom'
	| 'validTo'
	| 'reference'
	| 'months'
	| 'maxRateM3s'
	| 'conditions';

/** Header spellings per field, compared after lower-casing and dropping everything but letters and digits. */
export const HEADER_ALIASES: Record<Field, readonly string[]> = {
	registrationNo: ['registrationno', 'registrationnumber', 'regno', 'regnumber', 'warmsno', 'warmsnumber', 'warmsregistrationnumber', 'fileno', 'filenumber', 'licenceno', 'licencenumber', 'licenseno', 'licensenumber'],
	propertyRef: ['propertyref', 'property', 'propertyreference', 'propertydescription', 'farmportion', 'sgcode', 'sgnumber', 'sg21code'],
	farm: ['farm', 'farmname', 'node', 'nodename', 'wateruser', 'modelnode'],
	holder: ['holder', 'registereduser', 'username', 'waterusername', 'licensee', 'licencee', 'registrant', 'registeredowner', 'name'],
	authorisation: ['authorisation', 'authorization', 'authorisationtype', 'authorizationtype', 'entitlement', 'entitlementtype', 'usestatus'],
	purpose: ['purpose', 'sector', 'watersector', 'usesector', 'waterusesector'],
	waterSource: ['watersource', 'source', 'resource', 'resourcetype', 'sourcetype'],
	volumeM3PerYear: ['volumem3year', 'volumem3peryear', 'volumem3a', 'volumem3annum', 'registeredvolume', 'registeredvolumem3a', 'registeredvolumem3year', 'licensedvolume', 'licencedvolume', 'annualvolume', 'volume', 'volumem3'],
	storageM3: ['storagem3', 'storage', 'registeredstorage', 'registeredstoragem3', 'damcapacity', 'damcapacitym3'],
	validFrom: ['validfrom', 'startdate', 'from', 'issuedate', 'datefrom'],
	validTo: ['validto', 'enddate', 'to', 'expirydate', 'expiry', 'dateto'],
	reference: ['reference', 'ref', 'comment', 'comments', 'notes'],
	// Licence conditions (103, issue #72).
	months: ['months', 'abstractionmonths', 'permittedmonths', 'monthsofuse', 'usemonths'],
	maxRateM3s: ['maxratem3s', 'maxrate', 'maximumrate', 'maximumratem3s', 'maxabstractionrate', 'maxabstractionratem3s', 'ratem3s'],
	conditions: ['conditions', 'licenceconditions', 'licenseconditions', 'otherconditions']
};

/** The template's header row, in order (docs/allocations.md). */
export const TEMPLATE_HEADERS = [
	'registration_no',
	'property_ref',
	'farm',
	'holder',
	'authorisation',
	'purpose',
	'water_source',
	'volume_m3_year',
	'storage_m3',
	'valid_from',
	'valid_to',
	'reference',
	'months',
	'max_rate_m3s',
	'conditions'
] as const;

/** Most conditions in words on one allocation, and the longest one (103). */
export const CONDITIONS_MAX = 20;
export const CONDITION_MAX_CHARS = 500;
/** The conditions cell's separator, in the template and the export: `|` (a comma or semicolon would split the CSV cell). */
export const CONDITIONS_SEPARATOR = ' | ';

/** Headers that carry personal information the app must not hold (normalised). */
const FORBIDDEN_HEADER = /^(id|idno|idnr|idnumber|identity.*|rsaid.*|saidnumber|passport.*|.*(phone|cellular|cellno|cellnumber|mobile|telephone|telno|telnumber|fax|email).*|cell|tel)$/;

/** A 13-digit South African ID number, alone in a cell. */
const LOOKS_LIKE_ID_NUMBER = /^\d{13}$/;

export const normaliseHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export class ImportRefused extends Error {}

/** One parsed row: `line` is its 1-based line in the file. */
export interface ParsedRow {
	line: number;
	registrationNo: string;
	propertyRef: string;
	farm: string;
	holder: string;
	authorisation: Authorisation | null;
	purpose: Purpose;
	waterSource: WaterSource | null;
	volumeM3PerYear: number | null;
	storageM3: number | null;
	validFrom: string | null;
	validTo: string | null;
	reference: string;
	/** Licence conditions (103): the calendar months of use, null = none stated; the most it may take at once (m³/s); conditions in words. */
	months: number[] | null;
	maxRateM3s: number | null;
	conditions: string[];
	/** Why this row can't be imported; empty = valid. */
	errors: string[];
}

export interface ParsedTable {
	delimiter: ',' | ';';
	/** Which file column each field came from (the original header text). */
	columns: Partial<Record<Field, string>>;
	/** Headers no field reads. */
	ignoredColumns: string[];
	rows: ParsedRow[];
}

/** Split CSV text into records of string fields (RFC 4180 quoting, `,` or `;`); ImportRefused past IMPORT_MAX_COLUMNS in a row. */
export function splitCsv(text: string, delimiter: ',' | ';'): { line: number; cells: string[] }[] {
	const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const out: { line: number; cells: string[] }[] = [];
	let cells: string[] = [];
	let cell = '';
	let quoted = false;
	let line = 1;
	let recordLine = 1;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		if (quoted) {
			if (ch === '"') {
				if (s[i + 1] === '"') {
					cell += '"';
					i++;
				} else quoted = false;
			} else {
				if (ch === '\n') line++;
				cell += ch;
			}
			continue;
		}
		if (ch === '"' && cell === '') quoted = true;
		else if (ch === delimiter) {
			cells.push(cell);
			cell = '';
			// Stops a hostile row early, before it builds a million cells.
			if (cells.length >= IMPORT_MAX_COLUMNS) throw new ImportRefused(`line ${recordLine} has more than ${IMPORT_MAX_COLUMNS} columns`);
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && s[i + 1] === '\n') i++;
			cells.push(cell);
			out.push({ line: recordLine, cells });
			cells = [];
			cell = '';
			line++;
			recordLine = line;
		} else cell += ch;
	}
	if (quoted) throw new ImportRefused('the file has an unterminated quoted field');
	if (cell !== '' || cells.length) {
		cells.push(cell);
		out.push({ line: recordLine, cells });
	}
	// Drop blank lines.
	return out.filter((r) => r.cells.some((c) => c.trim() !== ''));
}

/** `;` when the header line has more semicolons than commas (a decimal-comma locale), else `,`. */
export function detectDelimiter(text: string): ',' | ';' {
	const first = text.split(/\r?\n/, 1)[0] ?? '';
	const count = (c: string) => first.split(c).length - 1;
	return count(';') > count(',') ? ';' : ',';
}

/**
 * A number cell: spaces (and no-break spaces) are thousands separators; with
 * `;` files a comma is the decimal mark, with `,` files a comma inside a quoted
 * cell is a thousands separator. Null for an empty cell, NaN for anything else.
 */
export function parseNumber(cell: string, delimiter: ',' | ';'): number | null {
	let v = cell.replace(/[\s  ]/g, '');
	if (v === '') return null;
	v = delimiter === ';' ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, '');
	if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v)) return NaN;
	return Number(v);
}

/** YYYY-MM-DD or YYYY/MM/DD, a real calendar date; null for empty; undefined for anything else. */
export function parseDate(cell: string): string | null | undefined {
	const v = cell.trim();
	if (v === '') return null;
	const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
	if (!m) return undefined;
	const iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
	const t = Date.parse(`${iso}T00:00:00Z`);
	return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso ? undefined : iso;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_FULL_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** One month: 1–12, or an English name or its first three letters ("Sept" too). */
function monthOf(v: string): number | undefined {
	if (/^\d{1,2}$/.test(v)) {
		const n = Number(v);
		return n >= 1 && n <= 12 ? n : undefined;
	}
	if (v === 'sept') return 9;
	const i = Math.max(MONTH_NAMES.indexOf(v), MONTH_FULL_NAMES.indexOf(v));
	return i < 0 ? undefined : i + 1;
}

/**
 * The months of use (a licence condition, 103): month numbers or names
 * separated by spaces, commas, semicolons, slashes or `|`, and ranges that
 * may run over the new year ("Oct-Mar" is October to March). Ascending and
 * without repeats; null for an empty cell; undefined for anything else.
 */
export function parseMonths(cell: string): number[] | null | undefined {
	const v = cell.trim().toLowerCase();
	if (v === '') return null;
	const out = new Set<number>();
	for (const part of v.split(/[\s,;/|]+/).filter(Boolean)) {
		const m = /^([a-z]+|\d{1,2})(?:[-–]([a-z]+|\d{1,2}))?$/.exec(part);
		if (!m) return undefined;
		const a = monthOf(m[1]!);
		const b = m[2] === undefined ? a : monthOf(m[2]);
		if (a === undefined || b === undefined) return undefined;
		for (let k = a; ; k = (k % 12) + 1) {
			out.add(k);
			if (k === b) break;
		}
	}
	return [...out].sort((x, y) => x - y);
}

const word = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function parseAuthorisation(cell: string): Authorisation | null | undefined {
	const w = word(cell);
	if (w === '') return null;
	if (/^(registration|registered|reg|warms|registered use)$/.test(w)) return 'registration';
	if (/^(licen[cs]e|licen[cs]ed|wul|water use licen[cs]e|s40|section 40)$/.test(w)) return 'licence';
	if (/^(ga|general authori[sz]ation|s39|section 39|schedule 1|sch 1)$/.test(w)) return 'general_authorisation';
	if (/^(elu|existing lawful use|existing|s35|section 35|s32|section 32|verified|verified elu)$/.test(w)) return 'existing_lawful_use';
	return undefined;
}

export function parsePurpose(cell: string): Purpose | null {
	const w = word(cell);
	if (w === '') return null;
	if (/irrigat|agricultur/.test(w)) return 'irrigation';
	if (/livestock|stock|watering/.test(w)) return 'livestock';
	if (/domestic|household|garden/.test(w)) return 'domestic';
	if (/industr/.test(w)) return 'industry';
	if (/min(e|ing)/.test(w)) return 'mining';
	if (/municipal|urban|water supply|wss/.test(w)) return 'municipal';
	return 'other';
}

export function parseWaterSource(cell: string): WaterSource | null | undefined {
	const w = word(cell);
	if (w === '') return null;
	if (/^(surface|surface water|sw|river|dam|stream)$/.test(w)) return 'surface';
	if (/^(groundwater|ground water|gw|borehole|boreholes|aquifer)$/.test(w)) return 'groundwater';
	return undefined;
}

/**
 * Parse an allocations table. Throws ImportRefused for a file the importer
 * can't take at all (too big, no header, a personal-information column, no
 * volume column); row problems are listed on each row instead.
 */
export function parseAllocationTable(text: string, kind: AllocationSourceKind): ParsedTable {
	if (text.length > IMPORT_MAX_CHARS) throw new ImportRefused(`the file is larger than ${IMPORT_MAX_CHARS / 1024 / 1024} MB`);
	const delimiter = detectDelimiter(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
	const records = splitCsv(text, delimiter);
	const header = records.shift();
	if (!header) throw new ImportRefused('the file is empty');
	if (records.length > IMPORT_MAX_ROWS) throw new ImportRefused(`the file has more than ${IMPORT_MAX_ROWS} rows`);

	const personal = header.cells.filter((h) => FORBIDDEN_HEADER.test(normaliseHeader(h)));
	if (personal.length)
		throw new ImportRefused(
			`the file has personal-information columns the app must not hold (${personal.map((h) => `“${h.trim()}”`).join(', ')}). Delete those columns and import again.`
		);

	const columns: Partial<Record<Field, string>> = {};
	const index: Partial<Record<Field, number>> = {};
	const ignoredColumns: string[] = [];
	header.cells.forEach((h, i) => {
		const n = normaliseHeader(h);
		const field = (Object.keys(HEADER_ALIASES) as Field[]).find((f) => HEADER_ALIASES[f].includes(n));
		if (field && index[field] === undefined) {
			index[field] = i;
			columns[field] = h.trim();
		} else if (h.trim() !== '') ignoredColumns.push(h.trim());
	});
	if (index.volumeM3PerYear === undefined) throw new ImportRefused('no volume column found (expected a header such as “volume_m3_year” or “Registered volume (m3/a)”)');

	const rows = records.map((r): ParsedRow => {
		const get = (f: Field) => (index[f] === undefined ? '' : (r.cells[index[f]!] ?? '').trim());
		const errors: string[] = [];
		const text = (f: Field, max: number) => {
			const v = get(f);
			if (v.length > max) errors.push(`${columns[f]} is longer than ${max} characters`);
			if (v.includes('\u0000')) errors.push(`${columns[f]} contains a NUL character`);
			return v.slice(0, max);
		};
		const row: ParsedRow = {
			line: r.line,
			registrationNo: text('registrationNo', 100),
			propertyRef: text('propertyRef', 200),
			farm: text('farm', 200),
			holder: text('holder', 200),
			authorisation: null,
			purpose: parsePurpose(get('purpose')) ?? 'irrigation',
			waterSource: null,
			volumeM3PerYear: null,
			storageM3: null,
			validFrom: null,
			validTo: null,
			reference: text('reference', 500),
			months: null,
			maxRateM3s: null,
			conditions: [],
			errors
		};
		for (const f of ['holder', 'reference', 'propertyRef', 'farm', 'conditions'] as const)
			if (LOOKS_LIKE_ID_NUMBER.test(get(f).replace(/\s/g, ''))) errors.push(`${columns[f]} looks like an ID number; the app doesn't keep those`);

		const auth = parseAuthorisation(get('authorisation'));
		if (auth === undefined) errors.push(`unknown authorisation “${get('authorisation')}” (registration, licence, general authorisation or existing lawful use)`);
		// A WARMS extract lists registrations; the template must say.
		else row.authorisation = auth ?? (kind === 'warms_extract' ? 'registration' : null);
		if (auth === null && kind !== 'warms_extract') errors.push('authorisation is missing');

		const src = parseWaterSource(get('waterSource'));
		if (src === undefined) errors.push(`unknown water source “${get('waterSource')}” (surface or groundwater)`);
		else if (src === null) errors.push('water source is missing (surface or groundwater)');
		else row.waterSource = src;

		const vol = parseNumber(get('volumeM3PerYear'), delimiter);
		if (vol === null) errors.push('volume is missing');
		else if (!Number.isFinite(vol) || vol < 0 || vol >= 1e12) errors.push(`volume “${get('volumeM3PerYear')}” is not a number of m³ per year ≥ 0`);
		else row.volumeM3PerYear = vol;

		const sto = parseNumber(get('storageM3'), delimiter);
		if (sto !== null && (!Number.isFinite(sto) || sto < 0 || sto >= 1e12)) errors.push(`storage “${get('storageM3')}” is not a number of m³ ≥ 0`);
		else row.storageM3 = sto;

		for (const f of ['validFrom', 'validTo'] as const) {
			const d = parseDate(get(f));
			if (d === undefined) errors.push(`${columns[f]} “${get(f)}” is not a date (use YYYY-MM-DD)`);
			else row[f] = d;
		}
		if (row.validFrom && row.validTo && row.validFrom > row.validTo) errors.push('valid from is after valid to');

		// Licence conditions (103).
		const months = parseMonths(get('months'));
		if (months === undefined) errors.push(`${columns.months} “${get('months')}” are not months (e.g. “Oct-Mar” or “10 11 12 1 2 3”)`);
		else row.months = months;
		const rate = parseNumber(get('maxRateM3s'), delimiter);
		if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate >= 1e6)) errors.push(`maximum rate “${get('maxRateM3s')}” is not a number of m³/s ≥ 0`);
		else row.maxRateM3s = rate;
		const conditions = get('conditions')
			.split('|')
			.map((c) => c.trim())
			.filter(Boolean);
		if (conditions.length > CONDITIONS_MAX) errors.push(`more than ${CONDITIONS_MAX} conditions (separate them with “|”)`);
		if (conditions.some((c) => c.length > CONDITION_MAX_CHARS)) errors.push(`a condition is longer than ${CONDITION_MAX_CHARS} characters`);
		if (conditions.some((c) => c.includes('\u0000'))) errors.push('a condition contains a NUL character');
		row.conditions = conditions.slice(0, CONDITIONS_MAX).map((c) => c.slice(0, CONDITION_MAX_CHARS));
		if (!row.registrationNo && !row.propertyRef && !row.farm) errors.push('the row has no registration number, property or farm to match it by');
		return row;
	});
	return { delimiter, columns, ignoredColumns, rows };
}

/** A farm or water-user node, for matching. */
export interface MatchNode {
	id: string;
	name: string;
}

/** An allocation already in the project that is matched to a node. */
export interface KnownMatch {
	registrationNo: string;
	propertyRef: string;
	nodeId: string;
}

export type MatchedBy = 'registration' | 'property' | 'name' | null;

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Match a row to a node: first the node an existing allocation with the same
 * registration number has, then the same property reference, then a node
 * whose name equals the row's farm (or property). Null when nothing matches or
 * the match is ambiguous (two nodes with the same name).
 */
export function matchRow(row: Pick<ParsedRow, 'registrationNo' | 'propertyRef' | 'farm'>, nodes: readonly MatchNode[], known: readonly KnownMatch[]): { nodeId: string | null; matchedBy: MatchedBy } {
	const ids = new Set(nodes.map((n) => n.id));
	const unique = (list: string[]) => {
		const s = [...new Set(list.filter((id) => ids.has(id)))];
		return s.length === 1 ? s[0]! : null;
	};
	if (row.registrationNo) {
		const id = unique(known.filter((k) => k.registrationNo && key(k.registrationNo) === key(row.registrationNo)).map((k) => k.nodeId));
		if (id) return { nodeId: id, matchedBy: 'registration' };
	}
	if (row.propertyRef) {
		const id = unique(known.filter((k) => k.propertyRef && key(k.propertyRef) === key(row.propertyRef)).map((k) => k.nodeId));
		if (id) return { nodeId: id, matchedBy: 'property' };
	}
	for (const name of [row.farm, row.propertyRef]) {
		if (!name) continue;
		const hits = nodes.filter((n) => key(n.name) === key(name));
		if (hits.length === 1) return { nodeId: hits[0]!.id, matchedBy: 'name' };
	}
	return { nodeId: null, matchedBy: null };
}
