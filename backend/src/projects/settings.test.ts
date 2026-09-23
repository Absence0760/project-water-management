import { defaultProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { mergeSettings, SettingsPatch } from './settings.js';

describe('SettingsPatch.dataQuality', () => {
	const ok = (dataQuality: unknown) => SettingsPatch.safeParse({ dataQuality }).success;

	it('accepts the defaults, any subset, and the boundary values', () => {
		expect(ok(defaultProjectSettings().dataQuality)).toBe(true);
		expect(ok({})).toBe(true);
		expect(ok({ agreementMinRatio: 1, agreementMaxRatio: 1 })).toBe(true);
		expect(ok({ agreementMinDays: 1 })).toBe(true);
		expect(ok({ agreementMinDays: 366, agreementMaxRatio: 100 })).toBe(true);
	});

	it('rejects ratios on the wrong side of 1, fractional or out-of-range days, and unknown keys', () => {
		for (const bad of [
			{ agreementMinRatio: 0 },
			{ agreementMinRatio: -0.5 },
			{ agreementMinRatio: 1.01 },
			{ agreementMaxRatio: 0.99 },
			{ agreementMaxRatio: 101 },
			{ agreementMinDays: 0 },
			{ agreementMinDays: 90.5 },
			{ agreementMinDays: 367 },
			{ agreementMinRatio: '0.5' },
			{ minRatio: 0.5 },
			null,
			[0.5]
		]) {
			expect(ok(bad), JSON.stringify(bad)).toBe(false);
		}
	});
});

describe('mergeSettings', () => {
	it('fills dataQuality from the defaults for settings stored before it existed, and field by field', () => {
		expect(mergeSettings({}).dataQuality).toEqual({ agreementMinRatio: 2 / 3, agreementMaxRatio: 1.5, agreementMinDays: 90 });
		expect(mergeSettings({ dataQuality: { agreementMinDays: 30 } }).dataQuality).toEqual({
			agreementMinRatio: 2 / 3,
			agreementMaxRatio: 1.5,
			agreementMinDays: 30
		});
	});
});
