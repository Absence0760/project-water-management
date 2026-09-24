import { calibrate, defaultProjectSettings, type CalibrationReport, type ModelInput } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { applyReport, fitInput, fitParams, progressFraction, SCORE_ROWS, scoreColumns, totalRuns } from './fit';

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
const period = (start: string, end: string, kge: number) => ({ start, end, scores: scores(kge) });

function report(over: Partial<CalibrationReport> = {}): CalibrationReport {
	return {
		model: 'gr4j',
		objective: 'kgePrime',
		budget: 100,
		seed: 1,
		free: ['x1', 'x3', 'x4'],
		params: { x1: 800, x2: 0, x3: 40, x4: 1.2 },
		startParams: { x1: 350, x2: 0, x3: 90, x4: 1.7 },
		flowKind: 'flow_observed_m3s',
		simulatedKey: 'simulated_outflow',
		fit: period('2013-01-01', '2018-12-31', 0.8),
		before: period('2013-01-01', '2018-12-31', 0.2),
		splitSample: null,
		differential: null,
		notes: [],
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
});

describe('scoreColumns', () => {
	it('lists before and fitted, then each test’s fitted and validation part, validation marked', () => {
		const r = report({
			splitSample: { params: {}, calibration: period('2013-01-01', '2015-12-31', 0.8), validation: period('2016-01-01', '2018-12-31', 0.4) },
			differential: { params: {}, calibration: period('2014-10-01', '2017-09-30', 0.7), validation: period('2013-10-01', '2018-09-30', 0.3), dryYears: [2014, 2016], wetYears: [2013, 2017], wetDryRatio: 2 }
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
		expect(cols[5]!.period).toBe('2013/14, 2017/18');
		expect(scoreColumns(report()).map((c) => c.id)).toEqual(['before', 'fit']);
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
		const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, returnFlowPct: 0 };
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
	});
});
