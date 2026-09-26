// "No new warnings" (publish/autoPublish.ts newWarnings): the test an auto
// run passes before it may replace the current publication.
import { describe, expect, it } from 'vitest';
import { newWarnings } from './autoPublish.js';

describe('newWarnings', () => {
	it('treats the same sentence with other numbers and dates as the same warning', () => {
		const prev = ['CHIRPS rain stands in on 2131 days and is not bias-corrected', 'Catchment rain accumulations spread over 2024-01-01 to 2024-01-03'];
		const next = ['CHIRPS rain stands in on 2132 days and is not bias-corrected', 'Catchment rain accumulations spread over 2024-02-01 to 2024-02-05'];
		expect(newWarnings(prev, next)).toEqual([]);
	});

	it('returns a warning the published run didn’t raise (positive control)', () => {
		const added = 'flow shares add up to 104 % at the outlet';
		expect(newWarnings(['CHIRPS rain stands in on 3 days'], ['CHIRPS rain stands in on 4 days', added])).toEqual([added]);
		expect(newWarnings([], [added])).toEqual([added]);
	});

	it('ignores warnings that went away', () => {
		expect(newWarnings(['one thing', 'another'], ['one thing'])).toEqual([]);
	});
});
