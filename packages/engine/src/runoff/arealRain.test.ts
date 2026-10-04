// The areal rainfall correction (settings.arealRain, engine ≥ 1.13.0,
// docs/model.md §2.4g): GR4J's rain × a factor per water-year month, with its
// provenance. Irrigation demand and the dams keep the recorded rain.
// Synthetic catchment: invented values only (public repo).
import { describe, expect, it } from 'vitest';
import { calibrate } from '../calibrate/calibrate';
import { fitRecordCaveats, fitRecordFromReport, fitRecordStatus } from '../calibrate/provenance';
import { diffInputs } from '../compare';
import {
	AREAL_RAIN_FITTED_WARNING,
	arealFactorFromMap,
	arealRainError,
	defaultProjectSettings,
	resolveArealRain,
	type ArealRain,
	type ModelInput
} from '../project';
import { runModel, runModelChecked } from '../run';
import { runoffForcing } from './simulate';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep
const flat = (f: number, method: ArealRain['method'] = 'map', source = 'invented MAP 600 mm ÷ forcing mean'): ArealRain => ({
	factors: new Array(12).fill(f) as never,
	method,
	source
});

/** Two farms to a gauge; F irrigates, D has a dam that takes no runoff. 3 years of rain, an observed record from GR4J-like flow. */
function catchment(settings: ModelInput['settings'] = {}, rainKind: 'rain_catchment_mm' | 'rain_chirps_mm' = 'rain_catchment_mm'): ModelInput {
	const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0.5, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const days = 1095;
	const rain = Array.from({ length: days }, (_, i) => (i % 17 === 0 ? 40 : i % 5 === 0 ? 3 : 0));
	const observed = Array.from({ length: days }, (_, i) => 0.05 + 0.3 * Math.exp(-(i % 17) / 4));
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, ...settings },
		model: {
			nodes: [
				{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0, pctRunoffToDam: 0 },
				{ ...node, id: 'F', name: 'Farm', kind: 'farm', downstreamNodeId: 'G', areaKm2: 12.5, divertCapacityM3Day: 5000 },
				{ ...node, id: 'D', name: 'Dam farm', kind: 'farm', downstreamNodeId: 'G', areaKm2: 4, pctRunoffToDam: 0, damCapacityM3: 300_000, damInitialPct: 0.8, damAreaFullM2: 60_000 }
			],
			crops: [{ id: 'c', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: [{ nodeId: 'F', cropId: 'c', areaM2: 200_000 }],
			transfers: []
		},
		series: { [rainKind]: { startDate: '2020-10-01', values: rain }, flow_observed_m3s: { startDate: '2020-10-01', values: observed } }
	};
}

type Out = ReturnType<typeof runModel>;
const series = (out: Out, key: string, nodeId: string | null = null) => out.series.find((s) => s.nodeId === nodeId && s.key === key)?.values;
const sum = (a: ArrayLike<number> | undefined) => Array.from(a ?? []).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);

describe('settings.arealRain: none', () => {
	it('is the default, and absent, null and all-1 factors give exactly the output of a project without it', () => {
		expect(defaultProjectSettings().arealRain).toBeNull();
		const before = runModel(catchment());
		const nulled = runModel(catchment({ arealRain: null }));
		expect(JSON.stringify(nulled)).toBe(JSON.stringify(before));
		// All 1s: the same numbers; only the run's record of the correction (and its column) is added.
		const ones = runModel(catchment({ arealRain: flat(1) }));
		for (const key of ['natural_flow', 'simulated_outflow', 'rain_used']) expect(series(ones, key)).toEqual(series(before, key));
		expect(ones.summary.farms).toEqual(before.summary.farms);
	});
});

