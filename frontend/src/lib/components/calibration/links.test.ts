import { describe, expect, it } from 'vitest';
import { calibrationHref } from './links';

describe('calibrationHref', () => {
	it('keeps the run, encoded, and the anchor', () => {
		expect(calibrationHref()).toBe('?tab=calibration');
		expect(calibrationHref('r 1')).toBe('?tab=calibration&run=r%201');
		expect(calibrationHref('r&1', 'res-plausibility')).toBe('?tab=calibration&run=r%261#res-plausibility');
		expect(calibrationHref(null, 'res-calibration')).toBe('?tab=calibration#res-calibration');
	});
});
