// The regional prior in calibration (issue #622 step 4, docs/model.md §2.10m):
// with the prior off, every calibration is the same as engine 1.106.0 before
// the wiring (its fitted parameters to the bit, and every other part of its
// report by testing/golden.ts' reportGolden, both taken before it); the
// penalty pulls the fit toward the p50s; `bounds: 'prior'` keeps the search
// inside the p10–p90 box; the fit record carries the prior; and under
// calibration zones each step takes the prior built for its own zone.
// Synthetic catchments: invented numbers only.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';
import { gaugeSeriesKey } from '../project';
import { readFileSync, writeFileSync } from 'node:fs';
import { reportDiff, reportGolden, type ReportGolden } from '../testing/golden';
import { resolveEnsembleOptions } from '../uncertainty/ensemble';
import { calibrate } from './calibrate';
import { fitRecordFromReport } from './provenance';
import { priorBox, priorStartParams, type CalibrationPrior, type ParamPriors, type PriorTargetRef } from './prior';
import { priorTargetOf } from './priorTarget';
import { calibrateStepwise, zoneFitPlan } from './stepwise';
import { newCalibrationZone, type CalibrationZone } from './zones';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'x',
	name: 'x',
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 0,
	pctUpstreamToDam: 0,
	pctRunoffToDam: 0,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	returnFlowFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

const START = '2010-10-01';
const DAYS = Math.round(5 * 365.25);

function rain(seed: number): number[] {
	const rng = new Rng(seed);
	const d0 = toEpochDay(START);
	return Array.from({ length: DAYS }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		return rng.bool([5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08) ? Math.round(rng.logFloat(0.5, 40) * 10) / 10 : 0;
	});
}

/** GR4J at x1 250, x3 60, x4 1.5 is the "observed" record of one 40 km² farm draining to a gauge; the fit starts elsewhere. */
function lumped(): ModelInput {
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { x1: 250, x2: 0, x3: 60, x4: 1.5, warmupDays: 365 } },
		model: {
			nodes: [node({ id: 'G', name: 'Gauge', kind: 'gauge' }), node({ id: 'F', name: 'Farm', downstreamNodeId: 'G', areaKm2: 40 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: rain(3) } }
	};
	const flow = runModel(input).series.find((s) => s.key === 'natural_flow')!.values;
	input.series.flow_observed_m3s = { startDate: START, values: flow.map((q) => q / 86_400) };
	input.settings.gr4j = { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 };
	return input;
}

const zone = (nodeId: string, over: Partial<CalibrationZone> = {}): CalibrationZone => ({ ...newCalibrationZone(nodeId), enabled: true, ...over });

/** Farm A (40 km²) above the weir H, farm B (60 km²) to the outlet G, per unit rain; H's and G's records are the truth. */
function zoned(): ModelInput {
	const base = rain(11);
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { x1: 220, x2: 0, x3: 50, x4: 1.3, warmupDays: 365 }, unitRain: { mode: 'perUnit' } },
		model: {
			nodes: [
				node({ id: 'G', name: 'Outlet', kind: 'gauge' }),
				node({ id: 'H', name: 'Weir', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 1 }),
				node({ id: 'A', name: 'Farm A', downstreamNodeId: 'H', areaKm2: 40, sortOrder: 2 }),
				node({ id: 'B', name: 'Farm B', downstreamNodeId: 'G', areaKm2: 60, sortOrder: 3 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: base },
			'rain_catchment_mm@A': { startDate: START, values: base.map((v) => v * 1.3) },
			'rain_catchment_mm@B': { startDate: START, values: base.map((v) => v * 0.9) }
		}
	};
	const truth = runModel({ ...input, settings: { ...input.settings, calibrationZones: [zone('H', { gr4j: { x1: 800, x2: 0, x3: 200, x4: 2.8 } })] } });
	const at = (nodeId: string | null, key: string) => truth.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
	input.series[gaugeSeriesKey('flow_observed_m3s', 'H')] = { startDate: START, values: at('H', 'outflow').map((q) => q / 86_400) };
	input.series.flow_observed_m3s = { startDate: START, values: at(null, 'simulated_outflow').map((q) => q / 86_400) };
	input.settings.gr4j = { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 };
	input.settings.calibrationZones = [zone('H')] as never;
	return input;
}

