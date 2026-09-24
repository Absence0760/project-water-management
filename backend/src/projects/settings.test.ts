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

	it('defaults to GR4J when none is stored', () => {
		expect(mergeSettings({}).runoffModel).toBe('gr4j');
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
		expect(ok({ calibrationPenalty: { enabled: true, weight: 10, marLowMm3: null, marHighMm3: null } })).toBe(true);
		expect(ok({ calibrationPenalty: { enabled: true, weight: 10, marLowMm3: 5, marHighMm3: 5 } })).toBe(true); // equal bounds: a zero-width band
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
			{ calibrationPenalty: { enabled: true, weight: 1 } }, // missing the (now required) band fields
			{ calibrationPenalty: { enabled: true, weight: 1, marLowMm3: 10, marHighMm3: 5 } }, // low > high
			{ calibrationPenalty: { enabled: true, weight: 1, marLowMm3: 5, marHighMm3: null } }, // one-sided
			{ calibrationPenalty: { enabled: true, weight: 1, marLowMm3: null, marHighMm3: 5 } },
			{ calibrationPenalty: { enabled: true, weight: 1, marLowMm3: -1, marHighMm3: 5 } },
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
			calibrationPenalty: { enabled: false, weight: 0.5, marLowMm3: null, marHighMm3: null }
		});
	});

	it('accepts a valid MAR band', () => {
		expect(ok({ calibrationPenalty: { enabled: true, weight: 2, marLowMm3: 5, marHighMm3: 10 } })).toBe(true);
		expect(
			SettingsPatch.safeParse({ wr2012: { calibrationPenalty: { enabled: true, weight: 2, marLowMm3: 5, marHighMm3: 10 } } }).data?.wr2012
				?.calibrationPenalty
		).toEqual({ enabled: true, weight: 2, marLowMm3: 5, marHighMm3: 10 });
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

	it('accepts the gauge and logger records', () => {
		for (const k of ['flow_observed_m3s', 'flow_logger_m3s', null]) expect(ok(k), String(k)).toBe(true);
	});

	it('no longer accepts Pitman flow, which engine 0.10.0 removed (audit P1)', () => {
		expect(ok('flow_pitman_m3s')).toBe(false);
	});

	it('never accepts a reference gauge (another catchment) as the calibration record', () => {
		expect(ok('flow_reference_m3s')).toBe(false);
		expect(ok('rain_catchment_mm')).toBe(false);
	});
});

describe('SettingsPatch.calibrationExclusions', () => {
	const ok = (calibrationExclusions: unknown) => SettingsPatch.safeParse({ calibrationExclusions }).success;

	it('accepts whole water years and date ranges, each with a reason, and none', () => {
		expect(ok([])).toBe(true);
		expect(ok([{ waterYear: 2015, reason: 'suspect rain year' }, { start: '2017-01-01', end: '2017-01-01', reason: 'gauge outage' }])).toBe(true);
		const parsed = SettingsPatch.parse({ calibrationExclusions: [{ waterYear: 2015, reason: '  padded  ' }] });
		expect(parsed.calibrationExclusions).toEqual([{ waterYear: 2015, reason: 'padded' }]);
	});

	it('rejects a missing or blank reason, fractional years, bad or reversed dates, extra keys and too many', () => {
		for (const bad of [
			[{ waterYear: 2015 }],
			[{ waterYear: 2015, reason: '   ' }],
			[{ waterYear: 2015, reason: 'x'.repeat(501) }],
			[{ waterYear: 2015.5, reason: 'x' }],
			[{ waterYear: '2015', reason: 'x' }],
			[{ start: '2017-02-30', end: '2017-03-01', reason: 'x' }],
			[{ start: '2017-03-01', end: '2017-02-01', reason: 'x' }],
			[{ start: '2017-03-01', reason: 'x' }],
			[{ waterYear: 2015, reason: 'x', note: 'y' }],
			[{ waterYear: 2015, reason: 'x' }, { waterYear: 2015, reason: 'again' }],
			new Array(101).fill({ waterYear: 2015, reason: 'x' }),
			{ waterYear: 2015, reason: 'x' },
			null
		]) {
			expect(ok(bad), JSON.stringify(bad).slice(0, 80)).toBe(false);
		}
	});
});

