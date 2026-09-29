// The audit workbook's file (./auditWorkbook.ts): its sheets, the live
// formulas on the Audit sheet and where they point (Parameters, the row
// above, the Model sheet), their last values, and Excel told to recompute
// on open. Read back with the import side's own zip reader.
import { evaluateAudit, isFormula } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { XlsxWorkbook } from '../export/writer';
import { ZipArchive } from '../import/zip';
import { auditFilename, auditLayout, buildAuditWorkbook, columnHeader, differenceFormula, formulaColumns, SHEETS } from './auditWorkbook';
import { auditFixture } from './fixture';

const fx = auditFixture();
const text = async (bytes: Uint8Array<ArrayBuffer>, part: string) => new TextDecoder().decode(await (await ZipArchive.open(bytes)).read(part));
const cellXml = (sheet: string, ref: string) => new RegExp(`<c r="${ref}"[^>]*>(.*?)</c>`).exec(sheet)?.[1] ?? null;
const unescape = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const formulaOf = (sheet: string, ref: string) => {
	const m = /<f>(.*?)<\/f>/.exec(cellXml(sheet, ref) ?? '');
	return m ? unescape(m[1]!) : null;
};
const valueOf = (sheet: string, ref: string) => Number(/<v>(.*?)<\/v>/.exec(cellXml(sheet, ref) ?? '')?.[1]);

describe('buildAuditWorkbook', async () => {
	const bytes = await buildAuditWorkbook({ plan: fx.plan, run: { label: 'Baseline', engineVersion: '9.9.9' } });
	const workbook = await text(bytes, 'xl/workbook.xml');
	const [first, about, params, audit, model] = await Promise.all([1, 2, 3, 4, 5].map((i) => text(bytes, `xl/worksheets/sheet${i}.xml`)));
	const { letter, differenceLetter, lastRow } = auditLayout(fx.plan);
	const L = (key: string) => letter.get(key)!;

	it('has the disclaimer, About, Parameters, Audit and Model sheets, and asks Excel to recompute on open', () => {
		expect([...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual([SHEETS.first, SHEETS.about, SHEETS.params, SHEETS.audit, SHEETS.model]);
		expect(workbook).toContain('<calcPr fullCalcOnLoad="1"/>');
		expect(first).toContain('Read this first');
	});

	it('keeps the run workbook as it was: no formulas, no recalculation flag', async () => {
		const book = new XlsxWorkbook();
		book.addDaily('Daily', ['date', 'Rain (mm)'], 'yyyy-mm-dd', 25569, [{ format: undefined, values: [1, 2] }], [11, 14]);
		expect(await text(await book.bytes(), 'xl/workbook.xml')).not.toContain('calcPr');
	});

	it('writes each parameter as a value the formulas refer to', () => {
		fx.plan.params.forEach((p, i) => expect(valueOf(params, `B${i + 2}`)).toBe(p.value));
	});

	it("starts the dam from the storage parameter on day one and from the row above after", () => {
		const initialRow = fx.plan.params.findIndex((p) => p.id === 'initial') + 2;
		expect(formulaOf(audit, `${L('dam_area')}2`)).toContain(`${SHEETS.params}!$B$${initialRow}`);
		expect(formulaOf(audit, `${L('dam_area')}3`)).toContain(`${L('dam_storage')}2`);
		expect(formulaOf(audit, `${L('dam_area')}3`)).not.toContain(`$B$${initialRow}`);
		expect(formulaOf(audit, `${L('dam_storage')}${lastRow}`)).toBe(`MIN(${L('interim_storage')}${lastRow},${SHEETS.params}!$B$${fx.plan.params.findIndex((p) => p.id === 'capacity') + 2})`);
	});

	it('writes every formula column as a formula with its computed value, and the inputs as values', () => {
		const { values } = evaluateAudit(fx.plan);
		const formulas = formulaColumns(fx.plan);
		for (const c of fx.plan.columns) {
			for (const row of [2, 3, lastRow]) {
				const ref = `${L(c.key)}${row}`;
				if (isFormula(c)) {
					expect(formulaOf(audit, ref), ref).toBe(formulas.get(c.key)!(row));
					expect(valueOf(audit, ref), ref).toBe(values.get(c.key)![row - 2]);
					expect(valueOf(model, ref), ref).toBe(fx.plan.columns.find((x) => x.key === c.key)!.model![row - 2]);
				} else {
					expect(formulaOf(audit, ref), ref).toBeNull();
					const v = c.values![row - 2];
					if (v === null) expect(cellXml(audit, ref)).toBeNull();
					else expect(valueOf(audit, ref), ref).toBe(v);
				}
			}
		}
	});

	it('compares every formula column with the Model sheet each day, and the run on About', () => {
		const f = formulaOf(audit, `${differenceLetter}5`)!;
		expect(f).toBe(differenceFormula(fx.plan, 5));
		for (const c of fx.plan.columns.filter(isFormula)) expect(f).toContain(`ABS(${L(c.key)}5-${SHEETS.model}!${L(c.key)}5)`);
		expect(valueOf(audit, `${differenceLetter}5`)).toBeLessThan(1e-6);
		expect(formulaOf(about, 'B6')).toBe(`MAX(${SHEETS.audit}!${differenceLetter}2:${differenceLetter}${lastRow})`);
		expect(valueOf(about, 'B6')).toBeLessThan(1e-6);
	});

	it('labels columns as the daily CSV does and marks the inputs', () => {
		const header = [...audit.matchAll(/<c r="[A-Z]+1"[^>]*><v>(.*?)<\/v><\/c>/g)].map((m) => unescape(m[1]!));
		expect(header[0]).toBe('date');
		expect(header).toContain('From the run: Inflow from upstream [H] (m³/day)');
		expect(header).toContain('Irrigation supplied [G] (m³/day)');
		expect(header.at(-1)).toMatch(/Largest \|Excel − model\|/);
	});
});

describe('names', () => {
	it('defuse a unit or run named like a formula', async () => {
		const plan = { ...fx.plan, name: '=HYPERLINK("x")' };
		const about = await text(await buildAuditWorkbook({ plan, run: { label: '+run', engineVersion: '1' } }), 'xl/worksheets/sheet2.xml');
		expect(about).toContain('Audit workbook: =HYPERLINK');
		expect(about).toContain('&apos;+run');
		expect(columnHeader({ key: 'x', letter: null, label: '=1+1', unit: '', expr: 0 })).toBe("'=1+1");
	});

	it('make a file name from the run and the unit', () => {
		expect(auditFilename('Baseline 2026/27', 'Upper farm: dam')).toBe('baseline_2026_27_upper_farm_dam_audit.xlsx');
		expect(auditFilename('***', '')).toBe('x_x_audit.xlsx');
	});
});
