import { describe, expect, it } from 'vitest';
import type { Wr2012Report } from '../reference/wr2012';
import { selectCase, typicalParamsFilter, wr2012MarFilter, type CaseVerdictInput, type FilterResult } from './rules';

const pass = (id: FilterResult['id'] = 'typicalParams'): FilterResult => ({ id, status: 'pass', detail: '' });
const fail = (id: FilterResult['id'] = 'typicalParams'): FilterResult => ({ id, status: 'fail', detail: 'X1 2000 is outside 100–1200 mm' });
const kase = (score: number | null, filters: FilterResult[] = [pass()], error: string | null = null): CaseVerdictInput => ({ error, score, filters });

describe('selectCase', () => {
	it('keeps the best held-out score among the cases that pass', () => {
		const v = selectCase([kase(0.6), kase(0.8, [fail()]), kase(0.7)]);
		expect(v.chosen).toBe(2);
		expect(v.eligible).toEqual([true, false, true]);
		expect(v.reasons[1]![0]).toContain('Parameters in the typical range');
	});

	it('keeps the first of equal scores', () => {
		expect(selectCase([kase(0.7), kase(0.7)]).chosen).toBe(0);
	});

	it('never keeps a case without a validation score, a failed fit or a failed filter', () => {
		const v = selectCase([kase(null), { ...kase(null), scoreMissing: 'the record doesn’t allow the dry → wet test' }, kase(0.9, [], 'the fit failed: too short'), kase(0.9, [fail()])]);
		expect(v.chosen).toBeNull();
		expect(v.reasons).toEqual([['no validation score'], ['the record doesn’t allow the dry → wet test'], ['the fit failed: too short'], [expect.stringContaining('outside')]]);
	});

	it('treats a filter it could not apply as no objection', () => {
		expect(selectCase([kase(0.5, [{ id: 'wr2012Mar', status: 'notApplicable', detail: '' }])]).chosen).toBe(0);
	});
});

describe('typicalParamsFilter', () => {
	it('passes parameters inside Perrin et al.’s ranges, and names each one outside', () => {
		expect(typicalParamsFilter({ x1: 350, x2: 0, x3: 90, x4: 1.7 }, ['x1', 'x3', 'x4']).status).toBe('pass');
		const f = typicalParamsFilter({ x1: 2000, x2: 0, x3: 90, x4: 5 }, ['x1', 'x3', 'x4']);
		expect(f.status).toBe('fail');
		expect(f.detail).toBe('X1 2000 is outside 100–1200 mm; X4 5 is outside 1.1–2.9 days');
	});

	it('only judges the parameters that were fitted', () => {
		expect(typicalParamsFilter({ x1: 350, x2: 0, x3: 90, x4: 5 }, ['x1', 'x3']).status).toBe('pass');
	});
});

describe('wr2012MarFilter', () => {
	const report = (level: Wr2012Report['flag']['level'], sim: number, deviationPct: number) =>
		({ flag: { level, basis: 'whole', deviationPct }, overlap: null, whole: { simulatedMarMm3: sim } }) as unknown as Wr2012Report;
	const noBand = { marLowMm3: null, marHighMm3: null };

	it('is not applicable without a WR2012 reference', () => {
		expect(wr2012MarFilter(null, noBand).status).toBe('notApplicable');
	});

	it('uses the calibration penalty’s band when both ends are set', () => {
		const band = { marLowMm3: 1, marHighMm3: 2 };
		expect(wr2012MarFilter(report('unusable', 1.5, 90), band).status).toBe('pass');
		const out = wr2012MarFilter(report('ok', 2.5, 0), band);
		expect(out.status).toBe('fail');
		expect(out.detail).toBe('natural MAR 2.5 Mm³/a is outside the band 1–2 Mm³/a');
	});

	it('otherwise passes within the check’s query threshold (ok or note) and fails beyond it', () => {
		expect(wr2012MarFilter(report('note', 1, 12), noBand).status).toBe('pass');
		const q = wr2012MarFilter(report('query', 1, -30), noBand);
		expect(q.status).toBe('fail');
		expect(q.detail).toContain('30 % below');
	});
});
