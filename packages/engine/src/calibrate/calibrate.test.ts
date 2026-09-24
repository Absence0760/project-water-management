import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';
import { gr4j, GR4J_PARAMS, type Gr4jParams } from '../runoff/gr4j';
import { runoffForcing, simulateRunoff } from '../runoff/simulate';
import { randomInput } from '../testing/fuzz';
import { checkAll } from '../testing/invariants';
import { calibrate, prepareCalibration, validationNotes, type DifferentialTest, type ValidationTest } from './calibrate';
import { fitScores } from './objective';

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
	returnFlowPct: 0,
	...over
});

/** Seasonal synthetic rain: wet winters, dry summers, the odd storm. */
function rain(days: number, start: string, seed: number): number[] {
	const rng = new Rng(seed);
	const d0 = toEpochDay(start);
	return Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		const wet = [5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08;
		return rng.bool(wet) ? Math.round(rng.logFloat(0.5, rng.bool(0.05) ? 150 : 40) * 10) / 10 : 0;
	});
}

/**
 * One farm (no dam, no crops) draining to a gauge, so simulated outflow =
 * natural flow; the "observed" record is GR4J itself with known parameters.
 */
function synthetic(truth: Gr4jParams, years = 8, start = '2010-10-01'): ModelInput {
	const days = Math.round(years * 365.25);
	const r = rain(days, start, 7);
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { ...truth, warmupDays: 365 } },
		model: {
			nodes: [node({ id: 'G', name: 'Gauge', kind: 'gauge' }), node({ id: 'F', name: 'Farm', downstreamNodeId: 'G', areaKm2: 40 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: start, values: r } }
	};
	const flow = runModel(input).series.find((s) => s.key === 'natural_flow')!.values;
	input.series.flow_observed_m3s = { startDate: start, values: flow.map((q) => q / 86_400) };
	// Calibration starts from the defaults, not from the truth.
	input.settings.gr4j = { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 };
	return input;
}

describe('prepareCalibration scores what runModel produces', () => {
	it('on random GR4J networks, gauge/logger records against simulated outflow, Pitman against natural flow', () => {
		let checked = 0;
		for (let seed = 1; seed <= 150 && checked < 30; seed++) {
			const input = randomInput(seed, { runoffModel: 'gr4j' });
			let pb;
			try {
				pb = prepareCalibration(input);
			} catch {
				continue; // no observed record, or too few observed days
			}
			const out = runModel(input);
			const key = pb.scoreNatural ? 'natural_flow' : 'simulated_outflow';
			const want = out.series.find((s) => s.nodeId === null && s.key === key)!.values;
			const got = pb.simulate(pb.startParams);
			for (const t of pb.scoredDays) expect(got[t], `seed ${seed} day ${t}`).toBe(want[t]);
			checked++;
		}
		expect(checked).toBeGreaterThanOrEqual(20);
	});
});

describe('prepareCalibration for the legacy model', () => {
	it('scores what a legacy runModel produces, bit for bit', () => {
		let checked = 0;
		for (let seed = 1; seed <= 150 && checked < 20; seed++) {
			const input = randomInput(seed);
			let pb;
			try {
				pb = prepareCalibration(input);
			} catch {
				continue;
			}
			expect(pb.model).toBe('legacy');
			const key = pb.scoreNatural ? 'natural_flow' : 'simulated_outflow';
			const want = runModel(input).series.find((s) => s.nodeId === null && s.key === key)!.values;
			const got = pb.simulate(pb.startParams);
			for (const t of pb.scoredDays) expect(got[t], `seed ${seed} day ${t}`).toBe(want[t]);
			checked++;
		}
		expect(checked).toBeGreaterThanOrEqual(10);
	});
});

