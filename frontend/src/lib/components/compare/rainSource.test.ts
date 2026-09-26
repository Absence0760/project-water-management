import { describe, expect, it } from 'vitest';
import { rainSourceNote } from './rainSource';

describe('rainSourceNote', () => {
	it('sets each run’s periods side by side, and says when a side has none', () => {
		const line = '2012-10-01 to 2019-09-30 (automatic station): alternative catchment gauge × Oct 1.25, …';
		expect(rainSourceNote({ periodsA: [], periodsB: [line], changed: true })).toBe(
			`The rain-source periods differ between the runs (A: none (the catchment series throughout); B: ${line}), so catchment rain differs over those dates. ` +
				'The periods themselves, a fit’s reference era, the alternative gauge’s or reference series’ data, or its product and version can each move them.'
		);
		expect(rainSourceNote({ periodsA: [line, line], periodsB: [line], changed: true })).toContain(`A: ${line} | ${line}; B: ${line}`);
	});
});
