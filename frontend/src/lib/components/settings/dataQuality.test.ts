import { defaultDataQualitySettings, defaultProjectSettings, rainCheckLimits } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { dataQualityError, describeRainChecks } from './dataQuality';

describe('dataQualityError', () => {
	const d = defaultProjectSettings().dataQuality;

	it('accepts the defaults and the boundaries the API accepts', () => {
		expect(dataQualityError(d)).toBeNull();
		expect(dataQualityError({ ...d, agreementMinRatio: 1, agreementMaxRatio: 1, agreementMinDays: 1 })).toBeNull();
		expect(dataQualityError({ ...d, agreementMinRatio: 0.01, agreementMaxRatio: 100, agreementMinDays: 366 })).toBeNull();
		expect(
			dataQualityError({
				...d,
				outlierFactorRain: 1000,
				outlierFactorFlow: 1.01,
				flatlineRainDays: 2,
				flatlineEvapDays: 366,
				flatlineFlowMinDays: 30,
				flatlineFlowMaxDays: 30,
				zeroRunRule: 'usualRain',
				zeroRunMinWetDays: 1,
				zeroRunUsualShare: 1,
				zeroRunMinDays: 366,
				zeroRunChirpsCheck: true,
				lowVsChirpsRatio: 0.99,
				lowVsChirpsBaseline: 'moving',
				lowVsChirpsMinimum: 'scaled'
			})
		).toBeNull();
	});

	it('names the field that is out of range', () => {
		expect(dataQualityError({ ...d, agreementMinRatio: 0 })).toMatch(/lowest/);
		expect(dataQualityError({ ...d, agreementMinRatio: 1.2 })).toMatch(/lowest/);
		expect(dataQualityError({ ...d, agreementMaxRatio: 0.9 })).toMatch(/highest/);
		expect(dataQualityError({ ...d, agreementMaxRatio: 101 })).toMatch(/highest/);
		expect(dataQualityError({ ...d, agreementMinDays: 30.5 })).toMatch(/whole number/);
		expect(dataQualityError({ ...d, agreementMinDays: 0 })).toMatch(/whole number/);
		expect(dataQualityError(null)).toMatch(/lowest/);
		expect(dataQualityError({ ...d, outlierFactorRain: 1 })).toMatch(/rain outlier factor/);
		expect(dataQualityError({ ...d, outlierFactorFlow: 1001 })).toMatch(/flow outlier factor/);
		expect(dataQualityError({ ...d, flatlineRainDays: 1 })).toMatch(/^The rain flat stretch must be/);
		expect(dataQualityError({ ...d, flatlineEvapDays: 7.5 })).toMatch(/^The A-pan flat stretch must be/);
		expect(dataQualityError({ ...d, flatlineFlowMinDays: 20, flatlineFlowMaxDays: 19 })).toBe('The longest flow flat stretch can’t be shorter than the shortest.');
		expect(dataQualityError({ ...d, zeroRunRule: 'weekly' as never })).toMatch(/how zero-rain runs are judged/);
		expect(dataQualityError({ ...d, zeroRunMinWetDays: 0 })).toMatch(/wet-season days/);
		expect(dataQualityError({ ...d, zeroRunUsualShare: 0 })).toMatch(/share of the usual annual rain/);
		expect(dataQualityError({ ...d, zeroRunMinDays: 400 })).toMatch(/shortest run/);
		expect(dataQualityError({ ...d, lowVsChirpsRatio: 1 })).toMatch(/Low vs CHIRPS: the ratio/);
		expect(dataQualityError({ ...d, lowVsChirpsBaseline: 'decade' as never })).toMatch(/usual ratio/);
		expect(dataQualityError({ ...d, lowVsChirpsMinimum: 'none' as never })).toMatch(/CHIRPS minimum/);
	});
});

describe('describeRainChecks', () => {
	const d = rainCheckLimits(defaultDataQualitySettings());

	it('says when a fit ran the defaults, and when it predates the setting', () => {
		expect(describeRainChecks(d)).toBe(
			'zero-rain runs with 60+ wet-season days; low vs CHIRPS below 50 % of the whole-record median, 50 mm CHIRPS minimum (the defaults)'
		);
		expect(describeRainChecks(undefined)).toMatch(/^the defaults \(fit made before these were settings\): zero-rain runs with 60\+/);
	});

	it('spells out other limits', () => {
		expect(
			describeRainChecks({ ...d, zeroRunRule: 'usualRain', zeroRunUsualShare: 0.3, zeroRunMinDays: 45, zeroRunChirpsCheck: true, lowVsChirpsBaseline: 'moving', lowVsChirpsMinimum: 'scaled' })
		).toBe(
			'zero-rain runs by 30 % of the usual annual rain over 45+ days, checked against CHIRPS; low vs CHIRPS below 50 % of the moving (±5 years) median, scaled CHIRPS minimum'
		);
	});
});
