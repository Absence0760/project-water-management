import { describe, expect, it } from 'vitest';
import { Report } from './report';
import { syntheticB023 } from './testWorkbook';
import { readTransfers } from './transfers';
import { B023Workbook } from './workbook';

const read = (b = syntheticB023()) => {
	const report = new Report();
	return { transfers: readTransfers(new B023Workbook(b.build()), report), report };
};

describe('readTransfers', () => {
	it('reads each draw column with a destination and a rate', () => {
		const { transfers, report } = read();
		expect(transfers).toEqual([{ from: 'Farm A', to: 'Farm B', months: [1, 2, 3], maxRateM3s: 0.1, minStoragePct: 0.2, column: 'O', col: 15, enabled: true }]);
		expect(report.notes).toEqual([]);
	});

	// Issue #54: a transfer whose draw formula is 0 never moved the water in the workbook.
	it('imports a column whose draw formula is the constant 0 switched off, with a warning', () => {
		for (const f of ['=0', '0', ' = 0 ', 0]) {
			const b = syntheticB023().set('Transfers', 'O8', f).name('zTransfers_FormulasAsTxt', 'Transfers!$I$8:$P$8');
			const { transfers, report } = read(b);
			expect(transfers[0]!.enabled, String(f)).toBe(false);
			expect(report.notes).toEqual([
				expect.objectContaining({
					code: 'transfer-switched-off',
					severity: 'warning',
					element: 'Farm A',
					message:
						'WARNING: transfer Farm A -> Farm B (column O): its draw formula is the constant 0, so the workbook never moved this water; it is imported switched off (Transfers tab, Enabled) (issue #54)'
				})
			]);
		}
		// Positive control: a real draw formula stays on.
		const on = syntheticB023().set('Transfers', 'O8', "=IF(fIsMthIn($H7, O$14), fGetTrfVolCapped('Farm A'!$Q6,O$10,O$11,O$16), 0)").name('zTransfers_FormulasAsTxt', 'Transfers!$I$8:$P$8');
		expect(read(on).transfers[0]!.enabled).toBe(true);
	});

	it('notes and lists a month list the substring match reads differently (M1)', () => {
		const { transfers, report } = read(syntheticB023().set('Transfers', 'O14', '11,12'));
		expect(transfers[0]!.months).toEqual([11, 12]);
		const message = "transfer Farm A -> Farm B: the workbook's substring match also runs it in months [1, 2], which '11,12' doesn't list; the app uses the listed months only (audit M1)";
		expect(report.notes).toEqual([expect.objectContaining({ code: 'transfer-months-substring', message, cell: 'O14' })]);
		expect(report.unmapped).toEqual([expect.objectContaining({ code: 'transfer-months-substring', message })]);
	});

	it('reads a month cell holding a number', () => {
		expect(read(syntheticB023().set('Transfers', 'O14', 7)).transfers[0]!.months).toEqual([7]);
	});

	it('skips a column with no destination or no rate, and lists the ones that look meant', () => {
		let r = read(syntheticB023().set('Transfers', 'O15', 0));
		expect(r.transfers).toEqual([]);
		expect(r.report.unmapped).toEqual([expect.objectContaining({ code: 'transfer-zero-rate', cell: 'O15', element: 'Farm A' })]);
		r = read(syntheticB023().set('Transfers', 'O12', '--'));
		expect(r.transfers).toEqual([]);
		expect(r.report.unmapped).toEqual([expect.objectContaining({ code: 'transfer-no-destination', cell: 'O12', element: 'Farm A' })]);
		// Column P: no destination and no rate is an unused column, not listed.
		expect(read().report.unmapped).toEqual([]);
	});

	it('finds the config rows by label, wherever they are', () => {
		const b = syntheticB023().set('Transfers', 'N12', null).set('Transfers', 'N5', 'Transfer to:').set('Transfers', 'O5', 'Farm B').set('Transfers', 'O12', null);
		expect(read(b).transfers.map((t) => t.to)).toEqual(['Farm B']);
		expect(() => read(syntheticB023().set('Transfers', 'N15', null))).toThrow("[Transfers] config rows not found: ['rate']");
	});
});
