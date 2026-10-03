// The soft WR2012 MAR penalty in automatic calibration (issue #4 phase 8).
// Synthetic catchment: invented numbers only.
import { describe, expect, it } from 'vitest';
import { daysPerMonth, toEpochDay } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';
import { calibrate, prepareCalibration } from './calibrate';
import { defaultWr2012Settings, type Wr2012Settings } from '../reference/wr2012Settings';

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
	returnFlowFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

const start = '2010-10-01';
const days = Math.round(6 * 365.25);

/** GR4J with known parameters is the "observed" record; one farm (no crops) on 40 km², draining to a gauge. */
function synthetic(): { input: ModelInput; mar: number } {
	const rng = new Rng(3);
	const d0 = toEpochDay(start);
	const rain = Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		return rng.bool([5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08) ? Math.round(rng.logFloat(0.5, 40) * 10) / 10 : 0;
	});
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { x1: 250, x2: 0, x3: 60, x4: 1.5, warmupDays: 365 } },
		model: {
			nodes: [node({ id: 'G', name: 'Gauge', kind: 'gauge' }), node({ id: 'F', name: 'Farm', downstreamNodeId: 'G', areaKm2: 40 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: start, values: rain } }
	};
	const flow = runModel(input).series.find((s) => s.key === 'natural_flow')!.values;
	input.series.flow_observed_m3s = { startDate: start, values: flow.map((q) => q / 86_400) };
	input.settings.gr4j = { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 };
	const mar = (flow.reduce((s, v) => s + v, 0) / flow.length) * 365.25 / 1e6;
	return { input, mar };
}

/** A reference on the same 40 km² (scale factor 1) whose MAR is `factor` × the true one. */
function withReference(input: ModelInput, mar: number, factor: number, penalty: Wr2012Settings['calibrationPenalty']): ModelInput {
	const target = mar * factor;
	const wr2012: Wr2012Settings = {
		...defaultWr2012Settings(),
		reference: {
			quaternary: 'Z99A',
			areaKm2: 40,
			marMm3: target,
			monthlyMm3: [...daysPerMonth(28.25)].map((d) => (target * d) / 365.25),
			periodStart: 2010,
			periodEnd: 2015,
			mapMm: null,
			source: 'Synthetic'
		},
		calibrationPenalty: penalty
	};
	return { ...input, settings: { ...input.settings, wr2012 } as ModelInput['settings'] };
}

describe('WR2012 MAR penalty in calibration', () => {
	const { input, mar } = synthetic();
	const opts = { budget: 150, validate: false, seed: 1 } as const;

	it('is off by default: no penalty, and the fit is what it was without a reference', () => {
		const plain = calibrate(input, opts);
		const ref = calibrate(withReference(input, mar, 1.4, { enabled: false, weight: 1, marLowMm3: null, marHighMm3: null }), opts);
		expect(plain.marPenalty).toBeNull();
		expect(ref.marPenalty).toBeNull();
		expect(ref.params).toEqual(plain.params);
		expect(prepareCalibration(withReference(input, mar, 1.4, { enabled: false, weight: 1, marLowMm3: null, marHighMm3: null })).marPenalty).toBeNull();
	});

	it('when on, records its weight and shows the fit with and without it; the penalty pulls the MAR towards the reference', () => {
		const r = calibrate(withReference(input, mar, 1.4, { enabled: true, weight: 2, marLowMm3: null, marHighMm3: null }), opts);
		const p = r.marPenalty!;
		expect(p.weight).toBe(2);
		expect(p.basis).toBe('overlap');
		expect(p.targetMarMm3).toBeCloseTo(mar * 1.4, 10);
		expect(p.unpenalised).not.toBeNull();
		// Without the penalty the fit tracks the observed record (MAR ≈ truth, ratio ≈ 1/1.4);
		// with it the simulated MAR moves towards the reference.
		expect(Math.abs(Math.log(p.marRatio))).toBeLessThan(Math.abs(Math.log(p.unpenalised!.marRatio)));
		// …at a cost to the fit to observed flow.
		expect(r.fit.scores.kgePrime!).toBeLessThanOrEqual(p.unpenalised!.fit.scores.kgePrime! + 1e-12);
		// The unpenalised fit is a whole run of its own, reported as its own stage.
		expect(r.evaluations).toBe(2 * opts.budget);
		// Same seed, same unpenalised result as a plain calibration.
		expect(p.unpenalised!.params).toEqual(calibrate(input, opts).params);
	});

	it('reports progress for the unpenalised stage after the others', () => {
		const stages: string[] = [];
		calibrate(withReference(input, mar, 1.4, { enabled: true, weight: 1, marLowMm3: null, marHighMm3: null }), {
			...opts,
			budget: 20,
			onProgress: (pr) => void (stages.at(-1) !== pr.stage && stages.push(pr.stage))
		});
		expect(stages).toEqual(['full', 'unpenalised']);
	});

	it('is deterministic for a seed', () => {
		const i = withReference(input, mar, 0.7, { enabled: true, weight: 1, marLowMm3: null, marHighMm3: null });
		expect(JSON.stringify(calibrate(i, opts))).toBe(JSON.stringify(calibrate(i, opts)));
	});
});

