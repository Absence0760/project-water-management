import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import { defaultRunId, filterRuns, isRunGone, RUN_GONE, runErrorText, runYears } from './runList';

describe('runYears', () => {
	it('shows the first and last year', () => {
		expect(runYears('1979-10-01', '2024-09-30')).toBe('1979–2024');
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

describe('defaultRunId', () => {
	const runs = [{ id: 'newest' }, { id: 'middle', published: true }, { id: 'oldest', published: false }];

	it('opens a viewer on the published run', () => {
		expect(defaultRunId(runs, 'viewer')).toBe('middle');
	});
	it('opens an editor or an owner on the newest run, published or not', () => {
		expect(defaultRunId(runs, 'editor')).toBe('newest');
		expect(defaultRunId(runs, 'owner')).toBe('newest');
	});
	it('opens a viewer on the newest run when nothing is published', () => {
		expect(defaultRunId([{ id: 'a' }, { id: 'b', published: false }], 'viewer')).toBe('a');
	});
	it('treats an unknown role like a viewer', () => {
		expect(defaultRunId(runs, null)).toBe('middle');
	});
	it('has no default without runs', () => {
		expect(defaultRunId([], 'viewer')).toBeNull();
		expect(defaultRunId([], 'owner')).toBeNull();
	});
});

describe('runErrorText (issue #77)', () => {
	it("words a run that's gone, never the API's bare \"not found\"", () => {
		const gone = new ApiError(404, 'not found');
		expect(isRunGone(gone)).toBe(true);
		expect(runErrorText(gone)).toBe(RUN_GONE);
	});
	it("keeps the server's own sentence for a refusal (positive control)", () => {
		const kept = new ApiError(409, 'this run is pinned; unpin it before deleting it');
		expect(isRunGone(kept)).toBe(false);
		expect(runErrorText(kept)).toBe('this run is pinned; unpin it before deleting it');
		expect(isRunGone(new Error('not found'))).toBe(false);
	});
});
