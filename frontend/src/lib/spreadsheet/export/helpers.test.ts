// The workbook's pure helpers: CSV reading, sheet names, number formats and
// the summary's sheet routing.
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { cellFormat, numberFormat, unitOf } from './formats';
import { defuse, sheetNamer } from './names';
import { splitSummary } from './summary';

describe('parseCsv', () => {
	it('reads the backend CSV: BOM, CRLF, quoting, blank lines, trailing empties', () => {
		const text = '\uFEFFa,"b, ""c""",\r\n\r\n"multi\r\nline",1.5\r\n';
		expect(parseCsv(text)).toEqual([['a', 'b, "c"', null], [], ['multi\r\nline', 1.5]]);
	});

	it('types exactly the numbers the backend writes, and nothing else', () => {
		const [row] = parseCsv('0.30000000000000004,-4.77e-13,5e+21,1e-7,007,1e3,2001/02,-0,"12",,x\r\n');
		expect(row).toEqual([0.30000000000000004, -4.77e-13, 5e21, 1e-7, '007', '1e3', '2001/02', '-0', '12', null, 'x']);
	});

	it('keeps a defused formula as text', () => {
		expect(parseCsv("'=1+1,'@SUM(A1)")).toEqual([["'=1+1", "'@SUM(A1)"]]);
	});

	it('refuses an unterminated quote', () => {
		expect(() => parseCsv('"open')).toThrow(/unterminated/);
	});
});

describe('defuse', () => {
	it('prefixes formula-looking text like the CSV exports, and leaves the rest', () => {
		for (const s of ['=cmd', '+1', '-2', '@SUM(A1)', '\tx', '\rx']) expect(defuse(s)).toBe(`'${s}`);
		for (const s of ['Upper farm', 'a=b', '', "'quoted"]) expect(defuse(s)).toBe(s);
	});
});

describe('sheetNamer', () => {
	it('makes Excel-safe, unique names ignoring case, at most 31 characters', () => {
		const name = sheetNamer();
		expect(name('Summary')).toBe('Summary');
		expect(name('summary')).toBe('summary (2)');
		expect(name('SUMMARY')).toBe('SUMMARY (3)');
		expect(name('a/b\\c[d]:e*f?g')).toBe('a_b_c_d__e_f_g');
		expect(name("'quoted'")).toBe('quoted');
		expect(name('   ')).toBe('Sheet');
		expect(name('History')).toBe('History_');
		expect(name('line\nbreak')).toBe('line break');
		const long = 'x'.repeat(40);
		expect(name(long)).toBe('x'.repeat(31));
		expect(name(long)).toBe(`${'x'.repeat(27)} (2)`);
		// A 31-character cut never splits an emoji's surrogate pair.
		expect(name(`${'y'.repeat(30)}💧`)).toBe('y'.repeat(30));
	});
});

describe('number formats', () => {
	it('reads the unit from the last bracket of a header', () => {
		expect(unitOf('Irrigation supplied [G] (m³/day)')).toBe('m³/day');
		expect(unitOf('Gross irrigation demand (before effective rain) (m³/day)')).toBe('m³/day');
		expect(unitOf('Supplied [K] (% of demand)')).toBe('% of demand');
		expect(unitOf('Runoff coefficient')).toBeNull();
	});

	it('picks a display format per unit, General otherwise', () => {
		expect(numberFormat('m³/day')).toBe('#,##0.00');
		expect(numberFormat('m³')).toBe('#,##0.00');
		expect(numberFormat('Mm³')).toBe('#,##0.000');
		expect(numberFormat('m³/s')).toBe('#,##0.000');
		expect(numberFormat('mm')).toBe('#,##0.0');
		// The exports write shares as 0–100: no `%` code, which would multiply by 100.
		expect(numberFormat('%')).toBe('0.0');
		expect(numberFormat('% of demand')).toBe('0.0');
		expect(numberFormat('×')).toBe('0.000');
		expect(numberFormat('flag')).toBe('0');
		expect(numberFormat('')).toBeUndefined();
		expect(numberFormat(null)).toBeUndefined();
		expect(numberFormat('furlongs')).toBeUndefined();
	});

	it('gives a small non-zero flow or volume the decimals for two significant figures (issue #45)', () => {
		expect(cellFormat('m³/s', 0.00042)).toBe('#,##0.00000');
		expect(cellFormat('Mm³', -0.0042)).toBe('#,##0.0000');
		expect(cellFormat('l/s', 0.009)).toBe('#,##0.0000');
		// Unchanged: zero, from 0.01 up, and every other unit.
		expect(cellFormat('m³/s', 0)).toBe('#,##0.000');
		expect(cellFormat('m³/s', 0.01)).toBe('#,##0.000');
		expect(cellFormat('m³/s', 1234.5)).toBe('#,##0.000');
		expect(cellFormat('m³/day', 0.00042)).toBe('#,##0.00');
		expect(cellFormat(null, 0.00042)).toBeUndefined();
		expect(cellFormat('m³/s', 1e-30)).toBe(`#,##0.${'0'.repeat(12)}`);
	});
});

describe('splitSummary', () => {
	it('keeps an unknown block on the sheet of the block before it', () => {
		const rows = parseCsv('Project,P\r\n\r\nCurtailment targets\r\nx,1\r\n\r\nSomething new\r\ny,2\r\n\r\nWarnings\r\nw\r\n');
		const out = splitSummary(rows);
		expect([...out.keys()]).toEqual(['Summary', 'Curtailment', 'Warnings']);
		expect(out.get('Curtailment')).toEqual([['Curtailment targets'], ['x', 1], [], ['Something new'], ['y', 2]]);
	});

	it('puts the assurance of supply and stress classes with the curtailment, the water account with the annual volumes (engine ≥ 0.32.0)', () => {
		const rows = parseCsv(
			'Curtailment targets\r\nx,1\r\n\r\nWater balance by water year (Oct–Sep)\r\nb,1\r\n\r\nAssurance of supply (reporting window)\r\nr,1\r\n\r\nStress classes by month (supplied ÷ demand)\r\ns,1\r\n\r\nWater account by water year (Oct–Sep)\r\na,1\r\n\r\nCHIRPS bias correction\r\nc,1\r\n'
		);
		const out = splitSummary(rows);
		expect(out.get('Curtailment')!.map((r) => r[0])).toEqual(['Curtailment targets', 'x', undefined, 'Assurance of supply (reporting window)', 'r', undefined, 'Stress classes by month (supplied ÷ demand)', 's']);
		expect(out.get('Annual volumes')!.map((r) => r[0])).toEqual(['Water balance by water year (Oct–Sep)', 'b', undefined, 'Water account by water year (Oct–Sep)', 'a']);
		expect(out.get('Data checks')!.map((r) => r[0])).toEqual(['CHIRPS bias correction', 'c']);
	});
});
