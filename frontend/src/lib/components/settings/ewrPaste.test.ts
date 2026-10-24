// The EWR settings' pastes through the shared dialog (issue #521): the same parsers as the old paste boxes, so the
// same values, shown as a preview; and each grid's CSV reads back through the paste unchanged.
import { describe, expect, it } from 'vitest';
import { blankEwrDailySource, type EwrRuleTable } from '@water-management/engine';
import { dailyCsv, planDailyPaste, planRuleTablePaste, ruleTableCsv } from './ewrPaste';
import { applyPaste, parseGrid } from './ewrRules';

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const POINTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
const table = (): EwrRuleTable =>
	({ siteNodeId: null, source: 'Synthetic', component: 'total', unit: 'mcm', points: [...POINTS], ewr: MONTHS.map(() => POINTS.map(() => 1)), lowFlow: null, naturalSource: 'run', natural: null, scale: 1 }) as EwrRuleTable;
const tsv = (v: (m: number, c: number) => number, heading = true) =>
	[...(heading ? [['Month', ...POINTS.map((p) => `${p}%`)].join('\t')] : []), ...MONTHS.map((m, r) => [m, ...POINTS.map((_, c) => v(r, c))].join('\t'))].join('\n');

describe('planRuleTablePaste', () => {
	it('gives the table applyPaste gives, and previews only the values that change', () => {
		const t = table();
		const text = tsv((r, c) => (r === 0 && c < 3 ? 2 : 1));
		const r = planRuleTablePaste(t, 'ewr', text, 'Mm³');
		if ('error' in r) throw new Error(r.error);
		expect(r.table).toEqual(applyPaste(t, 'ewr', parseGrid(text) as Exclude<ReturnType<typeof parseGrid>, { error: string }>));
		expect(r.plan.changes).toEqual([0, 1, 2].map((c) => ({ rowId: '0', rowName: 'Oct', key: String(c), column: `${POINTS[c]} %`, unit: 'Mm³', from: 1, to: 2 })));
		expect(r.plan.unchanged).toBe(117);
		expect(r.plan.notes).toContain('Rows matched by month name.');
		expect(r.message).toBe('Filled the EWR values: 12 months × 10 % points (rows matched by month name).');
	});
	it('fills an empty low-flow grid from null', () => {
		const t = { ...table(), lowFlow: MONTHS.map(() => POINTS.map(() => null as unknown as number)) };
		const r = planRuleTablePaste(t, 'lowFlow', tsv(() => 0.5, false), 'Mm³');
		if ('error' in r) throw new Error(r.error);
		expect(r.plan.changes).toHaveLength(120);
		expect(r.plan.changes[0]!.from).toBeNull();
		expect(r.message).toBe('Filled the low-flow values: 12 months × 10 % points (rows matched by month name).');
	});
	it('says when the heading row changes the % points, and counts every cell', () => {
		const text = ['Month\t10%\t50%\t99%', ...MONTHS.map((m) => `${m}\t1\t1\t1`)].join('\n');
		const r = planRuleTablePaste(table(), 'ewr', text, 'Mm³');
		if ('error' in r) throw new Error(r.error);
		expect(r.table.points).toEqual([10, 50, 99]);
		expect(r.plan.changes).toHaveLength(36);
		expect(r.plan.notes.at(-1)).toMatch(/^The heading row's % points \(10, 50, 99\) replace the table's/);
	});
	it('passes the parsers’ problems on as they were', () => {
		expect(planRuleTablePaste(table(), 'ewr', '1\t2\t3', 'Mm³')).toEqual({ error: 'Expected 12 rows, one per month (Oct … Sep); the paste has 1.' });
		expect(planRuleTablePaste(table(), 'ewr', MONTHS.map(() => '1\t2').join('\n'), 'Mm³')).toEqual({
			error: 'The paste has 2 values a row but the table has 10 % points: paste the heading row too, or change the points first.'
		});
	});
	it('writes a CSV that pastes back to the same grid', () => {
		const t = { ...table(), ewr: MONTHS.map((_, r) => POINTS.map((_, c) => r + c / 10)) };
		const r = planRuleTablePaste(t, 'ewr', ruleTableCsv(t, 'ewr'), 'Mm³');
		if ('error' in r) throw new Error(r.error);
		expect(r.plan.changes).toEqual([]);
		expect(r.table.ewr).toEqual(t.ewr);
	});
});

describe('planDailyPaste', () => {
	it('reads the 12 TAB flows as parseMonthlyRow does', () => {
		const src = { ...blankEwrDailySource(), method: 'tab' as const };
		const r = planDailyPaste(src, 'tabM3s', '0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1 1.1 1.2');
		if ('error' in r) throw new Error(r.error);
		expect(r.patch).toEqual({ tabM3s: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2] });
		expect(r.plan.changes[0]).toEqual({ rowId: '0', rowName: 'TAB flow', key: '0', column: 'Oct', unit: 'm³/s', from: null, to: 0.1 });
		expect(r.message).toBe('Filled the 12 TAB flows.');
		expect(planDailyPaste(src, 'tabM3s', '1 2 3')).toEqual({ error: 'Expected 12 flows, Oct … Sep; the paste has 3.' });
	});
	it('fills a percentile table, and refuses a row that isn’t ten points', () => {
		const src = { ...blankEwrDailySource(), method: 'percentile' as const };
		const r = planDailyPaste(src, 'reservePctM3s', tsv((m, c) => m + c, false));
		if ('error' in r) throw new Error(r.error);
		expect(r.patch.reservePctM3s![11]).toEqual(POINTS.map((_, c) => 11 + c));
		expect(r.message).toBe('Filled the total Reserve flow table (rows matched by month name).');
		// The third table (issue #552).
		const low = planDailyPaste(src, 'lowFlowPctM3s', tsv((m, c) => m + c, false));
		if ('error' in low) throw new Error(low.error);
		expect(low.patch.lowFlowPctM3s![2]).toEqual(POINTS.map((_, c) => 2 + c));
		expect(low.message).toBe('Filled the Reserve flow without high flows table (rows matched by month name).');
		expect(planDailyPaste(src, 'naturalPctM3s', MONTHS.map((m) => `${m}\t1\t2`).join('\n'))).toEqual({ error: 'The paste has 2 values a row; the table has 10, one per point (10 % … 99 %).' });
	});
	it('writes CSVs that paste back unchanged', () => {
		const src = { ...blankEwrDailySource(), method: 'percentile' as const, tabM3s: MONTHS.map((_, i) => i / 4), naturalPctM3s: MONTHS.map((_, r) => POINTS.map((_, c) => r * 10 + c)) };
		const withLow = { ...src, lowFlowPctM3s: MONTHS.map((_, r) => POINTS.map((_, c) => r + c / 10)) };
		for (const which of ['tabM3s', 'naturalPctM3s', 'lowFlowPctM3s'] as const) {
			const r = planDailyPaste(withLow, which, '﻿' + dailyCsv(withLow, which));
			if ('error' in r) throw new Error(r.error);
			expect(r.plan.changes).toEqual([]);
		}
	});
});
