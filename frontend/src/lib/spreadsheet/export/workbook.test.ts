import { DISCLAIMER, withSite, type RunSummary } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx/dist/xlsx.mini.min';
import { parseCsv } from './csv';
import { createRequire } from 'node:module';
import { dailyCells, dailyStub, sheetjsWorkbook, streamDailySheet } from './sheetjsReference';
import { annualVolumeRows, buildWorkbook, ewrGridRows, inputRows, type DailyColumn, type DailyTable, type WorkbookInput } from './workbook';

const require = createRequire(import.meta.url);

// Synthetic run data only (the repo is public).
const CSV_LINES = [
	'Project,Synthetic catchment',
	'Run,"Baseline, v2"',
	'Run notes,\'=HYPERLINK("x")',
	'',
	'Self-checks',
	'All passed,yes',
	'',
	'Farm summary',
	'Farm,Average supplied (m³/day),Demand supplied (%)',
	"'=cmd|' /C calc'!A0,123.456789012345,87.5",
	'Upper farm,0.1,100',
	'',
	'Catchment',
	'Mean natural flow (m³/day),4321.123456789',
	'',
	'Curtailment targets',
	'Reporting window,2021-10-01,2022-01-28,120 days',
	'Farm,Average demand [H] (m³/day)',
	'Upper farm,12.5',
	'',
	'EWR sites (reporting window)',
	'Site,Outlet',
	'Gauge,yes',
	'',
	'Reserve compliance by month (EWR rule tables)',
	'Not assessed: no EWR rule table',
	'',
	'Water balance by water year (Oct–Sep)',
	'Water year,Rain (mm),Outflow (m³)',
	'2021/22,312.4,1500000.25',
	'',
	'CHIRPS bias correction',
	'No CHIRPS series — nothing to correct',
	'',
	'Plausibility checks',
	'Dry season (months),Jan Feb',
	'',
	'Natural flow vs observed flow + net abstraction',
	'Not checked: the run has no observed flow record',
	'',
	'Calibration (outflow gauge vs observed)',
	'NSE,0.7123456789',
	'',
	'Warnings',
	'Something to check'
];
const summaryCsv = '\uFEFF' + CSV_LINES.join('\r\n') + '\r\n';

const summary = {
	farms: [],
	warnings: ['Something to check'],
	calibration: {
		annualVolumes: [{ waterYear: 2021, days: 100, daysInWindow: 120, observedMm3: 1.25, simulatedMm3: 1.5, diffPct: 20 }]
	},
	ewrCompliance: {
		waterYears: [2021],
		days: [[31, 30, 31, 28, 0, 0, 0, 0, 0, 0, 0, 0]],
		outlet: { nodeId: null, name: 'Outlet', daysNotMet: [[1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]], shortfallM3: [[10.5, 20.25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]] },
		farms: [{ nodeId: 'f1', name: '=Upper farm', daysNotMet: [[0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]], shortfallM3: [[0, 3.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]] }]
	}
} as unknown as RunSummary;

const catchment: DailyTable = {
	name: 'Catchment',
	startDate: '2021-10-01',
	columns: [
		{ header: 'Natural flow (m³/day)', unit: 'm³/day', values: [1234.5678901234567, 0, null, 1e-7] },
		{ header: 'Rain used (mm)', unit: 'mm', values: [12.3, 0, 0.1, 5] }
	]
};
const farm = (name: string): DailyTable => ({
	name,
	startDate: '2021-10-01',
	columns: [
		{ header: 'Irrigation supplied [G] (m³/day)', unit: 'm³/day', values: [0.1 + 0.2, 1 / 3, 2 / 3, -0] },
		{ header: 'Dam storage [Q] (m³)', unit: 'm³', values: [100000.00000000001, 99999.99999999999, 5e21, null] },
		{ header: 'Balance check (should be 0) [V] (m³/day)', unit: 'm³/day', values: [-4.77e-13, 0, 0, 0] },
		{ header: 'Unitless', unit: null, values: [1, 2, 3, 4] }
	]
});