/**
 * Engine 1.106.0 before the prior was wired, as each report's fitted parameters (to the bit) and its reportGolden
 * (testing/golden.ts: its structure and strings exact, each number at a relative 1e-9). Not a hash of every bit: libm
 * leaves last-bit differences between macOS and CI's Linux in a report's statistics (a hash taken on a Mac failed on
 * CI, run 40775756367), while the search takes the same path on both, so the parameters agree to the bit. Taken on
 * macOS arm64 and checked on Linux arm64 and x64 (Node 24.22.1). Rewrite with `GOLDEN_WRITE=1`, only for a change
 * that is meant to move a calibration with the prior off.
 */
const BEFORE_PRIOR_FILE = new URL('../../fixtures/prior-off-calibration.golden.json', import.meta.url);
type Pinned = Record<string, { params: unknown; golden: ReportGolden }>;
const BEFORE_PRIOR: Pinned = process.env.GOLDEN_WRITE ? {} : JSON.parse(readFileSync(BEFORE_PRIOR_FILE, 'utf8'));

function expectBeforePrior(name: string, params: unknown, report: unknown) {
	const got = { params, golden: reportGolden(report) };
	if (process.env.GOLDEN_WRITE) {
		BEFORE_PRIOR[name] = got;
		writeFileSync(BEFORE_PRIOR_FILE, `${JSON.stringify(BEFORE_PRIOR, null, '\t')}\n`);
		return;
	}
	expect(got.params, name).toEqual(BEFORE_PRIOR[name]!.params);
	expect(reportDiff(got.golden, BEFORE_PRIOR[name]!.golden), name).toEqual([]);
}

describe('with the prior off', () => {
	it('a calibration is as engine 1.106.0 made it before the prior was wired', () => {
		const r = calibrate(lumped(), { budget: 120, seed: 7, starts: 2 });
		expectBeforePrior('lumped', r.params, r);
		const t = calibrate(lumped(), { budget: 80, seed: 3, bounds: 'typical', validate: false });
		expectBeforePrior('typical', t.params, t);
	});

	it('a stepwise fit of calibration zones is as before too', () => {
		const r = calibrateStepwise(zoned(), { budget: 80, seed: 5, validate: false });
		expectBeforePrior('zoned', r.steps.map((st) => st.report.params), r);
	});

	it('tells a real change from platform noise', () => {
		const r = calibrate(lumped(), { budget: 80, seed: 3, bounds: 'typical', validate: false });
		const want = reportGolden(r);
		// Positive control: one statistic moved by 1e-6 (a real change) is a difference; by 1e-13 (libm's last bits) it
		// isn't; a changed string is one.
		const nudge = (by: number) => reportGolden({ ...r, fit: { ...r.fit, scores: { ...r.fit.scores, nse: r.fit.scores.nse! * (1 + by) } } });
		expect(reportDiff(nudge(1e-6), want)).toHaveLength(1);
		expect(reportDiff(nudge(1e-13), want)).toEqual([]);
		expect(reportDiff(reportGolden({ ...r, objective: 'nse' }), want)).toHaveLength(1);
	});
});

