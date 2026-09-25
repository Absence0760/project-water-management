import type { RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx/dist/xlsx.mini.min';
import { parseCsv } from './csv';
import { annualVolumeRows, buildWorkbook, dailyCells, dailyStub, inputRows, streamDailySheet, type DailyTable, type WorkbookInput } from './workbook';

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
	const wb = read(buildWorkbook(input()));

	it('names the sheets in order, Excel-safe and unique', () => {
		expect(wb.SheetNames).toEqual([
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

	it('marks a legacy run on the summary sheet, as the CSV does', () => {
		const legacy = read(buildWorkbook(input({ summaryCsv: '# runoff_model=legacy; workbook comparison only; not evidence (audit H1)\r\n' + summaryCsv })));
		expect(aoa(legacy.Sheets['Summary']!)[0]![0]).toBe('# runoff_model=legacy; workbook comparison only; not evidence (audit H1)');
	});

	it('copes with a run without an EWR grid, calibration or catchment series', () => {
		const bare = read(buildWorkbook(input({ summary: { farms: [], warnings: [] } as unknown as RunSummary, catchment: null, nodes: [], settings: null, model: null })));
		expect(bare.SheetNames).not.toContain('Catchment');
		expect(aoa(bare.Sheets['EWR grid']!)[1]![0]).toMatch(/before engine 0\.3\.0/);
		expect(aoa(bare.Sheets['Inputs']!)[1]![0]).toBe('Not recorded for this run');
	});
});

describe('daily sheets streamed into SheetJS XML', () => {
	/** Sheet XML SheetJS writes for `ws` in a one-sheet workbook. */
	const sheetXml = (ws: XLSX.WorkSheet) => {
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'S');
		const cfb = XLSX.CFB.read(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: false })), { type: 'array' });
		return new TextDecoder().decode(XLSX.CFB.find(cfb, '/xl/worksheets/sheet1.xml').content);
	};

	it('is byte-for-byte the sheet SheetJS writes from the same cells', () => {
		for (const t of [catchment, farm('F')]) {
			const streamed = new TextDecoder().decode(streamDailySheet(sheetXml(dailyStub(t)), t));
			expect(streamed).toBe(sheetXml(dailyCells(t)));
		}
	});

	it('refuses sheet XML it does not recognise rather than writing a broken file', () => {
		expect(() => streamDailySheet('<worksheet><sheetData><row r="1"></row></sheetData></worksheet>', catchment)).toThrow(/unexpected sheet XML/);
	});

	it('handles thousands of rows and reads back every value', () => {
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
		const wb = read(buildWorkbook(input({ catchment: t, nodes: [] })));
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