const input = (over: Partial<WorkbookInput> = {}): WorkbookInput => ({
	summaryCsv,
	summary,
	settings: { apanMm: [150, 150, 140, 130, 120, 110, 100, 110, 120, 130, 140, 150], runoffModel: 'gr4j', gr4j: { x1: 350, x2: 0 } },
	model: {
		nodes: [
			{ id: 'g', name: 'Gauge', kind: 'gauge', downstreamNodeId: null },
			{ id: 'f1', name: '=Upper farm', kind: 'farm', downstreamNodeId: 'g', damCapacityM3: 100000 }
		],
		crops: [{ id: 'c', name: 'Lucerne', cropFactor: [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8] }],
		cropAreas: [{ nodeId: 'f1', cropId: 'c', areaM2: 20000 }],
		transfers: []
	},
	catchment,
	nodes: [farm('=Upper farm'), farm('Summary'), farm('A farm with a very long name: [north]/south*?')],
	...over
});

const read = (bytes: Uint8Array) => XLSX.read(bytes, { type: 'array', cellNF: true });
const aoa = (ws: XLSX.WorkSheet) => XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });

describe('buildWorkbook', () => {
	let wb: XLSX.WorkBook;
	beforeAll(async () => {
		wb = read(await buildWorkbook(input()));
	});

	it('leads with the disclaimer, every paragraph with the Terms URL filled in, and its version', async () => {
		const rows = aoa(read(await buildWorkbook(input({ site: 'https://water.example.com' }))).Sheets['Read this first']!).map((r) => r[0]);
		DISCLAIMER.paragraphs.forEach((p, i) => expect(rows).toContain(`${i + 1}. ${withSite(p, 'https://water.example.com')}`));
		expect(rows.some((r) => String(r).endsWith('Terms of use: https://water.example.com/terms.'))).toBe(true);
		expect(rows).toContain(`Disclaimer version ${DISCLAIMER.version}.`);
	});

	it('names the sheets in order, Excel-safe and unique', () => {
		expect(wb.SheetNames).toEqual([
			'Read this first',
			'Summary',
			'Catchment',
			'=Upper farm',
			'Summary (2)',
			'A farm with a very long name_ _',
			'Curtailment',
			'EWR grid',
			'Reserve compliance',
			'Annual volumes',
			'Data checks',
			'Inputs',
			'Warnings'
		]);
		for (const n of wb.SheetNames) {
			expect(n.length).toBeLessThanOrEqual(31);
			expect(n).not.toMatch(/[[\]:*?/\\]/);
		}
	});

	it('writes daily headers with units and every value at full precision', () => {
		const rows = aoa(wb.Sheets['Catchment']!);
		expect(rows[0]).toEqual(['date', 'Natural flow (m³/day)', 'Rain used (mm)']);
		// Dates are real Excel dates, shown as ISO.
		expect(wb.Sheets['Catchment']!['A2'].w).toBe('2021-10-01');
		expect(wb.Sheets['Catchment']!['A5'].w).toBe('2021-10-04');
		expect(rows.slice(1).map((r) => r.slice(1))).toEqual([
			[1234.5678901234567, 12.3],
			[0, 0],
			[null, 0.1],
			[1e-7, 5]
		]);
		const f = aoa(wb.Sheets['=Upper farm']!);
		expect(f[0]).toEqual(['date', 'Irrigation supplied [G] (m³/day)', 'Dam storage [Q] (m³)', 'Balance check (should be 0) [V] (m³/day)', 'Unitless']);
		expect(f.slice(1).map((r) => r.slice(1))).toEqual([
			[0.30000000000000004, 100000.00000000001, -4.77e-13, 1],
			[1 / 3, 99999.99999999999, 0, 2],
			[2 / 3, 5e21, 0, 3],
			[0, null, 0, 4]
		]);
	});

	it('shows numbers with a per-column display format, leaving the value unrounded', () => {
		const ws = wb.Sheets['=Upper farm']!;
		expect(ws['B2'].z).toBe('#,##0.00');
		expect(ws['B2'].v).toBe(0.30000000000000004);
		expect(ws['C2'].z).toBe('#,##0.00');
		expect(ws['A2'].z).toBe('yyyy-mm-dd');
		expect(ws['E2'].z ?? 'General').toBe('General');
		expect(wb.Sheets['Catchment']!['C2'].z).toBe('#,##0.0');
		// Summary tables take the unit from their header, key/value rows from the label.
		const s = wb.Sheets['Summary']!;
		const supplied = aoa(s).findIndex((r) => r[0] === 'Upper farm');
		expect(s[XLSX.utils.encode_cell({ r: supplied, c: 1 })].z).toBe('#,##0.00');
		expect(s[XLSX.utils.encode_cell({ r: supplied, c: 2 })].z).toBe('0.0');
		const flow = aoa(s).findIndex((r) => r[0] === 'Mean natural flow (m³/day)');
		expect(s[XLSX.utils.encode_cell({ r: flow, c: 1 })]).toMatchObject({ v: 4321.123456789, z: '#,##0.00' });
	});

	it('puts the FDC percentile table on the Summary sheet, a small flow shown to two significant figures (issue #45)', async () => {
		const fdc = [
			'Flow-duration percentiles (flow equalled or exceeded on 10/50/90/95 % of days; Weibull plotting positions)',
			'Days ranked,Flow record,Q10 (m³/s),Q50 (m³/s),Q90 (m³/s),Q95 (m³/s),Days',
			'Whole run,Natural,12.5,0.5,0.0123,0.00042,365'
		];
		const withFdc = '﻿' + [...CSV_LINES.slice(0, CSV_LINES.indexOf('Warnings') - 1), '', ...fdc, '', 'Warnings', 'Something to check'].join('\r\n') + '\r\n';
		const book = read(await buildWorkbook(input({ summaryCsv: withFdc })));
		const s = book.Sheets['Summary']!;
		const r = aoa(s).findIndex((row) => row[0] === 'Whole run' && row[1] === 'Natural');
		expect(r).toBeGreaterThan(0);
		expect(aoa(s)[r - 2]![0]).toMatch(/^Flow-duration percentiles/);
		const cells = [2, 3, 4, 5].map((c) => s[XLSX.utils.encode_cell({ r, c })]);
		expect(cells.map((c) => c.v)).toEqual([12.5, 0.5, 0.0123, 0.00042]);
		expect(cells.map((c) => c.z)).toEqual(['#,##0.000', '#,##0.000', '#,##0.000', '#,##0.00000']);
		expect(cells.map((c) => XLSX.SSF.format(c.z, c.v))).toEqual(['12.500', '0.500', '0.012', '0.00042']);
	});

	it('spreads the summary CSV over its sheets, every row once, values equal to the CSV', () => {
		const csv = parseCsv(summaryCsv);
		const nonEmpty = (rows: unknown[][]) => rows.filter((r) => r.some((c) => c !== null)).map((r) => r.slice(0, r.findLastIndex((c) => c !== null) + 1));
		const sheets = ['Summary', 'Curtailment', 'Reserve compliance', 'Annual volumes', 'Data checks', 'Warnings'].map((n) => nonEmpty(aoa(wb.Sheets[n]!)));
		// Annual volumes ends with the calibration volumes from the run JSON, not the CSV.
		sheets[3]!.splice(-nonEmpty(annualVolumeRows(summary)).length);
		const key = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();
		expect(key(sheets.flat())).toEqual(key(nonEmpty(csv)));
		// Each sheet keeps the CSV's order.
		const lines = nonEmpty(csv).map((r) => JSON.stringify(r));
		for (const sheet of sheets) {
			const at = sheet.map((r) => lines.indexOf(JSON.stringify(r)));
			expect(at).toEqual([...at].sort((a, b) => a - b));
		}
		expect(sheets[4]!.map((r) => r[0])).toEqual(['CHIRPS bias correction', 'No CHIRPS series — nothing to correct', 'Plausibility checks', 'Dry season (months)', 'Natural flow vs observed flow + net abstraction', 'Not checked: the run has no observed flow record']);
		expect(aoa(wb.Sheets['Curtailment']!)[0]).toEqual(['Curtailment targets', null, null, null]);
		expect(aoa(wb.Sheets['Warnings']!)).toEqual([['Warnings'], ['Something to check']]);
		expect(aoa(wb.Sheets['Summary']!)[1]).toEqual(['Run', 'Baseline, v2', null]);
	});

	it('keeps formula-looking names inert: string cells, defused like the CSV', () => {
		const s = wb.Sheets['Summary']!;
		const rows = aoa(s);
		expect(rows[2]![1]).toBe('\'=HYPERLINK("x")');
		const evil = rows.findIndex((r) => typeof r[0] === 'string' && r[0].includes('cmd|'));
		const cell = s[XLSX.utils.encode_cell({ r: evil, c: 0 })];
		expect(cell.t).toBe('s');
		expect(cell.f).toBeUndefined();
		expect(cell.v).toBe("'=cmd|' /C calc'!A0");
		// No formula anywhere in the workbook.
		for (const n of wb.SheetNames) for (const [k, c] of Object.entries(wb.Sheets[n]!)) if (!k.startsWith('!')) expect((c as XLSX.CellObject).f).toBeUndefined();
		const grid = aoa(wb.Sheets['EWR grid']!);
		expect(grid.some((r) => r[0] === 'Site' && r[1] === "'=Upper farm")).toBe(true);
		const inputs = aoa(wb.Sheets['Inputs']!);
		expect(inputs.some((r) => r[0] === "'=Upper farm")).toBe(true);
	});

	it('writes the EWR grid, the annual volumes and the inputs from the run JSON', () => {
		const grid = aoa(wb.Sheets['EWR grid']!);
		const days = grid.findIndex((r) => r[0] === 'Days simulated');
		expect(grid[days + 1]).toEqual(['Water year', ...['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'], 'Year']);
		expect(grid[days + 2]).toEqual(['2021/22', 31, 30, 31, 28, 0, 0, 0, 0, 0, 0, 0, 0, 120]);
		const vol = grid.findIndex((r) => r[0] === 'Volume short of the EWR');
		expect(grid[vol + 1]![1]).toBe('Oct (m³)');
		expect(grid[vol + 2]!.slice(0, 3)).toEqual(['2021/22', 10.5, 20.25]);
		const annual = aoa(wb.Sheets['Annual volumes']!);
		expect(annual.at(-1)!.slice(0, 6)).toEqual(['2021/22', 100, 120, 1.25, 1.5, 20]);
		const inputs = aoa(wb.Sheets['Inputs']!);
		expect(inputs.find((r) => r[0] === 'apanMm')!.slice(0, 13)).toEqual(['apanMm', 150, 150, 140, 130, 120, 110, 100, 110, 120, 130, 140, 150]);
		expect(inputs.find((r) => r[0] === 'gr4j.x1')!.slice(0, 2)).toEqual(['gr4j.x1', 350]);
		// A crop area names its farm and crop, not their ids.
		const area = inputs.findIndex((r) => r[0] === 'Model: cropAreas');
		expect(inputs[area + 1]!.slice(0, 3)).toEqual(['nodeId', 'cropId', 'areaM2']);
		expect(inputs[area + 2]!.slice(0, 3)).toEqual(["'=Upper farm", 'Lucerne', 20000]);
	});

	it('marks a legacy run on the summary sheet, as the CSV does', async () => {
		const legacy = read(await buildWorkbook(input({ summaryCsv: '# runoff_model=legacy; workbook comparison only; not evidence (audit H1)\r\n' + summaryCsv })));
		expect(aoa(legacy.Sheets['Summary']!)[0]![0]).toBe('# runoff_model=legacy; workbook comparison only; not evidence (audit H1)');
	});

	it('copes with a run without an EWR grid, calibration or catchment series', async () => {
		const bare = read(await buildWorkbook(input({ summary: { farms: [], warnings: [] } as unknown as RunSummary, catchment: null, nodes: [], settings: null, model: null })));
		expect(bare.SheetNames).not.toContain('Catchment');
		expect(aoa(bare.Sheets['EWR grid']!)[1]![0]).toMatch(/before engine 0\.3\.0/);
		expect(aoa(bare.Sheets['Inputs']!)[1]![0]).toBe('Not recorded for this run');
	});
});