const RANGES: ParamPriors = {
	x1: { p10: 500, p50: 650, p90: 800 },
	x2: { p10: 0, p50: 0, p90: 0 },
	x3: { p10: 60, p50: 80, p90: 100 },
	x4: { p10: 1.2, p50: 1.5, p90: 1.9 }
};
const CATCHMENT: PriorTargetRef = { zoneNodeId: null, units: null };
const prior = (over: Partial<CalibrationPrior> = {}, target: PriorTargetRef = CATCHMENT, ranges: ParamPriors = RANGES): CalibrationPrior => ({
	ranges,
	weight: 0.1,
	provenance: {
		dataset: 'synthetic',
		datasetVersion: 'synthetic 1',
		synthetic: true,
		donorSetSha256: 'a'.repeat(64),
		donorSetHash: '0123456789abcdef',
		donorCount: 14,
		k: 7,
		similarityWeight: 0.5,
		donors: [
			{ id: 'SYN_01', weight: 0.6 },
			{ id: 'SYN_02', weight: 0.4 }
		],
		leaveOneOutSkill: 0.35,
		leaveOneOutN: 14,
		x1From: 'donors',
		referenceLoad: null,
		target
	},
	...over
});
const OPTS = { budget: 150, seed: 2, validate: false } as const;

describe('the prior penalty', () => {
	it('pulls the fit toward the prior’s medians, more as the weight grows, and is recorded', () => {
		const input = lumped();
		const off = calibrate(input, OPTS);
		const on = calibrate(input, { ...OPTS, prior: prior({ weight: 5 }) });
		// The truth is x1 250; the prior's median 650. A heavy penalty holds x1 near the median.
		expect(Math.abs(Math.log(on.params.x1! / 650))).toBeLessThan(Math.abs(Math.log(off.params.x1! / 650)));
		expect(on.prior).toMatchObject({ weight: 5, bounded: false, ranges: RANGES });
		expect(on.prior!.provenance.donorSetSha256).toBe('a'.repeat(64));
		expect(on.prior!.penaltyAtFit).toBeGreaterThanOrEqual(0);
		expect(on.prior!.penaltyAtStart).toBeGreaterThan(0);
		expect(on.notes.some((n) => /regional GR4J prior from 2 donor basins of 14 \(synthetic, invented donors\): a penalty of weight 5/.test(n))).toBe(true);
		expect(off.prior).toBeUndefined();
		expect('prior' in off).toBe(false);
	});

	it('scores only the free parameters', () => {
		const input = lumped();
		// x4 held at 1.7, far from a narrow x4 prior: it adds nothing, so the penalty at the start is x1's and x3's.
		const narrow = { ...RANGES, x4: { p10: 0.5, p50: 0.55, p90: 0.6 } };
		const r = calibrate(input, { ...OPTS, budget: 30, free: ['x1', 'x3'], prior: prior({}, CATCHMENT, narrow) });
		// Two-piece σ: x1 350 sits below its median (p50 − p10 side), x3 90 above its (p90 − p50 side).
		const z1 = (Math.log(350) - Math.log(650)) / ((Math.log(650) - Math.log(500)) / 1.2815515655446004);
		const z3 = (Math.log(90) - Math.log(80)) / ((Math.log(100) - Math.log(80)) / 1.2815515655446004);
		expect(r.prior!.penaltyAtStart).toBeCloseTo((z1 * z1 + z3 * z3) / 2, 10);
	});
});