describe('settings.arealRain: a factor', () => {
	it('multiplies the rain GR4J runs on by its water-year month’s factor, and adds the areal rain column', () => {
		const monthly = flat(1);
		(monthly.factors as unknown as number[])[0] = 2; // October only
		(monthly.factors as unknown as number[])[4] = 1.5; // February
		const out = runModel(catchment({ arealRain: monthly }));
		const used = series(out, 'rain_used')!;
		const final = series(out, 'rain_final')!;
		const areal = series(out, 'rain_areal')!;
		expect(used[0]).toBe(final[0]! * 2); // 1 October 2020
		const feb = 31 + 30 + 31 + 31; // 1 February 2021
		expect(used[feb + 1]).toBeCloseTo(final[feb + 1]! * 1.5, 12);
		expect(used[40]).toBe(final[40]); // November: × 1
		expect(areal.slice(0, 365)).toEqual(used.slice(0, 365));
		// The rain before the correction is recorded with it.
		expect(out.summary.runoff?.arealRain?.method).toBe('map');
		expect(out.summary.runoff?.arealRain?.rainBeforeMm).toBeCloseTo(sum(final), 9);
		expect(out.summary.runoff?.rainMm).toBeCloseTo(sum(used), 9);
	});

	it('corrects CHIRPS used raw too (no catchment rain): the rain used is CHIRPS × the factor', () => {
		const raw = runModel(catchment({}, 'rain_chirps_mm'));
		const out = runModel(catchment({ arealRain: flat(1.9) }, 'rain_chirps_mm'));
		const r = series(raw, 'rain_used')!;
		const u = series(out, 'rain_used')!;
		for (let t = 0; t < r.length; t++) expect(u[t]).toBeCloseTo(r[t]! * 1.9, 12);
		expect(sum(series(out, 'natural_flow'))).toBeGreaterThan(sum(series(raw, 'natural_flow')));
	});

	it('moves the runoff model only: crop demand, effective rain and the dam’s rain and evaporation stay identical', () => {
		const base = runModel(catchment());
		const out = runModel(catchment({ arealRain: flat(2) }));
		for (const [key, node] of [['crop_requirement', 'F'], ['gross_demand', 'F'], ['demand', 'F'], ['effective_rain', 'F'], ['rain_on_dam', 'D'], ['dam_evaporation', 'D'], ['dam_storage', 'D']] as const) {
			expect(series(out, key, node), `${key} ${node}`).toEqual(series(base, key, node));
		}
		expect(series(out, 'rain_final')).toEqual(series(base, 'rain_final'));
		expect(sum(series(out, 'natural_flow'))).toBeGreaterThan(sum(series(base, 'natural_flow')) * 1.5);
	});

	it('reads the areal rain wherever the catchment’s water balance does, and the run’s own checks still close', () => {
		const out = runModelChecked(catchment({ arealRain: flat(2) }));
		const areaM3PerMm = 16.5 * 1000;
		const natural = sum(series(out, 'natural_flow'));
		// Runoff coefficient: natural flow ÷ the areal rain volume, not ÷ the recorded rain.
		expect(out.summary.catchment.runoffCoefficient).toBeCloseTo(natural / (sum(series(out, 'rain_areal')) * areaM3PerMm), 9);
		// The water balance's whole-run row reads the areal rain too.
		const whole = out.summary.waterBalance!.total;
		expect(whole.rainMm).toBeCloseTo(sum(series(out, 'rain_areal')), 6);
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		// Days with no rain value from any source stay NaN in both columns, and the checks still pass.
		const gappy = catchment({ arealRain: flat(2) });
		const values = [...gappy.series!.rain_catchment_mm!.values];
		for (const t of [5, 6, 7, 400]) values[t] = null;
		gappy.series!.rain_catchment_mm = { ...gappy.series!.rain_catchment_mm!, values };
		const g = runModelChecked(gappy);
		expect(Number.isNaN(series(g, 'rain_areal')![6])).toBe(true);
		expect(Number.isNaN(series(g, 'rain_final')![6])).toBe(true);
		expect(g.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
	});

	it('is what automatic calibration fits under: the "before" score is the run’s own score', () => {
		const settings = { arealRain: flat(1.7), calibrationFlowKind: 'flow_observed_m3s' as const };
		const input = catchment(settings);
		const r = calibrate(input, { budget: 20, validate: false, seed: 3 });
		const run = runModel(input);
		expect(r.before.scores.nse).toBeCloseTo(run.summary.calibration!.nse!, 9);
		// Without the correction the same parameters score differently.
		const other = calibrate(catchment({ calibrationFlowKind: 'flow_observed_m3s' }), { budget: 20, validate: false, seed: 3 });
		expect(other.before.scores.nse).not.toBeCloseTo(r.before.scores.nse!, 3);
	});

	it('runoffForcing applies it and leaves PET alone', () => {
		const days = 40;
		const aligned = (k: string) => (k === 'rain_catchment_mm' ? new Array(days).fill(10) : new Array(days).fill(null));
		const base = runoffForcing({ apanMm: apan as never, panCoefficient: defaultProjectSettings().panCoefficient }, { startDate: '2020-10-01', days, aligned });
		const f = runoffForcing({ apanMm: apan as never, panCoefficient: defaultProjectSettings().panCoefficient, arealRain: flat(1.25) }, { startDate: '2020-10-01', days, aligned });
		expect(Array.from(f.rainMm)).toEqual(Array.from(base.rainMm, (v) => v * 1.25));
		expect(Array.from(f.petMm)).toEqual(Array.from(base.petMm));
	});
});

describe('resolveArealRain / arealRainError', () => {
	it('accepts 12 factors within 0.25–4, a method and a source', () => {
		expect(arealRainError(flat(1.9))).toBeNull();
		expect(arealRainError(null)).toBeNull();
		expect(resolveArealRain(flat(1.9), [])).toEqual(flat(1.9));
	});

	it('ignores, with a warning, what it can’t use: GR4J then runs on the recorded rain', () => {
		const bad: unknown[] = [
			{ ...flat(1), factors: [1, 1] },
			flat(4.5),
			flat(0.2),
			{ ...flat(1), method: 'guess' },
			{ ...flat(1), source: '  ' },
			{ ...flat(1), source: 'x'.repeat(601) },
			[1, 2],
			'2'
		];
		for (const raw of bad) {
			const warnings: string[] = [];
			expect(resolveArealRain(raw, warnings), JSON.stringify(raw).slice(0, 60)).toBeNull();
			expect(warnings[0]).toMatch(/^areal rainfall correction ignored/);
		}
		const out = runModel(catchment({ arealRain: flat(9) as never }));
		expect(out.summary.warnings.some((w) => w.startsWith('areal rainfall correction ignored'))).toBe(true);
		expect(series(out, 'rain_areal')).toBeUndefined();
	});

	it('warns on every run when the factor was fitted to the flow record', () => {
		expect(runModel(catchment({ arealRain: flat(1.5, 'fitted') })).summary.warnings).toContain(AREAL_RAIN_FITTED_WARNING);
		expect(runModel(catchment({ arealRain: flat(1.5, 'map') })).summary.warnings).not.toContain(AREAL_RAIN_FITTED_WARNING);
	});
});

describe('arealFactorFromMap', () => {
	it('is the MAP ÷ the mean annual rain over complete water years only', () => {
		// 2019-12-01 … 2022-11-30: complete water years 2020/21 and 2021/22 (365 days each).
		const start = '2019-12-01';
		const days = 1096;
		const rain = Array.from({ length: days }, (_, t) => (t < 305 ? 5 : t < 305 + 365 ? 1 : t < 305 + 730 ? 2 : 50));
		const r = arealFactorFromMap(1095, rain, start)!;
		expect(r.waterYears).toEqual([2020, 2021]);
		expect(r.meanAnnualMm).toBeCloseTo((365 + 730) / 2, 9);
		expect(r.factor).toBeCloseTo(1095 / 547.5, 12);
	});

	it('leaves a year with a missing day out, and gives null without a complete year or a MAP', () => {
		const rain: (number | null)[] = new Array(731).fill(1); // 2020-10-01 … 2022-09-30
		rain[400] = null;
		expect(arealFactorFromMap(730, rain, '2020-10-01')!.waterYears).toEqual([2020]);
		expect(arealFactorFromMap(730, new Array(100).fill(1), '2020-10-01')).toBeNull();
		expect(arealFactorFromMap(0, rain, '2020-10-01')).toBeNull();
	});
});

describe('fit provenance', () => {
	const report = () => calibrate(catchment({ arealRain: flat(1.7), calibrationFlowKind: 'flow_observed_m3s' }), { budget: 10, validate: false, seed: 1 });
	const record = (arealRain: ArealRain | null | undefined) => {
		const settings = { ...defaultProjectSettings(), ...(arealRain !== undefined ? { arealRain } : {}) };
		return fitRecordFromReport(report(), { settings, validate: false, validationRecord: null, engineVersion: 'test', fittedAt: '2026-01-01T00:00:00Z' });
	};

	it('records the correction the fit ran under, and a change of factor is a forcing change', () => {
		const r = record(flat(1.7));
		expect(r.forcing?.arealRain).toEqual(flat(1.7));
		const same = { ...defaultProjectSettings(), arealRain: flat(1.7) };
		expect(fitRecordStatus(same, r).forcingChanged).toBe(false);
		// Another source note or method only: the same rain, no refit asked for.
		expect(fitRecordStatus({ ...same, arealRain: flat(1.7, 'stations', 'reworded') }, r).forcingChanged).toBe(false);
		const changed = fitRecordStatus({ ...same, arealRain: flat(1.8) }, r);
		expect(changed.forcingChanged).toBe(true);
		expect(fitRecordCaveats(changed).join(' ')).toMatch(/areal rainfall correction/);
		expect(fitRecordStatus({ ...same, arealRain: null }, r).forcingChanged).toBe(true);
	});

	it('reads a record made before the correction existed as a fit without one', () => {
		const r = record(undefined);
		delete (r.forcing as { arealRain?: unknown }).arealRain;
		expect(fitRecordStatus(defaultProjectSettings(), r).forcingChanged).toBe(false);
		expect(fitRecordStatus({ ...defaultProjectSettings(), arealRain: flat(1) }, r).forcingChanged).toBe(false); // all 1s: the same rain
		expect(fitRecordStatus({ ...defaultProjectSettings(), arealRain: flat(2) }, r).forcingChanged).toBe(true);
	});
});

describe('run comparison', () => {
	it('lists a change of the correction among the settings, and a run saved without one ran with none', () => {
		const a = catchment();
		const b = catchment({ arealRain: flat(1.9) });
		const changes = diffInputs({ settings: a.settings, model: a.model } as never, { settings: b.settings, model: b.model } as never);
		const line = changes.find((c) => c.subject === 'Areal rainfall correction (GR4J)');
		expect(line?.text).toMatch(/none → × 1\.9 \(map: invented MAP/);
		expect(diffInputs({ settings: a.settings, model: a.model } as never, { settings: { ...a.settings, arealRain: null }, model: a.model } as never)).toEqual([]);
		const c = catchment({ arealRain: flat(2) });
		expect(diffInputs({ settings: b.settings, model: b.model } as never, { settings: c.settings, model: c.model } as never).find((x) => x.subject === 'Areal rainfall correction (GR4J)')?.text).toMatch(/factors/);
	});
});