describe('the workbook is byte for byte what SheetJS wrote (issue #9: ./writer.ts replaced it)', () => {
	/**
	 * A SheetJS module as the export worker had it: SheetJS keeps its number
	 * format table in module state, and the worker was new for every export,
	 * so each reference build gets a freshly loaded copy.
	 */
	const freshSheetJS = (): typeof XLSX => {
		const path = require.resolve('xlsx/dist/xlsx.mini.min.js');
		delete require.cache[path];
		return require(path) as typeof XLSX;
	};
	/** The zip's parts by name, as text. */
	const partsOf = (bytes: Uint8Array) => {
		const cfb = XLSX.CFB.read(bytes, { type: 'array' });
		return cfb.FullPaths.flatMap((p: string, i: number) => {
			const f = cfb.FileIndex[i];
			return f.type === 2 && f.content?.length ? [[p.slice(cfb.FullPaths[0].length), new TextDecoder().decode(f.content)]] : [];
		});
	};
	const same = async (x: WorkbookInput) => {
		const [mine, reference] = [await buildWorkbook(x), await sheetjsWorkbook(freshSheetJS(), x)];
		// Part by part first, so a difference reads as XML rather than as a byte offset.
		expect(partsOf(mine)).toEqual(partsOf(reference));
		expect(Buffer.from(mine).equals(Buffer.from(reference))).toBe(true);
	};
	const col = (header: string, unit: string | null, values: (number | null)[]): DailyColumn => ({ header, unit, values });

	it('for the full test run: 12 sheets, every number format, formula-looking names', () => same(input()));

	it('for a bare run, a legacy run and one with small-flow formats', async () => {
		await same(input({ summary: { farms: [], warnings: [] } as unknown as RunSummary, catchment: null, nodes: [], settings: null, model: null }));
		await same(input({ summaryCsv: '# runoff_model=legacy; workbook comparison only; not evidence (audit H1)\r\n' + summaryCsv }));
		const fdc = ['Flow-duration percentiles', 'Days ranked,Q10 (m³/s),Q95 (Mm³)', 'Whole run,0.00042,0.0000123', 'Wet,12.5,0.009'];
		await same(input({ summaryCsv: summaryCsv + fdc.join('\r\n') + '\r\n' }));
	});

	it('for awkward text: whitespace, line breaks, control characters, markup and non-Latin script', () =>
		same(
			input({
				summaryCsv: '﻿' + ['Project," lead space"', 'Run,"trail space "', 'Notes,"two\nlines"', 'Tab,"a\tb"', 'Bell,"x\u0007y"', 'Markup,"<b>&amp;\'q\'""</b>"', 'Name,Ωμέγα 水 😀', '', 'Warnings', ' '].join('\r\n') + '\r\n',
				catchment: { name: 'Catchment', startDate: '2000-02-28', columns: [col(' Flow\nnext (m³/day)', 'm³/day', [1, NaN, Infinity, -0, 1e21, 1.5e-300])] },
				nodes: [
					{ name: 'No days', startDate: '2000-01-01', columns: [col('Dam storage (m³)', 'm³', [])] },
					{ name: 'No columns', startDate: '2000-01-01', columns: [] },
					{ name: '  Farm & <co> "x" ', startDate: '1999-12-31', columns: [col('Share (%)', '%', [50, 12.25]), col('Ratio (×)', '×', [0.5]), col('Flag (flag)', 'flag', [1, 0])] }
				]
			})
		));

	it('for a multi-year run (thousands of rows per sheet, more than nine sheets)', () => same(input(syntheticRun(2, 8))), 60_000);

	it('the reference itself: streaming a SheetJS stub gives the sheet SheetJS writes from every cell', () => {
		const sheetXml = (ws: XLSX.WorkSheet) => {
			const wb = XLSX.utils.book_new();
			XLSX.utils.book_append_sheet(wb, ws, 'S');
			const cfb = XLSX.CFB.read(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: false })), { type: 'array' });
			return new TextDecoder().decode(XLSX.CFB.find(cfb, '/xl/worksheets/sheet1.xml').content);
		};
		for (const t of [catchment, farm('F')]) expect(streamDailySheet(XLSX, sheetXml(dailyStub(XLSX, t)), t)).toBe(sheetXml(dailyCells(XLSX, t)));
		expect(() => streamDailySheet(XLSX, '<worksheet><sheetData><row r="1"></row></sheetData></worksheet>', catchment)).toThrow(/unexpected sheet XML/);
	});

	it('handles thousands of rows and reads back every value', async () => {
		const days = 5000;
		const t: DailyTable = {
			name: 'Long',
			startDate: '1990-01-01',
			columns: Array.from({ length: 5 }, (_, c) => ({
				header: `Col ${c} (m³/day)`,
				unit: 'm³/day',
				values: Array.from({ length: days }, (_, i) => (i % 97 === c ? null : Math.sin(i * (c + 1)) * 1e4))
			}))
		};
		const wb = read(await buildWorkbook(input({ catchment: t, nodes: [] })));
		const rows = aoa(wb.Sheets['Catchment']!);
		expect(rows).toHaveLength(days + 1);
		for (let c = 0; c < 5; c++) expect(rows.slice(1).map((r) => r[c + 1])).toEqual(t.columns[c]!.values);
		expect(wb.Sheets['Catchment']![`A${days + 1}`].w).toBe('2003-09-09');
	});
});