describe('the prior bounds', () => {
	it('keep every start inside the p10–p90 box, with or without the penalty', () => {
		const input = lumped();
		for (const weight of [0, 0.1]) {
			const r = calibrate(input, { ...OPTS, starts: 2, bounds: 'prior', prior: prior({ weight }) });
			expect(r.bounds).toBe('prior');
			expect(r.prior!.bounded).toBe(true);
			const box = priorBox(RANGES);
			for (const s of r.startResults) {
				for (const k of ['x1', 'x3', 'x4'] as const) {
					expect(s.params[k]!).toBeGreaterThanOrEqual(box[k].min);
					expect(s.params[k]!).toBeLessThanOrEqual(box[k].max);
				}
			}
			expect(r.notes.some((n) => /the search kept to its p10–p90 box/.test(n))).toBe(true);
		}
	});

	it('says when the box pins a free parameter', () => {
		const pinned = { ...RANGES, x4: { p10: 1.5, p50: 1.5, p90: 1.5 } };
		const r = calibrate(lumped(), { ...OPTS, budget: 30, bounds: 'prior', prior: prior({}, CATCHMENT, pinned) });
		expect(r.params.x4).toBe(1.5);
		expect(r.notes.some((n) => /box holds x4 at one value/.test(n))).toBe(true);
	});

	it('the fit record carries the prior, and none when the fit used none', () => {
		const ctx = {
			settings: { calibrationStart: null, calibrationEnd: null, panCoefficient: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], apanMm: apan, chirpsBiasCorrection: 'none' },
			validate: false,
			validationRecord: null,
			engineVersion: '1.106.0',
			fittedAt: '2026-10-28T00:00:00.000Z'
		} as never;
		const on = fitRecordFromReport(calibrate(lumped(), { ...OPTS, budget: 30, bounds: 'prior', prior: prior() }), ctx);
		expect(on.bounds).toBe('prior');
		expect(on.prior!.provenance.donors.map((d) => d.id)).toEqual(['SYN_01', 'SYN_02']);
		const off = fitRecordFromReport(calibrate(lumped(), { ...OPTS, budget: 30 }), ctx);
		expect('prior' in off).toBe(false);
	});

	it('an uncertainty ensemble after a fit in the prior’s box samples the typical ranges, and says so', () => {
		const input = lumped();
		input.settings.fitRecord = { model: 'gr4j', bounds: 'prior', objective: 'kgePrime' } as never;
		const { options, notes } = resolveEnsembleOptions(input, { members: 40 });
		expect(options.bounds).toBe('typical');
		expect(notes.some((n) => /regional prior’s p10–p90 box/.test(n))).toBe(true);
	});
});

describe('a prior that can’t be used', () => {
	it('is refused with the reason', () => {
		const input = lumped();
		expect(() => calibrate(input, { ...OPTS, bounds: 'prior' })).toThrow(/prior bounds need a regional prior/);
		expect(() => calibrate(input, { ...OPTS, prior: prior({ weight: 0 }) })).toThrow(/no penalty weight/);
		expect(() => calibrate(input, { ...OPTS, prior: prior({ weight: 11 }) })).toThrow(/from 0 to 10/);
		expect(() => calibrate(input, { ...OPTS, prior: prior({}, CATCHMENT, { ...RANGES, x3: { p10: 90, p50: 80, p90: 100 } }) })).toThrow(/p10 ≤ p50 ≤ p90/);
		expect(() => calibrate(input, { ...OPTS, prior: prior({}, { zoneNodeId: 'H', units: ['A'] }) })).toThrow(/built for a calibration zone/);
	});
});

