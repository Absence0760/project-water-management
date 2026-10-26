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

	it('reads a warning an older engine worded differently as the same warning (engine 1.98.0, issue #586 D19)', () => {
		const at197 = [
			'Calibration site: the gauge "Weir" has no observed flow record attached: attach one on the Data page, or pick another site in Settings → Calibration record. Until then, 3 days.',
			'Validation signatures (provisional limits): on the 1096 scored days of the outlet, the base-flow index is 0.4. The Plausibility checks panel lists the signatures.',
			'rain stations: the setting is not an object, so it is ignored (docs/model.md §2.4i)'
		];
		const at198 = [
			'Calibration site: the gauge "Weir" has no observed flow record attached: attach one on the Data page, or pick another site in Calibration → Calibration record. Until then, 4 days.',
			'Hydrological signatures (provisional limits): on the 1097 scored days of the outlet, the base-flow index is 0.5. Calibration → Plausibility checks lists the signatures.',
			'rain stations: the setting is not an object, so it is ignored'
		];
		expect(newWarnings(at197, at198)).toEqual([]);
		// A warning the older run didn't raise still counts, whatever its words.
		expect(newWarnings(at197.slice(1), at198)).toEqual([at198[0]]);
	});

	it('ignores warnings that went away', () => {
		expect(newWarnings(['one thing', 'another'], ['one thing'])).toEqual([]);
	});
});
