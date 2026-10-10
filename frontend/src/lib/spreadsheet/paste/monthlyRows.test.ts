import { describe, expect, it } from 'vitest';
import { applyMonthlyPaste, monthlyRowsCsv, planMonthlyPaste, type MonthlyRow } from './monthlyRows';

const rows = (): MonthlyRow[] => [
	{ id: 'a', name: 'A-pan evaporation', aliases: ['A-pan'], unit: 'mm', values: [180, 200, 230, 235, 190, 170, 120, 95, 75, 80, 110, 145], max: 10_000 },
	{ id: 'k', name: 'Pan coefficient', unit: '', values: new Array(12).fill(0.7), max: 2 }
];
const plan = (r: ReturnType<typeof planMonthlyPaste>) => {
	if ('error' in r) throw new Error(r.error);
	return r;
};

describe('planMonthlyPaste (issue #477)', () => {
	it('matches rows by name or alias and months by heading, short or long, in any order', () => {
		const p = plan(planMonthlyPaste('Parameter\tJanuary\tOct\na-pan\t240\t180\nPan coefficient\t0,75\t0,7', rows(), { nameHeadings: ['Parameter'] }));
		expect(p.changes.map((c) => [c.rowId, c.column, c.unit, c.from, c.to])).toEqual([
			['a', 'Jan', 'mm', 235, 240],
			['k', 'Jan', '', 0.7, 0.75]
		]);
		expect(p.unchanged).toBe(2);
		expect(p.notes).toContain('Matched 2 rows by name.');
	});

	it('fills from the anchor without names or headings, and writes back through set', () => {
		const p = plan(planMonthlyPaste('0.8\t0.8', rows(), { anchor: { row: 1, col: 10 } }));
		const set: [string, number, number][] = [];
		applyMonthlyPaste(p, (id, m, v) => set.push([id, m, v]));
		expect(set).toEqual([
			['k', 10, 0.8],
			['k', 11, 0.8]
		]);
	});

	it('stops on a value outside the row’s range, naming the row and month', () => {
		expect(planMonthlyPaste('A-pan\t-1', rows())).toEqual({ error: 'A-pan evaporation, Oct: -1 mm is below 0 mm.' });
		expect(planMonthlyPaste('Pan coefficient\t0.7\t2.5', rows())).toEqual({ error: 'Pan coefficient, Nov: 2.5 is above 2.' });
	});

	it('its CSV pastes back as no change, the info columns left out', () => {
		const csv = monthlyRowsCsv(rows(), 'Parameter', [{ heading: 'Unit', value: (r) => r.unit || '×' }]);
		expect(csv.split('\r\n')[0]).toBe('Parameter,Unit,Oct,Nov,Dec,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep');
		const p = plan(planMonthlyPaste(csv, rows(), { nameHeadings: ['Parameter'], ignoreHeadings: ['Unit'] }));
		expect(p.changes).toEqual([]);
		expect(p.unchanged).toBe(24);
		expect(monthlyRowsCsv(rows().slice(0, 1), 'Row', [], 'mm').split('\r\n')[0]).toBe('Row,Oct (mm),Nov (mm),Dec (mm),Jan (mm),Feb (mm),Mar (mm),Apr (mm),May (mm),Jun (mm),Jul (mm),Aug (mm),Sep (mm)');
	});
});