describe('the prior under calibration zones', () => {
	it('each zone’s target is its own land units and area; the catchment’s is every unit', () => {
		const z = zoned();
		expect(priorTargetOf(z, 'H')).toMatchObject({ zoneNodeId: 'H', units: ['A'], areaKm2: 40 });
		expect(priorTargetOf(z, null)).toMatchObject({ zoneNodeId: null, units: ['B'], areaKm2: 60 });
		expect(() => priorTargetOf(z, 'G')).toThrow(/no calibration zone/);
		const l = priorTargetOf(lumped(), null);
		// Five whole water years (2010/11 … 2014/15): the MAP is their mean total, on the catchment's rain.
		expect(l).toMatchObject({ zoneNodeId: null, units: null, areaKm2: 40, years: 5, rainFrom: 'catchment' });
		const rain = lumped().series.rain_catchment_mm!.values as number[];
		expect(l.mapMm!).toBeCloseTo(rain.reduce((a, b) => a + b, 0) / 5, 9);
		expect(l.aridity!).toBeGreaterThan(0);
		// Under Per unit flow generation each zone's climate is its own units' rain: A's is 1.3 × the catchment's, B's 0.9 ×.
		const h = priorTargetOf(z, 'H');
		const site = priorTargetOf(z, null);
		const base = (z.series.rain_catchment_mm!.values as number[]).reduce((a, b) => a + b, 0) / 5;
		expect(h.rainFrom).toBe('units');
		expect(h.mapMm! / base).toBeCloseTo(1.3, 9);
		expect(site.mapMm! / base).toBeCloseTo(0.9, 9);
		expect(h.aridity! / site.aridity!).toBeCloseTo(1.3 / 0.9, 9);
		expect(() => priorTargetOf(lumped(), 'H')).toThrow(/no calibration zone/);
	});

	it('takes the climate over whole water years before any forecast tail', () => {
		const input = lumped();
		const rain = input.series.rain_catchment_mm!.values as number[];
		// 200 days past the record's end (a part water year) of forecast rain at 20 mm a day: neither counts.
		input.series.rain_forecast_mm = { startDate: '2015-10-01', values: new Array(200).fill(20) };
		const t = priorTargetOf(input, null);
		expect(t.years).toBe(5);
		expect(t.mapMm!).toBeCloseTo(rain.reduce((a, b) => a + b, 0) / 5, 9);
		// A record of 1.3 water years has one whole year: the MAP is that year's total, not 1.3 years' mean × 365.25.
		const short = lumped();
		const cut = 365 + 120;
		short.series.rain_catchment_mm = { startDate: START, values: rain.slice(0, cut) };
		short.series.flow_observed_m3s = { startDate: START, values: (short.series.flow_observed_m3s!.values as number[]).slice(0, cut) };
		const st = priorTargetOf(short, null);
		expect(st.years).toBe(1);
		expect(st.mapMm!).toBeCloseTo(rain.slice(0, 365).reduce((a, b) => a + b, 0), 9);
	});

	it('the stepwise fit gives each step the prior built for its zone, and refuses another zone’s', () => {
		const z = zoned();
		const plan = zoneFitPlan(z)!;
		const forStep = (zoneNodeId: string | null) => {
			const t = priorTargetOf(z, zoneNodeId);
			return prior({ weight: 0.2 }, { zoneNodeId: t.zoneNodeId, units: t.units });
		};
		const r = calibrateStepwise(z, { budget: 60, seed: 5, validate: false, prior: (step) => forStep(step.zoneNodeId) });
		expect(r.steps.map((s) => s.zoneNodeId)).toEqual(plan.map((s) => s.zoneNodeId));
		expect(r.steps.map((s) => s.report.prior!.provenance.target)).toEqual([
			{ zoneNodeId: 'H', units: ['A'] },
			{ zoneNodeId: null, units: ['B'] }
		]);
		// The prior bounds need a prior for every step: refused before the first fit runs.
		let fits = 0;
		expect(() =>
			calibrateStepwise(z, {
				budget: 20,
				validate: false,
				bounds: 'prior',
				prior: (step) => (step.zoneNodeId === 'H' ? forStep('H') : undefined),
				onProgress: () => void fits++
			})
		).toThrow(/prior for every calibration zone/);
		expect(fits).toBe(0);
		// The upstream zone's prior on the site's step, or the catchment's on a zone's, is refused.
		expect(() => calibrate(z, { ...OPTS, budget: 20, prior: forStep('H') })).toThrow(/another target/);
		expect(() => calibrate(z, { ...OPTS, budget: 20, zone: 'H', prior: prior() })).toThrow(/another target/);
	});
});

describe('starting from the prior', () => {
	it('takes the medians, inside GR4J’s bounds', () => {
		expect(priorStartParams(RANGES)).toEqual({ x1: 650, x2: 0, x3: 80, x4: 1.5 });
		expect(priorStartParams({ ...RANGES, x4: { p10: 0.1, p50: 0.2, p90: 0.3 } }).x4).toBe(0.5);
	});
});
