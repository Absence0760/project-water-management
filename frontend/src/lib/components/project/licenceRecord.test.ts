import { describe, expect, it } from 'vitest';
import type { LicenceRecord } from '$lib/api';
import { formOf, formProblem, outcomeBody, recordStatus } from './licenceRecord';

const empty: LicenceRecord = { outcome: null, outcomeOn: null, expiresOn: null, reason: '', closesOn: null, reviewDueOn: null };

describe('recordStatus', () => {
	it('says there is nothing to keep before the first pack or nomination', () => {
		expect(recordStatus(empty, '2026-10-01')).toEqual({ text: expect.stringContaining('no licence record to keep'), due: false });
	});

	it('gives the next review, and flags one that is due', () => {
		expect(recordStatus({ ...empty, reviewDueOn: '2031-10-01' }, '2026-10-01')).toEqual({ text: 'No outcome is recorded. Next review: 2031-10-01.', due: false });
		const due = recordStatus({ ...empty, reviewDueOn: '2026-10-01' }, '2026-10-01');
		expect(due.due).toBe(true);
		expect(due.text).toContain('record the licence outcome, or confirm');
	});

	it('gives a grant’s expiry and the closing date, and says when it has passed', () => {
		const granted: LicenceRecord = { ...empty, outcome: 'granted', outcomeOn: '2026-03-01', expiresOn: '2046-02-28', closesOn: '2049-02-28', reason: 'x' };
		expect(recordStatus(granted, '2026-10-01')).toEqual({ text: 'Granted on 2026-03-01; the licence expires on 2046-02-28. The record is kept until 2049-02-28.', due: false });
		const refused: LicenceRecord = { ...empty, outcome: 'refused', outcomeOn: '2020-03-01', closesOn: '2023-03-01', reason: 'x' };
		const s = recordStatus(refused, '2026-10-01');
		expect(s.due).toBe(true);
		expect(s.text).toBe('Refused on 2020-03-01. The record could be deleted from 2023-03-01: ask the operator, in writing, when the organisation no longer needs it.');
	});
});

describe('the owner’s form', () => {
	it('needs a reason, a decision date and, for a grant, an expiry after it', () => {
		expect(formProblem({ outcome: 'granted', outcomeOn: '2026-03-01', expiresOn: '2046-02-28', reason: '' })).toContain('Say why');
		expect(formProblem({ outcome: 'refused', outcomeOn: '', expiresOn: '', reason: 'letter' })).toContain('date of the decision');
		expect(formProblem({ outcome: 'granted', outcomeOn: '2026-03-01', expiresOn: '', reason: 'letter' })).toContain('expires');
		expect(formProblem({ outcome: 'granted', outcomeOn: '2026-03-01', expiresOn: '2026-01-01', reason: 'letter' })).toContain('before it was granted');
		expect(formProblem({ outcome: '', outcomeOn: '', expiresOn: '', reason: 'wrong project' })).toBeNull();
	});

	it('sends only the fields the outcome takes', () => {
		expect(outcomeBody({ outcome: 'granted', outcomeOn: '2026-03-01', expiresOn: '2046-02-28', reason: ' letter ' })).toEqual({
			outcome: 'granted',
			outcomeOn: '2026-03-01',
			expiresOn: '2046-02-28',
			reason: 'letter'
		});
		expect(outcomeBody({ outcome: 'withdrawn', outcomeOn: '2026-03-01', expiresOn: '2046-02-28', reason: 'x' })).toEqual({ outcome: 'withdrawn', outcomeOn: '2026-03-01', reason: 'x' });
		expect(outcomeBody({ outcome: '', outcomeOn: '2026-03-01', expiresOn: '', reason: 'x' })).toEqual({ outcome: null, reason: 'x' });
		expect(formOf({ ...empty, outcome: 'refused', outcomeOn: '2026-03-01', reason: 'kept' })).toEqual({ outcome: 'refused', outcomeOn: '2026-03-01', expiresOn: '', reason: '' });
	});
});
