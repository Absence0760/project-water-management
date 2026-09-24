import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, type ProjectSettings } from '../project';
import type { CalibrationReport, ScoredPeriod } from './calibrate';
import type { FitScores } from './objective';
import {
	editedParams,
	excludedDayMask,
	exclusionError,
	exclusionLabel,
	exclusionRange,
	exclusionsError,
	fitRecordCaveats,
	fitRecordFromReport,
	fitRecordStatus,
	resolveFitRecord,
	sanitizeExclusions
} from './provenance';

const scores = (kge: number): FitScores => ({
	days: 100,
	kgePrime: kge,
	kgeYearly: null,
	kgeNp: kge,
	nse: kge,
	nseSqrt: kge,
	nseLog: kge,
	volumeErrorPct: 1,
	fdcHighPct: 2,
	fdcMidSlopePct: 3,
	fdcLowPct: 4
});
const period = (start: string, end: string, kge: number): ScoredPeriod => ({ start, end, waterYears: [2012], scores: scores(kge) });

function report(over: Partial<CalibrationReport> = {}): CalibrationReport {
	return {
		model: 'gr4j',
		objective: 'kgePrime',
		budget: 300,
		seed: 7,
		free: ['x1', 'x3', 'x4'],
		params: { x1: 512.25, x2: 0, x3: 61.5, x4: 2.25 },
		startParams: { x1: 350, x2: 0, x3: 90, x4: 1.7 },
		flowKind: 'flow_logger_m3s',
		simulatedKey: 'simulated_outflow',
		fit: period('2012-10-01', '2014-09-30', 0.8),
		before: period('2012-10-01', '2014-09-30', 0.3),
		splitSample: {
			params: { x1: 500, x2: 0, x3: 60, x4: 2 },
			calibration: period('2012-10-01', '2013-09-30', 0.82),
			validation: period('2013-10-01', '2014-09-30', 0.55)
		},
		differential: null,
		independentRecord: null,
		notes: ['The record has 2 water years…'],
		exclusions: [],
		evaluations: 600,
		cancelled: false,
		...over
	};
}

const gr4jSettings = (x: Partial<ProjectSettings['gr4j']> = {}): ProjectSettings => {
	const s = defaultProjectSettings();
	s.runoffModel = 'gr4j';
	s.gr4j = { ...s.gr4j, x1: 512.25, x3: 61.5, x4: 2.25, ...x };
	return s;
};

describe('calibration exclusions', () => {
	it('a water year covers 1 October to 30 September', () => {
		expect(exclusionRange({ waterYear: 2015, reason: 'suspect rain' })).toEqual({ start: '2015-10-01', end: '2016-09-30', reason: 'suspect rain' });
		expect(exclusionLabel({ waterYear: 2015, reason: 'r' })).toBe('WY 2015/16');
		expect(exclusionLabel({ start: '2015-01-01', end: '2015-03-31', reason: 'r' })).toBe('2015-01-01 – 2015-03-31');
	});

	it('needs a reason, whole years and real dates in order', () => {
		expect(exclusionError({ waterYear: 2015, reason: 'gauge moved' })).toBeNull();
		expect(exclusionError({ start: '2015-01-01', end: '2015-01-01', reason: 'outage' })).toBeNull();
		expect(exclusionError({ waterYear: 2015, reason: '  ' })).toBe('needs a reason');
		expect(exclusionError({ waterYear: 2015 })).toBe('needs a reason');
		expect(exclusionError({ waterYear: 2015.5, reason: 'x' })).toMatch(/whole year/);
		expect(exclusionError({ start: '2015-02-30', end: '2015-03-01', reason: 'x' })).toMatch(/YYYY-MM-DD/);
		expect(exclusionError({ start: '2015-03-01', end: '2015-02-01', reason: 'x' })).toBe('ends before it starts');
		expect(exclusionError(null)).toBe('not an exclusion');
	});

	it('the engine drops invalid stored entries with a warning and trims reasons', () => {
		const warnings: string[] = [];
		const out = sanitizeExclusions([{ waterYear: 2015, reason: ' bad rain ' }, { start: '2016-01-01', end: '2015-01-01', reason: 'x' }, 'junk'], warnings);
		expect(out).toEqual([{ waterYear: 2015, reason: 'bad rain' }]);
		expect(warnings).toHaveLength(2);
		expect(sanitizeExclusions(undefined, warnings)).toEqual([]);
		expect(sanitizeExclusions({}, warnings)).toEqual([]);
		expect(warnings.at(-1)).toMatch(/not a list/);
	});

	it('checks a list: the first bad entry, by position, and the same period twice', () => {
		expect(exclusionsError([])).toBeNull();
		expect(exclusionsError([{ waterYear: 2015, reason: 'a' }, { start: '2015-10-01', end: '2016-09-30', reason: 'b' }])).toBeNull();
		expect(exclusionsError([{ waterYear: 2015, reason: 'a' }, { waterYear: 2016, reason: '' }])).toBe('Exclusion 2: needs a reason');
		expect(exclusionsError([{ waterYear: 2015, reason: 'a' }, { waterYear: 2015, reason: 'b' }])).toBe('Exclusion 2: WY 2015/16 is listed twice');
	});

	it('marks the excluded days of a run, clipped to it', () => {
		const m = excludedDayMask([{ start: '2019-12-30', end: '2020-01-02' }], '2020-01-01', 5);
		expect([...m]).toEqual([1, 1, 0, 0, 0]);
	});
});

