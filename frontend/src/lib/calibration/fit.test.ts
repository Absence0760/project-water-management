import { calibrate, defaultProjectSettings, ENGINE_VERSION, fitRecordStatus, forecastSplit, rainCheckLimits, type CalibrationReport, type ModelInput, type ProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import {
	applyReport,
	benchmarkRows,
	climatologyWarning,
	fitInput,
	fitParams,
	fitRecordFor,
	fittedAtText,
	fmtScore,
	intervalText,
	marPenaltyOn,
	progressFraction,
	rankedByText,
	SCORE_ROWS,
	scoreCellText,
	scoreColumns,
	SEED_MAX,
	seedError,
	STAGE_LABEL,
	stageText,
	totalRuns,
	validationRecordOptions,
	waterYearsText
} from './fit';

const scores = (kge: number) => ({
	days: 100,
	kgePrime: kge,
	kgeYearly: null,
	kgeNp: 0.5,
	nse: 0.4,
	nseSqrt: 0.5,
	nseLog: 0.3,
	kgeLowHigh: 0.4,
	volumeErrorPct: 5,
	fdcHighPct: -10,
	fdcMidSlopePct: 20,
	fdcLowPct: 3
});
/** Water years (Oct–Sep) a date span touches. */
const wys = (start: string, end: string) => {
	const wy = (d: string) => Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) < 10 ? 1 : 0);
	return Array.from({ length: wy(end) - wy(start) + 1 }, (_, i) => wy(start) + i);
};
const period = (start: string, end: string, kge: number, waterYears = wys(start, end)) => ({ start, end, waterYears, scores: scores(kge) });

function report(over: Partial<CalibrationReport> = {}): CalibrationReport {
	return {
		model: 'gr4j',
		objective: 'kgePrime',
		bounds: 'wide',
		budget: 100,
		seed: 1,
		starts: 1,
		startResults: [{ seed: 1, params: { x1: 800, x2: 0, x3: 40, x4: 1.2 }, score: 0.8, best: true }],
		free: ['x1', 'x3', 'x4'],
		params: { x1: 800, x2: 0, x3: 40, x4: 1.2 },
		startParams: { x1: 350, x2: 0, x3: 90, x4: 1.7 },
		flowKind: 'flow_observed_m3s',
		simulatedKey: 'simulated_outflow',
		fit: period('2003-01-01', '2008-12-31', 0.8),
		before: period('2003-01-01', '2008-12-31', 0.2),
		splitSample: null,
		differential: null,
		independentRecord: null,
		notes: [],
		exclusions: [],
		evaluations: 100,
		cancelled: false,
		...over
	};
}

describe('fitInput', () => {
	it('runs the unsaved form and network over the server’s series', () => {
		const server = { settings: defaultProjectSettings(), model: { nodes: [], crops: [], cropAreas: [], transfers: [] }, series: { rain_catchment_mm: { startDate: '2020-01-01', values: [1] } } } as unknown as ModelInput;
		const form = { ...defaultProjectSettings(), runoffModel: 'gr4j' as const };
		const edited = { nodes: [{ id: 'n' }], crops: [], cropAreas: [], transfers: [] } as unknown as ModelInput['model'];
		expect(fitInput(server, form).settings.runoffModel).toBe('gr4j');
		expect(fitInput(server, form).model).toBe(server.model);
		expect(fitInput(server, form, edited).model).toBe(edited);
		expect(fitInput(server, form).series).toBe(server.series);
	});
});

describe('fitParams', () => {
	it('offers GR4J X1, X3, X4 ticked, and X2 only when groundwater exchange is on (unticked)', () => {
		expect(fitParams().map((p) => [p.key, p.checked])).toEqual([
			['x1', true],
			['x3', true],
			['x4', true]
		]);
		expect(fitParams(true).find((p) => p.key === 'x2')).toMatchObject({ checked: false });
	});
});

