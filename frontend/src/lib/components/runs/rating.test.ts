import { describe, expect, it } from 'vitest';
import { describePbias, NSE_HELP, PBIAS_HELP } from './rating';

describe('describePbias', () => {
	it('reads the engine sign convention (positive = under-estimate)', () => {
		expect(describePbias(12)).toBe('model under-estimates total flow');
		expect(describePbias(-23.5)).toBe('model over-estimates total flow');
		expect(describePbias(0)).toBe('no overall bias');
		expect(describePbias(null)).toBe('');
	});
});

describe('no pass marks on daily scores (calibration research CR-6)', () => {
	it('the help explains each score without a rating', () => {
		for (const h of [NSE_HELP, PBIAS_HELP]) expect(h).not.toMatch(/very good|satisfactory|Moriasi/i);
	});
});