describe('inputRows', () => {
	it('lists settings with arrays across the row and nested objects by path', () => {
		const rows = inputRows({ a: 1, b: [1, 2], c: { d: 'x', e: [{ f: true }] }, g: null }, null);
		expect(rows).toEqual([['Settings the run used'], ['a', 1], ['b', 1, 2], ['c.d', 'x'], ['c.e[1].f', 'yes'], ['g', null]]);
	});
});

/** A deterministic multi-year run shaped like a real one: many zero days, values at full double precision. */
function syntheticRun(years: number, farms: number): { catchment: DailyTable; nodes: DailyTable[] } {
	let seed = 42;
	const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
	const days = Math.round(years * 365.25);
	const table = (name: string, cols: number): DailyTable => ({
		name,
		startDate: '1990-10-01',
		columns: Array.from({ length: cols }, (_, c) => ({
			header: `Column ${c} (m³/day)`,
			unit: c % 7 === 3 ? 'mm' : 'm³/day',
			values: Array.from({ length: days }, (_, i) => (c % 4 === 0 && i % 3 ? 0 : rnd() < 0.35 ? 0 : (1 + Math.sin(i / 58)) * rnd() * 10 ** (1 + (c % 4))))
		}))
	});
	return { catchment: table('Catchment', 19), nodes: Array.from({ length: farms }, (_, f) => table(`Farm ${f + 1}`, 32)) };
}

