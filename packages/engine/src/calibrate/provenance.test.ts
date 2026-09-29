import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import { defaultDataQualitySettings, defaultProjectSettings, rainCheckLimits, type ProjectSettings, type RainSourcePeriod, type ZeroRainSettings } from '../project';
import type { CalibrationReport, ScoredPeriod } from './calibrate';
import type { FitScores } from './objective';
import {
	chirpsFactorsDrifted,
	CHIRPS_FACTOR_TOLERANCE,
	calibrationFitStatus,
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

/** The accumulation fields (engine ≥ 0.20.0) at their defaults. */
const ACC: Pick<ZeroRainSettings, 'accumulationMode' | 'keepReadings' | 'addAccumulations'> = { accumulationMode: 'spread', keepReadings: [], addAccumulations: [] };

const scores = (kge: number): FitScores => ({
	days: 100,
	kgePrime: kge,
	kgeYearly: null,
	kgeNp: kge,
	nse: kge,
	nseSqrt: kge,
	nseLog: kge,
	kgeLowHigh: kge,
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
		bounds: 'wide',
		budget: 300,
		seed: 7,
		starts: 1,
		startResults: [{ seed: 7, params: { x1: 512.25, x2: 0, x3: 61.5, x4: 2.25 }, score: 0.8, best: true }],
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
		// Other dated-period lists name their own entries.
		expect(exclusionsError([{ waterYear: 2015, reason: '' }], 'keep-dry period')).toBe('Keep-dry period 1: needs a reason');
		expect(exclusionsError(new Array(101).fill({ waterYear: 2015, reason: 'x' }), 'missing-rain period')).toBe('at most 100 missing-rain periods');
	});

	it('marks the excluded days of a run, clipped to it', () => {
		const m = excludedDayMask([{ start: '2019-12-30', end: '2020-01-02' }], '2020-01-01', 5);
		expect([...m]).toEqual([1, 1, 0, 0, 0]);
	});
});

