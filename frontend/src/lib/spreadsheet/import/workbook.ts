// Reading a b023 workbook: SheetJS options, named ranges and cell values.
//
// extract_project.py opens the workbook with openpyxl
// load_workbook(read_only=True, data_only=True, keep_vba=False): cached
// values only. This does the same with SheetJS. Nothing here evaluates a
// formula (SheetJS never does) or reads macros: the VBA project isn't
// extracted (bookVBA false), formula text isn't kept (cellFormula false), and
// a formula cell Excel saved without a value reads as blank, as in openpyxl.
// The VBA project isn't even unpacked (see readWorkbook()).
//
// SheetJS's mini build: it reads .xlsx and .xlsm (the same container) without
// the legacy formats and codepages, which keeps the import worker small. The
// parity tests run through it on both kinds.
import * as XLSX from 'xlsx/dist/xlsx.mini.min';
import { type Cell, cellAddress, clean, columnIndex, isName, pyStrip } from './cells';
import { fromExcelSerial, isDateFormat, isTimedeltaFormat, durationFromExcel } from './dates';
import { InvalidWorkbookError, NotB023WorkbookError, UnreadableWorkbookError, WorkbookTooLargeError } from './errors';
import { packageParts, relsPathOf, sheetParts } from './ooxml';
import { type StoredEntry, type ZipLimits, ZipArchive, storedZip } from './zip';

/**
 * Largest file readWorkbook() accepts. A real catchment workbook with a
 * 40-year daily record is close to 90 MB (most of it the per-farm Element
 * sheets, which the importer skips), so the limit leaves room for a longer
 * record or more farms while still refusing an absurd upload.
 */
export const MAX_WORKBOOK_BYTES = 150_000_000;
/** Most sheets readWorkbook() accepts (b023 has about 30 plus one per element). */
export const MAX_WORKBOOK_SHEETS = 250;

/** The sheets the b023 named ranges live on; read first so the Element sheets are never parsed. */
const B023_SHEETS = ['AppSettings', 'Network', 'Farm spec', 'Crop demand', 'Farm demand', 'Transfers', 'Flow data', 'Flow Calibration Cfg', 'EWR Cfg'];

/** SheetJS options: cached values and number formats (to spot dates), nothing else. */
const READ_OPTIONS: XLSX.ParsingOptions = {
	type: 'array',
	dense: true,
	cellFormula: false,
	cellHTML: false,
	cellText: false,
	cellNF: true,
	cellDates: false,
	cellStyles: false,
	sheetStubs: false,
	bookVBA: false
};

export interface ReadLimits extends ZipLimits {
	maxBytes?: number;
	maxSheets?: number;
}

/**
 * Parse the workbook file for extractProject(). Only the sheets the b023
 * named ranges point at are parsed (the Element sheets of a large workbook
 * are most of its size and the project doesn't need them), so the result is
 * a partial WorkBook: SheetNames lists every sheet, Sheets holds those.
 *
 * SheetJS inflates every part of a zip it's handed, which for a client-size
 * workbook peaked near a gigabyte. So this opens the zip itself (./zip.ts)
 * and hands SheetJS only the parts the import reads: the content types and
 * relationships, the workbook, its shared strings, styles and metadata, and
 * those sheets. The Element sheets, the calculation chain, the VBA project,
 * drawings and media are never inflated.
 */
