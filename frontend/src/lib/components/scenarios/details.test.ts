import { describe, expect, it } from 'vitest';
import { proposerSummary, statementSummary } from './details';

describe('proposerSummary', () => {
	it('says none, lists up to two names, then counts the rest', () => {
		expect(proposerSummary([])).toBe('none ticked');
		expect(proposerSummary(['Upper farm'])).toBe('Upper farm');
		expect(proposerSummary(['Upper farm', 'Lower farm'])).toBe('Upper farm, Lower farm');
		expect(proposerSummary(['Upper farm', 'Lower farm', 'Village', 'Mine', 'Orchard'])).toBe('Upper farm, Lower farm and 3 more');
	});
});

describe('statementSummary', () => {
	it('counts the answered prompts', () => {
		expect(statementSummary(0, 3)).toBe('0 of 3 answered');
		expect(statementSummary(2, 3)).toBe('2 of 3 answered');
	});
});