describe('progress', () => {
	it('spreads the three stages over 0–1, or the one stage without validation', () => {
		expect(totalRuns(1500, true)).toBe(4500);
		expect(progressFraction({ stage: 'full', evaluations: 750, budget: 1500, best: 0 }, false)).toBe(0.5);
		expect(progressFraction({ stage: 'full', evaluations: 1500, budget: 1500, best: 0 }, true)).toBeCloseTo(1 / 3, 12);
		expect(progressFraction({ stage: 'dsst', evaluations: 1500, budget: 1500, best: 0 }, true)).toBe(1);
	});

	it('adds the fit without the WR2012 penalty as a last stage when the penalty is on', () => {
		expect(totalRuns(1500, true, true)).toBe(6000);
		expect(totalRuns(1500, false, true)).toBe(3000);
		expect(progressFraction({ stage: 'dsst', evaluations: 1500, budget: 1500, best: 0 }, true, true)).toBe(0.75);
		expect(progressFraction({ stage: 'unpenalised', evaluations: 750, budget: 1500, best: 0 }, false, true)).toBe(0.75);
		expect(STAGE_LABEL.unpenalised).toBe('Fitting again without the WR2012 penalty');
	});

	it('weights the full fit by its starts, and says which start is running (CR-2)', () => {
		expect(totalRuns(1500, true, false, 5)).toBe(1500 * 7);
		expect(totalRuns(1500, true, true, 5)).toBe(1500 * 8);
		const p = (stage: 'full' | 'split' | 'dsst' | 'unpenalised', evaluations: number, start?: number) =>
			({ stage, evaluations, budget: 100, best: 0, ...(start ? { start, starts: 5 } : {}) }) as const;
		// 5 starts + split + dsst = 7 equal parts.
		expect(progressFraction(p('full', 50, 1), true, false, 5)).toBeCloseTo(0.5 / 7, 12);
		expect(progressFraction(p('full', 100, 5), true, false, 5)).toBeCloseTo(5 / 7, 12);
		expect(progressFraction(p('split', 50), true, false, 5)).toBeCloseTo(5.5 / 7, 12);
		expect(progressFraction(p('dsst', 100), true, false, 5)).toBe(1);
		expect(progressFraction(p('unpenalised', 50), false, true, 5)).toBeCloseTo(5.5 / 6, 12);
		expect(stageText(p('full', 10, 2))).toBe('Fitting the whole record (start 2 of 5)');
		expect(stageText(p('split', 10))).toBe('Split-sample test');
	});

	it('the penalty applies only when switched on and a reference is entered', () => {
		const s = defaultProjectSettings();
		expect(marPenaltyOn(s)).toBe(false);
		expect(marPenaltyOn({ wr2012: { ...s.wr2012, calibrationPenalty: { enabled: true, weight: 1, marLowMm3: null, marHighMm3: null } } })).toBe(false);
		const reference = { quaternary: 'Z99A', areaKm2: 1, marMm3: 1, monthlyMm3: new Array(12).fill(1 / 12), periodStart: 1990, periodEnd: 2000, mapMm: null, source: 's' };
		expect(marPenaltyOn({ wr2012: { ...s.wr2012, reference } })).toBe(false);
		expect(marPenaltyOn({ wr2012: { ...s.wr2012, reference, calibrationPenalty: { enabled: true, weight: 1, marLowMm3: null, marHighMm3: null } } })).toBe(true);
	});
});