describe('calibrate', () => {
	it('fits the legacy model too, so both models can be compared calibrated (issue #4 phase 6)', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 4);
		const report = calibrate(input, { model: 'legacy', budget: 300, validate: false });
		expect(report.model).toBe('legacy');
		expect(report.free).toEqual(['a', 'b', 'summerFactor', 'winterFactor']);
		expect(report.startParams).toEqual({ a: 0.09, b: 1.2, summerFactor: 0.1, winterFactor: 1, baseResetRatio: 1.5 });
		expect(report.fit.scores.kgePrime!).toBeGreaterThan(report.before.scores.kgePrime!);
		expect(() => calibrate(input, { model: 'legacy', free: ['x1'] })).toThrow(/not a calibratable legacy parameter: x1/);
	}, 60_000);

	it('recovers known GR4J parameters from noise-free flow (X1, X3 within 10 %, X4 within 0.2 days)', () => {
		const truth = { x1: 420, x2: 0, x3: 85, x4: 2.3 };
		const report = calibrate(synthetic(truth), { budget: 5000, seed: 1, validate: false });
		expect(Math.abs(report.params.x1! / truth.x1 - 1)).toBeLessThan(0.1);
		expect(Math.abs(report.params.x3! / truth.x3 - 1)).toBeLessThan(0.1);
		expect(Math.abs(report.params.x4! - truth.x4)).toBeLessThan(0.2);
		expect(report.params.x2).toBe(0);
		expect(report.fit.scores.kgePrime!).toBeGreaterThan(0.99);
		expect(report.before.scores.kgePrime!).toBeLessThan(report.fit.scores.kgePrime!);
		expect(report.evaluations).toBe(5000);
	}, 120_000);

	it('fitted parameters, applied to the project, pass every run invariant', () => {
		let checked = 0;
		for (let seed = 1; seed <= 200 && checked < 8; seed++) {
			const input = randomInput(seed, { runoffModel: 'gr4j' });
			let report;
			try {
				report = calibrate(input, { budget: 40, seed, validate: false });
			} catch {
				continue;
			}
			const fitted = structuredClone(input);
			fitted.settings.gr4j = { ...fitted.settings.gr4j!, ...report.params };
			expect(checkAll(fitted, seed), `seed ${seed}`).toBeNull();
			checked++;
		}
		expect(checked).toBe(8);
	}, 120_000);

	it('keeps every parameter inside its bounds, and is deterministic for a seed', () => {
		const input = synthetic({ x1: 2900, x2: 0, x3: 5, x4: 0.6 }, 4);
		const a = calibrate(input, { budget: 300, seed: 4 });
		for (const p of [a.params, a.splitSample!.params, ...(a.differential ? [a.differential.params] : [])]) {
			for (const s of GR4J_PARAMS) {
				expect(p[s.key]).toBeGreaterThanOrEqual(s.min);
				expect(p[s.key]).toBeLessThanOrEqual(s.max);
			}
		}
		expect(calibrate(input, { budget: 300, seed: 4 })).toEqual(a);
		expect(calibrate(input, { budget: 300, seed: 5 }).params).not.toEqual(a.params);
	}, 60_000);

	it('fits only the free parameters; X2 moves only when freed', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 3);
		const fixed = calibrate(input, { budget: 200, free: ['x1'], validate: false });
		expect(fixed.params).toMatchObject({ x2: 0, x3: 90, x4: 1.7 });
		expect(fixed.params.x1).not.toBe(350);
		const withX2 = calibrate(input, { budget: 200, free: ['x1', 'x2', 'x3', 'x4'], validate: false });
		expect(withX2.free).toEqual(['x1', 'x2', 'x3', 'x4']);
		const yearly = calibrate(input, { budget: 100, objective: 'kgeYearly', validate: false });
		expect(yearly.objective).toBe('kgeYearly');
		expect(yearly.fit.scores.kgeYearly!).toBeGreaterThanOrEqual(yearly.before.scores.kgeYearly!);
	}, 60_000);

	it('scores only observed days inside the calibration window and outside exclusions', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 4);
		const obs = input.series.flow_observed_m3s!;
		obs.values[40] = null;
		input.settings.calibrationStart = '2011-10-01';
		input.settings.calibrationEnd = '2013-09-30';
		const pb = prepareCalibration(input, [{ start: '2012-01-01', end: '2012-01-31' }]);
		const d0 = toEpochDay('2010-10-01');
		const dates = Array.from(pb.scoredDays, (t) => fromEpochDay(d0 + t));
		expect(dates[0]).toBe('2011-10-01');
		expect(dates.at(-1)).toBe('2013-09-30');
		expect(dates.some((d) => d.startsWith('2012-01'))).toBe(false);
		expect(pb.scoredDays.length).toBe(731 - 31);
		const report = calibrate(input, { budget: 50, validate: false, exclusions: [{ start: '2012-01-01', end: '2012-01-31' }] });
		expect(report.fit).toMatchObject({ start: '2011-10-01', end: '2013-09-30' });
		expect(report.fit.scores.days).toBe(700);
	});

	it('reports a split-sample test, and a dry → wet test when there are enough water years', () => {
		const report = calibrate(synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 8), { budget: 150, seed: 2 });
		const ss = report.splitSample!;
		expect(ss.calibration.end < ss.validation.start).toBe(true);
		expect(ss.calibration.scores.days + ss.validation.scores.days).toBe(report.fit.scores.days);
		const dsst = report.differential!;
		expect(dsst.dryYears).toHaveLength(4);
		expect(dsst.wetYears).toHaveLength(4);
		expect(dsst.dryYears.some((y) => dsst.wetYears.includes(y))).toBe(false);
		expect(dsst.wetDryRatio).toBeGreaterThan(1);
		expect(report.evaluations).toBe(3 * 150);
	}, 60_000);

	it('says plainly when the record can’t test wet years', () => {
		const report = calibrate(synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 2.5), { budget: 60 });
		expect(report.differential).toBeNull();
		expect(report.notes.join(' ')).toMatch(/too few to fit on dry years and test on wet ones.*weakly constrained/);
	});

	it('flags a record whose "wet" years are hardly wetter than its dry ones', () => {
		// Identical rain every year: the wet half can't be wetter than the dry half.
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 1);
		const oneYear = input.series.rain_catchment_mm!.values.slice(0, 365);
		const years = 6;
		input.series.rain_catchment_mm!.values = Array.from({ length: years * 365 }, (_, t) => oneYear[t % 365]!);
		const truth = { ...input.settings, gr4j: { x1: 420, x2: 0, x3: 85, x4: 2.3, warmupDays: 365 } };
		const flow = runModel({ ...input, settings: truth, series: { rain_catchment_mm: input.series.rain_catchment_mm } }).series.find((s) => s.key === 'natural_flow')!.values;
		input.series.flow_observed_m3s = { startDate: '2010-10-01', values: flow.map((q) => q / 86_400) };
		const report = calibrate(input, { budget: 60 });
		expect(report.differential!.wetDryRatio).toBeLessThan(1.5);
		expect(report.notes.join(' ')).toMatch(/no clearly wet years to test on/);
	});

	it('refuses a project with no observed record, and can be cancelled', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 2);
		const noObs = { ...input, series: { rain_catchment_mm: input.series.rain_catchment_mm } };
		expect(() => calibrate(noObs)).toThrow(/no observed flow series/);
		const seen: string[] = [];
		const report = calibrate(input, {
			budget: 500,
			onProgress: (p) => {
				seen.push(p.stage);
				return p.evaluations >= 20;
			}
		});
		expect(report.cancelled).toBe(true);
		expect(report.evaluations).toBe(20);
		expect(report.splitSample).toBeNull();
		expect(new Set(seen)).toEqual(new Set(['full']));
		expect(report.notes.join(' ')).toMatch(/cancelled/);
	});

	it('the fast path matches the traced simulation over the scored days', () => {
		const input = synthetic({ x1: 420, x2: 0, x3: 85, x4: 2.3 }, 2);
		const f = runoffForcing({ apanMm: apan as never, panCoefficient: new Array(12).fill(0.7) as never }, {
			startDate: '2010-10-01',
			days: 730,
			aligned: (k) => (k === 'rain_catchment_mm' ? input.series.rain_catchment_mm!.values.slice(0, 730) : new Array(730).fill(null))
		});
		const p = { x1: 300, x2: 0, x3: 70, x4: 2 };
		const full = simulateRunoff(gr4j, p, f, { warmupDays: 365 });
		const short = simulateRunoff(gr4j, p, f, { warmupDays: 365, trace: false, days: 400 });
		expect(Array.from(short.qMm)).toEqual(Array.from(full.qMm.slice(0, 400)));
	});
});

