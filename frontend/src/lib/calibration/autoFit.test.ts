import { defaultCalibrationRules, defaultProjectSettings, type AutoCalibrationReport, type AutoCase, type CalibrationReport, type ProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { autoCaseRows, autoFitRecordFor, autoProgressFraction, autoRunsTotal, autoStageText, keptPan, rulesUnsaved, selectionText } from './autoFit';

const period = { start: '2012-10-01', end: '2014-09-30', waterYears: [2012, 2013], scores: { days: 730, kgePrime: 0.8 } } as unknown as CalibrationReport['fit'];
const calReport = (x1: number): CalibrationReport =>
	({
		model: 'gr4j',
		objective: 'kgePrime',
		bounds: 'typical',
		budget: 250,
		seed: 3,
		starts: 1,
		startResults: [],
		free: ['x1', 'x3', 'x4'],
		params: { x1, x2: 0, x3: 70, x4: 2.1 },
		startParams: { x1: 350, x2: 0, x3: 90, x4: 1.7 },
		flowKind: 'flow_observed_m3s',
		simulatedKey: 'simulated_outflow',
		fit: period,
		before: period,
		splitSample: null,
		differential: null,
		independentRecord: null,
		notes: [],
		exclusions: [],
		evaluations: 750,
		cancelled: false
	}) as CalibrationReport;

const kase = (over: Partial<AutoCase>): AutoCase => ({
	pan: { id: 'project', label: 'The project’s pan coefficient', values: null },
	bounds: 'wide',
	objective: 'kgePrime',
	label: 'x',
	report: calReport(400),
	error: null,
	naturalMarMm3: 12.345,
	filters: [
		{ id: 'wr2012Mar', status: 'notApplicable', detail: '' },
		{ id: 'typicalParams', status: 'pass', detail: '' }
	],
	score: 0.61,
	eligible: true,
	reasons: [],
	...over
});

const report = (over: Partial<AutoCalibrationReport> = {}): AutoCalibrationReport => ({
	rules: defaultCalibrationRules(),
	engineVersion: '1.25.0',
	seed: 3,
	starts: 1,
	budget: 250,
	flowKind: 'flow_observed_m3s',
	validationRecord: null,
	years: [],
	ruleExclusions: [],
	cases: [
		kase({}),
		kase({ bounds: 'typical', score: 0.72, report: calReport(420) }),
		kase({ bounds: 'typical', objective: 'nseLog', score: 0.9, eligible: false, reasons: ['Parameters in the typical range: X1 2000 is outside 100–1200 mm'], filters: [{ id: 'typicalParams', status: 'fail', detail: '' }] })
	],
	chosen: 1,
	notes: [],
	cancelled: false,
	...over
});

describe('automated calibration in the page', () => {
	it('lists each fit with whether it was kept, its held-out score and why it wasn’t kept', () => {
		expect(autoCaseRows(report())).toEqual([
			{ label: 'The project’s pan coefficient, wide bounds, KGE′', verdict: 'Passed', score: '0.61', mar: '12.35', filters: 'MAR inside the WR2012 band: not applied; Parameters in the typical range: passed', reasons: [] },
			{ label: 'The project’s pan coefficient, typical bounds, KGE′', verdict: 'Kept', score: '0.72', mar: '12.35', filters: expect.any(String), reasons: [] },
			{
				label: expect.stringContaining('typical bounds, NSE on log Q'),
				verdict: 'Not kept',
				score: '0.90',
				mar: '12.35',
				filters: 'Parameters in the typical range: failed',
				reasons: ['Parameters in the typical range: X1 2000 is outside 100–1200 mm']
			}
		]);
	});

	it('counts every fit’s runs from the rules’ own search, both validation tests always included', () => {
		// 2 fits × 1 500 × (5 starts + 2 validation fits).
		expect(autoRunsTotal(defaultCalibrationRules(), false)).toBe(21_000);
		expect(autoRunsTotal(defaultCalibrationRules(), true)).toBe(24_000);
	});

	it('spreads progress over the fits, and names the fit being run', () => {
		const p = { caseIndex: 1, cases: 2, progress: { stage: 'full' as const, start: 1, starts: 1, evaluations: 0, budget: 100, best: 0 } };
		expect(autoProgressFraction(p, false, 1)).toBeCloseTo(0.5);
		expect(autoStageText(p)).toBe('Fit 2 of 2: Fitting the whole record (start 1 of 1)');
	});

	it('says what keeps a fit, and when the form’s rules aren’t the saved ones', () => {
		expect(selectionText(defaultCalibrationRules())).toBe('the best KGE′ on the dry → wet test (wet years)');
		const saved = defaultCalibrationRules();
		expect(rulesUnsaved(saved, defaultCalibrationRules())).toBe(false);
		expect(rulesUnsaved(saved, { ...saved, exclusions: { maxFlaggedShare: 0.3 } })).toBe(true);
	});

	it('records the kept case as the fit, with how the rules chose it', () => {
		const s = defaultProjectSettings() as ProjectSettings;
		const rec = autoFitRecordFor(report(), s, { now: new Date('2026-09-29T10:00:00Z') })!;
		expect(rec.params.x1).toBe(420);
		expect(rec.bounds).toBe('typical');
		expect(rec.fittedAt).toBe('2026-09-29T10:00:00.000Z');
		expect(rec.auto).toMatchObject({ chosen: 1, rules: { revision: 1 }, cases: [{ eligible: true }, { eligible: true }, { eligible: false }] });
		expect(rec.validate).toBe(true);
		expect(autoFitRecordFor(report({ chosen: null }), s, {})).toBeNull();
	});

	it('writes the pan coefficient a preset case was fitted under into the record’s forcing, and hands it to Apply', () => {
		const preset = { id: 'generic', label: 'Generic (flat 0.70)', values: new Array(12).fill(0.7) };
		const r = report({ cases: [kase({ pan: preset })], chosen: 0 });
		const s = { ...defaultProjectSettings(), panCoefficient: new Array(12).fill(0.8) } as unknown as ProjectSettings;
		expect(keptPan(r)).toEqual({ values: preset.values, source: expect.stringMatching(/^Generic \(flat 0\.70\) preset \(automated calibration\): /) });
		expect(autoFitRecordFor(r, s, {})!.forcing!.panCoefficient).toEqual(preset.values);
		// The project's own row: nothing extra to write.
		expect(keptPan(report())).toBeNull();
	});
});
