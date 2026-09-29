// Automated calibration end to end (issue #153): the rules, not a person,
// decide the exclusions, the fits and the one kept. The "observed" record is
// GR4J itself with known parameters, as in ./calibrate.test.ts.
import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearOf } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';
import type { Gr4jParams } from '../runoff/params';
import { ENGINE_VERSION } from '../version';
import { autoCalibrate } from './auto';
import { autoFitRecordOf } from './provenance';
import { defaultCalibrationRules, type CalibrationRules } from './rulesSettings';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'x',
	name: 'x',
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 0,
	areaHiKm2: 0,
	areaLoKm2: 0,
	flowShareManual: null,
	pctUpstreamToDam: 0,
	pctRunoffToDam: 0,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	lossReturnFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

const START = '1990-10-01';
/** A small search, set in the rules (rules.run), as every automated fit's is. */
const QUICK = { seed: 3, starts: 1, budget: 250 };

function rain(days: number, seed: number): number[] {
	const rng = new Rng(seed);
	const d0 = toEpochDay(START);
	return Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		const wet = [5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08;
		return rng.bool(wet) ? Math.round(rng.logFloat(0.5, rng.bool(0.05) ? 150 : 40) * 10) / 10 : 0;
	});
}

/** One farm draining to a gauge; the gauge record is GR4J with `truth`, and the fit starts from the defaults. */
function synthetic(truth: Gr4jParams, rules: Partial<CalibrationRules> = {}, years = 8): ModelInput {
	const days = Math.round(years * 365.25);
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { ...truth, warmupDays: 365 }, calibrationRules: { ...defaultCalibrationRules(), run: QUICK, ...rules } },
		model: {
			nodes: [node({ id: 'G', name: 'Gauge', kind: 'gauge' }), node({ id: 'F', name: 'Farm', downstreamNodeId: 'G', areaKm2: 40 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: rain(days, 7) } }
	};
	const flow = runModel(input).series.find((s) => s.key === 'natural_flow')!.values;
	input.series.flow_observed_m3s = { startDate: START, values: flow.map((q) => q! / 86_400) };
	input.settings.gr4j = { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 };
	return input;
}


const TRUTH: Gr4jParams = { x1: 420, x2: 0, x3: 70, x4: 2.1 };