describe('fit record', () => {
	const ctx = {
		settings: { calibrationStart: '2012-10-01', calibrationEnd: null, calibrationExclusions: [{ waterYear: 2015, reason: 'suspect rain' }] },
		validate: true,
		validationRecord: null,
		engineVersion: '9.9.9',
		fittedAt: '2026-09-24T10:00:00.000Z'
	};

	it('keeps the settings, seed, budget, scores and notes of the fit', () => {
		const r = fitRecordFromReport(report(), ctx);
		expect(r).toMatchObject({
			fittedAt: '2026-09-24T10:00:00.000Z',
			engineVersion: '9.9.9',
			model: 'gr4j',
			objective: 'kgePrime',
			seed: 7,
			budget: 300,
			evaluations: 600,
			free: ['x1', 'x3', 'x4'],
			calibrationStart: '2012-10-01',
			calibrationEnd: null,
			exclusions: [{ waterYear: 2015, reason: 'suspect rain' }],
			validate: true,
			editedParams: []
		});
		expect(r.splitSample!.validation.scores.kgePrime).toBe(0.55);
		expect(r.notes).toEqual(['The record has 2 water years…']);
		expect(r.marPenalty).toBeNull();
		const penalty = { weight: 0.5, targetMarMm3: 12, basis: 'overlap' as const, marRatio: 1.05, unpenalised: null };
		expect(fitRecordFromReport(report({ marPenalty: penalty }), ctx).marPenalty).toEqual(penalty);
		// Survives a JSON round trip unchanged (it is stored in jsonb).
		expect(JSON.parse(JSON.stringify(r))).toEqual(r);
	});

	it('lists fitted parameters edited since the fit, and none while they match', () => {
		const rec = fitRecordFromReport(report(), ctx);
		expect(editedParams(gr4jSettings(), rec)).toEqual([]);
		expect(editedParams(gr4jSettings({ x1: 600 }), rec)).toEqual(['x1']);
		// X2 was not fitted: changing it doesn't count against the fit.
		expect(editedParams(gr4jSettings({ x2: 1 }), rec)).toEqual([]);
		const s = { ...gr4jSettings({ x4: 3 }), fitRecord: { ...rec, editedParams: [] } } as ProjectSettings & Record<string, unknown>;
		expect(resolveFitRecord(s)!.editedParams).toEqual(['x4']);
		// A client can't set or clear the mark: it is recomputed from the parameters.
		const back = { ...gr4jSettings(), fitRecord: { ...rec, editedParams: ['x1'] } } as ProjectSettings & Record<string, unknown>;
		expect(resolveFitRecord(back)!.editedParams).toEqual([]);
		expect(resolveFitRecord(defaultProjectSettings() as ProjectSettings & Record<string, unknown>)).toBeNull();
		expect(resolveFitRecord({ fitRecord: { model: 'nope' } } as never)).toBeNull();
	});

	it('checks legacy parameters in settings.calibration', () => {
		const rec = fitRecordFromReport(report({ model: 'legacy', free: ['a', 'b'], params: { a: 0.2, b: 1.4, summerFactor: 0.1, winterFactor: 1 } }), ctx);
		const s = defaultProjectSettings();
		s.calibration = { ...s.calibration, a: 0.2, b: 1.4 };
		expect(editedParams(s, rec)).toEqual([]);
		s.calibration.b = 1.5;
		expect(editedParams(s, rec)).toEqual(['b']);
	});

	it('says when the fit no longer describes the settings', () => {
		const rec = fitRecordFromReport(report(), ctx);
		const s = { ...gr4jSettings(), calibrationStart: '2012-10-01', calibrationExclusions: [{ waterYear: 2015, reason: 'suspect rain' }] };
		const ok = fitRecordStatus(s, rec);
		expect(ok).toEqual({ editedParams: [], otherModel: false, windowChanged: false, exclusionsChanged: false, flowKindChanged: false });
		expect(fitRecordCaveats(ok)).toEqual([]);
		const changed = fitRecordStatus(
			{
				...s,
				runoffModel: 'legacy',
				gr4j: { ...s.gr4j, x1: 1 },
				calibrationEnd: '2014-01-01',
				calibrationExclusions: [],
				calibrationFlowKind: 'flow_observed_m3s'
			},
			rec
		);
		expect(changed).toEqual({ editedParams: ['x1'], otherModel: true, windowChanged: true, exclusionsChanged: true, flowKindChanged: true });
		const caveats = fitRecordCaveats(changed, (k) => k.toUpperCase());
		expect(caveats).toHaveLength(5);
		expect(caveats[1]).toMatch(/^Parameters edited since the fit: X1\./);
	});
});
