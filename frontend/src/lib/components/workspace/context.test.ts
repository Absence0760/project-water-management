import { describe, expect, it } from 'vitest';
import { sectionContext } from './context';

const base = { runs: [{ id: 'a' }, { id: 'b' }], seriesCount: 3, behind: 0, transfers: [] };

describe('sectionContext', () => {
	it('counts runs on Runs and Compare, and says when there are none', () => {
		expect(sectionContext('runs', base)).toBe('2 runs');
		expect(sectionContext('compare', { ...base, runs: [{ id: 'a' }] })).toBe('1 run');
		expect(sectionContext('runs', { ...base, runs: [] })).toBe('No runs yet');
		expect(sectionContext('runs', { ...base, runs: null })).toBeNull();
	});

	it('the Summary says only that there are no runs yet (its run line comes from the tab)', () => {
		expect(sectionContext('overview', { ...base, runs: [] })).toBe('No runs yet');
		expect(sectionContext('overview', base)).toBeNull();
	});

	it('counts input series and how many are behind', () => {
		expect(sectionContext('series', base)).toBe('3 daily input series');
		expect(sectionContext('series', { ...base, behind: 2 })).toBe('3 daily input series · 2 behind');
		expect(sectionContext('series', { ...base, seriesCount: 0 })).toBe('No input series yet');
		expect(sectionContext('series', { ...base, seriesCount: null })).toBeNull();
	});

	it('counts transfer rules and the active ones', () => {
		expect(sectionContext('transfers', { ...base, transfers: [{ enabled: true }, { enabled: false }] })).toBe('2 transfer rules · 1 active');
		expect(sectionContext('transfers', base)).toBe('No transfer rules yet');
	});

	it('is null for sections with nothing to count', () => {
		for (const tab of ['settings', 'scenarios', 'allocations', 'applications', 'network', 'crops', 'history'] as const)
			expect(sectionContext(tab, base)).toBeNull();
	});
});