describe('SettingsPatch.zeroRainRuns (CR-20)', () => {
	const ok = (zeroRainRuns: unknown) => SettingsPatch.safeParse({ zeroRainRuns }).success;

	it('accepts the defaults, either mode, and dated periods with reasons; any subset may be patched', () => {
		expect(ok(defaultProjectSettings().zeroRainRuns)).toBe(true);
		expect(ok({ mode: 'asRecorded' })).toBe(true);
		expect(ok({ keepDry: [{ start: '2003-05-01', end: '2003-08-31', reason: 'real drought' }] })).toBe(true);
		expect(ok({ missing: [{ waterYear: 1999, reason: 'gauge offline' }] })).toBe(true);
	});

	it('rejects an unknown mode, unknown keys, and periods the calibration exclusions would reject', () => {
		for (const bad of [
			{ mode: 'sometimes' },
			{ mode: 'missing', note: 'x' },
			{ keepDry: [{ start: '2003-05-01', end: '2003-04-01', reason: 'x' }] },
			{ keepDry: [{ start: '2003-05-01', end: '2003-08-31' }] },
			{ missing: [{ waterYear: 1999, reason: 'a' }, { waterYear: 1999, reason: 'b' }] },
			{ missing: new Array(101).fill({ waterYear: 1999, reason: 'x' }) },
			{ missing: { waterYear: 1999, reason: 'x' } }
		]) {
			expect(ok(bad), JSON.stringify(bad).slice(0, 80)).toBe(false);
		}
		const r = SettingsPatch.safeParse({ zeroRainRuns: { keepDry: [{ start: '2003-05-01', end: '2003-05-02', reason: '  ' }] } });
		expect(r.success).toBe(false);
		expect(JSON.stringify(r.error!.issues)).toContain('a keep-dry period needs a reason');
	});

	it('merges one level deep: patching the mode keeps the stored lists', () => {
		const stored = { zeroRainRuns: { mode: 'missing', keepDry: [{ waterYear: 2003, reason: 'real' }], missing: [] } };
		expect(patchSettings(stored, { zeroRainRuns: { mode: 'asRecorded' } }).zeroRainRuns).toEqual({
			mode: 'asRecorded',
			keepDry: [{ waterYear: 2003, reason: 'real' }],
			missing: []
		});
		expect(mergeSettings({}).zeroRainRuns).toEqual({ mode: 'missing', keepDry: [], missing: [] });
	});
});