describe('autoCalibrate', () => {
	it('fits every case the rules ask for and keeps the best held-out score among those that pass', () => {
		const r = autoCalibrate(synthetic(TRUTH));
		expect(r.cases.map((c) => c.label)).toEqual(['The project’s pan coefficient · wide bounds · kgePrime', 'The project’s pan coefficient · typical bounds · kgePrime']);
		expect(r.chosen).not.toBeNull();
		const kept = r.cases[r.chosen!]!;
		expect(kept.eligible).toBe(true);
		// The score is the wet years' KGE′ from the dry → wet test, never the in-sample fit.
		expect(kept.score).toBe(kept.report!.differential!.validation.scores.kgePrime);
		for (const c of r.cases) if (c.eligible) expect(c.score!).toBeLessThanOrEqual(kept.score!);
		// A synthetic record from GR4J itself: the kept fit reproduces it closely.
		expect(kept.score!).toBeGreaterThan(0.9);
		expect(r.rules.revision).toBe(1);
		expect(r.engineVersion).toBe(ENGINE_VERSION);
		expect(r.seed).toBe(3);
	});

	it('says the rules are drafts and that the WR2012 filter could not apply without a reference', () => {
		const r = autoCalibrate(synthetic(TRUTH));
		expect(r.notes).toEqual([expect.stringContaining('draft rules, not yet signed off'), expect.stringContaining('WR2012 MAR filter could not be applied')]);
		expect(r.cases[0]!.filters.map((f) => [f.id, f.status])).toEqual([
			['wr2012Mar', 'notApplicable'],
			['typicalParams', 'pass']
		]);
	});

	it('takes the seed, starts and model runs from the rules, so another seed is a rule change', () => {
		const r = autoCalibrate(synthetic(TRUTH, { run: { seed: 9, starts: 1, budget: 120 }, cases: { bounds: ['typical'], objectives: ['kgePrime'] } }));
		expect([r.seed, r.starts, r.budget]).toEqual([9, 1, 120]);
		expect(r.cases[0]!.report!.seed).toBe(9);
		expect(r.cases[0]!.report!.budget).toBe(120);
	});

	it('gives the same report for the same input, rules and seed', () => {
		const a = autoCalibrate(synthetic(TRUTH));
		const b = autoCalibrate(synthetic(TRUTH));
		expect(b.chosen).toBe(a.chosen);
		expect(b.cases.map((c) => c.report!.params)).toEqual(a.cases.map((c) => c.report!.params));
	});

	it('keeps nothing when every case fails a filter, and says why for each', () => {
		// X1 well outside Perrin et al.'s 100–1200 mm: a wide fit finds it, so the typical-range filter refuses it.
		const r = autoCalibrate(synthetic({ x1: 2500, x2: 0, x3: 70, x4: 2.1 }, { cases: { bounds: ['wide'], objectives: ['kgePrime'] } }));
		expect(r.cases[0]!.report!.params.x1).toBeGreaterThan(1200);
		expect(r.chosen).toBeNull();
		expect(r.cases[0]!.reasons).toEqual([expect.stringMatching(/^Parameters in the typical range: X1 \d+(\.\d+)? is outside 100–1200 mm/)]);
		expect(r.notes.at(-1)).toContain('No fit passed the rules');
	});

	it('refuses a case it can’t score by the rules’ test instead of falling back to the in-sample fit', () => {
		// Two years: too few to fit on dry years and test on wet ones.
		const r = autoCalibrate(synthetic(TRUTH, { cases: { bounds: ['typical'], objectives: ['kgePrime'] } }, 2));
		expect(r.cases[0]!.report!.differential).toBeNull();
		expect(r.cases[0]!.reasons).toEqual(['the record doesn’t allow the dry → wet test (wet years)']);
		expect(r.chosen).toBeNull();
		// Selecting by the split-sample test instead, the same record gives a fit.
		const split = autoCalibrate(synthetic(TRUTH, { cases: { bounds: ['typical'], objectives: ['kgePrime'] }, selection: { test: 'split', score: 'kgePrime' } }, 2));
		expect(split.chosen).toBe(0);
	});

	it('leaves out, by rule, a water year whose days are mostly flagged, and fits without it', () => {
		const input = synthetic(TRUTH, { cases: { bounds: ['typical'], objectives: ['kgePrime'] } });
		const obs = input.series.flow_observed_m3s!;
		const d0 = toEpochDay(START);
		// Water year 1993/94 is recorded far above the highest field gauging: every one of its days is extrapolated.
		const gaugedMax = Math.max(...obs.values.map((v) => v ?? 0)) + 1;
		obs.values = obs.values.map((v, t) => (waterYearOf(d0 + t) === 1993 ? gaugedMax * 2 : v));
		input.settings.qualityFlags = {
			ratings: { flow_observed_m3s: { gaugedMaxM3s: gaugedMax, gaugedMinM3s: null, source: 'synthetic' } },
			// Scored (censored) by the flag settings themselves, so only the rule leaves the year out.
			aboveRating: 'include',
			belowRating: 'exclude',
			suspect: 'exclude',
			infilled: 'exclude'
		};
		const r = autoCalibrate(input);
		expect(r.ruleExclusions).toEqual([{ waterYear: 1993, reason: expect.stringMatching(/^Rule \(calibration rules, exclusions\): 365 of 365 observed days flagged \(100 %\)/) }]);
		expect(r.years.filter((y) => y.excluded).map((y) => y.waterYear)).toEqual([1993]);
		const kept = r.cases[r.chosen!]!.report!;
		expect(kept.exclusions).toContainEqual({ start: '1993-10-01', end: '1994-09-30' });
		expect(kept.fit.waterYears).not.toContain(1993);
		expect(r.notes).toContainEqual('The exclusion rule left out 1 water year.');
	});

	it('refuses rules the project can’t run: another record to select by, or a pan preset under a monthly PE row', () => {
		expect(() => autoCalibrate(synthetic(TRUTH, { selection: { test: 'independent', score: 'kgePrime' } }))).toThrow(/has only one record/);
		const monthly = synthetic(TRUTH, { forcing: { pan: ['project', 'generic'] } });
		monthly.settings.pe = { kind: 'monthly', mm: apan, source: 'synthetic' } as never;
		expect(() => autoCalibrate(monthly)).toThrow(/monthly PE row/);
	});

	it('fits each listed pan coefficient as its own cases, under that coefficient', () => {
		const r = autoCalibrate(synthetic(TRUTH, { forcing: { pan: ['project', 'generic'] }, cases: { bounds: ['typical'], objectives: ['kgePrime'] } }));
		expect(r.cases.map((c) => [c.pan.id, c.pan.values?.[0] ?? null])).toEqual([
			['project', null],
			['generic', 0.7]
		]);
	});

	it('stops at a cancel and keeps nothing', () => {
		let calls = 0;
		const r = autoCalibrate(synthetic(TRUTH), { onProgress: () => ++calls > 10 });
		expect(r.cancelled).toBe(true);
		expect(r.chosen).toBeNull();
		expect(r.cases).toHaveLength(1);
		expect(r.notes).toContainEqual('Cancelled: no fit is kept.');
	});

	it('records the rules, the rule exclusions and every case with why it was or wasn’t kept', () => {
		const r = autoCalibrate(synthetic(TRUTH));
		const rec = autoFitRecordOf(r as typeof r & { chosen: number });
		expect(rec.rules).toEqual(r.rules);
		expect(rec.chosen).toBe(r.chosen);
		expect(rec.cases).toHaveLength(2);
		expect(rec.cases[r.chosen!]).toMatchObject({ eligible: true, reasons: [], bounds: r.cases[r.chosen!]!.bounds, params: r.cases[r.chosen!]!.report!.params });
	});
});
