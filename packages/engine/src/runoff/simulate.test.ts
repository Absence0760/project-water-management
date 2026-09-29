import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, LEGACY_UPGRADED_WARNING, type ModelInput } from '../project';
import { runModel } from '../run';
import { ENGINE_VERSION } from '../version';
import { gr4j } from './gr4j';
import { GR4J_NO_PET, hasPotentialEvaporation } from './pet';
import { resolveParams, runoffForcing, simulateRunoff } from './simulate';
import { GR4J_PARAMS } from './params';
import { checkRunoffBalance } from '../verify/checks';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep

/** One farm draining to a gauge, 2 years of daily rain from 2020-10-01. */
function catchment(rain: (number | null)[], settings: ModelInput['settings'] = {}): ModelInput {
	const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 1, lossReturnFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, ...settings },
		model: {
			nodes: [
				{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
				{ ...node, id: 'F', name: 'Farm', kind: 'farm', downstreamNodeId: 'G', areaKm2: 12.5 }
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2020-10-01', values: rain } }
	};
}

const rain = Array.from({ length: 730 }, (_, i) => (i % 17 === 0 ? 40 : i % 5 === 0 ? 1 : 0));
const series = (out: ReturnType<typeof runModel>, key: string) => out.series.find((s) => s.nodeId === null && s.key === key)?.values;

describe('GR4J forcing', () => {
	it('uses the rain chain without a threshold, and PET = pan coefficient × A-pan spread over the month', () => {
		const days = 366; // 2020-10-01 … 2021-10-01
		const k = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65];
		const f = runoffForcing(
			{ apanMm: apan as never, panCoefficient: k as never },
			{
				startDate: '2020-10-01',
				days,
				aligned: (kind) =>
					kind === 'rain_catchment_mm' ? [0.5, null, -3, ...new Array(days - 3).fill(null)] : kind === 'rain_chirps_mm' ? [9, 2, 9, ...new Array(days - 3).fill(1.5)] : new Array(days).fill(null)
			}
		);
		// Catchment rain first, CHIRPS where it's missing, 0.5 mm is not thresholded away, negatives count as 0.
		expect(Array.from(f.rainMm.slice(0, 4))).toEqual([0.5, 2, 0, 1.5]);
		// October 2020: 0.6 × 150 mm over 31 days; February 2021 (28 days): 0.8 × 180… (water-year index 4 = Feb).
		expect(f.petMm[0]).toBeCloseTo((0.6 * 150) / 31, 12);
		const feb = 31 + 30 + 31 + 31; // days before 1 Feb 2021
		expect(f.petMm[feb]).toBeCloseTo((0.8 * 180) / 28, 12);
		// Each whole month's PET totals coefficient × A-pan exactly.
		let oct = 0;
		for (let t = 0; t < 31; t++) oct += f.petMm[t]!;
		expect(oct).toBeCloseTo(0.6 * 150, 10);
	});
});

describe('GR4J warm-up', () => {
	const f = { rainMm: Float64Array.from([10, 0, 0, 30, 0, 0, 0]), petMm: new Float64Array(7).fill(2) };
	const p = { x1: 200, x2: 0, x3: 60, x4: 1.5 };

	it('with no warm-up the run starts from half-full stores', () => {
		const tr = simulateRunoff(gr4j, p, f, { warmupDays: 0 });
		expect(tr.storageStartMm).toBe(0.5 * 200 + 0.5 * 60);
	});

	it('cycles the forcing from day 1 and outputs only the days after it', () => {
		const warm = simulateRunoff(gr4j, p, f, { warmupDays: 7 });
		// A warm-up of exactly one cycle = running the forcing twice and keeping the second pass.
		const twice = simulateRunoff(gr4j, p, { rainMm: Float64Array.from([...f.rainMm, ...f.rainMm]), petMm: Float64Array.from([...f.petMm, ...f.petMm]) }, { warmupDays: 0 });
		expect(Array.from(warm.qMm)).toEqual(Array.from(twice.qMm.slice(7)));
		expect(warm.qMm.length).toBe(7);
		// Longer than the forcing: it keeps cycling.
		const thrice = simulateRunoff(gr4j, p, f, { warmupDays: 14 });
		expect(thrice.qMm.length).toBe(7);
		expect(thrice.storageStartMm).not.toBe(warm.storageStartMm);
	});

	it('records each store at the start of the first output day, summing to the starting storage (engine 1.20.0)', () => {
		const half = simulateRunoff(gr4j, p, f, { warmupDays: 0 });
		expect(half.storesStartMm).toEqual([100, 30, 0]);
		const warm = simulateRunoff(gr4j, p, f, { warmupDays: 7 });
		expect(warm.storesStartMm.reduce((a, v) => a + v, 0)).toBeCloseTo(warm.storageStartMm, 12);
		// The same stores the first day steps from: a one-cycle warm-up is the doubled forcing's day 7 start, its day 6 end.
		const twice = simulateRunoff(gr4j, p, { rainMm: Float64Array.from([...f.rainMm, ...f.rainMm]), petMm: Float64Array.from([...f.petMm, ...f.petMm]) }, { warmupDays: 0 });
		expect(warm.storesStartMm).toEqual(twice.stores.map((s) => s[6]));
		// A warm start begins from the saved state, so its stores are that state's, not a warm-up's.
		const saved = simulateRunoff(gr4j, p, f, { warmupDays: 7, captureAt: 3 }).captured!;
		const resumed = simulateRunoff(gr4j, p, f, { warmupDays: 7, initial: saved });
		expect(resumed.storesStartMm).toEqual(warm.stores.map((s) => s[2]));
	});

	it('the fast path gives the same flow as the traced run', () => {
		const a = simulateRunoff(gr4j, p, f, { warmupDays: 3 });
		const b = simulateRunoff(gr4j, p, f, { warmupDays: 3, trace: false });
		expect(Array.from(b.qMm)).toEqual(Array.from(a.qMm));
		expect(b.aetMm.length).toBe(0);
	});
});