describe('SettingsPatch.fitRecord', () => {
	const period = { start: '2012-10-01', end: '2014-09-30', waterYears: [2012, 2013], scores: { days: 730, kgePrime: 0.8, kgeYearly: null } };
	const record = {
		fittedAt: '2026-09-24T10:00:00.000Z',
		engineVersion: '0.6.0',
		model: 'gr4j',
		objective: 'kgePrime',
		bounds: 'wide',
		seed: 7,
		budget: 300,
		evaluations: 900,
		cancelled: false,
		free: ['x1', 'x3', 'x4'],
		params: { x1: 512, x2: 0, x3: 61, x4: 2.2 },
		startParams: { x1: 350, x2: 0, x3: 90, x4: 1.7 },
		flowKind: 'flow_logger_m3s',
		simulatedKey: 'simulated_outflow',
		calibrationStart: null,
		calibrationEnd: null,
		exclusions: [{ waterYear: 2015, reason: 'suspect rain' }],
		validate: true,
		validationRecord: 'flow_observed_m3s',
		fit: period,
		before: period,
		splitSample: { params: { x1: 500 }, calibration: period, validation: period },
		differential: { params: { x1: 500 }, calibration: period, validation: period, dryYears: [2012], wetYears: [2013], wetDryRatio: 1.8 },
		independentRecord: {
			params: { x1: 512 },
			calibration: period,
			validation: period,
			flowKind: 'flow_observed_m3s',
			simulatedKey: 'simulated_outflow',
			overlapDays: 10
		},
		notes: ['A note.'],
		editedParams: []
	};
	const ok = (fitRecord: unknown) => SettingsPatch.safeParse({ fitRecord }).success;

	it('accepts a full record, and null (no fit)', () => {
		expect(ok(record)).toBe(true);
		expect(ok(null)).toBe(true);
		expect(ok({ ...record, splitSample: null, differential: null, independentRecord: null, notes: [] })).toBe(true);
		const marPenalty = {
			weight: 0.5,
			targetMarMm3: 12,
			marLowMm3: null,
			marHighMm3: null,
			basis: 'overlap',
			marRatio: 1.05,
			unpenalised: { params: { x1: 400 }, fit: period, marRatio: 1.4 }
		};
		expect(ok({ ...record, marPenalty })).toBe(true);
		expect(ok({ ...record, marPenalty: { ...marPenalty, marLowMm3: 5, marHighMm3: 10 } })).toBe(true);
		expect(ok({ ...record, marPenalty: { ...marPenalty, weight: 11 } })).toBe(false);
		expect(ok({ ...record, marPenalty: { ...marPenalty, extra: 1 } })).toBe(false);
	});

	it('accepts an optional forcing block (the pan coefficient / A-pan the fit ran under), and a record from before it without', () => {
		const forcing = { panCoefficient: new Array(12).fill(0.7), apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] };
		expect(ok(record)).toBe(true); // no forcing: a record from before it existed
		expect(ok({ ...record, forcing })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, panCoefficient: new Array(11).fill(0.7) } })).toBe(false); // wrong length
		expect(ok({ ...record, forcing: { ...forcing, panCoefficient: new Array(12).fill(2.1) } })).toBe(false); // out of bounds (0–2)
		expect(ok({ ...record, forcing: { ...forcing, apanMm: forcing.apanMm.map(() => Infinity) } })).toBe(false); // must be finite
		expect(ok({ ...record, forcing: { ...forcing, extra: 1 } })).toBe(false); // no other keys
	});

	it('accepts an optional chirpsBiasCorrection inside forcing, and a forcing from before it without', () => {
		const forcing = { panCoefficient: new Array(12).fill(0.7), apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] };
		expect(ok({ ...record, forcing })).toBe(true); // no chirpsBiasCorrection: a forcing from before it existed
		expect(ok({ ...record, forcing: { ...forcing, chirpsBiasCorrection: 'monthly' } })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, chirpsBiasCorrection: 'none' } })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, chirpsBiasCorrection: 'yearly' } })).toBe(false); // not a known mode
	});

	it('accepts an optional, whole zeroRainRuns inside forcing (CR-20)', () => {
		const forcing = { panCoefficient: new Array(12).fill(0.7), apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100], chirpsBiasCorrection: 'monthly' };
		const zr = { mode: 'missing', keepDry: [{ waterYear: 2003, reason: 'real drought' }], missing: [] };
		expect(ok({ ...record, forcing: { ...forcing, zeroRainRuns: zr } })).toBe(true);
		expect(ok({ ...record, forcing: { ...forcing, zeroRainRuns: { mode: 'missing' } } })).toBe(false); // recorded whole
		expect(ok({ ...record, forcing: { ...forcing, zeroRainRuns: { ...zr, mode: 'sometimes' } } })).toBe(false);
		expect(ok({ ...record, forcing: { ...forcing, zeroRainRuns: { ...zr, keepDry: [{ waterYear: 2003, reason: ' ' }] } } })).toBe(false);
	});

	it('accepts the starts of a multi-start fit (CR-2), and a record from before them without', () => {
		const startResults = [
			{ seed: 7, params: { x1: 512, x2: 0, x3: 61, x4: 2.2 }, score: 0.8, best: true },
			{ seed: 1000010, params: { x1: 900, x2: 0, x3: 40, x4: 2.2 }, score: null, best: false }
		];
		expect(ok({ ...record, starts: 2, startResults })).toBe(true);
		expect(ok(record)).toBe(true);
		expect(ok({ ...record, starts: 0, startResults })).toBe(false);
		expect(ok({ ...record, starts: 11, startResults })).toBe(false);
		expect(ok({ ...record, starts: 2, startResults: [{ ...startResults[0], extra: 1 }] })).toBe(false);
		expect(ok({ ...record, starts: 11, startResults: new Array(11).fill(startResults[0]) })).toBe(false);
	});

	it('rejects a record missing its provenance, with an unknown objective or model, a bad time, or extra keys', () => {
		const without = (k: string) => Object.fromEntries(Object.entries(record).filter(([key]) => key !== k));
		for (const bad of [
			without('seed'),
			without('objective'),
			without('bounds'),
			without('fittedAt'),
			without('engineVersion'),
			without('exclusions'),
			{ ...record, objective: 'rmse' },
			{ ...record, model: 'pitman' },
			{ ...record, bounds: 'narrow' },
			{ ...record, seed: -1 },
			{ ...record, seed: 1.5 },
			{ ...record, fittedAt: 'yesterday' },
			{ ...record, exclusions: [{ waterYear: 2015 }] },
			{ ...record, fit: { ...period, scores: { kgePrime: 'high' } } },
			{ ...record, extra: 1 }
		]) {
			expect(ok(bad), JSON.stringify(bad).slice(0, 60)).toBe(false);
		}
	});

	it('patchSettings recomputes editedParams from the parameters, whatever the client sends', () => {
		const stored = { runoffModel: 'gr4j', gr4j: { x1: 512, x2: 0, x3: 61, x4: 2.2, warmupDays: 365 } };
		expect(patchSettings(stored, { fitRecord: { ...record, editedParams: ['x1'] } }).fitRecord).toMatchObject({ editedParams: [] });
		const edited = patchSettings(stored, { fitRecord: record, gr4j: { x1: 600, x2: 0, x3: 61, x4: 2.2, warmupDays: 365 } });
		expect(edited.fitRecord).toMatchObject({ editedParams: ['x1'] });
		// An edit in a later save, with the record untouched, still marks it.
		const later = patchSettings({ ...stored, fitRecord: record }, { gr4j: { x1: 512, x2: 0, x3: 70, x4: 2.2, warmupDays: 365 } });
		expect(later.fitRecord).toMatchObject({ editedParams: ['x3'] });
		expect(patchSettings(stored, {}).fitRecord).toBeNull();
		// A new record replaces the stored one whole (never merged field by field).
		const replaced = patchSettings({ ...stored, fitRecord: { ...record, seed: 1, oldKey: true } }, { fitRecord: record });
		expect(replaced.fitRecord).not.toHaveProperty('oldKey');
		expect(replaced.fitRecord!.seed).toBe(7);
	});
});

describe('SettingsPatch.effectiveRainStoreMm (engine N3)', () => {
	const ok = (effectiveRainStoreMm: unknown) => SettingsPatch.safeParse({ effectiveRainStoreMm }).success;

	it('accepts 0 (no carry-over) up to 500 mm', () => {
		for (const v of [0, 12.5, 25, 500]) expect(ok(v), String(v)).toBe(true);
	});

	it('rejects a negative, oversized or non-numeric store', () => {
		for (const v of [-1, 501, Infinity, '25', null]) expect(ok(v), String(v)).toBe(false);
	});

	it('defaults to 25 mm for a project that never set it', () => {
		expect(mergeSettings({}).effectiveRainStoreMm).toBe(25);
		expect(defaultProjectSettings().effectiveRainStoreMm).toBe(25);
	});
});
