// Desktop Reserve Model output files (issue #455): the .rul and .tab parsers on
// synthetic files of the DRM's layout, both units, CRLF and LF, a missing
// block and a bad line, and what each fills.
import { blankEwrRuleTable, ewrDailySourceIssues, ewrRuleTableIssues, blankEwrDailySource } from '@water-management/engine';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	drmKind,
	DRM_MONTH_DAYS,
	exampleRulFile,
	exampleTabFile,
	gridToM3s,
	mcmMonthToM3s,
	parseDrmFile,
	parseRulFile,
	parseTabFile,
	percentileTablesFromRul,
	ruleTableFromRul,
	ruleTableFromTab,
	type RulFile,
	type TabFile
} from './drmFiles';

const ok = <T>(v: T | { error: string }): T => {
	if (v && typeof v === 'object' && 'error' in v) throw new Error(v.error);
	return v as T;
};
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const lines = (s: string) => s.split('\r\n');

describe('the unit conversion', () => {
	it('Mm³ a month → m³/s over the calendar month, February 28 days', () => {
		expect(DRM_MONTH_DAYS.reduce((a, b) => a + b, 0)).toBe(365);
		// Oct (31 days): 2.6784 Mm³ = 1 m³/s; Feb (28 days): 2.4192 Mm³ = 1 m³/s.
		expect(mcmMonthToM3s(2.6784, 0)).toBeCloseTo(1, 12);
		expect(mcmMonthToM3s(2.4192, 4)).toBeCloseTo(1, 12);
		expect(mcmMonthToM3s(2.592, 1)).toBeCloseTo(1, 12);
	});
});

describe('parseRulFile', () => {
	it('reads the synthetic m³/s file: unit, REC, date, points and the three blocks', () => {
		const r = ok(parseRulFile(exampleRulFile('m3s')));
		expect(r).toMatchObject({ kind: 'rul', unit: 'm3s', category: 'C', generated: '01/01/2026', points: [10, 20, 30, 40, 50, 60, 70, 80, 90, 99] });
		expect(r.total).toHaveLength(12);
		expect(r.lowFlow).toHaveLength(12);
		expect(r.natural).toHaveLength(12);
		// Row order Oct … Sep, ten values each; the first row is October's.
		expect(r.total[0]).toEqual(lines(exampleRulFile('m3s'))[9]!.trim().split(/\s+/).slice(1).map(Number));
		for (const g of [r.total, r.lowFlow!, r.natural!]) for (const row of g) expect(row).toHaveLength(10);
	});

	it('reads an older file in Mm³ a month, and the same file with LF line ends', () => {
		const crlf = ok(parseRulFile(exampleRulFile('mcm')));
		expect(crlf.unit).toBe('mcm');
		expect(ok(parseRulFile(lf(exampleRulFile('mcm'))))).toEqual(crlf);
		// Converted to m³/s, the Mm³ file is the m³/s file to its rounding.
		const m3s = ok(parseRulFile(exampleRulFile('m3s')));
		const conv = gridToM3s(crlf.natural!, 'mcm');
		conv.forEach((row, wy) => row.forEach((v, i) => expect(v).toBeCloseTo(m3s.natural![wy]![i]!, 2)));
	});

	it('a file without the low-flow or natural block reads with that block null', () => {
		const text = lines(exampleRulFile()).slice(0, 22).join('\r\n');
		const r = ok(parseRulFile(text));
		expect(r.lowFlow).toBeNull();
		expect(r.natural).toBeNull();
		expect(percentileTablesFromRul(r)).toEqual({ error: expect.stringMatching(/no “Natural Duration curves” block/) });
	});

	it('names the line that didn’t parse', () => {
		const l = lines(exampleRulFile());
		const bad = [...l];
		bad[12] = 'Jan    0.067   0.055   x   0.034   0.026   0.018   0.012   0.007   0.004   0.001';
		expect(parseRulFile(bad.join('\r\n'))).toEqual({ error: expect.stringMatching(/^line 13: the Jan row of the total Reserve block needs 10 numbers/) });
		const short = [...l];
		short[30] = 'Feb    0.067   0.055';
		expect(parseRulFile(short.join('\r\n'))).toEqual({ error: expect.stringMatching(/^line 31: the Feb row of the Reserve Flows without High Flows block needs 10 numbers; it has 2/) });
		const notMonth = [...l];
		notMonth[11] = 'Total  1 2 3';
		expect(parseRulFile(notMonth.join('\r\n'))).toEqual({ error: expect.stringMatching(/^line 12: expected a month row of the total Reserve block/) });
		const cut = l.slice(0, 15).join('\r\n');
		expect(parseRulFile(cut)).toEqual({ error: expect.stringMatching(/^The total Reserve block ends after 6 months \(line 16\)/) });
		const unit = [...l];
		unit[5] = 'Data are given in furlongs per fortnight';
		expect(parseRulFile(unit.join('\r\n'))).toEqual({ error: expect.stringMatching(/^line 6: the unit/) });
		expect(parseRulFile('Month,10%,20%\nOct,1,2')).toEqual({ error: expect.stringMatching(/No “Data are given in …” line/) });
	});

	it('fills a rule table: the total as the EWR, the low flows, the natural curve, the REC and a source', () => {
		const r = ok(parseRulFile(exampleRulFile('mcm')));
		const t = ruleTableFromRul(blankEwrRuleTable(null), r, 'synthetic.rul');
		expect(t).toMatchObject({ component: 'total', unit: 'mcm', category: 'C', sourceKind: 'desktop', source: 'Desktop Reserve Model rule curves (synthetic.rul, generated 01/01/2026)', naturalSource: 'run' });
		expect(t.ewr).toEqual(r.total);
		expect(t.lowFlow).toEqual(r.lowFlow);
		expect(t.natural).toEqual(r.natural);
		expect(ewrRuleTableIssues(t)).toEqual([]);
		// A typed source is kept.
		expect(ruleTableFromRul({ ...blankEwrRuleTable(null), source: 'Gazette 123' }, r, 'x.rul').source).toBe('Gazette 123');
	});

	it('fills the daily EWR’s percentile tables in m³/s', () => {
		const r = ok(parseRulFile(exampleRulFile('mcm')));
		const p = ok(percentileTablesFromRul(r));
		expect(p.naturalPctM3s![4]![0]).toBeCloseTo(mcmMonthToM3s(r.natural![4]![0]!, 4), 12);
		expect(p.reservePctM3s![0]![9]).toBeCloseTo(mcmMonthToM3s(r.total[0]![9]!, 0), 12);
		// A new source scales by area (issue #90 B2), so it needs the table's area.
		const src = { ...blankEwrDailySource(), method: 'percentile' as const, tableAreaKm2: 50, ...p };
		expect(ewrDailySourceIssues(src)).toEqual([]);
	});
});

