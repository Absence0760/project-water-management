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

describe('SettingsPatch.runoffModel', () => {
	const ok = (runoffModel: unknown) => SettingsPatch.safeParse({ runoffModel }).success;

	it('accepts the models the engine has, and nothing else', () => {
		expect(ok(defaultProjectSettings().runoffModel)).toBe(true);
		expect(ok('legacy')).toBe(true);
		expect(ok('gr4j')).toBe(true);
		for (const bad of ['pitman', '', null, 1]) expect(ok(bad), JSON.stringify(bad)).toBe(false);
	});

	it('defaults to legacy for settings stored before it existed', () => {
		expect(mergeSettings({}).runoffModel).toBe('legacy');
	});
});

describe('SettingsPatch.gr4j and panCoefficient', () => {
	const ok = (patch: unknown) => SettingsPatch.safeParse(patch).success;

	it('accepts the defaults, any subset, and the bounds', () => {
		expect(ok({ gr4j: defaultProjectSettings().gr4j, panCoefficient: defaultProjectSettings().panCoefficient })).toBe(true);
		expect(ok({ gr4j: {} })).toBe(true);
		expect(ok({ gr4j: { x1: 10, x2: -5, x3: 1, x4: 0.5, warmupDays: 0 } })).toBe(true);
		expect(ok({ gr4j: { x1: 3000, x2: 3, x3: 1000, x4: 10, warmupDays: 3650 } })).toBe(true);
	});

	it('rejects values outside the bounds, fractional warm-ups, unknown keys and bad pan coefficients', () => {
		for (const bad of [
			{ gr4j: { x1: 9 } },
			{ gr4j: { x2: 3.5 } },
			{ gr4j: { x3: 0 } },
			{ gr4j: { x4: 11 } },
			{ gr4j: { warmupDays: 1.5 } },
			{ gr4j: { warmupDays: -1 } },
			{ gr4j: { x5: 1 } },
			{ gr4j: { x1: '350' } },
			{ panCoefficient: [0.7] },
			{ panCoefficient: new Array(12).fill(-0.1) },
			{ panCoefficient: new Array(12).fill(2.1) }
		]) {
			expect(ok(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	it('fills GR4J parameters field by field for settings stored before them', () => {
		expect(mergeSettings({}).gr4j).toEqual({ x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 });
		expect(mergeSettings({ gr4j: { x1: 500 } }).gr4j.x1).toBe(500);
		expect(mergeSettings({ gr4j: { x1: 500 } }).gr4j.x3).toBe(90);
		expect(mergeSettings({}).panCoefficient).toEqual(new Array(12).fill(0.7));
	});
});