describe('scoreColumns', () => {
	it('lists before and fitted, then each test’s fitted and validation part, validation marked', () => {
		const r = report({
			splitSample: { params: {}, calibration: period('2003-01-01', '2005-12-31', 0.8), validation: period('2006-01-01', '2008-12-31', 0.4) },
			differential: {
				params: {},
				calibration: period('2004-10-01', '2007-09-30', 0.7, [2004, 2006]),
				validation: period('2003-10-01', '2008-09-30', 0.3, [2003, 2007]),
				dryYears: [2004, 2006],
				wetYears: [2003, 2007],
				wetDryRatio: 2
			}
		});
		const cols = scoreColumns(r);
		expect(cols.map((c) => [c.id, c.validation])).toEqual([
			['before', false],
			['fit', false],
			['split-cal', false],
			['split-val', true],
			['dsst-cal', false],
			['dsst-val', true]
		]);
		expect(cols[3]!.period).toBe('2006-01-01 – 2008-12-31');
		expect(cols[5]!.period).toBe('WY 2003/04, 2007/08');
		expect(scoreColumns(report()).map((c) => c.id)).toEqual(['before', 'fit']);
	});

	it('adds the fit on all days beside the fit when the quality flags changed the days scored (CR-19), and not otherwise', () => {
		const cols = scoreColumns(report({ fitAllDays: period('2003-01-01', '2008-12-31', 0.5) }));
		expect(cols.map((c) => [c.id, c.label, c.validation])).toEqual([
			['before', 'Current parameters', false],
			['fit', 'Fitted', false],
			['fit-all', 'Fitted, all days (flags ignored)', false]
		]);
		expect(scoreColumns(report({ fitAllDays: null })).map((c) => c.id)).toEqual(['before', 'fit']);
	});

	it('shows the dry → wet test as the water years scored, never an overlapping date envelope', () => {
		// Interleaved years: the dry set's first–last dates (2004-10-01 … 2007-09-30)
		// sit inside the wet set's (2003-10-01 … 2008-09-30), although no year is in both.
		const r = report({
			differential: {
				params: {},
				calibration: period('2004-10-01', '2007-09-30', 0.7, [2004, 2006]),
				validation: period('2003-10-01', '2008-09-30', 0.3, [2003, 2005, 2007]),
				dryYears: [2004, 2006],
				wetYears: [2003, 2005, 2007],
				wetDryRatio: 2
			}
		});
		const [dry, wet] = scoreColumns(r).filter((c) => c.id.startsWith('dsst'));
		expect(dry!.period).toBe('WY 2004/05, 2006/07');
		expect(wet!.period).toBe('WY 2003/04, 2005/06, 2007/08');
		for (const c of [dry!, wet!]) expect(c.period).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(waterYearsText([1999])).toBe('WY 1999/00');
		expect(waterYearsText([])).toBe('–');
	});

	it('says what ranked the dry → wet years: the reference gauge, else the fitted record (also for a test from before rankedBy)', () => {
		expect(rankedByText({ rankedBy: 'reference' })).toBe('years ranked dry → wet by the reference gauge (other catchment), a regional wet/dry index that is never scored');
		expect(rankedByText({ rankedBy: 'observed' })).toBe('years ranked dry → wet by the fitted record’s own mean flow');
		expect(rankedByText({})).toBe(rankedByText({ rankedBy: 'observed' }));
	});

	it('adds the independent-record validation column when the report has one', () => {
		const r = report({
			independentRecord: {
				flowKind: 'flow_logger_m3s',
				simulatedKey: 'simulated_outflow',
				params: {},
				calibration: period('2003-01-01', '2008-12-31', 0.8),
				validation: period('2005-10-01', '2008-09-30', 0.5),
				overlapDays: 0
			}
		});
		const last = scoreColumns(r).at(-1)!;
		expect(last).toMatchObject({ id: 'record-val', label: 'Independent record: Logger flow', period: '2005-10-01 – 2008-09-30', validation: true });
		expect(last.scores.kgePrime).toBe(0.5);
	});
});

