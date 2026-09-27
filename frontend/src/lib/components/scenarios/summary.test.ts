import { describe, expect, it } from 'vitest';
import { scenariosSummary } from './summary';

const run = { id: 'r', label: 'x', createdAt: '2024-01-01T00:00:00Z' };

describe('scenariosSummary', () => {
	it('says so when there are none', () => {
		expect(scenariosSummary([])).toBe('No scenarios yet');
	});
	it('counts one scenario in the singular, with no results', () => {
		expect(scenariosSummary([{ status: 'draft', lastRun: null }])).toBe('1 scenario · 1 draft · none run yet');
	});
	it('counts each status in the order they move through, leaving out zeros, and those with results', () => {
		expect(
			scenariosSummary([
				{ status: 'submitted', lastRun: run },
				{ status: 'draft', lastRun: null },
				{ status: 'draft', lastRun: run },
				{ status: 'decided', lastRun: run }
			])
		).toBe('4 scenarios · 2 drafts · 1 submitted · 1 decided · 3 with results');
	});
});
