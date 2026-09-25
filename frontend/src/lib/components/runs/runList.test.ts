import { describe, expect, it } from 'vitest';
import { filterRuns, runYears } from './runList';

describe('runYears', () => {
	it('shows the first and last year', () => {
		expect(runYears('1981-01-01', '2025-03-31')).toBe('1981–2025');
	});
	it('shows one year when the run starts and ends in it', () => {
		expect(runYears('2021-03-04', '2021-12-31')).toBe('2021');
	});
});

describe('filterRuns', () => {
	const runs = [{ label: 'Baseline 2026' }, { label: 'Dam raise, Farm 7' }, { label: null }, { label: 'Baseline logger' }];

	it('keeps every run for a blank query', () => {
		expect(filterRuns(runs, '  ')).toEqual(runs);
	});
	it('matches any case and every word, in any order', () => {
		expect(filterRuns(runs, 'LOGGER baseline').map((r) => r.label)).toEqual(['Baseline logger']);
		expect(filterRuns(runs, 'baseline').map((r) => r.label)).toEqual(['Baseline 2026', 'Baseline logger']);
	});
	it('finds an unlabelled run by the name the list shows', () => {
		expect(filterRuns(runs, 'untitled')).toEqual([{ label: null }]);
	});
	it('returns nothing when no label matches', () => {
		expect(filterRuns(runs, 'transfer')).toEqual([]);
	});
});