describe('score intervals and benchmarks (CR-5)', () => {
	const iv = (lo: number, hi: number) => ({ lo, hi });
	const intervals = { level: 0.9, resamples: 1000, seed: 1, years: 6, kgePrime: iv(0.48, 0.71), nse: iv(-0.3, 0.05), kgeLowHigh: null };
	const bench = (clim: number) => ({ meanFlow: { ...scores(1 - Math.SQRT2), nse: 0 }, climatology: scores(clim), halfWindowDays: 7 });
	const withExtras = (p: ReturnType<typeof period>, clim: number) => ({ ...p, intervals, benchmarks: bench(clim) });

	it('a score cell carries its 90 % interval when there is one, and a negative bound never reads as a dash', () => {
		const [col] = scoreColumns(report({ before: withExtras(period('2003-01-01', '2008-12-31', 0.62), 0.3) }));
		expect(scoreCellText(col!, 'kgePrime')).toBe('0.62 (0.48–0.71)');
		expect(scoreCellText(col!, 'nse')).toBe('0.40 (-0.30 to 0.05)');
		// No interval for this score, or not a score that gets one: the bare value.
		expect(scoreCellText(col!, 'kgeLowHigh')).toBe('0.40');
		expect(scoreCellText(col!, 'volumeErrorPct', '%')).toBe('+5.0%');
		expect(intervalText(iv(-0.5, -0.1))).toBe('(-0.50 to -0.10)');
	});

	it('reads a report or stored record from before them: no intervals, no benchmarks, a missing score as "–"', () => {
		const p = period('2003-01-01', '2008-12-31', 0.62);
		const { kgeLowHigh: _, ...before118 } = p.scores;
		const cols = scoreColumns(report({ fit: { ...p, scores: before118 as typeof p.scores } }));
		expect(cols[1]).toMatchObject({ intervals: null, benchmarks: null });
		expect(scoreCellText(cols[1]!, 'kgePrime')).toBe('0.62');
		expect(scoreCellText(cols[1]!, 'kgeLowHigh')).toBe('–');
		expect(benchmarkRows(cols, 'kgePrime')).toEqual([]);
		expect(climatologyWarning(cols, 'kgePrime')).toBeNull();
		expect(fmtScore(undefined)).toBe('–');
		expect(fmtScore(Number.NaN)).toBe('–');
	});

	it('benchmark rows: the model, the mean flow and the climatology on the fit’s objective, over the columns that have them', () => {
		const r = report({
			fit: withExtras(period('2003-01-01', '2008-12-31', 0.62), 0.3),
			splitSample: { params: {}, calibration: period('2003-01-01', '2005-12-31', 0.8), validation: withExtras(period('2006-01-01', '2008-12-31', 0.4), 0.2) }
		});
		const rows = benchmarkRows(scoreColumns(r), 'kgePrime');
		expect(rows).toEqual([
			{ label: 'Model', cells: ['0.62 (0.48–0.71)', '0.40 (0.48–0.71)'] },
			{ label: 'Mean flow every day', cells: ['-0.41', '-0.41'] },
			{ label: 'Day-of-year climatology (±7 days)', cells: ['0.30', '0.20'] }
		]);
		expect(climatologyWarning(scoreColumns(r), 'kgePrime')).toBeNull();
	});

	it('one plain sentence when the model doesn’t beat climatology on the fitted or a validation period (not on “current parameters”)', () => {
		const r = report({
			before: withExtras(period('2003-01-01', '2008-12-31', 0.1), 0.5),
			fit: withExtras(period('2003-01-01', '2008-12-31', 0.62), 0.3),
			splitSample: { params: {}, calibration: period('2003-01-01', '2005-12-31', 0.8), validation: withExtras(period('2006-01-01', '2008-12-31', 0.4), 0.45) }
		});
		expect(climatologyWarning(scoreColumns(r), 'kgePrime')).toBe(
			'On “Split: other half”, the model scores no better than repeating each calendar day’s average observed flow: it adds little beyond the seasonal cycle there.'
		);
		const both = report({ ...r, fit: withExtras(period('2003-01-01', '2008-12-31', 0.3), 0.3) });
		expect(climatologyWarning(scoreColumns(both), 'kgePrime')).toMatch(/^On the fitted period and “Split: other half”, /);
	});
});

describe('validationRecordOptions', () => {
	const both = ['rain_catchment_mm', 'flow_observed_m3s', 'flow_logger_m3s'];
	it('offers the other record only when both a gauge and a logger record exist', () => {
		expect(validationRecordOptions(both, null)).toEqual(['flow_logger_m3s']);
		expect(validationRecordOptions(both, 'flow_observed_m3s')).toEqual(['flow_logger_m3s']);
		expect(validationRecordOptions(both, 'flow_logger_m3s')).toEqual(['flow_observed_m3s']);
		expect(validationRecordOptions(['flow_observed_m3s'], null)).toEqual([]);
		expect(validationRecordOptions(['flow_logger_m3s'], 'flow_logger_m3s')).toEqual([]);
		expect(validationRecordOptions(null, null)).toEqual([]);
	});

	it('has a row for every score the engine reports', () => {
		expect(SCORE_ROWS.map((r) => r.key).sort()).toEqual(Object.keys(scores(0)).filter((k) => k !== 'days').sort());
	});
});

