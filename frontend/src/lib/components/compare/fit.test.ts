import type { FitRecord, FitScores, ProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { asFitRecord, fitValidationRows } from './fit';

const scores = (v: number): FitScores => ({
	days: 100,
	kgePrime: v,
	kgeYearly: null,
	kgeNp: v,
	nse: v,
	nseSqrt: v,
	nseLog: v,
	volumeErrorPct: 0,
	fdcHighPct: 0,
	fdcMidSlopePct: 0,
	fdcLowPct: 0
});
const period = (v: number) => ({ start: '2013-01-01', end: '2014-12-31', waterYears: [2012, 2013], scores: scores(v) });

const record = (over: Partial<FitRecord> = {}): FitRecord =>
	({
		fittedAt: '2026-09-24T10:05:00.000Z',
		model: 'gr4j',
		objective: 'kgePrime',
		seed: 7,
		fit: period(0.81),
		before: period(0.2),
		splitSample: { params: {}, calibration: period(0.8), validation: period(0.456) },
		differential: null,
		independentRecord: null,
		editedParams: [],
		...over
	}) as FitRecord;

const row = (rows: ReturnType<typeof fitValidationRows>, label: string) => rows!.find((r) => r.label === label)!;

describe('fitValidationRows', () => {
	it('puts each run’s in-sample score next to its validation scores', () => {
		const rows = fitValidationRows(record(), record({ seed: 8, editedParams: ['x1'] }));
		expect(row(rows, 'Fit')).toEqual({ label: 'Fit', a: 'GR4J fit of 2026-09-24 10:05 UTC (KGE′, seed 7)', b: 'GR4J fit of 2026-09-24 10:05 UTC (KGE′, seed 8)' });
		expect(row(rows, 'Calibration period (in-sample)')).toMatchObject({ a: '0.81', b: '0.81' });
		expect(row(rows, 'Split-sample: other half')).toMatchObject({ a: '0.46', b: '0.46' });
		expect(row(rows, 'Dry → wet: wet years')).toMatchObject({ a: 'not run', b: 'not run' });
		expect(row(rows, 'Parameters edited since fit')).toMatchObject({ a: 'no', b: 'yes (x1)' });
		// No settings snapshot given (an older caller): can't say, rather than guessing.
		expect(row(rows, 'Forcing changed since fit')).toEqual({ label: 'Forcing changed since fit', a: 'unknown', b: 'unknown' });
		expect(row(rows, 'WR2012 MAR penalty')).toMatchObject({ a: 'off', b: 'off' });
		const penalised = record({ marPenalty: { weight: 0.5, targetMarMm3: 10, marLowMm3: null, marHighMm3: null, basis: 'whole', marRatio: 1.1, unpenalised: null } });
		expect(row(fitValidationRows(penalised, null), 'WR2012 MAR penalty').a).toBe('weight 0.5, MAR 1.10 × WR2012');
		const banded = record({
			marPenalty: { weight: 2, targetMarMm3: 6, marLowMm3: 4, marHighMm3: 9, basis: 'overlap', marRatio: 0.95, unpenalised: null }
		});
		expect(row(fitValidationRows(banded, null), 'WR2012 MAR penalty').a).toBe('weight 2, MAR 0.95 × 4–9 Mm³/a band');
	});

	it('shows the bounds the fit searched', () => {
		const rows = fitValidationRows(record({ bounds: 'wide' }), record({ bounds: 'typical' }));
		expect(row(rows, 'Bounds')).toEqual({ label: 'Bounds', a: 'wide', b: 'typical (Perrin et al. 80 %)' });
	});

	it('says when a run has no fit record, and returns null when neither has', () => {
		const rows = fitValidationRows(null, record());
		expect(row(rows, 'Fit').a).toMatch(/^none/);
		expect(row(rows, 'Calibration period (in-sample)').a).toBe('–');
		expect(fitValidationRows(null, null)).toBeNull();
	});

	it('says when a run’s own forcing has moved since its fit, given that run’s settings', () => {
		const mono = (v: number): number[] => Array(12).fill(v);
		const withForcing = record({
			free: [],
			params: {},
			calibrationStart: null,
			calibrationEnd: null,
			exclusions: [],
			flowKind: 'flow_observed_m3s',
			forcing: { panCoefficient: mono(0.7), apanMm: mono(100), chirpsBiasCorrection: 'monthly' }
		});
		const settings = {
			runoffModel: 'gr4j',
			calibrationStart: null,
			calibrationEnd: null,
			calibrationExclusions: [],
			calibrationFlowKind: null,
			panCoefficient: mono(0.7),
			apanMm: mono(100),
			chirpsBiasCorrection: 'monthly'
		} as unknown as Partial<ProjectSettings>;
		const same = fitValidationRows(withForcing, null, settings, null);
		expect(row(same, 'Forcing changed since fit')).toEqual({ label: 'Forcing changed since fit', a: 'no', b: '–' });
		const moved = fitValidationRows(withForcing, null, { ...settings, panCoefficient: mono(0.9) } as unknown as Partial<ProjectSettings>, null);
		expect(row(moved, 'Forcing changed since fit').a).toBe('yes');
		// The CHIRPS bias correction mode alone can move it too.
		const chirpsMoved = fitValidationRows(withForcing, null, { ...settings, chirpsBiasCorrection: 'none' } as unknown as Partial<ProjectSettings>, null);
		expect(row(chirpsMoved, 'Forcing changed since fit').a).toBe('yes');
		// Issue #40c: a run on another CHIRPS product or version than its fit says so; a run that didn't record one can't compare.
		const onV2 = record({ ...withForcing, forcing: { ...withForcing.forcing!, chirpsSource: { product: 'CHIRPS', version: '2.0' } } });
		const v3 = { product: 'CHIRPS sat', version: '3.0' };
		expect(row(fitValidationRows(onV2, onV2, settings, settings, { a: v3, b: { product: 'CHIRPS', version: '2.0' } }), 'Forcing changed since fit')).toMatchObject({
			a: 'yes (another CHIRPS product or version)',
			b: 'no'
		});
		expect(row(fitValidationRows(onV2, null, settings, null, { a: undefined }), 'Forcing changed since fit').a).toBe('no');
		// Issue #51: CHIRPS factors drifted beyond 2 % since the fit say so; the same factors (positive control) don't.
		const f = [1.1, 1.2, 0.9, 1, 1, 1, 1, 1, 1, 1, 1, 1];
		const set = (factors: number[]) => [{ label: 'whole record', factors }];
		const onFactors = record({ ...withForcing, forcing: { ...withForcing.forcing!, chirpsFitPeriod: 'all', chirpsFactors: set(f) } });
		expect(row(fitValidationRows(onFactors, onFactors, settings, settings, {}, {}, { a: set([1.3, ...f.slice(1)]), b: set(f) }), 'Forcing changed since fit')).toMatchObject({
			a: 'yes (the CHIRPS factors drifted)',
			b: 'no'
		});
		// Issue #45: a run on another daily A-pan series than its fit says so; the same series (positive control) doesn't.
		const pan = { startDate: '2020-10-01', length: 30, valuesSha256: 'c'.repeat(64) };
		const onPan = record({ ...withForcing, forcing: { ...withForcing.forcing!, apanDaily: pan } });
		expect(row(fitValidationRows(onPan, onPan, settings, settings, {}, { a: { ...pan, valuesSha256: 'd'.repeat(64) }, b: { ...pan } }), 'Forcing changed since fit')).toMatchObject({
			a: 'yes (another daily A-pan series)',
			b: 'no'
		});
		expect(row(fitValidationRows(onPan, null, settings, null, {}, { a: undefined }), 'Forcing changed since fit').a).toBe('no');
	});
});

describe('asFitRecord', () => {
	it('takes a stored record and nothing else', () => {
		expect(asFitRecord(record())).not.toBeNull();
		for (const v of [null, undefined, {}, 'x', { fittedAt: 'x' }]) expect(asFitRecord(v)).toBeNull();
	});
});