describe('validationNotes', () => {
	const period = (kge: number) => ({ start: '2014-10-01', end: '2015-09-30', scores: { ...fitScores([1, 2, 3], [1, 2, 3]), kgePrime: kge } });
	const test = (cal: number, val: number): ValidationTest => ({ params: {}, calibration: period(cal), validation: period(val) });

	it('calls out a validation score well below the calibration score, and a dry → wet test on few years', () => {
		const dsst: DifferentialTest = { ...test(0.8, 0.34), dryYears: [2014, 2016], wetYears: [2013, 2015], wetDryRatio: 2.2 };
		expect(validationNotes('kgePrime', test(0.83, 0.36), dsst)).toEqual([
			'On the split-sample test KGE′ falls from 0.83 (the half the model was fitted to) to 0.36 (the other half): the fit does not carry over well, so treat results outside the calibration period with caution.',
			'Fitted to the dry years, KGE′ falls from 0.80 to 0.34 on the wet years: wet-year behaviour is uncertain.',
			'The dry → wet test rests on 2 dry and 2 wet water years, too few for a firm conclusion.'
		]);
	});

	it('says nothing when the fit carries over', () => {
		const dsst: DifferentialTest = { ...test(0.8, 0.7), dryYears: [1, 2, 3], wetYears: [4, 5, 6], wetDryRatio: 2 };
		expect(validationNotes('kgePrime', test(0.8, 0.75), dsst)).toEqual([]);
		expect(validationNotes('kgePrime', null, null)).toEqual([]);
	});
});