describe('applyReport', () => {
	it('writes only the fitted parameters into gr4j, and leaves the rest of the form alone', () => {
		const s = defaultProjectSettings();
		const g = applyReport(s, report());
		expect(g.gr4j).toEqual({ x1: 800, x2: 0, x3: 40, x4: 1.2, warmupDays: 365 });
		expect(g.calibration).toBe(s.calibration);
	});

	it('round-trips an engine report: applied settings reproduce the fitted score', () => {
		const days = 3 * 365;
		const rain = Array.from({ length: days }, (_, i) => (i % 11 === 0 ? 30 : i % 4 === 0 ? 2 : 0));
		const flow = Array.from({ length: days }, (_, i) => 0.05 + 0.4 * Math.exp(-(i % 11) / 2));
		const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 1, lossReturnFraction: 0, damAreaFullM2: null, damAreaExponent: 0.7, damSeepagePerDay: 0 };
		const input: ModelInput = {
			settings: { ...defaultProjectSettings(), runoffModel: 'gr4j', apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] },
			model: {
				nodes: [
					{ ...node, id: 'G', name: 'G', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
					{ ...node, id: 'F', name: 'F', kind: 'farm', downstreamNodeId: 'G', areaKm2: 20 }
				],
				crops: [],
				cropAreas: [],
				transfers: []
			},
			series: { rain_catchment_mm: { startDate: '2005-10-01', values: rain }, flow_observed_m3s: { startDate: '2005-10-01', values: flow } }
		};
		const r = calibrate(input, { budget: 80, validate: false });
		const applied: ModelInput = { ...input, settings: applyReport(input.settings as ReturnType<typeof defaultProjectSettings>, r) as unknown as ModelInput['settings'] };
		expect(calibrate(applied, { budget: 1, validate: false }).before.scores.kgePrime).toBeCloseTo(r.fit.scores.kgePrime!, 12);
		// The record Apply stores describes the applied settings exactly: nothing edited, nothing changed.
		const settings = applied.settings as ReturnType<typeof defaultProjectSettings>;
		const record = fitRecordFor(r, settings, { validate: false, validationRecord: null });
		expect(fitRecordStatus(settings, record)).toEqual({
			editedParams: [],
			otherModel: false,
			windowChanged: false,
			exclusionsChanged: false,
			qualityFlagsChanged: false,
			flowKindChanged: false,
			forcingChanged: false,
			chirpsSourceChanged: false,
			apanDailyChanged: false,
			chirpsFactorsChanged: false
		});
	});
});

describe('seedError', () => {
	it('takes whole numbers 0 … 2³¹ − 1', () => {
		for (const ok of [0, 1, 42, SEED_MAX]) expect(seedError(ok), String(ok)).toBeNull();
		expect(seedError(null)).toBe('Enter a seed.');
		for (const bad of [-1, 1.5, SEED_MAX + 1, NaN]) expect(seedError(bad), String(bad)).toMatch(/whole number/);
	});
});