describe('the zip container', () => {
	/** The zip's parts by name, uncompressed (SheetJS's own container reader). */
	const parts = (bytes: Uint8Array) => {
		const cfb = XLSX.CFB.read(bytes, { type: 'array' });
		const out = new Map<string, string>();
		cfb.FullPaths.forEach((p: string, i: number) => {
			const f = cfb.FileIndex[i];
			if (f.type === 2 && f.content?.length) out.set(p.slice(cfb.FullPaths[0].length), new TextDecoder().decode(f.content));
		});
		return out;
	};

	it('is a deflated OOXML zip whose streamed sheets are, uncompressed, exactly what SheetJS writes', async () => {
		const t = farm('F');
		const bytes = await buildWorkbook(input({ catchment: null, nodes: [t] }));
		// Every local header says method 8 (deflate).
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let at = 0;
		let entries = 0;
		while (view.getUint32(at, true) === 0x04034b50) {
			expect(view.getUint16(at + 8, true)).toBe(8);
			at += 30 + view.getUint16(at + 26, true) + view.getUint32(at + 18, true);
			entries++;
		}
		expect(entries).toBeGreaterThan(5);
		const p = parts(bytes);
		expect([...p.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet3.xml']));
		// Sheet 3 (the farm, after Read this first and Summary) holds the same XML SheetJS writes from the full cells.
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Read this first');
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Summary');
		XLSX.utils.book_append_sheet(wb, dailyCells(XLSX, t), 'F');
		const full = XLSX.CFB.read(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: false })), { type: 'array' });
		const expected = new TextDecoder().decode(XLSX.CFB.find(full, '/xl/worksheets/sheet3.xml').content);
		expect(p.get('xl/worksheets/sheet3.xml')!.replace(/ s="\d+"/g, '')).toBe(expected.replace(/ s="\d+"/g, ''));
	});

	it('keeps a multi-year run small (real deflate) and reads every cell back', async () => {
		// 10 years, catchment + 3 farms: ~1.3 million cells.
		const run = syntheticRun(10, 3);
		const bytes = await buildWorkbook(input(run));
		const raw = [...parts(bytes).values()].reduce((n, x) => n + x.length, 0);
		// Measured 4.0 MB: the parts are 17.6 MB uncompressed, and SheetJS own deflate makes ~8.6 MB of the same cells.
		expect(bytes.length).toBeLessThan(4_600_000);
		expect(bytes.length).toBeLessThan(raw / 4);
		const wb = read(bytes);
		for (const t of [run.catchment, ...run.nodes]) {
			const rows = aoa(wb.Sheets[t.name]!);
			expect(rows).toHaveLength(t.columns[0]!.values.length + 1);
			t.columns.forEach((c, i) => expect(rows.slice(1).map((r) => r[i + 1])).toEqual(c.values));
		}
	}, 60_000);
});

describe('ewrGridRows names what the outlet is compared with', () => {
	const siteRow = (sum: RunSummary) => ewrGridRows(sum).find((r) => r[0] === 'Site' && String(r[1]).startsWith('Outlet'))![1];
	it('the full pragmatic EWR, or the daily EWR from the DRM tables the run used (engine ≥ 1.77.0)', () => {
		expect(siteRow(summary)).toBe('Outlet: simulated outflow vs the full pragmatic EWR');
		expect(siteRow({ ...summary, catchment: { outletEwr: { method: 'tab' } } } as unknown as RunSummary)).toBe('Outlet: simulated outflow vs the daily EWR from the DRM TAB file');
	});
});