describe('GR4J parameters', () => {
	it('replaces a missing, non-numeric or out-of-bounds parameter with its default, and says so', () => {
		const w: string[] = [];
		expect(resolveParams(GR4J_PARAMS, { x1: 5, x3: 'big', x4: 2 }, 'GR4J', w)).toEqual({ x1: 350, x2: 0, x3: 90, x4: 2 });
		expect(w).toEqual([
			'GR4J Production store capacity X1 5 is outside 10–3000 mm; using 350',
			'GR4J Routing store capacity X3 "big" is outside 1–1000 mm; using 90'
		]);
	});
});

describe('runModel with GR4J', () => {
	it('converts mm to m³/day over the catchment and reports the store series and the balance', () => {
		const out = runModel(catchment(rain));
		expect(out.engineVersion).toBe(ENGINE_VERSION);
		const b = out.summary.runoff!;
		expect(b).toMatchObject({ model: 'gr4j', params: { x1: 350, x2: 0, x3: 90, x4: 1.7 }, warmupDays: 365, areaKm2: 12.5 });
		const nat = series(out, 'natural_flow')!;
		expect(nat.reduce((a, v) => a + v, 0) / (12.5 * 1000)).toBeCloseTo(b.flowMm, 9);
		for (const k of ['rain_used', 'pet', 'aet', 'production_store', 'routing_store', 'uh_store']) expect(series(out, k), k).toHaveLength(730);
		// Closed catchment: no exchange series.
		expect(series(out, 'exchange')).toBeUndefined();
		expect(b.exchangeMm).toBe(0);
		// No legacy intermediates (the b023 model was removed in engine 1.0.0).
		expect(series(out, 'base_flow')).toBeUndefined();
		// Conservation: a closed model can't make more flow than the rain plus what it started with.
		expect(b.flowMm).toBeLessThanOrEqual(b.rainMm + b.storageStartMm);
		// Each store after the warm-up (engine 1.20.0), by series key, summing to the starting storage.
		expect(Object.keys(b.storesStartMm!)).toEqual(['production_store', 'routing_store', 'uh_store']);
		expect(Object.values(b.storesStartMm!).reduce((a, v) => a + v, 0)).toBeCloseTo(b.storageStartMm, 9);
		// Day one closes store by store from them: the production store's change is its own.
		expect(b.storesStartMm!.production_store).toBeLessThanOrEqual(350);
		expect(checkRunoffBalance(catchment(rain), out)).toBeNull();
	});

	it('the runoff self-check catches starting stores that do not add up to the starting storage', () => {
		const input = catchment(rain);
		const out = runModel(input);
		const b = out.summary.runoff!;
		b.storesStartMm = { ...b.storesStartMm!, routing_store: b.storesStartMm!.routing_store! + 1 };
		expect(checkRunoffBalance(input, out)).toMatch(/stores at the start sum to/);
		b.storesStartMm = { production_store: b.storageStartMm, routing_store: 0 };
		expect(checkRunoffBalance(input, out)).toMatch(/missing or outside their bounds/);
		// A run from before engine 1.20.0 has none, and the check still closes on the total.
		delete b.storesStartMm;
		expect(checkRunoffBalance(input, out)).toBeNull();
	});

	it('reports groundwater exchange as a series when X2 ≠ 0', () => {
		const out = runModel(catchment(rain, { gr4j: { ...defaultProjectSettings().gr4j, x2: -1.5 } }));
		expect(series(out, 'exchange')!.some((v) => v < 0)).toBe(true);
		expect(out.summary.runoff!.exchangeMm).toBeLessThan(0);
	});

	it('warns and uses the default for an invalid parameter', () => {
		const out = runModel(catchment(rain, { gr4j: { ...defaultProjectSettings().gr4j, x4: 0 } }));
		expect(out.summary.warnings).toContain('GR4J Unit hydrograph time base X4 0 is outside 0.5–10 days; using 1.7');
		expect(out.summary.runoff!.params.x4).toBe(1.7);
	});

	it('warns when a month’s pan coefficient sits outside FAO-56’s typical Class A pan range (0.6–0.85), naming the months', () => {
		const flat = defaultProjectSettings().panCoefficient; // 0.7 every month: inside range, no warning
		expect(runModel(catchment(rain, { panCoefficient: flat })).summary.warnings.some((w) => w.includes('pan coefficient'))).toBe(false);
		const mixed = [0.5, ...flat.slice(1, 11), 0.9] as never; // Oct too low, Sep too high
		const out = runModel(catchment(rain, { panCoefficient: mixed }));
		expect(out.summary.warnings).toContain(
			"pan coefficient is outside FAO-56's typical Class A pan range (0.6–0.85) in Oct, Sep: confirm against local humidity and wind"
		);
		// Boundaries themselves are fine: 0.6 and 0.85 are inside the range.
		const boundary = [0.6, ...flat.slice(1, 11), 0.85] as never;
		expect(runModel(catchment(rain, { panCoefficient: boundary })).summary.warnings.some((w) => w.includes('pan coefficient'))).toBe(false);
	});

	it('explains a short run whose flow exceeds its rain', () => {
		const input = catchment(new Array(20).fill(0));
		input.series.rain_catchment_mm!.values[19] = 0.1; // some rain, so a coefficient exists
		input.settings.gr4j = { ...defaultProjectSettings().gr4j, warmupDays: 0 };
		const out = runModel(input);
		// Flow comes only from the half-full stores draining.
		expect(out.summary.catchment.runoffCoefficient!).toBeGreaterThan(1);
		expect(out.summary.warnings.find((w) => w.startsWith('natural flow is'))).toMatch(/GR4J stores held 220 mm after the warm-up/);
	});

	it('a project still set to the removed legacy model runs GR4J, with its balance, and says so (engine 1.0.0)', () => {
		const settings = { runoffModel: 'legacy', calibration: { a: 0.1, recessionFactors: [0.9], rainThresholdMm: 2, catchmentAreaKm2: null } } as never;
		const out = runModel(catchment(rain, settings));
		expect(out.summary.runoff).toMatchObject({ model: 'gr4j' });
		expect(out.summary.warnings).toContain(LEGACY_UPGRADED_WARNING);
		// Bit for bit the GR4J run of the same project (positive control: that one doesn't warn).
		const gr4jRun = runModel(catchment(rain));
		expect(gr4jRun.summary.warnings).not.toContain(LEGACY_UPGRADED_WARNING);
		expect(series(out, 'natural_flow')).toEqual(series(gr4jRun, 'natural_flow'));
	});

	it('refuses to run with no potential evaporation, which would turn nearly all rain into flow', () => {
		const zeros = new Array(12).fill(0) as never;
		expect(() => runModel(catchment(rain, { apanMm: zeros }))).toThrow(GR4J_NO_PET);
		// A-pan without a pan coefficient is no evaporation either.
		expect(() => runModel(catchment(rain, { panCoefficient: zeros }))).toThrow(GR4J_NO_PET);
		// One month with evaporation is enough to run (positive control).
		const one = new Array(12).fill(0);
		one[3] = 200;
		expect(runModel(catchment(rain, { apanMm: one as never })).summary.runoff!.petMm).toBeGreaterThan(0);
	});

	it('hasPotentialEvaporation needs A-pan × pan coefficient above 0 in some month', () => {
		const k = new Array(12).fill(0.7);
		expect(hasPotentialEvaporation({ apanMm: apan as never, panCoefficient: k as never })).toBe(true);
		expect(hasPotentialEvaporation({ apanMm: new Array(12).fill(0) as never, panCoefficient: k as never })).toBe(false);
		expect(hasPotentialEvaporation({ apanMm: apan as never, panCoefficient: new Array(12).fill(0) as never })).toBe(false);
	});
});