describe('fitRecordFor', () => {
	it('records the report with the form it ran on, the engine version and the time', () => {
		const form = { ...defaultProjectSettings(), calibrationStart: '2004-10-01', calibrationExclusions: [{ waterYear: 2006, reason: 'suspect rain' }] };
		const r = report({ seed: 99, notes: ['A note.'], splitSample: { params: {}, calibration: period('2003-01-01', '2005-12-31', 0.8), validation: period('2006-01-01', '2008-12-31', 0.4) } });
		const rec = fitRecordFor(r, form, { validate: true, validationRecord: 'flow_logger_m3s', now: new Date('2026-09-24T10:05:33.120Z') });
		expect(rec).toMatchObject({
			fittedAt: '2026-09-24T10:05:33.120Z',
			engineVersion: ENGINE_VERSION,
			seed: 99,
			starts: 1,
			startResults: [{ seed: 1, params: { x1: 800, x2: 0, x3: 40, x4: 1.2 }, score: 0.8, best: true }],
			budget: 100,
			objective: 'kgePrime',
			calibrationStart: '2004-10-01',
			calibrationEnd: null,
			exclusions: [{ waterYear: 2006, reason: 'suspect rain' }],
			validate: true,
			validationRecord: 'flow_logger_m3s',
			notes: ['A note.'],
			editedParams: []
		});
		// The stored record draws the same score table as the report (in-sample fit next to its validation).
		expect(scoreColumns(rec)).toEqual(scoreColumns(r));
		// Later edits to the form don't reach the stored record.
		form.calibrationExclusions[0]!.reason = 'changed';
		expect(rec.exclusions[0]!.reason).toBe('suspect rain');
	});

	it('records the evaporation forcing the fit ran under, copied, not shared with the form', () => {
		const form = { ...defaultProjectSettings(), panCoefficient: [0.65, 0.65, 0.65, 0.65, 0.65, 0.65, 0.65, 0.65, 0.65, 0.65, 0.65, 0.65] as ProjectSettings['panCoefficient'] };
		const rec = fitRecordFor(report(), form, { validate: false, validationRecord: null });
		expect(rec.forcing).toEqual({ panCoefficient: form.panCoefficient, apanMm: form.apanMm, chirpsBiasCorrection: 'monthly', zeroRainRuns: form.zeroRainRuns, chirpsFitPeriod: 'all', rainSource: [], pe: { kind: 'pan' }, arealRain: null, rainChecks: rainCheckLimits(form.dataQuality) });
		(form.panCoefficient as unknown as number[])[0] = 0.9;
		expect(rec.forcing!.panCoefficient[0]).toBe(0.65);
	});

	it('records the areal rainfall correction the fit ran under (engine ≥ 1.13.0)', () => {
		const arealRain = { factors: new Array(12).fill(1.9) as unknown as ProjectSettings['panCoefficient'], method: 'map' as const, source: 'invented MAP ÷ forcing mean' };
		const rec = fitRecordFor(report(), { ...defaultProjectSettings(), arealRain }, { validate: false, validationRecord: null });
		expect(rec.forcing!.arealRain).toEqual(arealRain);
		expect(rec.forcing!.arealRain!.factors).not.toBe(arealRain.factors);
	});

	it('records where the pan-coefficient row came from, when noted (engine ≥ 0.31.1)', () => {
		const form = { ...defaultProjectSettings(), panCoefficientSource: 'FAO-56 Table 5, Case A' };
		expect(fitRecordFor(report(), form, { validate: false, validationRecord: null }).forcing!.panCoefficientSource).toBe('FAO-56 Table 5, Case A');
		expect(fitRecordFor(report(), defaultProjectSettings(), { validate: false, validationRecord: null }).forcing).not.toHaveProperty('panCoefficientSource');
	});

	it('records a monthly PE input the fit ran under, copied (issue #39)', () => {
		const mm = new Array(12).fill(90) as unknown as ProjectSettings['apanMm'];
		const form = { ...defaultProjectSettings(), pe: { kind: 'monthly' as const, mm, source: 'station ET₀' } };
		const rec = fitRecordFor(report(), form, { validate: false, validationRecord: null });
		expect(rec.forcing!.pe).toEqual({ kind: 'monthly', mm, source: 'station ET₀' });
		(mm as unknown as number[])[0] = 1;
		expect(rec.forcing!.pe).toEqual({ kind: 'monthly', mm: new Array(12).fill(90), source: 'station ET₀' });
	});

	it('records the CHIRPS fit period the fit ran under, copied, and the factor sets from the report (engine ≥ 0.29.0)', () => {
		const ranges = [{ fromWaterYear: 1990, toWaterYear: 2004, reason: 'old network' }];
		const form = { ...defaultProjectSettings(), chirpsFitPeriod: ranges };
		const sets = [{ label: 'listed range 1990/91–2004/05 (old network), filling every year', factors: new Array(12).fill(1.4) }];
		const rec = fitRecordFor(report({ chirpsFactors: sets }), form, { validate: false, validationRecord: null });
		expect(rec.forcing!.chirpsFitPeriod).toEqual(ranges);
		expect(rec.forcing!.chirpsFactors).toEqual(sets);
		ranges[0]!.toWaterYear = 2010;
		expect((rec.forcing!.chirpsFitPeriod as typeof ranges)[0]!.toWaterYear).toBe(2004);
	});

	it('records the rain-source periods the fit ran under, copied (engine ≥ 0.30.0)', () => {
		const period = {
			start: '2012-10-01',
			end: '2019-09-30',
			series: 'rain_catchment_alt_mm' as const,
			factors: 'fit' as const,
			fitReference: { series: 'rain_reanalysis_mm' as const, fromWaterYear: 1995, toWaterYear: 2011 },
			reason: 'automatic station'
		};
		const form = { ...defaultProjectSettings(), rainSource: [period] };
		const rec = fitRecordFor(report(), form, { validate: false, validationRecord: null });
		expect(rec.forcing!.rainSource).toEqual([period]);
		period.end = '2020-09-30';
		expect(rec.forcing!.rainSource![0]!.end).toBe('2019-09-30');
		// And a change of periods flags "forcing changed since fit".
		expect(fitRecordStatus({ ...form, rainSource: [] }, rec).forcingChanged).toBe(true);
	});

	it('records the CHIRPS bias correction mode the fit ran under too', () => {
		const form = { ...defaultProjectSettings(), chirpsBiasCorrection: 'none' as const };
		const rec = fitRecordFor(report(), form, { validate: false, validationRecord: null });
		expect(rec.forcing!.chirpsBiasCorrection).toBe('none');
	});

	it('records the zero-rain run settings the fit ran under, accumulation fields included, copied, not shared with the form (CR-20, B4)', () => {
		const form = {
			...defaultProjectSettings(),
			zeroRainRuns: {
				...defaultProjectSettings().zeroRainRuns,
				mode: 'missing' as const,
				keepDry: [{ waterYear: 2003, reason: 'real' }],
				accumulationMode: 'asRecorded' as const,
				addAccumulations: [{ start: '2003-07-01', end: '2003-07-09', reason: 'observer away' }]
			}
		};
		const rec = fitRecordFor(report(), form, { validate: false, validationRecord: null });
		expect(rec.forcing!.zeroRainRuns).toEqual(form.zeroRainRuns);
		form.zeroRainRuns.keepDry[0]!.reason = 'changed';
		expect(rec.forcing!.zeroRainRuns!.keepDry[0]!.reason).toBe('real');
	});

	it('records the CHIRPS series’ product and version the fit ran on, when known (issue #40c)', () => {
		const form = defaultProjectSettings();
		const v2 = { product: 'CHIRPS', version: '2.0' };
		expect(fitRecordFor(report(), form, { validate: false, validationRecord: null, chirpsSource: v2 }).forcing!.chirpsSource).toEqual(v2);
		expect(fitRecordFor(report(), form, { validate: false, validationRecord: null, chirpsSource: null }).forcing!.chirpsSource).toBeNull();
		// Not known: nothing recorded, so nothing is ever compared.
		expect(fitRecordFor(report(), form, { validate: false, validationRecord: null }).forcing).not.toHaveProperty('chirpsSource');
	});

	it('records the daily A-pan series the fit ran on, when known (issue #45)', () => {
		const form = defaultProjectSettings();
		const pan = { startDate: '2020-10-01', length: 30, valuesSha256: 'c'.repeat(64) };
		expect(fitRecordFor(report(), form, { validate: false, validationRecord: null, apanDaily: pan }).forcing!.apanDaily).toEqual(pan);
		expect(fitRecordFor(report(), form, { validate: false, validationRecord: null, apanDaily: null }).forcing!.apanDaily).toBeNull();
		expect(fitRecordFor(report(), form, { validate: false, validationRecord: null }).forcing).not.toHaveProperty('apanDaily');
	});

	it('shows the fit time in UTC to the minute', () => {
		expect(fittedAtText('2026-09-24T10:05:33.120Z')).toBe('2026-09-24 10:05 UTC');
		expect(fittedAtText('2026-09-24T10:05:33Z')).toBe('2026-09-24 10:05 UTC');
	});
});

