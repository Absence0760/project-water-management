// The Excel audit workbook for one farm of a run (issue #68): its daily water
// balance as live Excel formulas over the farm's inputs, beside the model's
// own numbers and a column with the largest difference each day, so Excel
// (or LibreOffice, or Google Sheets) recomputes the model independently.
// The engine decides the columns and formulas (verify/audit.ts
// farmAuditPlan); this lays them out and writes them with the run export's
// writer (../export/writer.ts). Pure (no I/O): ./collect.ts fetches.
//
// Sheets: the disclaimer; About (the run, how to read the file, the largest
// difference over the run as a formula); Parameters (the farm's fixed
// inputs, one cell each, that the formulas refer to); Audit (date, inputs as
// values, formula columns, the difference column); Model (the same columns
// with the run's stored numbers).
import { auditFormula, evaluateAudit, isFormula, type AuditColumn, type FarmAuditPlan } from '@water-management/engine';
import { DATE_FORMAT, numberFormat } from '../export/formats';
import { defuse } from '../export/names';
import { readFirstRows, rowCells } from '../export/workbook';
import { colName, XlsxWorkbook, type XlsxCell, type XlsxDailyColumn } from '../export/writer';

export interface AuditWorkbookInput {
	plan: FarmAuditPlan;
	/** The run as GET …/runs/:runId names it. */
	run: { label: string; engineVersion: string };
	/** The site's address, for the disclaimer's Terms URL; '' leaves the path. */
	site?: string;
}

/** Excel's serial for 1970-01-01 (the 1900 date system). */
const EPOCH_SERIAL = 25569;
export const SHEETS = { first: 'Read this first', about: 'About', params: 'Parameters', audit: 'Audit', model: 'Model' } as const;
/** The Audit sheet's last column: on each day, the largest |formula − model| over the formula columns. */
export const DIFFERENCE_HEADER = 'Largest |Excel − model| over the formula columns';

/** A column's header, as the daily CSV writes a farm column: label [letter] (unit); a column taken from the run as given says so. */
export function columnHeader(c: AuditColumn): string {
	return defuse(`${isFormula(c) ? '' : 'From the run: '}${c.label}${c.letter ? ` [${c.letter}]` : ''}${c.unit ? ` (${c.unit})` : ''}`);
}

/** Where each thing sits: a column's letter on Audit and Model (A is the date), a parameter's cell. */
export function auditLayout(plan: FarmAuditPlan) {
	const letter = new Map(plan.columns.map((c, i) => [c.key, colName(i + 1)]));
	const paramRow = new Map(plan.params.map((p, i) => [p.id, i + 2]));
	const paramRef = (id: string) => {
		const r = paramRow.get(id);
		if (r === undefined) throw new Error(`audit: no parameter ${id}`);
		return `${SHEETS.params}!$B$${r}`;
	};
	return { letter, paramRef, differenceLetter: colName(plan.columns.length + 1), lastRow: plan.days + 1 };
}

const ROW = '\u0000';
const ROW_ABOVE = '\u0001';

/**
 * Each formula column's formula as a function of its sheet row: row 2 (the
 * first day) takes the row above from its starting parameter, every later
 * row from the row above.
 */
export function formulaColumns(plan: FarmAuditPlan): Map<string, (row: number) => string> {
	const { letter, paramRef } = auditLayout(plan);
	const out = new Map<string, (row: number) => string>();
	for (const c of plan.columns) {
		if (!isFormula(c)) continue;
		const text = (first: boolean) =>
			auditFormula(
				c.expr,
				(key, prev) => {
					const l = letter.get(key);
					if (!l) throw new Error(`audit: no column ${key}`);
					if (!prev) return `${l}${ROW}`;
					if (first) return paramRef(plan.initial[key] ?? '');
					return `${l}${ROW_ABOVE}`;
				},
				paramRef
			);
		const first = text(true);
		const rest = text(false);
		out.set(c.key, (row) => (row === 2 ? first : rest).replaceAll(ROW, String(row)).replaceAll(ROW_ABOVE, String(row - 1)));
	}
	return out;
}

/** The difference column's formula on `row`: MAX over the formula columns of ABS(Audit − Model). */
export function differenceFormula(plan: FarmAuditPlan, row: number): string {
	const { letter } = auditLayout(plan);
	const terms = plan.columns.filter(isFormula).map((c) => `ABS(${letter.get(c.key)}${row}-${SHEETS.model}!${letter.get(c.key)}${row})`);
	return `MAX(${terms.join(',')})`;
}

