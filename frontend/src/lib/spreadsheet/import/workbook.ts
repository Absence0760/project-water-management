// Reading a b023 workbook: the streaming reader, named ranges and cell values.
//
// extract_project.py opens the workbook with openpyxl
// load_workbook(read_only=True, data_only=True, keep_vba=False): cached
// values only. This does the same. Nothing here evaluates a formula or reads
// macros: formula text is never read, a formula cell Excel saved without a
// value reads as blank, as in openpyxl, and the VBA project isn't even
// unpacked.
//
// The reader (WP-1.31 memory fix) is this project's own, not SheetJS: the
// zip is opened by ./zip.ts, and the few parts the import needs are parsed
// as they inflate (./xml.ts: a streaming tokenizer; ./workbookParts.ts:
// sheets, defined names, number formats; ./sheet.ts: cells;
// ./sharedStrings.ts: only the strings those cells use). No sheet is ever
// held whole, and the import worker carries no SheetJS. It reproduces the
// cells SheetJS gave the parser; the parity tests compare the two readers
// cell by cell (./sheetjsReference.ts) as well as the importer's output with
// the Python's.
import { type Cell, clean, columnIndex, isName, pyStrip } from './cells';
import { fromExcelSerial, isDateFormat, isTimedeltaFormat, durationFromExcel } from './dates';
import { InvalidWorkbookError, NotB023WorkbookError, UnreadableWorkbookError, WorkbookTooLargeError } from './errors';
import { CONTENT_TYPES_NAMESPACE, packageParts, relTargets, relsPathOf } from './ooxml';
import { SharedStringsReader } from './sharedStrings';
import { type SheetCells, SheetReader } from './sheet';
import type { DefinedName, RawCell, SheetSource, WorkbookSource } from './source';
import { defaultStyles, readStyles, readWorkbookXml } from './workbookParts';
import { XmlScanner } from './xml';
import { type ZipLimits, ZipArchive } from './zip';

/**
 * Largest file readWorkbook() accepts. A catchment workbook with a
 * multi-decade daily record runs to tens of MB (most of it the per-farm
 * Element sheets, which the importer skips), so the limit leaves room for a longer
 * record or more farms while still refusing an absurd upload.
 */
export const MAX_WORKBOOK_BYTES = 150_000_000;
/** Most sheets readWorkbook() accepts (b023 has about 30 plus one per element). */
export const MAX_WORKBOOK_SHEETS = 250;

/** The sheets the b023 named ranges live on; read first so the Element sheets are never parsed. */
export const B023_SHEETS = ['AppSettings', 'Home', 'Network', 'Farm spec', 'Crop demand', 'Farm demand', 'Transfers', 'Flow data', 'Flow Calibration Cfg', 'EWR Cfg'];

export interface ReadOptions extends ZipLimits {
	/** Largest file accepted (default MAX_WORKBOOK_BYTES). */
	maxBytes?: number;
	/** Most sheets accepted (default MAX_WORKBOOK_SHEETS). */
	maxSheets?: number;
	/** Called before each sheet is parsed: (sheet, i, n), 1-based. */
	onProgress?: (sheet: string, i: number, n: number) => void;
}

/** The workbook readWorkbook() returns: every sheet's name, the defined names, and the cells of the sheets it read. */
class StreamedWorkbook implements WorkbookSource {
	readonly sheets = new Map<string, SheetCells>();

	constructor(
		readonly sheetNames: readonly string[],
		readonly names: readonly DefinedName[],
		readonly date1904: boolean
	) {}

	sheet(name: string): SheetSource | undefined {
		return this.sheets.get(name);
	}
}

/**
 * The sheets to parse: the b023 sheets, or exactly the named ranges' sheets
 * when those lie elsewhere (renamed or moved tables), matched to the
 * workbook's sheet names case-insensitively, as SheetJS matched them.
 */
export function sheetsToRead(source: WorkbookSource): string[] {
	const book = new B023Workbook(source);
	const wanted = new Set<string>();
	for (const name of ALL_NAMES) {
		const target = book.sheetOf(name);
		if (target !== null && source.sheetNames.includes(target)) wanted.add(target);
	}
	const byLower = new Map<string, string>();
	for (const n of source.sheetNames) byLower.set(n.toLowerCase(), n);
	return ([...wanted].every((s) => B023_SHEETS.includes(s)) ? B023_SHEETS : [...wanted])
		.map((s) => byLower.get(s.toLowerCase()))
		.filter((s): s is string => s !== undefined);
}

