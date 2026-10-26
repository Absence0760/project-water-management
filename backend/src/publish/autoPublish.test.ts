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

	it('reads a data check from before engine 1.99.0, its dates year first, as the same warning (issue #586 R4-G)', () => {
		const at198 = [
			'Observed flow: 1 negative value (2020-10-06: -0.4 m³/s). Flow can’t be negative',
			'Rainfall (catchment): 1 run of zero rain covering 60+ days: 2012-06-01 to 2012-08-15 (76 days). Real dry spells?'
		];
		const at199 = [
			'Observed flow: 1 negative value (6 Oct 2020: -0.4 m³/s). Flow can’t be negative',
			'Rainfall (catchment): 1 run of zero rain covering 60+ days: 1 Jun 2012 to 15 Aug 2012 (76 days). Real dry spells?'
		];
		expect(newWarnings(at198, at199)).toEqual([]);
		// A date in another month is the same warning, as a year-first date in another month always was.
		expect(newWarnings(at199, ['Observed flow: 1 negative value (4 Mar 2021: -0.5 m³/s). Flow can’t be negative'])).toEqual([]);
		// Positive control: a data check the published run didn't raise still counts.
		const added = 'Observed flow: 1 flat stretch of 14 or more days with the same value (6 Oct 2020: 5.35 m³/s for 20 days). A stuck logger or a filled-in gap?';
		expect(newWarnings(at198, [...at199, added])).toEqual([added]);
	});

	it('reads any other warning from before engine 1.100.0, its dates year first, as the same warning (issue #586 R4-O)', () => {
		const at199 = [
			'3 days (2020-01-08 to 2020-01-10) of this run use forecast rain, not recorded rain (catchment or CHIRPS); all of them fall in the reporting window (2020-01-01 to 2020-01-10), so curtailment and the EWR sites cover forecast days',
			'Catchment rain treated as missing on 76 days: 2019-06-01 to 2019-08-15 (76 days, flagged zero run). CHIRPS (bias-corrected) then forecast rain stand in, 120 mm in all. The stored series is unchanged.'
		];
		const at1100 = [
			'3 days (8 Jan 2020 to 10 Jan 2020) of this run use forecast rain, not recorded rain (catchment or CHIRPS); all of them fall in the reporting window (1 Jan 2020 to 10 Jan 2020), so curtailment and the EWR sites cover forecast days',
			'Catchment rain treated as missing on 76 days: 1 Jun 2019 to 15 Aug 2019 (76 days, flagged zero run). CHIRPS (bias-corrected) then forecast rain stand in, 120 mm in all. The stored series is unchanged.'
		];
		expect(newWarnings(at199, at1100)).toEqual([]);
		// And back: a 1.100.0 run published, a 1.99.0 run made after it (an older worker) adds nothing either.
		expect(newWarnings(at1100, at199)).toEqual([]);
		// Positive control: a warning the published run didn't raise still counts, in either form.
		const added = 'damStorageReset: 1 Mar 2021 is outside the run; ignored';
		expect(newWarnings(at199, [...at1100, added])).toEqual([added]);
		expect(newWarnings(at1100, [...at199, 'damStorageReset: 2021-03-01 is outside the run; ignored'])).toEqual(['damStorageReset: 2021-03-01 is outside the run; ignored']);
	});

	it('ignores warnings that went away', () => {
		expect(newWarnings(['one thing', 'another'], ['one thing'])).toEqual([]);
	});
});
