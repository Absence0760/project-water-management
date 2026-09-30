import { APPLICANT_PROMPTS, NO_PROMPTS } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { answeredCount, statementPatch, storedAnswers } from './statement';

const stored = { purposeAndNeed: 'Winter storage.', mitigation: '', monitoring: 'A weir, read weekly.' };

describe('the applicant’s statement', () => {
	it('asks the three fixed prompts in order: purpose and need, mitigation, monitoring', () => {
		expect(APPLICANT_PROMPTS.map((p) => p.heading)).toEqual(['Purpose and need', 'Mitigation', 'Monitoring']);
		for (const p of APPLICANT_PROMPTS) expect(p.question.trim()).toMatch(/\?$/);
	});

	it('takes the answers off a scenario row and nothing else', () => {
		expect(storedAnswers({ ...stored, name: 'x', description: 'y' } as never)).toEqual(stored);
	});

	it('sends only the answers whose trimmed text changed, trimmed', () => {
		expect(statementPatch({ ...stored }, stored)).toEqual({});
		expect(statementPatch({ ...stored, purposeAndNeed: '  Winter storage.\n' }, stored)).toEqual({});
		expect(statementPatch({ ...stored, mitigation: '  Releases in dry months. ' }, stored)).toEqual({ mitigation: 'Releases in dry months.' });
		// Clearing an answer sends '' (Appendix C then prints "Not given").
		expect(statementPatch({ ...stored, monitoring: '   ' }, stored)).toEqual({ monitoring: '' });
	});

	it('counts an answer only when it has more than whitespace', () => {
		expect(answeredCount(NO_PROMPTS)).toBe(0);
		expect(answeredCount(stored)).toBe(2);
		expect(answeredCount({ ...stored, mitigation: ' \n ' })).toBe(2);
		expect(answeredCount({ purposeAndNeed: 'a', mitigation: 'b', monitoring: 'c' })).toBe(3);
	});
});