/**
 * Parse the workbook file for extractProject(). Only the sheets the b023
 * named ranges point at are parsed (the Element sheets of a large workbook
 * are most of its size and the project doesn't need them), so the result
 * lists every sheet but holds the cells of those only.
 *
 * Only the parts the import reads are ever inflated: the content types, the
 * workbook and its relationships, the styles, those sheets and the shared
 * strings. Each sheet is parsed as it inflates, one sheet at a time, so the
 * caller can show which sheet is being read. The Element sheets, the
 * calculation chain, the VBA project, drawings and media are never touched.
 * Given the picked File (a Blob), it reads just those parts' bytes from it,
 * a slice at a time; bytes already in memory work too.
 */
export async function readWorkbook(data: Blob | ArrayBuffer | Uint8Array, opts: ReadOptions = {}): Promise<WorkbookSource> {
	const maxBytes = opts.maxBytes ?? MAX_WORKBOOK_BYTES;
	const maxSheets = opts.maxSheets ?? MAX_WORKBOOK_SHEETS;
	const size = data instanceof Blob ? data.size : data.byteLength;
	if (size > maxBytes) throw new WorkbookTooLargeError('bytes', size, maxBytes);
	const zip = await ZipArchive.open(data instanceof Blob || data instanceof Uint8Array ? data : new Uint8Array(data), opts);
	const text = async (part: string) => new TextDecoder().decode(await zip.read(part));

	const ctPart = zip.find('[Content_Types].xml');
	if (ctPart === undefined) throw new UnreadableWorkbookError('it has no [Content_Types].xml, so it is not an Office file');
	const pkg = packageParts(await text(ctPart));
	if (pkg.namespace !== CONTENT_TYPES_NAMESPACE) throw new UnreadableWorkbookError('its [Content_Types].xml is in an unknown namespace, so it is not an Office file');
	const workbookPart = zip.find(pkg.workbook ?? 'xl/workbook.xml') ?? null;
	if (workbookPart === null) {
		throw new UnreadableWorkbookError(
			pkg.binary || zip.find('xl/workbook.bin') ? 'it is a binary .xlsb workbook; save it from Excel as .xlsm or .xlsx' : 'it has no workbook part'
		);
	}
	const workbookXml = readWorkbookXml(await zip.read(workbookPart), workbookPart);
	const relsPart = zip.find(relsPathOf(workbookPart)) ?? zip.find('xl/_rels/workbook.xml.rels');
	const targets = relsPart === undefined ? new Map<string, string>() : relTargets(workbookPart, await text(relsPart));
	if (workbookXml.sheets.length > maxSheets) throw new WorkbookTooLargeError('sheets', workbookXml.sheets.length, maxSheets);

	const source = new StreamedWorkbook(
		workbookXml.sheets.map((s) => s.name),
		workbookXml.names,
		workbookXml.date1904
	);
	const partOf = new Map<string, string>();
	for (const s of workbookXml.sheets) {
		const target = s.rid === undefined ? undefined : targets.get(s.rid);
		const part = target === undefined ? undefined : zip.find(target);
		if (part !== undefined) partOf.set(s.name, part);
	}
	const sheets = sheetsToRead(source).filter((s) => partOf.has(s));

	let styles = defaultStyles();
	if (pkg.styles !== null) {
		const part = zip.find(pkg.styles);
		if (part === undefined) throw new UnreadableWorkbookError(`it has no ${pkg.styles}, which its content types list`, 'corrupt');
		styles = readStyles(await zip.read(part), part);
	}

	for (const [i, name] of sheets.entries()) {
		opts.onProgress?.(name, i + 1, sheets.length);
		const part = partOf.get(name)!;
		const reader = new SheetReader(part, styles, workbookXml.date1904);
		const scanner = new XmlScanner(reader, part);
		await zip.stream(part, (chunk) => scanner.push(chunk));
		scanner.end();
		source.sheets.set(name, reader.finish());
	}

	// Then the shared strings, keeping only the ones those sheets use.
	const needed = new Set<number>();
	for (const cells of source.sheets.values()) for (const i of cells.sharedIndices()) needed.add(i);
	if (needed.size) {
		const part = pkg.strings.length ? zip.find(pkg.strings[0]!) : undefined;
		const strings = new SharedStringsReader(needed, part ?? 'sharedStrings');
		if (part !== undefined) {
			const scanner = new XmlScanner(strings, part);
			await zip.stream(part, (chunk) => scanner.push(chunk));
			scanner.end();
		}
		for (const i of needed) {
			if (strings.get(i) === undefined) throw new UnreadableWorkbookError('a cell in it refers to a shared string that is not there', 'corrupt');
		}
		const lookup = (i: number) => strings.get(i);
		for (const cells of source.sheets.values()) cells.sharedStrings = lookup;
	}
	return source;
}