describe('fitInput leaves the forecast tail out (issue #51)', () => {
	const DAYS = 200; // catchment rain 2020-01-01 … 2020-07-18
	const server = (forecastStart: string) =>
		({
			settings: defaultProjectSettings(),
			model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
			series: {
				rain_catchment_mm: { startDate: '2020-01-01', values: Array.from({ length: DAYS }, (_, i) => (i % 5 === 0 ? 4 : 0)) },
				rain_forecast_mm: { startDate: forecastStart, values: new Array(14).fill(30) }
			}
		}) as unknown as ModelInput;

	it('fits the record only, as an ordinary run: the forecast series cut and the run ending the day before it', () => {
		const input = fitInput(server('2020-07-19'), defaultProjectSettings());
		expect(forecastSplit(input).forecastFrom).toBeNull();
		expect(input.series.rain_forecast_mm).toBeUndefined();
		expect(input.settings.simulationEnd).toBe('2020-07-18');
		// Positive control: the server's input has the tail the fit leaves out.
		expect(forecastSplit(server('2020-07-19')).forecastFrom).toBe('2020-07-19');
	});

	it('keeps dry days between the last rain and a later forecast in the record, and the form’s other settings', () => {
		const form = { ...defaultProjectSettings(), runoffModel: 'gr4j' as const };
		const input = fitInput(server('2020-07-25'), form);
		expect(input.settings.simulationEnd).toBe('2020-07-24');
		expect(input.settings.runoffModel).toBe('gr4j');
	});
});
