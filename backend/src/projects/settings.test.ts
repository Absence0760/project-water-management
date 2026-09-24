import { defaultProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { mergeSettings, patchSettings, SettingsPatch } from './settings.js';

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

describe('SettingsPatch.chirpsBiasCorrection', () => {
	const ok = (chirpsBiasCorrection: unknown) => SettingsPatch.safeParse({ chirpsBiasCorrection }).success;

	it('accepts monthly and none, and nothing else', () => {
		expect(ok('monthly')).toBe(true);
		expect(ok('none')).toBe(true);
		for (const bad of ['yearly', '', null, true, 1]) expect(ok(bad), JSON.stringify(bad)).toBe(false);
	});

	it('defaults to monthly for settings stored before it existed', () => {
		expect(mergeSettings({}).chirpsBiasCorrection).toBe('monthly');
		expect(mergeSettings({ chirpsBiasCorrection: 'none' }).chirpsBiasCorrection).toBe('none');
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

describe('SettingsPatch.wr2012', () => {
	const ok = (wr2012: unknown) => SettingsPatch.safeParse({ wr2012 }).success;
	const issues = (wr2012: unknown) => {
		const r = SettingsPatch.safeParse({ wr2012 });
		return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
	};
	// Synthetic: an invented quaternary and round numbers.
	const monthly = (mar: number) => [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30].map((d) => (mar * d) / 365.25);
	const reference = {
		quaternary: 'Z99A',
		areaKm2: 100,
		marMm3: 10,
		monthlyMm3: monthly(10),
		periodStart: 1990,
		periodEnd: 2009,
		mapMm: 600,
		source: 'Synthetic table'
	};

	it('accepts the defaults, a full reference, any subset of the groups, and clearing the reference', () => {
		expect(ok(defaultProjectSettings().wr2012)).toBe(true);
		expect(ok({ ...defaultProjectSettings().wr2012, reference })).toBe(true);
		expect(ok({ reference: { ...reference, mapMm: null } })).toBe(true);
		expect(ok({ reference: null })).toBe(true);
		expect(ok({ scaling: 'areaRain', lowFlowMonths: [12, 1, 2] })).toBe(true);
		expect(ok({ calibrationPenalty: { enabled: true, weight: 10 } })).toBe(true);
		expect(ok({})).toBe(true);
	});

	it('rejects a MAR larger than the rain volume over the quaternary (MAP × area)', () => {
		// 600 mm × 100 km² = 60 Mm³ a year of rain.
		expect(ok({ reference: { ...reference, marMm3: 60, monthlyMm3: monthly(60) } })).toBe(true);
		expect(issues({ reference: { ...reference, marMm3: 61, monthlyMm3: monthly(61) } })).toEqual(['wr2012.reference.marMm3']);
	});

	it('rejects monthly means (Mm³ per month) whose sum is more than 5 % off the MAR, e.g. values typed in m³/s', () => {
		expect(ok({ reference: { ...reference, monthlyMm3: monthly(10.4) } })).toBe(true);
		expect(issues({ reference: { ...reference, monthlyMm3: monthly(10.6) } })).toEqual(['wr2012.reference.monthlyMm3']);
		// 10 Mm³/a is ~0.317 m³/s; typed per month in m³/s the sum is ~3.8, not 10.
		expect(issues({ reference: { ...reference, monthlyMm3: new Array(12).fill(0.317) } })).toEqual(['wr2012.reference.monthlyMm3']);
	});

	it('rejects incomplete or malformed references, bad thresholds, months and weights', () => {
		const { source: _source, ...noSource } = reference;
		for (const bad of [
			{ reference: { ...reference, quaternary: '' } },
			{ reference: { ...reference, source: ' ' } },
			{ reference: { ...reference, areaKm2: 0 } },
			{ reference: { ...reference, monthlyMm3: [1, 2] } },
			{ reference: { ...reference, periodStart: 2010, periodEnd: 2000 } },
			{ reference: { ...reference, periodStart: 1990.5 } },
			{ reference: { ...reference, mapMm: 0 } },
			{ reference: { ...reference, extra: 1 } },
			{ reference: noSource },
			{ scaling: 'rain' },
			{ lowFlowMonths: [0] },
			{ lowFlowMonths: [] },
			{ flags: { notePct: 10, queryPct: 25, queryWetterPct: 15 } },
			{ flags: { notePct: 30, queryPct: 25, queryWetterPct: 15, unusablePct: 50 } },
			{ flags: { notePct: 10, queryPct: 25, queryWetterPct: 30, unusablePct: 50 } },
			{ flags: { notePct: 0, queryPct: 25, queryWetterPct: 15, unusablePct: 50 } },
			{ calibrationPenalty: { enabled: true, weight: 11 } },
			{ calibrationPenalty: { enabled: 'yes', weight: 1 } },
			{ penalty: true }
		]) {
			expect(ok(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	it('defaults to no reference, area scaling, 10/25/15/50 % thresholds and the penalty off', () => {
		expect(mergeSettings({}).wr2012).toEqual({
			reference: null,
			scaling: 'area',
			lowFlowMonths: null,
			flags: { notePct: 10, queryPct: 25, queryWetterPct: 15, unusablePct: 50 },
			calibrationPenalty: { enabled: false, weight: 0.5 }
		});
	});
});

describe('patchSettings', () => {
	it('merges nested groups one level deep, so a partial patch keeps the other stored fields', () => {
		const stored = { gr4j: { x1: 500, x3: 40 }, dataQuality: { agreementMinDays: 30 } };
		const s = patchSettings(stored, { gr4j: { x4: 2 }, dataQuality: { agreementMinRatio: 0.9 } });
		expect(s.gr4j).toMatchObject({ x1: 500, x3: 40, x4: 2 });
		expect(s.dataQuality).toEqual({ agreementMinRatio: 0.9, agreementMaxRatio: 1.5, agreementMinDays: 30 });
	});

	it('replaces top-level values and whole WR2012 groups (the reference is never half-merged)', () => {
		const ref = { quaternary: 'Z99A', areaKm2: 1, marMm3: 1, monthlyMm3: new Array(12).fill(1 / 12), periodStart: 1990, periodEnd: 2000, mapMm: null, source: 's' };
		const stored = { effectiveRainFraction: 0.5, wr2012: { reference: ref, scaling: 'areaRain' } };
		const s = patchSettings(stored, { effectiveRainFraction: 0.7, wr2012: { calibrationPenalty: { enabled: true, weight: 1 } } });
		expect(s.effectiveRainFraction).toBe(0.7);
		expect(s.wr2012.reference).toEqual(ref);
		expect(s.wr2012.scaling).toBe('areaRain');
		expect(s.wr2012.calibrationPenalty).toEqual({ enabled: true, weight: 1 });
		expect(patchSettings(stored, { wr2012: { reference: null } }).wr2012.reference).toBeNull();
	});
});

describe('SettingsPatch.calibrationFlowKind', () => {
	const ok = (calibrationFlowKind: unknown) => SettingsPatch.safeParse({ calibrationFlowKind }).success;

	it('accepts the observed records and Pitman flow', () => {
		for (const k of ['flow_observed_m3s', 'flow_logger_m3s', 'flow_pitman_m3s', null]) expect(ok(k), String(k)).toBe(true);
	});

	it('never accepts a reference gauge (another catchment) as the calibration record', () => {
		expect(ok('flow_reference_m3s')).toBe(false);
		expect(ok('rain_catchment_mm')).toBe(false);
	});
});