/** A named range resolved to its sheet and 1-based corners. */
export interface Ref {
	sheet: string;
	c1: number;
	r1: number;
	c2: number;
	r2: number;
}

const REF_RE = /^'?(.+?)'?!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/;

/** SheetJS's error codes (what RawCell carries) → the text openpyxl returns for an error cell. */
const ERROR_TEXT: Record<number, string> = {
	0x00: '#NULL!',
	0x07: '#DIV/0!',
	0x0f: '#VALUE!',
	0x17: '#REF!',
	0x1d: '#NAME?',
	0x24: '#NUM!',
	0x2a: '#N/A',
	0x2b: '#GETTING_DATA'
};

/**
 * The named ranges the import can't do without; any missing means this isn't
 * a b023 workbook. (Names only expected.json uses aren't listed: the
 * TypeScript importer never builds it, decision D17.)
 */
export const REQUIRED_NAMES = [
	'zNetwork_ElementNameLst',
	'zNetwork_ElementTypeLst',
	'zNetwork_UpstreamTbl',
	'zNetwork_OutflowGauge',
	'zFarmSpec_FarmNameLst',
	'rFarmSpec_AreaTotal',
	'rFarmSpec_DataAreas',
	'zFarmSpec_PercFragmLst',
	'zFarmSpec_PercUpstrInflowToDamLst',
	'zFarmSpec_PercFarmRunoffToDamList',
	'zFarmSpec_CompositeDamVol',
	'zFarmSpec_StartStoragePercLst',
	'zFarmSpec_CompositeDamMinPerc',
	'zFarmSpec_DiversionToDam',
	'zFarmSpec_PercIrrReturnFlow',
	'rFarmSpec_SelectedMethod',
	'rFarmSpec_Methods',
	'rFarmSpec_FragmentationTolerance',
	'zCropDemand_CropNameLst',
	'zCropDemand_FactorsTbl',
	'rCropDemand_EffectiveRainfall',
	'zFarmDemand_FarmNameLst',
	'zFarmDemand_CropNameLst',
	'zFarmDemand_GrossMth',
	'zTransfers_HeaderFarmsFrom',
	'rAppSet_MonthLbls',
	'zAppSet_MonthDays',
	'zEWR_Pragmatic',
	'zFlowData_HeaderDate',
	'zFlowData_DateE_DateSeries',
	'zFlowData_HeaderHydrologyData',
	'zFlowData_HeaderUseRain',
	'rCalibration_RecessionFactors',
	'rCalibration_Curve',
	'rCalibration_PeakCoef_a',
	'rCalibration_PeakExp_b',
	'rCalibration_RainThreshold',
	'rCalibration_FactorSummer',
	'rCalibration_FactorWinter',
	'rCalibration_SummerMths',
	'rCalibration_MinFlowRatioToResetBase',
	'rCalibration_WinterTodayThresh',
	'rCalibration_WinterNextDayThresh',
	'rCalibration_ShiftPeakIndexLo',
	'rCalibration_ShiftPeakIndexHi',
	'rCalibration_Amplitude',
	'rCalibration_DaysMax'
] as const;

/** Named ranges read when present. */
export const OPTIONAL_NAMES = [
	'zAppVer',
	'zCalibration_Date1',
	'zCalibration_DateN',
	'rUseFlow',
	'zTransfers_FormulaRow',
	'zTransfers_FormulasAsTxt',
	'zTransfers_HeaderFarmsInOut',
	'zFarmDemand_GrossMthDays',
	'zHome_CalcDate1',
	'zHome_CalcDateN'
] as const;

const ALL_NAMES: readonly string[] = [...REQUIRED_NAMES, ...OPTIONAL_NAMES];

/** One workbook, read the way extract_project.py's Workbook class reads it. */
export class B023Workbook {
	private readonly names = new Map<string, string>();
	private readonly date1904: boolean;

	constructor(readonly source: WorkbookSource) {
		// openpyxl's wb.defined_names holds the workbook-scoped names (a later duplicate wins).
		for (const n of source.names) if (!n.local) this.names.set(n.name, n.ref);
		this.date1904 = source.date1904;
	}

