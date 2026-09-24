import { calibrate, defaultProjectSettings, ENGINE_VERSION, fitRecordStatus, type CalibrationReport, type ModelInput } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { applyReport, fitInput, fitParams, fitRecordFor, fittedAtText, marPenaltyOn, progressFraction, SCORE_ROWS, scoreColumns, SEED_MAX, seedError, STAGE_LABEL, stageText, totalRuns, validationRecordOptions, waterYearsText } from './fit';

const scores = (kge: number) => ({
	days: 100,
	kgePrime: kge,
	kgeYearly: null,
	kgeNp: 0.5,
	nse: 0.4,
	nseSqrt: 0.5,
	nseLog: 0.3,
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
		fit: period('2013-01-01', '2018-12-31', 0.8),
		before: period('2013-01-01', '2018-12-31', 0.2),
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
		expect(fitParams('gr4j').map((p) => [p.key, p.checked])).toEqual([
			['x1', true],
			['x3', true],
			['x4', true]
		]);
		expect(fitParams('gr4j', true).find((p) => p.key === 'x2')).toMatchObject({ checked: false });
		expect(fitParams('legacy').filter((p) => p.checked).map((p) => p.key)).toEqual(['a', 'b', 'summerFactor', 'winterFactor']);
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
			splitSample: { params: {}, calibration: period('2013-01-01', '2015-12-31', 0.8), validation: period('2016-01-01', '2018-12-31', 0.4) },
			differential: {
				params: {},
				calibration: period('2014-10-01', '2017-09-30', 0.7, [2014, 2016]),
				validation: period('2013-10-01', '2018-09-30', 0.3, [2013, 2017]),
				dryYears: [2014, 2016],
				wetYears: [2013, 2017],
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
		expect(cols[3]!.period).toBe('2016-01-01 – 2018-12-31');
		expect(cols[5]!.period).toBe('WY 2013/14, 2017/18');
		expect(scoreColumns(report()).map((c) => c.id)).toEqual(['before', 'fit']);
	});

	it('shows the dry → wet test as the water years scored, never an overlapping date envelope', () => {
		// Interleaved years: the dry set's first–last dates (2014-10-01 … 2017-09-30)
		// sit inside the wet set's (2013-10-01 … 2018-09-30), although no year is in both.
		const r = report({
			differential: {
				params: {},
				calibration: period('2014-10-01', '2017-09-30', 0.7, [2014, 2016]),
				validation: period('2013-10-01', '2018-09-30', 0.3, [2013, 2015, 2017]),
				dryYears: [2014, 2016],
				wetYears: [2013, 2015, 2017],
				wetDryRatio: 2
			}
		});
		const [dry, wet] = scoreColumns(r).filter((c) => c.id.startsWith('dsst'));
		expect(dry!.period).toBe('WY 2014/15, 2016/17');
		expect(wet!.period).toBe('WY 2013/14, 2015/16, 2017/18');
		for (const c of [dry!, wet!]) expect(c.period).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(waterYearsText([1999])).toBe('WY 1999/00');
		expect(waterYearsText([])).toBe('–');
	});

	it('adds the independent-record validation column when the report has one', () => {
		const r = report({
			independentRecord: {
				flowKind: 'flow_logger_m3s',
				simulatedKey: 'simulated_outflow',
				params: {},
				calibration: period('2013-01-01', '2018-12-31', 0.8),
				validation: period('2015-10-01', '2018-09-30', 0.5),
				overlapDays: 0
			}
		});
		const last = scoreColumns(r).at(-1)!;
		expect(last).toMatchObject({ id: 'record-val', label: 'Independent record: Logger flow', period: '2015-10-01 – 2018-09-30', validation: true });
		expect(last.scores.kgePrime).toBe(0.5);
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
	it('writes only the fitted parameters, into gr4j or calibration, and leaves the rest of the form alone', () => {
		const s = defaultProjectSettings();
		const g = applyReport(s, report());
		expect(g.gr4j).toEqual({ x1: 800, x2: 0, x3: 40, x4: 1.2, warmupDays: 365 });
		expect(g.calibration).toBe(s.calibration);
		const legacy = applyReport(s, report({ model: 'legacy', free: ['a', 'b'], params: { a: 0.2, b: 1.4, summerFactor: 0.9 } }));
		expect(legacy.calibration).toMatchObject({ a: 0.2, b: 1.4, summerFactor: 0.1 });
		expect(legacy.gr4j).toBe(s.gr4j);
	});

	it('round-trips an engine report: applied settings reproduce the fitted score', () => {
		const days = 3 * 365;
		const rain = Array.from({ length: days }, (_, i) => (i % 11 === 0 ? 30 : i % 4 === 0 ? 2 : 0));
		const flow = Array.from({ length: days }, (_, i) => 0.05 + 0.4 * Math.exp(-(i % 11) / 2));
		const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 1, lossReturnFraction: 0 };
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
			series: { rain_catchment_mm: { startDate: '2015-10-01', values: rain }, flow_observed_m3s: { startDate: '2015-10-01', values: flow } }
		};
		const r = calibrate(input, { budget: 80, validate: false });
		const applied: ModelInput = { ...input, settings: applyReport(input.settings as ReturnType<typeof defaultProjectSettings>, r) as unknown as ModelInput['settings'] };
		expect(calibrate(applied, { budget: 1, validate: false }).before.scores.kgePrime).toBeCloseTo(r.fit.scores.kgePrime!, 12);
		// The record Apply stores describes the applied settings exactly: nothing edited, nothing changed.
		const settings = applied.settings as ReturnType<typeof defaultProjectSettings>;
		const record = fitRecordFor(r, settings, { validate: false, validationRecord: null });
		expect(fitRecordStatus(settings, record)).toEqual({ editedParams: [], otherModel: false, windowChanged: false, exclusionsChanged: false, flowKindChanged: false });
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
		const form = { ...defaultProjectSettings(), calibrationStart: '2014-10-01', calibrationExclusions: [{ waterYear: 2016, reason: 'suspect rain' }] };
		const r = report({ seed: 99, notes: ['A note.'], splitSample: { params: {}, calibration: period('2013-01-01', '2015-12-31', 0.8), validation: period('2016-01-01', '2018-12-31', 0.4) } });
		const rec = fitRecordFor(r, form, { validate: true, validationRecord: 'flow_logger_m3s', now: new Date('2026-09-24T10:05:33.120Z') });
		expect(rec).toMatchObject({
			fittedAt: '2026-09-24T10:05:33.120Z',
			engineVersion: ENGINE_VERSION,
			seed: 99,
			starts: 1,
			startResults: [{ seed: 1, params: { x1: 800, x2: 0, x3: 40, x4: 1.2 }, score: 0.8, best: true }],
			budget: 100,
			objective: 'kgePrime',
			calibrationStart: '2014-10-01',
			calibrationEnd: null,
			exclusions: [{ waterYear: 2016, reason: 'suspect rain' }],
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

	it('shows the fit time in UTC to the minute', () => {
		expect(fittedAtText('2026-09-24T10:05:33.120Z')).toBe('2026-09-24 10:05 UTC');
		expect(fittedAtText('2026-09-24T10:05:33Z')).toBe('2026-09-24 10:05 UTC');
	});
});
