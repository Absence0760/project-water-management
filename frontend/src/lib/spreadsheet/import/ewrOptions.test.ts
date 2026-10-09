// The optional [EWR options] sheet (engine ≥ 1.77.0, issue #455): the same
// values and notes as extract_project.py read_ewr_options()
// (scripts/wbt-import/test_ewr_options.py has the same cases), and parity on
// the committed variant fixture.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractProject, readWorkbook } from './index';
import { jsonDiff } from './parity';
import { Report } from './report';
import { type TestValue, WorkbookBuilder } from './testWorkbook';
import { B023Workbook } from './workbook';
import { readEwrOptions } from './ewrOptions';

const FIXTURES = new URL('../../../../../scripts/wbt-import/fixtures/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, FIXTURES));
const POINTS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99];
const S = 'EWR options';

function sheet(o: { method?: TestValue; scaling?: TestValue; mar?: TestValue; area?: TestValue; tab?: TestValue[]; natural?: TestValue[][]; points?: TestValue[] } = {}) {
	const b = new WorkbookBuilder().sheet(S);
	b.set(S, 'A1', o.method === undefined ? 'TAB file' : o.method);
	b.set(S, 'A2', o.scaling === undefined ? 'MAR ratio' : o.scaling);
	b.set(S, 'A3', o.mar === undefined ? 100 : o.mar);
	b.set(S, 'A4', o.area === undefined ? null : o.area);
	b.col(S, 'A10', o.tab ?? new Array(12).fill(0.5));
	b.row(S, 'C5', o.points ?? POINTS);
	(o.natural ?? Array.from({ length: 12 }, () => new Array(10).fill(1))).forEach((row, i) => b.row(S, `C${10 + i}`, row));
	for (let i = 0; i < 12; i++) b.row(S, `C${30 + i}`, new Array(10).fill(1));
	const names: Record<string, string> = {
		zEwrOpt_Method: '$A$1',
		zEwrOpt_Scaling: '$A$2',
		zEwrOpt_TableMar: '$A$3',
		zEwrOpt_TableArea: '$A$4',
		zEwrOpt_TabM3s: '$A$10:$A$21',
		zEwrOpt_PctPoints: '$C$5:$L$5',
		zEwrOpt_NaturalPct: '$C$10:$L$21',
		zEwrOpt_ReservePct: '$C$30:$L$41'
	};
	for (const [n, r] of Object.entries(names)) b.name(n, `'${S}'!${r}`);
	return new B023Workbook(b.build());
}
const readIt = (wb: B023Workbook) => {
	const report = new Report();
	return { out: readEwrOptions(wb, report), notes: report.notes };
};

describe('readEwrOptions', () => {
	it('no sheet: no setting and no note', () => {
		expect(readIt(new B023Workbook(new WorkbookBuilder().sheet('Home').build()))).toEqual({ out: null, notes: [] });
	});

	it('a TAB source', () => {
		const { out, notes } = readIt(sheet({ tab: Array.from({ length: 12 }, (_, i) => 0.1 * (i + 1)) }));
		expect(out).toMatchObject({ method: 'tab', scaling: 'mar', tableMarMm3: 100, tableAreaKm2: null });
		expect(out!.tabM3s![11]).toBeCloseTo(1.2, 12);
		expect(notes.map((n) => [n.code, n.severity, n.message])).toEqual([
			['ewr-options', 'info', '[EWR options] the daily EWR at the outlet: the DRM TAB file, scaled by the MAR ratio (docs/model.md 2.9f)']
		]);
	});

	it('reads the names case-insensitively; blank is the default', () => {
		expect(readIt(sheet({ method: 'percentile TABLES', scaling: 'Area Ratio', area: 40 })).out).toMatchObject({ method: 'percentile', scaling: 'area', tableAreaKm2: 40 });
		expect(readIt(sheet({ method: null, scaling: null })).out!.method).toBe('pragmatic');
	});

	it('an unknown method or scaling warns and falls back', () => {
		const { out, notes } = readIt(sheet({ method: 'Monthly', scaling: 'Volume' }));
		expect([out!.method, out!.scaling]).toEqual(['pragmatic', 'mar']);
		expect(notes[0]!.message).toMatch(/^WARNING: \[EWR options\] the EWR method "Monthly"/);
		expect(notes[1]!.message).toMatch(/^WARNING: \[EWR options\] the scaling "Volume"/);
		expect(notes[0]!.severity).toBe('warning');
	});

	it('a method missing what it needs imports as the pragmatic EWR and keeps the values', () => {
		const natural = [[...new Array(9).fill(1), null], ...Array.from({ length: 11 }, () => new Array(10).fill(1))];
		const { out, notes } = readIt(sheet({ method: 'Percentile tables', scaling: 'Area ratio', natural }));
		expect(out!.method).toBe('pragmatic');
		expect(out!.naturalPctM3s).toBeNull();
		expect(out!.reservePctM3s).not.toBeNull();
		expect(notes[0]!.message).toBe(
			'WARNING: [EWR options] the DRM percentile tables needs the natural flow percentile table, the table area (a number for every cell, none below 0): imported as the pragmatic EWR'
		);
	});

	it('a negative or text value drops that table; a 0 MAR is no MAR', () => {
		expect(readIt(sheet({ tab: [...new Array(11).fill(0.5), -1] })).out!.tabM3s).toBeNull();
		expect(readIt(sheet({ tab: [...new Array(11).fill(0.5), 'x'] })).out!.tabM3s).toBeNull();
		expect(readIt(sheet({ mar: 0 })).out!.tableMarMm3).toBeNull();
	});

	it('other percentile points warn', () => {
		expect(readIt(sheet({ points: [10, 20, 30, 40, 50, 60, 70, 80, 90, 99] })).notes[0]!.message).toMatch(/^WARNING: \[EWR options\] the percentile points are not 0\.1/);
	});
});

describe('the [EWR options] variant of the synthetic workbook: parity with extract_project.py', () => {
	it('reads the same settings.ewrDailySource and notes, and adds nothing else', async () => {
		const expected = JSON.parse(read('synthetic_b023.ewr-options.json').toString('utf8')) as { ewrDailySource: unknown; notes: string[] };
		const variant = extractProject(await readWorkbook(read('synthetic_b023.ewr-options.xlsx')), { fileName: 'synthetic_b023.ewr-options.xlsx' });
		expect(jsonDiff(variant.project.settings.ewrDailySource, expected.ewrDailySource)).toBeNull();
		expect(variant.notes.filter((n) => n.message.includes('[EWR options]')).map((n) => n.message)).toEqual(expected.notes);
		// Without the sheet, the workbook imports as before: no setting, the same notes.
		const base = extractProject(await readWorkbook(read('synthetic_b023.xlsx')), { fileName: 'synthetic_b023.xlsx' });
		expect(base.project.settings).not.toHaveProperty('ewrDailySource');
		const { ewrDailySource: _, ...rest } = variant.project.settings;
		expect(jsonDiff(rest, base.project.settings)).toBeNull();
		expect(variant.notes.filter((n) => !n.message.includes('[EWR options]')).map((n) => n.message)).toEqual(base.notes.map((n) => n.message));
	});
});