/** The About sheet's rows; the largest difference over the run is a formula. */
function aboutRows(input: AuditWorkbookInput, largest: number): (XlsxCell | undefined)[][] {
	const { plan, run } = input;
	const { differenceLetter, lastRow } = auditLayout(plan);
	const end = new Date(Date.parse(`${plan.startDate}T00:00:00Z`) + (plan.days - 1) * 86_400_000).toISOString().slice(0, 10);
	const inputs = plan.columns.filter((c) => !isFormula(c));
	const firstFormula = plan.columns.findIndex(isFormula);
	const s = (v: string): XlsxCell => ({ t: 's', v });
	return [
		[s(defuse(`Audit workbook: ${plan.name}`))],
		[s('Run'), s(defuse(run.label))],
		[s('Engine version'), s(run.engineVersion)],
		[s('Period'), s(`${plan.startDate} to ${end} (${plan.days} days)`)],
		[],
		[
			s('Largest |Excel − model| over the run (m³, m³/day or m²)'),
			{ t: 'f', f: `MAX(${SHEETS.audit}!${differenceLetter}2:${differenceLetter}${lastRow})`, v: largest, z: '0.00E+00' }
		],
		[],
		[s('What this is'), s(`The ${SHEETS.audit} sheet recomputes this unit's daily water balance with live formulas, so this spreadsheet checks the model's arithmetic on its own.`)],
		[s('Inputs'), s(`Columns B to ${colName(inputs.length)} of ${SHEETS.audit} are inputs taken from the run as given, not recomputed here: rain, the open-water evaporation depth, the demand side (gross demand, the effective rain used, the demand factor) and what arrives from the rest of the network (H, I, J and the EWR Z). The model checks those in its own verification.`)],
		[
			s('Formulas'),
			s(`Columns ${colName(firstFormula + 1)} to ${colName(plan.columns.length)} are formulas over the inputs, the ${SHEETS.params} sheet and the row above (the dam's storage carries from day to day; day one starts from the storage parameter).`)
		],
		[s('Model'), s(`The ${SHEETS.model} sheet holds the model's own numbers in the same columns. The last column of ${SHEETS.audit} is each day's largest difference: float noise, far below a litre, when the two agree. Excel sets a difference within about 1e-15 of zero to exactly 0, so it can read 0 where the model's own check shows 1e-12: the two agree.`)],
		[s('Letters'), s('Letters in brackets are the b023 FarmTemplate columns (docs/model.md §2.7).')],
		[
			s('Editing'),
			s(
				'Change a parameter or an input and every later day recomputes. A few formulas were shaped by the parameters when the file was written (the evaporation limit when b > 1, the seepage split, the diversion cap), so a structural change is a new export.'
			)
		]
	];
}

/** The workbook as .xlsx bytes. */
export async function buildAuditWorkbook(input: AuditWorkbookInput): Promise<Uint8Array<ArrayBuffer>> {
	const { plan } = input;
	const { values, largestDifference } = evaluateAudit(plan);
	const formulas = formulaColumns(plan);
	const book = new XlsxWorkbook();

	const first = rowCells(readFirstRows(input.site));
	book.addRows(SHEETS.first, first.cells, first.lastCol, [120]);
	const worst = largestDifference.reduce((a, b) => Math.max(a, b), 0);
	book.addRows(SHEETS.about, aboutRows(input, worst), 1, [44, 120]);
	const params: (XlsxCell | undefined)[][] = [
		[{ t: 's', v: 'Parameter' }, { t: 's', v: 'Value' }, { t: 's', v: 'Unit' }],
		...plan.params.map((p): XlsxCell[] => [{ t: 's', v: p.label }, { t: 'n', v: p.value }, { t: 's', v: p.unit ?? '' }])
	];
	book.addRows(SHEETS.params, params, 2, [60, 16, 10]);

	const day0 = Date.parse(`${plan.startDate}T00:00:00Z`) / 86_400_000 + EPOCH_SERIAL;
	const header = ['date', ...plan.columns.map(columnHeader)];
	const widths = [11, ...plan.columns.map(() => 14)];
	const audit: XlsxDailyColumn[] = plan.columns.map((c) => ({
		format: numberFormat(c.unit),
		values: isFormula(c) ? values.get(c.key)! : c.values!,
		...(isFormula(c) ? { formula: formulas.get(c.key)! } : {})
	}));
	audit.push({ format: '0.00E+00', values: largestDifference, formula: (row) => differenceFormula(plan, row) });
	book.addDaily(SHEETS.audit, [...header, DIFFERENCE_HEADER], DATE_FORMAT, day0, audit, [...widths, 18]);
	const model: XlsxDailyColumn[] = plan.columns.map((c) => ({ format: numberFormat(c.unit), values: isFormula(c) ? c.model : c.values! }));
	book.addDaily(SHEETS.model, header, DATE_FORMAT, day0, model, widths);
	return book.bytes();
}

/** The file name: `<run>_<unit>_audit.xlsx`, each name lower-cased and reduced to letters, digits, `-` and `_` (as the server's export names). */
export function auditFilename(runLabel: string, unitName: string): string {
	const slug = (s: string) =>
		s
			.normalize('NFKD')
			.replace(/[^\w-]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.slice(0, 60)
			.toLowerCase() || 'x';
	return `${slug(runLabel)}_${slug(unitName)}_audit.xlsx`;
}
