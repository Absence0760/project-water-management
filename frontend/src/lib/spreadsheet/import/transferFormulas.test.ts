import { describe, expect, it } from 'vitest';
import { Report } from './report';
import { syntheticB023, type WorkbookBuilder } from './testWorkbook';
import { checkTransferFormulas } from './transferFormulas';
import { readTransfers } from './transfers';
import { B023Workbook } from './workbook';

function check(b: WorkbookBuilder) {
	const wb = new B023Workbook(b.build());
	const report = new Report();
	checkTransferFormulas(wb, readTransfers(wb, new Report()), report);
	return report.unmapped;
}

const STANDARD_DRAW = "=IF(fIsMthIn($H7, O$14), fGetTrfVolCapped('Farm A'!Q6,O$10,O$11,O$16), 0)";

describe('checkTransferFormulas', () => {
	it('passes the standard formulas', () => {
		expect(check(syntheticB023())).toEqual([]);
		// References to unused columns (P draws nothing) and absolute references don't matter.
		expect(check(syntheticB023().set('Transfers', 'J8', '= -$O$7 + P7').set('Transfers', 'O8', STANDARD_DRAW.replace("'Farm A'!Q6", "'Farm A'!$Q$6")))).toEqual([]);
	});

	it('lists an InOut formula with a factor (a conveyance loss) or a missing leg', () => {
		let u = check(syntheticB023().set('Transfers', 'K8', '=O7*0.9-P7'));
		expect(u).toEqual([expect.objectContaining({ code: 'transfer-inout-formula', element: 'Farm B', cell: 'K8', text: '=O7*0.9-P7' })]);
		expect(u[0]!.message).toContain('not a plain sum and difference');
		expect(u[0]!.message).toContain('(here "=O7")');
		u = check(syntheticB023().set('Transfers', 'J8', '=P7'));
		expect(u[0]!.message).toContain("it doesn't subtract column O (Farm A -> Farm B)");
		u = check(syntheticB023().set('Transfers', 'K8', '=O7+O7'));
		expect(u[0]!.message).toContain('counts column O (Farm A -> Farm B) 2 times');
		u = check(syntheticB023().set('Transfers', 'K8', '=0'));
		expect(u[0]!.message).toContain('it is 0, so it moves no water');
		u = check(syntheticB023().set('Transfers', 'K8', '=O6'));
		expect(u[0]!.message).toContain('refers to row 6');
		u = check(syntheticB023().set('Transfers', 'K8', '=O7+H7'));
		expect(u[0]!.message).toContain('H7 is not a draw-from-dam column');
	});

	it('lists a farm in a transfer without an InOut column, and a duplicate column', () => {
		const u = check(syntheticB023().set('Transfers', 'K19', 'Farm A'));
		expect(u.map((x) => x.code).sort()).toEqual(['transfer-inout-duplicate', 'transfer-inout-missing']);
		expect(u.find((x) => x.code === 'transfer-inout-missing')!.element).toBe('Farm B');
	});

	it('lists a draw formula reading the spill column, another farm or other columns (quirk 3)', () => {
		let u = check(syntheticB023().set('Transfers', 'O8', STANDARD_DRAW.replace("'Farm A'!Q6", "'Farm A'!R6")));
		expect(u).toEqual([expect.objectContaining({ code: 'transfer-draw-formula', cell: 'O8', element: 'Farm A' })]);
		expect(u[0]!.message).toContain('reads column R (spill) of the farm sheet, not Q (dam storage)');
		u = check(syntheticB023().set('Transfers', 'O8', STANDARD_DRAW.replace("'Farm A'!Q6", 'Farm_B!Q6')));
		expect(u[0]!.message).toContain("draws from Farm_B's sheet, not Farm A's");
		u = check(syntheticB023().set('Transfers', 'O8', STANDARD_DRAW.replace('O$14', 'P$14')));
		expect(u[0]!.message).toContain('uses settings from other columns (P$14)');
		u = check(syntheticB023().set('Transfers', 'O8', '=MIN(1, 2)'));
		expect(u[0]!.message).toContain("isn't the standard fGetTrfVolCapped draw");
	});

	it('says when the formulas could not be checked', () => {
		expect(check(syntheticB023().unname('zTransfers_FormulasAsTxt'))).toEqual([expect.objectContaining({ code: 'transfer-formulas-unchecked' })]);
		// No transfers, nothing to check.
		expect(check(syntheticB023().unname('zTransfers_FormulasAsTxt').set('Transfers', 'O15', 0))).toEqual([]);
	});
});