describe('WR2012 MAR band penalty in calibration (issue #4 phase 6: two disagreeing published MAR estimates)', () => {
	const { input, mar } = synthetic();
	const opts = { budget: 150, validate: false, seed: 1 } as const;

	/** A reference whose calibration-penalty band is [mar × loFactor, mar × hiFactor] (marMm3 itself is unused by a band fit). */
	function withBand(loFactor: number, hiFactor: number, weight = 2): ModelInput {
		return withReference(input, mar, 1, { enabled: true, weight, marLowMm3: mar * loFactor, marHighMm3: mar * hiFactor });
	}

	it('records the band on the report (target = its geometric mean), and pulls a fit outside it back in', () => {
		// Well above the unconstrained fit's MAR (≈ the truth, since the "observed" record is noise-free).
		const r = calibrate(withBand(1.8, 2.2), opts);
		const p = r.marPenalty!;
		expect(p.marLowMm3).toBeCloseTo(mar * 1.8, 8);
		expect(p.marHighMm3).toBeCloseTo(mar * 2.2, 8);
		expect(p.targetMarMm3).toBeCloseTo(Math.sqrt(mar * 1.8 * (mar * 2.2)), 8);
		const simulated = p.marRatio * p.targetMarMm3;
		const simulatedUnpenalised = p.unpenalised!.marRatio * p.targetMarMm3;
		// Unconstrained, the fit tracks the observed record, well below the band; penalised (a soft pull, not
		// a hard constraint), it moves substantially closer, to within 5 % of entering it.
		expect(simulatedUnpenalised).toBeLessThan(p.marLowMm3!);
		expect(simulated).toBeGreaterThan(simulatedUnpenalised);
		expect(simulated).toBeGreaterThanOrEqual(p.marLowMm3! * 0.95);
		expect(simulated).toBeLessThanOrEqual(p.marHighMm3! * 1.05);
	});

	it('costs nothing when the free fit’s MAR already falls inside a wide band', () => {
		const r = calibrate(withBand(0.3, 3), opts);
		const p = r.marPenalty!;
		const simulated = p.marRatio * p.targetMarMm3;
		expect(simulated).toBeGreaterThanOrEqual(p.marLowMm3!);
		expect(simulated).toBeLessThanOrEqual(p.marHighMm3!);
	});

	it('a one-sided or inverted band falls back to a single target, same as prepareCalibration/wr2012Penalty', () => {
		const oneSided = withReference(input, mar, 1.4, { enabled: true, weight: 1, marLowMm3: 5, marHighMm3: null });
		const r = calibrate(oneSided, opts);
		expect(r.marPenalty!.marLowMm3).toBeNull();
		expect(r.marPenalty!.marHighMm3).toBeNull();
		expect(r.marPenalty!.targetMarMm3).toBeCloseTo(mar * 1.4, 10);
	});
});