describe('fit record', () => {
	const panCoefficient: Monthly = [0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7];
	const apanMm: Monthly = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
	const ctx = {
		settings: {
			calibrationStart: '2012-10-01',
			calibrationEnd: null,
			calibrationExclusions: [{ waterYear: 2015, reason: 'suspect rain' }],
			panCoefficient,
			apanMm,
			chirpsBiasCorrection: 'monthly' as const
		},
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
		expect(r.forcing).toEqual({
			panCoefficient,
			apanMm,
			chirpsBiasCorrection: 'monthly',
			chirpsFitPeriod: 'all',
			rainSource: [],
			pe: { kind: 'pan' },
			arealRain: null,
			rainChecks: rainCheckLimits(defaultDataQualitySettings())
		});
		expect(r.splitSample!.validation.scores.kgePrime).toBe(0.55);
		expect(r.notes).toEqual(['The record has 2 water years…']);
		expect(r.marPenalty).toBeNull();
		const penalty = { weight: 0.5, targetMarMm3: 12, marLowMm3: null, marHighMm3: null, basis: 'overlap' as const, marRatio: 1.05, unpenalised: null };
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

	it('drops a stored fit of the removed legacy model: nothing is fitted (engine 1.0.0)', () => {
		const legacy = { ...fitRecordFromReport(report(), ctx), model: 'legacy', free: ['a', 'b'], params: { a: 0.2, b: 1.4 } } as never;
		expect(resolveFitRecord({ ...gr4jSettings(), fitRecord: legacy } as never)).toBeNull();
		expect(calibrationFitStatus({ ...gr4jSettings(), fitRecord: legacy }, 'flow_logger_m3s')).toBe('notFitted');
		expect(fitRecordStatus(gr4jSettings(), legacy).otherModel).toBe(true);
		expect(fitRecordCaveats(fitRecordStatus(gr4jSettings(), legacy))[0]).toMatch(/legacy runoff model, removed in engine 1\.0\.0/);
		// Positive control: the GR4J fit is kept, and is this model's.
		const rec = fitRecordFromReport(report(), ctx);
		expect(resolveFitRecord({ ...gr4jSettings(), fitRecord: rec } as never)).not.toBeNull();
		expect(fitRecordStatus(gr4jSettings(), rec).otherModel).toBe(false);
	});

	it('calls the scores in-sample only when the parameters were fitted on the days scored (issue #45)', () => {
		const s = { ...gr4jSettings(), calibrationStart: '2012-10-01', calibrationExclusions: [{ waterYear: 2015, reason: 'suspect rain' }] };
		const rec = fitRecordFromReport(report(), ctx);
		// Positive control: the fit's model, window, exclusions and record, parameters as fitted.
		expect(calibrationFitStatus({ ...s, fitRecord: rec }, 'flow_logger_m3s')).toBe('fitted');
		// A forcing change since the fit leaves the days fitted the same.
		expect(calibrationFitStatus({ ...s, chirpsBiasCorrection: 'none', fitRecord: rec }, 'flow_logger_m3s')).toBe('fitted');
		// So does a fit recorded on a daily A-pan series (engine ≥ 0.40.0): replacing it is forcingChanged, not fitStatus.
		const onPan = fitRecordFromReport(report(), { ...ctx, apanDaily: { startDate: '2012-10-01', length: 730, valuesSha256: 'a'.repeat(64) } });
		expect(calibrationFitStatus({ ...s, fitRecord: onPan }, 'flow_logger_m3s')).toBe('fitted');
		expect(fitRecordStatus({ ...s, fitRecord: onPan }, onPan, { apanDaily: null }).apanDailyChanged).toBe(true);
		// Nothing fitted: no record, or a record for another runoff model (a stored legacy fit).
		expect(calibrationFitStatus(s, 'flow_logger_m3s')).toBe('notFitted');
		expect(calibrationFitStatus({ ...s, fitRecord: { ...rec, model: 'legacy' } as never }, 'flow_logger_m3s')).toBe('notFitted');
		// Edited by hand since the fit.
		expect(calibrationFitStatus({ ...s, gr4j: { ...s.gr4j, x1: 1 }, fitRecord: rec }, 'flow_logger_m3s')).toBe('edited');
		// Fitted, but on other days: another window, other exclusions or the other record.
		expect(calibrationFitStatus({ ...s, calibrationEnd: '2014-01-01', fitRecord: rec }, 'flow_logger_m3s')).toBe('otherPeriod');
		expect(calibrationFitStatus({ ...s, calibrationExclusions: [], fitRecord: rec }, 'flow_logger_m3s')).toBe('otherPeriod');
		expect(calibrationFitStatus({ ...s, fitRecord: rec }, 'flow_observed_m3s')).toBe('otherPeriod');
	});

	it('says when the fit no longer describes the settings', () => {
		const s = { ...gr4jSettings(), calibrationStart: '2012-10-01', calibrationExclusions: [{ waterYear: 2015, reason: 'suspect rain' }] };
		// The fit's own recorded forcing matches this settings object exactly, so forcingChanged starts false.
		const rec = fitRecordFromReport(report(), { ...ctx, settings: { ...ctx.settings, panCoefficient: s.panCoefficient, apanMm: s.apanMm } });
		const ok = fitRecordStatus(s, rec);
		expect(ok).toEqual({ editedParams: [], otherModel: false, windowChanged: false, exclusionsChanged: false, flowKindChanged: false, forcingChanged: false, chirpsSourceChanged: false, apanDailyChanged: false, chirpsFactorsChanged: false, observedOriginChanged: false, flowFillChanged: false });
		expect(fitRecordCaveats(ok)).toEqual([]);
		const changed = fitRecordStatus(
			{
				...s,
				gr4j: { ...s.gr4j, x1: 1 },
				calibrationEnd: '2014-01-01',
				calibrationExclusions: [],
				calibrationFlowKind: 'flow_observed_m3s',
				panCoefficient: [0.9, ...s.panCoefficient.slice(1)] as unknown as ProjectSettings['panCoefficient'],
				chirpsBiasCorrection: 'none'
			},
			rec
		);
		expect(changed).toEqual({ editedParams: ['x1'], otherModel: false, windowChanged: true, exclusionsChanged: true, flowKindChanged: true, forcingChanged: true, chirpsSourceChanged: false, apanDailyChanged: false, chirpsFactorsChanged: false, observedOriginChanged: false, flowFillChanged: false });
		const caveats = fitRecordCaveats(changed, (k) => k.toUpperCase());
		expect(caveats).toHaveLength(5);
		expect(caveats[0]).toMatch(/^Parameters edited since the fit: X1\./);
		expect(caveats.at(-1)).toMatch(/potential evaporation GR4J runs on \(the PE input, or the pan coefficient or A-pan evaporation it is taken from\), the areal rainfall correction, CHIRPS bias correction, CHIRPS fit period, rain-source periods or zero-rain run handling has changed since the fit/);
	});

	it('forcingChanged is tolerant of float noise, true only when the recorded forcing differs, and false when there is none to compare', () => {
		const rec = fitRecordFromReport(report(), ctx);
		const mono = (arr: number[]): Monthly => arr as unknown as Monthly;
		expect(fitRecordStatus({ panCoefficient, apanMm, chirpsBiasCorrection: 'monthly' }, rec).forcingChanged).toBe(false);
		// Same tolerance as `close` / `editedParams`: negligible float noise doesn't count.
		expect(fitRecordStatus({ panCoefficient: mono(panCoefficient.map((v) => v + 1e-12)), apanMm, chirpsBiasCorrection: 'monthly' }, rec).forcingChanged).toBe(false);
		expect(fitRecordStatus({ panCoefficient: mono(panCoefficient.map((v, i) => (i === 0 ? v + 0.1 : v))), apanMm, chirpsBiasCorrection: 'monthly' }, rec).forcingChanged).toBe(true);
		expect(fitRecordStatus({ panCoefficient, apanMm: mono(apanMm.map((v, i) => (i === 3 ? v + 5 : v))), chirpsBiasCorrection: 'monthly' }, rec).forcingChanged).toBe(true);
		// The CHIRPS bias correction mode alone can flag it too.
		expect(fitRecordStatus({ panCoefficient, apanMm, chirpsBiasCorrection: 'none' }, rec).forcingChanged).toBe(true);
		// Zero-rain run handling (engine ≥ 0.15.0) is part of the forcing too: a fit recorded with it flags a change of mode or list.
		const zr = { ...ACC, mode: 'missing' as const, keepDry: [], missing: [] };
		const withZr = fitRecordFromReport(report(), { ...ctx, settings: { ...ctx.settings, zeroRainRuns: zr } });
		expect(withZr.forcing!.zeroRainRuns).toEqual(zr);
		expect(fitRecordStatus({ panCoefficient, apanMm, chirpsBiasCorrection: 'monthly', zeroRainRuns: zr }, withZr).forcingChanged).toBe(false);
		expect(fitRecordStatus({ panCoefficient, apanMm, chirpsBiasCorrection: 'monthly', zeroRainRuns: { ...zr, mode: 'asRecorded' } }, withZr).forcingChanged).toBe(true);
		expect(
			fitRecordStatus({ panCoefficient, apanMm, chirpsBiasCorrection: 'monthly', zeroRainRuns: { ...zr, keepDry: [{ waterYear: 2003, reason: 'real' }] } }, withZr).forcingChanged
		).toBe(true);
		// … and a run snapshot from before the setting ran flagged runs as recorded.
		expect(fitRecordStatus({ panCoefficient, apanMm, chirpsBiasCorrection: 'monthly' }, withZr).forcingChanged).toBe(true);
		// The accumulation fields (engine ≥ 0.20.0) are part of it: a change of mode or list flags it …
		expect(fitRecordStatus({ panCoefficient, apanMm, chirpsBiasCorrection: 'monthly', zeroRainRuns: { ...zr, accumulationMode: 'asRecorded' } }, withZr).forcingChanged).toBe(true);
		expect(
			fitRecordStatus(
				{ panCoefficient, apanMm, chirpsBiasCorrection: 'monthly', zeroRainRuns: { ...zr, addAccumulations: [{ start: '2003-07-01', end: '2003-07-09', reason: 'observer away' }] } },
				withZr
			).forcingChanged
		).toBe(true);
		// … but a fit whose zeroRainRuns predates them (engine < 0.20.0) has nothing to compare them against.
		const { accumulationMode: _m, keepReadings: _k, addAccumulations: _a, ...preAcc } = zr;
		const pre020 = { ...withZr, forcing: { ...withZr.forcing!, zeroRainRuns: preAcc as unknown as ZeroRainSettings } };
		expect(fitRecordStatus({ panCoefficient, apanMm, chirpsBiasCorrection: 'monthly', zeroRainRuns: { ...zr, accumulationMode: 'asRecorded' } }, pre020).forcingChanged).toBe(false);
		expect(fitRecordStatus({ panCoefficient, apanMm, chirpsBiasCorrection: 'monthly', zeroRainRuns: { ...zr, mode: 'asRecorded' } }, pre020).forcingChanged).toBe(true);
		// A fit recorded before zeroRainRuns was tracked: nothing to compare, so it alone never flags.
		expect(fitRecordStatus({ panCoefficient, apanMm, chirpsBiasCorrection: 'monthly', zeroRainRuns: { ...zr, mode: 'asRecorded' } }, rec).forcingChanged).toBe(false);
		// The data-quality rain-check limits (engine ≥ 1.20.0) decide which zero runs are filled and which years the CHIRPS fit drops: a change flags the fit.
		const dq = defaultDataQualitySettings();
		expect(rec.forcing!.rainChecks).toEqual(rainCheckLimits(dq));
		const base = { panCoefficient, apanMm, chirpsBiasCorrection: 'monthly' as const };
		expect(fitRecordStatus({ ...base, dataQuality: dq }, rec).forcingChanged).toBe(false);
		expect(fitRecordStatus({ ...base, dataQuality: { ...dq, zeroRunChirpsCheck: true } }, rec).forcingChanged).toBe(true);
		expect(fitRecordStatus({ ...base, dataQuality: { ...dq, lowVsChirpsRatio: 0.4 } }, rec).forcingChanged).toBe(true);
		// … but not the limits that only flag (outliers, flat-lines, gauge vs logger).
		expect(fitRecordStatus({ ...base, dataQuality: { ...dq, outlierFactorRain: 8, agreementMinDays: 30 } }, rec).forcingChanged).toBe(false);
		// A fit recorded before the limits were settings ran the defaults: the defaults now are no change, others are.
		const pre120 = { ...rec, forcing: { ...rec.forcing!, rainChecks: undefined } };
		expect(fitRecordStatus({ ...base, dataQuality: dq }, pre120).forcingChanged).toBe(false);
		expect(fitRecordStatus(base, pre120).forcingChanged).toBe(false);
		expect(fitRecordStatus({ ...base, dataQuality: { ...dq, zeroRunRule: 'usualRain' } }, pre120).forcingChanged).toBe(true);
		// A fit made with non-default limits records them.
		const withDq = fitRecordFromReport(report(), { ...ctx, settings: { ...ctx.settings, dataQuality: { ...dq, zeroRunMinWetDays: 45 } } });
		expect(withDq.forcing!.rainChecks!.zeroRunMinWetDays).toBe(45);
		expect(fitRecordStatus({ ...base, dataQuality: dq }, withDq).forcingChanged).toBe(true);
		// A forcing recorded before chirpsBiasCorrection was added to it: nothing to compare, so it alone never flags.
		const noMode = { ...rec, forcing: { panCoefficient: [...panCoefficient], apanMm: [...apanMm] } };
		expect(fitRecordStatus({ panCoefficient, apanMm, chirpsBiasCorrection: 'none' }, noMode).forcingChanged).toBe(false);
		// A record made before `forcing` existed: nothing to compare, so it is never flagged.
		const old = { ...rec, forcing: undefined };
		const zeros = mono([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(fitRecordStatus({ panCoefficient: zeros, apanMm: zeros }, old).forcingChanged).toBe(false);
	});

	it('records the CHIRPS fit period and factors, and flags a changed fit period (engine ≥ 0.29.0)', () => {
		const ranges = [{ fromWaterYear: 1990, toWaterYear: 2004, reason: 'old network' }];
		const factors = [{ label: 'range 1990/91–2004/05 (old network), filling every year', fittedOn: '1990/91–2004/05', factors: new Array(12).fill(1.5) }];
		const rec = fitRecordFromReport(report({ chirpsFactors: factors }), { ...ctx, settings: { ...ctx.settings, chirpsFitPeriod: ranges } });
		expect(rec.forcing!.chirpsFitPeriod).toEqual(ranges);
		expect(rec.forcing!.chirpsFactors).toEqual(factors);
		const base = { panCoefficient, apanMm, chirpsBiasCorrection: 'monthly' as const };
		// Positive control: the same period is no change.
		expect(fitRecordStatus({ ...base, chirpsFitPeriod: [{ ...ranges[0]! }] }, rec).forcingChanged).toBe(false);
		expect(fitRecordStatus({ ...base, chirpsFitPeriod: 'all' }, rec).forcingChanged).toBe(true);
		expect(fitRecordStatus({ ...base, chirpsFitPeriod: [{ ...ranges[0]!, toWaterYear: 2005 }] }, rec).forcingChanged).toBe(true);
		// Settings without it (a run before engine 0.29.0) fitted the whole record.
		expect(fitRecordStatus(base, rec).forcingChanged).toBe(true);
		expect(fitRecordStatus(base, fitRecordFromReport(report(), ctx)).forcingChanged).toBe(false);
		// A forcing recorded before it: nothing to compare, so it alone never flags.
		const { chirpsFitPeriod: _p, chirpsFactors: _f, ...pre029 } = rec.forcing!;
		expect(fitRecordStatus({ ...base, chirpsFitPeriod: ranges }, { ...rec, forcing: pre029 }).forcingChanged).toBe(false);
	});

	it('records the rain-source periods and flags "forcing changed since fit" when they change (engine ≥ 0.30.0)', () => {
		const period: RainSourcePeriod = {
			start: '2012-10-01',
			end: '2019-09-30',
			series: 'rain_catchment_alt_mm',
			factors: 'fit',
			fitReference: { series: 'rain_reanalysis_mm', fromWaterYear: 1995, toWaterYear: 2008 },
			reason: 'automatic station replaces the averaged gauges'
		};
		const rec = fitRecordFromReport(report(), { ...ctx, settings: { ...ctx.settings, rainSource: [period] } });
		expect(rec.forcing!.rainSource).toEqual([period]);
		const base = { panCoefficient, apanMm, chirpsBiasCorrection: 'monthly' as const, chirpsFitPeriod: 'all' as const };
		// Positive control: the same periods are no change.
		expect(fitRecordStatus({ ...base, rainSource: [{ ...period }] }, rec).forcingChanged).toBe(false);
		expect(fitRecordStatus({ ...base, rainSource: [] }, rec).forcingChanged).toBe(true);
		expect(fitRecordStatus({ ...base, rainSource: [{ ...period, end: '2020-09-30' }] }, rec).forcingChanged).toBe(true);
		expect(fitRecordStatus({ ...base, rainSource: [{ ...period, fitReference: { ...period.fitReference!, fromWaterYear: 1990 } }] }, rec).forcingChanged).toBe(true);
		// Turning on the quantile map (engine ≥ 1.21.0) changes the rain the fit saw, and so does its threshold.
		const mapped = { ...period, quantileMap: { fromWaterYear: 1995, toWaterYear: 2008, wetDayMm: 1 } };
		expect(fitRecordStatus({ ...base, rainSource: [mapped] }, rec).forcingChanged).toBe(true);
		const recMapped = fitRecordFromReport(report(), { ...ctx, settings: { ...ctx.settings, rainSource: [mapped] } });
		expect(fitRecordStatus({ ...base, rainSource: [{ ...mapped }] }, recMapped).forcingChanged).toBe(false);
		expect(fitRecordStatus({ ...base, rainSource: [{ ...mapped, quantileMap: { ...mapped.quantileMap, wetDayMm: 2 } }] }, recMapped).forcingChanged).toBe(true);
		// A forcing recorded before 0.30.0 ran with no periods: adding one is a change, none is not.
		const { rainSource: _r, ...pre030 } = rec.forcing!;
		expect(fitRecordStatus({ ...base, rainSource: [period] }, { ...rec, forcing: pre030 }).forcingChanged).toBe(true);
		expect(fitRecordStatus(base, { ...rec, forcing: pre030 }).forcingChanged).toBe(false);
	});

	it('records where the pan-coefficient row came from, and never counts an edit to it as a forcing change (engine ≥ 0.31.1)', () => {
		const note = 'FAO-56 Table 5, Case A, 10 m green crop fetch; RH and wind: invented station, 2010–2020';
		const base = { panCoefficient, apanMm, chirpsBiasCorrection: 'monthly' as const, chirpsFitPeriod: 'all' as const, rainSource: [], panCoefficientSource: note };
		const rec = fitRecordFromReport(report(), { ...ctx, settings: { ...ctx.settings, panCoefficientSource: note } });
		expect(rec.forcing!.panCoefficientSource).toBe(note);
		// Positive control: the same settings are no change; then only the note differs, still no change.
		expect(fitRecordStatus(base, rec).forcingChanged).toBe(false);
		expect(fitRecordStatus({ ...base, panCoefficientSource: 'reworded' }, rec).forcingChanged).toBe(false);
		expect(fitRecordStatus({ ...base, panCoefficientSource: '' }, rec).forcingChanged).toBe(false);
		// No note, nothing recorded (a record made before 0.31.1 looks the same).
		expect(fitRecordFromReport(report(), ctx).forcing).not.toHaveProperty('panCoefficientSource');
	});

	it('records the PE input and flags a change of its kind or row, not of its source note or of A-pan alone under a monthly PE (engine ≥ 0.31.0)', () => {
		const mm: Monthly = [110, 130, 150, 160, 140, 115, 75, 45, 30, 30, 45, 75];
		const monthlyPe = { kind: 'monthly' as const, mm, source: 'station FAO-56 ET₀ × 1.0' };
		const base = { panCoefficient, apanMm, chirpsBiasCorrection: 'monthly' as const, chirpsFitPeriod: 'all' as const, rainSource: [] };
		const rec = fitRecordFromReport(report(), { ...ctx, settings: { ...ctx.settings, pe: monthlyPe } });
		expect(rec.forcing!.pe).toEqual(monthlyPe);
		// A copy, not the settings' own row.
		expect(rec.forcing!.pe).not.toBe(monthlyPe);
		const mono = (arr: number[]): Monthly => arr as unknown as Monthly;
		const status = (s: Partial<ProjectSettings>) => fitRecordStatus(s, rec).forcingChanged;
		// Positive control: the same PE is no change, nor is float noise.
		expect(status({ ...base, pe: { ...monthlyPe, mm: mono([...mm]) } })).toBe(false);
		expect(status({ ...base, pe: { ...monthlyPe, mm: mono(mm.map((v) => v + 1e-12)) } })).toBe(false);
		// Another row, or back to pan × A-pan, is a change.
		expect(status({ ...base, pe: { ...monthlyPe, mm: mono(mm.map((v, i) => (i === 2 ? v + 5 : v))) } })).toBe(true);
		expect(status({ ...base, pe: { kind: 'pan' } })).toBe(true);
		// Settings without pe (a run before 0.31.0) ran pan × A-pan: a change from this monthly fit.
		expect(status(base)).toBe(true);
		// Rewording the source note doesn't change what GR4J ran on.
		expect(status({ ...base, pe: { ...monthlyPe, source: 'ET₀ from the farm AWS, 2001–2020' } })).toBe(false);
		// Under a monthly PE, GR4J never reads A-pan or the pan coefficient: changing them alone is no GR4J forcing change.
		const apan2 = mono(apanMm.map((v) => v * 1.2));
		const k2 = mono(panCoefficient.map(() => 0.8));
		expect(status({ ...base, apanMm: apan2, panCoefficient: k2, pe: monthlyPe })).toBe(false);
		// … but under pan × A-pan they are (positive control).
		const panRec = fitRecordFromReport(report(), ctx);
		expect(panRec.forcing!.pe).toEqual({ kind: 'pan' });
		expect(fitRecordStatus({ ...base, pe: { kind: 'pan' } }, panRec).forcingChanged).toBe(false);
		expect(fitRecordStatus({ ...base, apanMm: apan2, pe: { kind: 'pan' } }, panRec).forcingChanged).toBe(true);
		expect(fitRecordStatus({ ...base, panCoefficient: k2 }, panRec).forcingChanged).toBe(true);
		// A pan fit, then switching to a monthly PE, is a change even when A-pan is untouched.
		expect(fitRecordStatus({ ...base, pe: monthlyPe }, panRec).forcingChanged).toBe(true);
		// A forcing recorded before 0.31.0 (no pe) ran pan × A-pan: current pan settings match it, monthly ones don't.
		const { pe: _pe, ...pre031 } = panRec.forcing!;
		const old = { ...panRec, forcing: pre031 };
		expect(fitRecordStatus({ ...base, pe: { kind: 'pan' } }, old).forcingChanged).toBe(false);
		expect(fitRecordStatus(base, old).forcingChanged).toBe(false);
		expect(fitRecordStatus({ ...base, pe: monthlyPe }, old).forcingChanged).toBe(true);
		// The caveat names the PE input.
		expect(fitRecordCaveats(fitRecordStatus({ ...base, pe: monthlyPe }, old)).at(-1)).toMatch(/^The potential evaporation GR4J runs on \(the PE input/);
	});

	it('flags a fit made on another CHIRPS version (issue #40 part c), only when both sides know the version', () => {
		const s = { panCoefficient, apanMm, chirpsBiasCorrection: 'monthly' as const };
		const v2 = { product: 'CHIRPS', version: '2.0' };
		const v3 = { product: 'CHIRPS', version: '3.0' };
		const rec = fitRecordFromReport(report(), { ...ctx, chirpsSource: v2 });
		expect(rec.forcing!.chirpsSource).toEqual(v2);
		expect(fitRecordStatus(s, rec, { chirpsSource: { ...v2 } })).toMatchObject({ forcingChanged: false, chirpsSourceChanged: false });
		const changed = fitRecordStatus(s, rec, { chirpsSource: v3 });
		expect(changed).toMatchObject({ forcingChanged: true, chirpsSourceChanged: true });
		const caveats = fitRecordCaveats(changed);
		expect(caveats.filter((c) => /CHIRPS series holds another product or version than the fit ran on/.test(c))).toHaveLength(1);
		// Said once, not again as the generic forcing caveat.
		expect(caveats.some((c) => /pan coefficient, A-pan evaporation/.test(c))).toBe(false);
		// Unrecorded is a version of its own: a fit on v2.0 against a series whose version is no longer recorded is flagged.
		expect(fitRecordStatus(s, rec, { chirpsSource: null }).chirpsSourceChanged).toBe(true);
		// The caller doesn't know the version now, or the record predates it: nothing to compare.
		expect(fitRecordStatus(s, rec).chirpsSourceChanged).toBe(false);
		const before = fitRecordFromReport(report(), ctx);
		expect(before.forcing).not.toHaveProperty('chirpsSource');
		expect(fitRecordStatus(s, before, { chirpsSource: v3 })).toMatchObject({ forcingChanged: false, chirpsSourceChanged: false });
		// A fit on a series with no recorded version records null.
		expect(fitRecordFromReport(report(), { ...ctx, chirpsSource: null }).forcing!.chirpsSource).toBeNull();
	});

	it('records the fitted record’s source and unit, and flags a change only when both sides know it (issue #66)', () => {
		const s = { panCoefficient, apanMm, chirpsBiasCorrection: 'monthly' as const };
		const dws = { source: 'DWS X1H001', unit: 'm³/s', factor: 1 };
		const rec = fitRecordFromReport(report(), { ...ctx, observedOrigin: dws });
		expect(rec.observedOrigin).toEqual(dws);
		expect(fitRecordStatus(s, rec, { observedOrigin: { ...dws } }).observedOriginChanged).toBe(false);
		const litres = fitRecordStatus(s, rec, { observedOrigin: { ...dws, unit: 'l/s', factor: 0.001 } });
		expect(litres).toMatchObject({ observedOriginChanged: true, forcingChanged: false });
		expect(fitRecordCaveats(litres).filter((c) => /calibration record now comes from another source/.test(c))).toHaveLength(1);
		expect(fitRecordStatus(s, rec).observedOriginChanged).toBe(false);
		const before = fitRecordFromReport(report(), ctx);
		expect(before).not.toHaveProperty('observedOrigin');
		expect(fitRecordStatus(s, before, { observedOrigin: dws }).observedOriginChanged).toBe(false);
	});

	it('records the fitted record’s gap filling, and flags a change only when filled days are read then or now (issue #66)', () => {
		const spec = { interpolateMaxDays: 5, donor: null, donorMaxDays: 60, donorMinOverlapDays: 365 };
		const fill = (useFilledDays: boolean, sp: typeof spec | null = spec) => ({ flow_observed_m3s: null, flow_logger_m3s: sp, useFilledDays });
		const s = { ...gr4jSettings(), calibrationStart: '2012-10-01', calibrationExclusions: [{ waterYear: 2015, reason: 'suspect rain' }] };
		const shown = fitRecordFromReport(report(), { ...ctx, settings: { ...ctx.settings, flowGapFill: fill(false) } });
		expect(shown.flowGapFill).toEqual({ spec, useFilledDays: false });
		// Filled days not read, then or now: another spec changes nothing the fit saw.
		expect(fitRecordStatus({ ...s, flowGapFill: fill(false, { ...spec, interpolateMaxDays: 2 }) }, shown).flowFillChanged).toBe(false);
		expect(fitRecordStatus({ ...s, flowGapFill: fill(true) }, shown).flowFillChanged).toBe(true);
		const read = fitRecordFromReport(report(), { ...ctx, settings: { ...ctx.settings, flowGapFill: fill(true) } });
		expect(fitRecordStatus({ ...s, flowGapFill: fill(true) }, read).flowFillChanged).toBe(false);
		const other = fitRecordStatus({ ...s, flowGapFill: fill(true, { ...spec, interpolateMaxDays: 2 }) }, read);
		expect(other.flowFillChanged).toBe(true);
		expect(fitRecordCaveats(other).some((c) => /gap filling of the calibration record has changed/.test(c))).toBe(true);
		// The scores are then on other days.
		expect(calibrationFitStatus({ ...s, flowGapFill: fill(true, { ...spec, interpolateMaxDays: 2 }), fitRecord: read }, 'flow_logger_m3s')).toBe('otherPeriod');
		// A record from before it read measured days only: flagged only once filled days are read.
		const { flowGapFill: _gone, ...older } = shown;
		expect(fitRecordStatus({ ...s, flowGapFill: fill(false) }, older).flowFillChanged).toBe(false);
		expect(fitRecordStatus({ ...s, flowGapFill: fill(true) }, older).flowFillChanged).toBe(true);
	});

	it('flags CHIRPS factors that drifted beyond 2 % since the fit, with the settings and product the same (issue #51)', () => {
		const s = { runoffModel: 'gr4j' as const, panCoefficient, apanMm, chirpsBiasCorrection: 'monthly' as const, chirpsFitPeriod: 'all' as const };
		const f = [1.1, 1.2, 0.9, 1, 1, 1, 1, 1, 1, 1, 1, null];
		const set = (factors: (number | null)[]) => [{ label: 'whole record', factors }];
		const rec = fitRecordFromReport(report({ chirpsFactors: set(f) }), { ...ctx, settings: { ...ctx.settings, chirpsFitPeriod: 'all' } });
		// Positive control: the same factors, and a drift within 2 % (1.1 → 1.12, +1.8 %), are no change.
		expect(fitRecordStatus(s, rec, { chirpsFactors: set(f) })).toMatchObject({ forcingChanged: false, chirpsFactorsChanged: false });
		expect(fitRecordStatus(s, rec, { chirpsFactors: set([1.12, ...f.slice(1)]) }).chirpsFactorsChanged).toBe(false);
		// 1.2 → 1.23 (+2.5 %): changed, with its own caveat, said once.
		const drifted = fitRecordStatus(s, rec, { chirpsFactors: set([1.1, 1.23, ...f.slice(2)]) });
		expect(drifted).toMatchObject({ forcingChanged: true, chirpsFactorsChanged: true });
		const caveats = fitRecordCaveats(drifted);
		expect(caveats.filter((c) => /monthly CHIRPS factors this run applies differ by more than 2 %/.test(c))).toHaveLength(1);
		expect(caveats.some((c) => /^The potential evaporation GR4J runs on/.test(c))).toBe(false);
		// A month gaining or losing a factor, or another number of fit ranges, is a change.
		expect(fitRecordStatus(s, rec, { chirpsFactors: set([...f.slice(0, 11), 1]) }).chirpsFactorsChanged).toBe(true);
		expect(fitRecordStatus(s, rec, { chirpsFactors: [...set(f), ...set(f)] }).chirpsFactorsChanged).toBe(true);
		// Unknown on either side: nothing to compare.
		expect(fitRecordStatus(s, rec).chirpsFactorsChanged).toBe(false);
		const { chirpsFactors: _f, ...noFactors } = rec.forcing!;
		expect(fitRecordStatus(s, { ...rec, forcing: noFactors }, { chirpsFactors: set([2, ...f.slice(1)]) }).chirpsFactorsChanged).toBe(false);
		// A change of mode or product is said by its own flag, not as drift.
		expect(fitRecordStatus({ ...s, chirpsBiasCorrection: 'none' }, rec, { chirpsFactors: null })).toMatchObject({ forcingChanged: true, chirpsFactorsChanged: false });
	});

	it('chirpsFactorsDrifted compares month by month, relative to the fit’s factor', () => {
		const one = (factors: (number | null)[]) => [{ label: 'whole record', factors }];
		expect(chirpsFactorsDrifted(null, null)).toBe(false);
		expect(chirpsFactorsDrifted(null, one([1]))).toBe(true);
		expect(chirpsFactorsDrifted(one([0.5]), one([0.509]))).toBe(false);
		expect(chirpsFactorsDrifted(one([0.5]), one([0.511]))).toBe(true);
		expect(chirpsFactorsDrifted(one([null]), one([null]))).toBe(false);
		expect(CHIRPS_FACTOR_TOLERANCE).toBe(0.02);
	});

	it('flags a GR4J fit whose daily A-pan series has changed since (issue #45), only when both sides know it', () => {
		const s = { runoffModel: 'gr4j' as const, panCoefficient, apanMm, chirpsBiasCorrection: 'monthly' as const };
		const pan1 = { startDate: '2012-10-01', length: 730, valuesSha256: 'a'.repeat(64) };
		const rec = fitRecordFromReport(report(), { ...ctx, apanDaily: pan1 });
		expect(rec.forcing!.apanDaily).toEqual(pan1);
		// Positive control: the same series now is not a change.
		expect(fitRecordStatus(s, rec, { apanDaily: { ...pan1 } })).toMatchObject({ forcingChanged: false, apanDailyChanged: false });
		expect(fitRecordCaveats(fitRecordStatus(s, rec, { apanDaily: { ...pan1 } })).some((c) => /daily A-pan|potential evaporation/.test(c))).toBe(false);
		// Other values, a longer record, or no series at all: changed, with its own caveat, said once.
		for (const now of [{ ...pan1, valuesSha256: 'b'.repeat(64) }, { ...pan1, length: 731 }, { ...pan1, startDate: '2012-10-02' }, null]) {
			const st = fitRecordStatus(s, rec, { apanDaily: now });
			expect(st, JSON.stringify(now)).toMatchObject({ forcingChanged: true, apanDailyChanged: true });
			const caveats = fitRecordCaveats(st);
			expect(caveats.filter((c) => /daily A-pan evaporation series has been added, replaced or removed/.test(c))).toHaveLength(1);
			expect(caveats.some((c) => /^The potential evaporation GR4J runs on/.test(c))).toBe(false);
		}
		// A fit without a series, and a series added since.
		const none = fitRecordFromReport(report(), { ...ctx, apanDaily: null });
		expect(none.forcing!.apanDaily).toBeNull();
		expect(fitRecordStatus(s, none, { apanDaily: null }).apanDailyChanged).toBe(false);
		expect(fitRecordStatus(s, none, { apanDaily: pan1 }).apanDailyChanged).toBe(true);
		// Nothing to compare: the caller doesn't know the series, or the record predates tracking it.
		expect(fitRecordStatus(s, rec).apanDailyChanged).toBe(false);
		const before = fitRecordFromReport(report(), ctx);
		expect(before.forcing).not.toHaveProperty('apanDaily');
		expect(fitRecordStatus(s, before, { apanDaily: pan1 }).apanDailyChanged).toBe(false);
		// The series doesn't reach GR4J under a monthly PE, nor a stored legacy fit.
		const monthly = { kind: 'monthly' as const, mm: apanMm, source: 'station ET0' };
		expect(fitRecordStatus({ ...s, pe: monthly }, rec, { apanDaily: null }).apanDailyChanged).toBe(false);
		const legacy = { ...fitRecordFromReport(report(), { ...ctx, apanDaily: pan1 }), model: 'legacy' } as never;
		expect(fitRecordStatus(s, legacy, { apanDaily: null }).apanDailyChanged).toBe(false);
	});
});