	has(name: string): boolean {
		return this.names.has(name);
	}

	/** The required named ranges the workbook lacks. */
	missingNames(): string[] {
		return REQUIRED_NAMES.filter((n) => !this.names.has(n));
	}

	/** The sheet a named range points at, or null (missing or not a plain reference). */
	sheetOf(name: string): string | null {
		const text = this.names.get(name);
		const m = text === undefined ? null : REF_RE.exec(pyStrip(text));
		return m ? m[1]!.replace(/''/g, "'") : null;
	}

	/** Workbook.ref(): named range → sheet and corners. */
	ref(name: string): Ref {
		const text = this.names.get(name);
		if (text === undefined) throw new NotB023WorkbookError([name]);
		const m = REF_RE.exec(pyStrip(text));
		if (!m) throw new InvalidWorkbookError(`The named range ${name} is not a plain cell or range reference: ${text}`);
		const c1 = columnIndex(m[2]!);
		const r1 = Number(m[3]);
		return { sheet: m[1]!.replace(/''/g, "'"), c1, r1, c2: m[4] ? columnIndex(m[4]) : c1, r2: m[5] ? Number(m[5]) : r1 };
	}

	private sheet(name: string): SheetSource {
		const ws = this.source.sheet(name);
		if (ws) return ws;
		if (this.source.sheetNames.includes(name)) throw new Error(`sheet ${name} was not parsed (read the file with readWorkbook())`);
		throw new InvalidWorkbookError(`The workbook has no sheet [${name}], which its named ranges point at.`, name);
	}

	hasSheet(name: string): boolean {
		return this.source.sheetNames.includes(name);
	}

	/** The last row of the sheet's used range (1-based; 0 for an empty sheet). */
	lastRow(sheet: string): number {
		return this.sheet(sheet).lastRow;
	}

	/** One cell (1-based column and row), as openpyxl's cached value. */
	cell(sheet: string, col: number, row: number): Cell {
		return this.value(this.sheet(sheet).cell(col, row));
	}

	private value(c: RawCell | undefined): Cell {
		if (!c) return null;
		switch (c.t) {
			case 'n': {
				const v = c.v as number;
				if (!isDateFormat(c.z as string | undefined)) return v;
				return isTimedeltaFormat(c.z as string) ? durationFromExcel(v) : fromExcelSerial(v, this.date1904);
			}
			case 's':
				return String(c.v ?? '');
			case 'b':
				return Boolean(c.v);
			case 'e':
				return ERROR_TEXT[c.v as number] ?? '#UNKNOWN!';
			case 'd': {
				// An ISO-typed cell (t="d"; Excel itself doesn't write these). Read its calendar date, time zone free.
				const v = c.v as unknown;
				if (v instanceof Date) {
					const serial = (v.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
					return fromExcelSerial(serial);
				}
				return typeof v === 'string' ? v : null;
			}
			default:
				return null;
		}
	}

	/** Workbook.block(): a rectangle of cells, padded with blanks (1-based, inclusive). */
	block(sheet: string, c1: number, r1: number, c2: number, r2: number): Cell[][] {
		const out: Cell[][] = [];
		for (let r = r1; r <= r2; r++) {
			const row: Cell[] = [];
			for (let c = c1; c <= c2; c++) row.push(this.cell(sheet, c, r));
			out.push(row);
		}
		return out;
	}

	named(name: string): Cell[][] {
		const { sheet, c1, r1, c2, r2 } = this.ref(name);
		return this.block(sheet, c1, r1, c2, r2);
	}

	/** Workbook.cell(): a named range's first cell. */
	cellNamed(name: string): Cell {
		const { sheet, c1, r1 } = this.ref(name);
		return this.cell(sheet, c1, r1);
	}

	/**
	 * table_rows(): a b023 config table's name column below its header row, up
	 * to the '--' sentinel row, skipping blanks. Names are clean()ed.
	 */
	tableRows(name: string): { sheet: string; col: number; rows: number[]; names: string[] } {
		const { sheet, c1, r1, r2 } = this.ref(name);
		const rows: number[] = [];
		const names: string[] = [];
		for (let r = r1 + 1; r <= r2; r++) {
			const v = this.cell(sheet, c1, r);
			if (clean(v).startsWith('--')) break;
			if (isName(v)) {
				rows.push(r);
				names.push(clean(v));
			}
		}
		return { sheet, col: c1, rows, names };
	}
}
