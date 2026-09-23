import { defaultProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { dataQualityError } from './dataQuality';

describe('dataQualityError', () => {
	it('accepts the defaults and the boundaries the API accepts', () => {
		expect(dataQualityError(defaultProjectSettings().dataQuality)).toBeNull();
		expect(dataQualityError({ agreementMinRatio: 1, agreementMaxRatio: 1, agreementMinDays: 1 })).toBeNull();
		expect(dataQualityError({ agreementMinRatio: 0.01, agreementMaxRatio: 100, agreementMinDays: 366 })).toBeNull();
	});

	it('names the field that is out of range', () => {
		const d = defaultProjectSettings().dataQuality;
		expect(dataQualityError({ ...d, agreementMinRatio: 0 })).toMatch(/lowest/);
		expect(dataQualityError({ ...d, agreementMinRatio: 1.2 })).toMatch(/lowest/);
		expect(dataQualityError({ ...d, agreementMaxRatio: 0.9 })).toMatch(/highest/);
		expect(dataQualityError({ ...d, agreementMaxRatio: 101 })).toMatch(/highest/);
		expect(dataQualityError({ ...d, agreementMinDays: 30.5 })).toMatch(/whole number/);
		expect(dataQualityError({ ...d, agreementMinDays: 0 })).toMatch(/whole number/);
		expect(dataQualityError(null)).toMatch(/lowest/);
	});
});