describe('parseTabFile', () => {
	it('reads the MAR, the REC and the total flows (maintenance), converted to m³/s', () => {
		const t = ok(parseTabFile(exampleTabFile()));
		expect(t).toMatchObject({ kind: 'tab', marMm3: 49.8, category: 'C', generated: '01/01/2026' });
		expect(t.totalMaintMcm).toEqual([1.26, 0.7, 0.28, 0.14, 0.14, 0.21, 0.56, 2.6, 4.8, 5.6, 4.2, 3]);
		t.totalMaintM3s.forEach((v, wy) => expect(v).toBeCloseTo((t.totalMaintMcm[wy]! * 1e6) / (DRM_MONTH_DAYS[wy]! * 86_400), 12));
		// February: 0.14 Mm³ over 28 days.
		expect(t.totalMaintM3s[4]).toBeCloseTo(0.14e6 / (28 * 86_400), 12);
		expect(ok(parseTabFile(lf(exampleTabFile())))).toEqual(t);
	});

	it('fills a rule table’s natural MAR and REC', () => {
		const t = ok(parseTabFile(exampleTabFile()));
		expect(ruleTableFromTab(blankEwrRuleTable(null), t)).toMatchObject({ naturalMarMcm: 49.8, category: 'C' });
	});

	it('names the line that didn’t parse, and a file without the table', () => {
		const l = lines(exampleTabFile());
		const bad = [...l];
		bad[16] = '         Nov    2.000   1.600   0.800    0.700   0.100     0.000';
		expect(parseTabFile(bad.join('\r\n'))).toEqual({ error: expect.stringMatching(/^line 17: the Nov row of the monthly distributions block needs 7 numbers; it has 6/) });
		const mar = [...l];
		mar[4] = '        MAR               =  lots';
		expect(parseTabFile(mar.join('\r\n'))).toEqual({ error: expect.stringMatching(/^line 5: the MAR/) });
		expect(parseTabFile(l.slice(0, 8).join('\r\n'))).toEqual({ error: expect.stringMatching(/No “Monthly Distributions” table/) });
	});
});

describe('drmKind and parseDrmFile', () => {
	it('tells the two files apart by their content, and leaves a CSV alone', () => {
		expect(drmKind(exampleRulFile())).toBe('rul');
		expect(drmKind(exampleTabFile())).toBe('tab');
		expect(drmKind('Month,10%\nOct,1')).toBeNull();
		expect(parseDrmFile('Month,10%\nOct,1')).toBeNull();
		expect((parseDrmFile(exampleTabFile()) as TabFile).kind).toBe('tab');
		expect((parseDrmFile(exampleRulFile()) as RulFile).kind).toBe('rul');
	});
});

describe('the e2e fixtures', () => {
	it('are the synthetic example files, byte for byte (e2e/fixtures/drm-synthetic.*)', () => {
		const at = (name: string) => readFileSync(new URL(`../../../../../e2e/fixtures/${name}`, import.meta.url), 'utf8');
		expect(at('drm-synthetic.rul')).toBe(exampleRulFile('m3s'));
		expect(at('drm-synthetic.tab')).toBe(exampleTabFile());
	});
});
