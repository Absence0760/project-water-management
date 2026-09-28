import { describe, expect, it } from 'vitest';
import { calibrationSample } from './sample';

describe('calibrationSample (issue #45)', () => {
	it('says in-sample only when the parameters were fitted on the days scored', () => {
		// Positive control: a run whose parameters came from the fit, unchanged, on its window and record.
		expect(calibrationSample({ fitStatus: 'fitted' })).toMatchObject({
			status: 'fitted',
			label: 'Calibration period (in-sample)',
			short: 'calibration period (in-sample)',
			qualifier: 'in-sample'
		});
		expect(calibrationSample({ fitStatus: 'notFitted' })).toMatchObject({ label: 'Calibration period (parameters not fitted)', qualifier: 'parameters not fitted' });
		expect(calibrationSample({ fitStatus: 'edited' }).label).toBe('Calibration period (parameters edited since the fit)');
		expect(calibrationSample({ fitStatus: 'otherPeriod' }).label).toBe('Calibration period (not the period fitted)');
		for (const s of ['notFitted', 'edited', 'otherPeriod'] as const) expect(calibrationSample({ fitStatus: s }).short).not.toMatch(/in-sample/);
	});

	it('claims nothing on a run made before the fit status was recorded', () => {
		for (const cal of [{}, null, undefined]) {
			expect(calibrationSample(cal)).toMatchObject({ status: 'unknown', label: 'Calibration period', short: 'calibration period', qualifier: null });
		}
		expect(calibrationSample({}).note).toMatch(/engine 0\.39\.0/);
	});
});