export async function readWorkbook(data: ArrayBuffer | Uint8Array, limits: ReadLimits = {}): Promise<XLSX.WorkBook> {
	const maxBytes = limits.maxBytes ?? MAX_WORKBOOK_BYTES;
	const maxSheets = limits.maxSheets ?? MAX_WORKBOOK_SHEETS;
	if (data.byteLength > maxBytes) throw new WorkbookTooLargeError('bytes', data.byteLength, maxBytes);
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	const zip = ZipArchive.open(bytes, limits);

	const parts = new Map<string, StoredEntry>();
	/** Inflate one part (once), kept under its exact name in the zip; false when the zip lacks it. */
	const load = async (name: string): Promise<boolean> => {
		const exact = zip.find(name);
		if (exact === undefined) return false;
		if (!parts.has(exact)) parts.set(exact, { name: exact, data: await zip.read(exact), crc: zip.info(exact)!.crc });
		return true;
	};
	const text = (name: string) => new TextDecoder().decode(parts.get(zip.find(name)!)!.data);

	if (!(await load('[Content_Types].xml'))) throw new UnreadableWorkbookError('it has no [Content_Types].xml, so it is not an Office file');
	const pkg = packageParts(text('[Content_Types].xml'));
	const workbookPart = pkg.workbook ?? (zip.find('xl/workbook.xml') ?? null);
	if (workbookPart === null || !(await load(workbookPart))) {
		throw new UnreadableWorkbookError(
			pkg.binary || zip.find('xl/workbook.bin') ? 'it is a binary .xlsb workbook; save it from Excel as .xlsm or .xlsx' : 'it has no workbook part'
		);
	}
	await load('_rels/.rels');
	const relsPart = zip.find(relsPathOf(workbookPart)) ?? 'xl/_rels/workbook.xml.rels';
	const hasRels = await load(relsPart);
	for (const p of pkg.support) await load(p);

	const layout = sheetParts(workbookPart, text(workbookPart), hasRels ? text(relsPart) : '');
	if (layout.names.length > maxSheets) throw new WorkbookTooLargeError('sheets', layout.names.length, maxSheets);

	const read = (sheets: string[]) => {
		const packed = storedZip([...parts.values()]);
		// The zip holds a copy; drop the inflated parts before SheetJS makes its own.
		if (sheets.length > 0) parts.clear();
		try {
			return XLSX.read(packed, { ...READ_OPTIONS, sheets });
		} catch (e) {
			throw new UnreadableWorkbookError(e instanceof Error ? e.message : String(e));
		}
	};
	// Pass 1, no sheets: the defined names, to see which sheets they point at.
	const book = new B023Workbook(read([]));
	const wanted = new Set<string>();
	for (const name of ALL_NAMES) {
		const target = book.sheetOf(name);
		if (target !== null && book.wb.SheetNames.includes(target)) wanted.add(target);
	}
	// The usual b023 sheets, or exactly the named ranges' sheets when those
	// lie elsewhere (renamed or moved tables).
	const sheets = [...wanted].every((s) => B023_SHEETS.includes(s)) ? B023_SHEETS : [...wanted];
	for (const s of pkg.strings) await load(s);
	for (const s of sheets) {
		const part = layout.parts.get(s);
		if (part !== undefined) await load(part);
	}
	// Pass 2: those sheets.
	return read(sheets);
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

/** SheetJS error codes → the text openpyxl returns for an error cell. */
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
	'zTransfers_HeaderFarmsInOut'
] as const;

const ALL_NAMES: readonly string[] = [...REQUIRED_NAMES, ...OPTIONAL_NAMES];

/** One workbook, read the way extract_project.py's Workbook class reads it. */
export class B023Workbook {
	private readonly names = new Map<string, string>();
	private readonly date1904: boolean;

	constructor(readonly wb: XLSX.WorkBook) {
		// openpyxl's wb.defined_names holds the workbook-scoped names (a later duplicate wins).
		for (const n of wb.Workbook?.Names ?? []) if (n.Sheet === undefined) this.names.set(n.Name, n.Ref);
		this.date1904 = Boolean(wb.Workbook?.WBProps?.date1904);
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

	private sheet(name: string): XLSX.WorkSheet {
		const ws = this.wb.Sheets[name];
		if (ws) return ws;
		if (this.wb.SheetNames.includes(name)) throw new Error(`sheet ${name} was not parsed (read the file with readWorkbook())`);
		throw new InvalidWorkbookError(`The workbook has no sheet [${name}], which its named ranges point at.`, name);
	}

	hasSheet(name: string): boolean {
		return this.wb.SheetNames.includes(name);
	}

	/** The last row of the sheet's used range (1-based; 0 for an empty sheet). */
	lastRow(sheet: string): number {
		const ref = this.sheet(sheet)['!ref'];
		return ref ? XLSX.utils.decode_range(ref).e.r + 1 : 0;
	}

	/** One cell (1-based column and row), as openpyxl's cached value. */
	cell(sheet: string, col: number, row: number): Cell {
		const ws = this.sheet(sheet);
		const dense = (ws as { '!data'?: XLSX.CellObject[][] })['!data'];
		const c = dense ? dense[row - 1]?.[col - 1] : (ws[cellAddress(col, row)] as XLSX.CellObject | undefined);
		return this.value(c);
	}

	private value(c: XLSX.CellObject | undefined): Cell {
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
