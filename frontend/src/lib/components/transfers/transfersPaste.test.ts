import { describe, expect, it } from 'vitest';
import type { Transfer } from '@water-management/engine';
import { planMonthlyPaste } from '$lib/spreadsheet/paste/monthlyRows';
import { applyTransferPaste, planTransferPaste, transferRows, transfersCsv, TRANSFERS_FORMAT } from './transfersPaste';

const names: Record<string, string> = { u: 'Upper farm', l: 'Lower farm' };
const name = (id: string) => names[id] ?? '(unnamed)';
const rule = (id: string, from: string, to: string, extra: Partial<Transfer> = {}): Transfer =>
	({ id, fromNodeId: from, toNodeId: to, enabled: true, months: [], maxRateM3s: 0, minStoragePct: 0, priority: 1, dailyCapM3: null, ...extra }) as unknown as Transfer;
const rules = () => [
	// A workbook rule: one max rate in its ticked months (Oct, Nov).
	rule('t1', 'u', 'l', { months: [10, 11], maxRateM3s: 0.05 }),
	rule('t2', 'l', 'u', { monthlyRateM3s: [0, 0, 0, 0, 0, 0, 0, 0.02, 0.02, 0.02, 0, 0], months: [5, 6, 7], maxRateM3s: 0.02 })
];
const plan = (r: ReturnType<typeof planTransferPaste>) => {
	if ('error' in r) throw new Error(r.error);
	return r;
};

describe('transfers paste (issue #477)', () => {
	it('names each rule as its card does and by its route', () => {
		const rows = transferRows(rules(), name, 1, 'm³/s');
		expect(rows.map((r) => [r.name, r.aliases])).toEqual([
			['Transfer 1', ['Upper farm → Lower farm', 'Upper farm -> Lower farm']],
			['Transfer 2', ['Lower farm → Upper farm', 'Lower farm -> Upper farm']]
		]);
		expect(rows[0]!.values.slice(0, 3)).toEqual([0.05, 0.05, 0]);
	});

	it('reads rates in the shown unit and writes m³/s back, the months and max rate in step', () => {
		const ts = rules();
		// l/s: 1000 l/s per m³/s.
		const rows = transferRows(ts, name, 1000, 'l/s');
		const p = plan(planTransferPaste('Transfer\tDec\tOct\nUpper farm -> Lower farm\t80\t0\nTransfer 2\t\t', rows));
		expect(p.changes.map((c) => [c.rowId, c.column, c.unit, c.from, c.to])).toEqual([
			['t1', 'Dec', 'l/s', 0, 80],
			['t1', 'Oct', 'l/s', 50, 0]
		]);
		applyTransferPaste(p, ts, 1000);
		expect(ts[0]!.monthlyRateM3s).toEqual([0, 0.05, 0.08, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(ts[0]!.months).toEqual([11, 12]);
		expect(ts[0]!.maxRateM3s).toBe(0.08);
		// Transfer 2 untouched.
		expect(ts[1]!.monthlyRateM3s).toEqual([0, 0, 0, 0, 0, 0, 0, 0.02, 0.02, 0.02, 0, 0]);
	});

	it('stops on a negative rate', () => {
		expect(planTransferPaste('Transfer 1\t-1', transferRows(rules(), name, 1, 'm³/s'))).toEqual({ error: 'Transfer 1, Oct: -1 m³/s is below 0 m³/s.' });
	});

	it('its CSV has the route and pastes back as no change', () => {
		const ts = rules();
		const csv = transfersCsv(ts, name, 1, 'm³/s');
		expect(csv.split('\r\n').slice(0, 2)).toEqual([
			'Transfer,From,To,Oct (m³/s),Nov (m³/s),Dec (m³/s),Jan (m³/s),Feb (m³/s),Mar (m³/s),Apr (m³/s),May (m³/s),Jun (m³/s),Jul (m³/s),Aug (m³/s),Sep (m³/s)',
			'Transfer 1,Upper farm,Lower farm,0.05,0.05,0,0,0,0,0,0,0,0,0,0'
		]);
		const p = plan(planTransferPaste(csv, transferRows(ts, name, 1, 'm³/s')));
		expect(p.changes).toEqual([]);
		expect(p.notes).toEqual(['Matched 2 rows by name.']);
	});

	it('its Expected format example reads, both rows matched (by number and by route)', () => {
		const p = plan(planTransferPaste(TRANSFERS_FORMAT.example, transferRows(rules(), name, 1, 'm³/s')));
		// Transfer 1's rates change; Transfer 2 (by its route) already has the example's.
		expect(new Set(p.changes.map((c) => c.rowId))).toEqual(new Set(['t1']));
		expect(p.changes.length + p.unchanged).toBe(24);
		expect(p.notes[0]).toBe('Matched 2 rows by name.');
		expect(TRANSFERS_FORMAT.exampleName).toMatch(/\.csv$/);
		// The same text through the shared reader: no row or column left out.
		expect(plan(planMonthlyPaste(TRANSFERS_FORMAT.example, transferRows(rules(), name, 1, 'm³/s'), { ignoreHeadings: ['From', 'To'], nameHeadings: ['Transfer'] })).notes).toEqual(['Matched 2 rows by name.']);
	});
});
