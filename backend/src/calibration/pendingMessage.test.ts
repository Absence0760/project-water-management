// The cap's refusal (POST …/auto-calibrations, 429): it says where the person's
// running run of the rules is, so one in another project doesn't read as
// running in this one too (store.ts pendingCalibrationMessage).
import { describe, expect, it } from 'vitest';
import { pendingCalibrationMessage } from './store.js';

describe('pendingCalibrationMessage', () => {
	it('names the other project the run is in', () => {
		expect(pendingCalibrationMessage('b', [{ projectId: 'a', projectName: 'Upper Kleinberg' }])).toBe(
			'you already have an automated calibration queued or running in the project “Upper Kleinberg”, and only one at a time is allowed; wait for it to finish, then start this one'
		);
	});

	it('says “this project” when the run is this one’s, even with another elsewhere', () => {
		const msg = 'an automated calibration is already queued or running in this project; wait for it to finish';
		expect(pendingCalibrationMessage('a', [{ projectId: 'a', projectName: 'A' }])).toBe(msg);
		expect(pendingCalibrationMessage('a', [{ projectId: 'b', projectName: 'B' }, { projectId: 'a', projectName: 'A' }])).toBe(msg);
	});

	it('falls back to “another project” when the name can’t be seen', () => {
		const m = pendingCalibrationMessage('b', [{ projectId: 'a', projectName: null }]);
		expect(m).toContain('in another project');
		expect(m).not.toContain('“');
	});
});
