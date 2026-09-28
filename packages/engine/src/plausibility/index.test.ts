// The plausibility checks as a run computes them (run.ts runPlausibility):
// the inputs it builds from the network and the rain, end to end.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import type { ModelInput, NetworkNode, RunSeries } from '../project';
import { runModelWith } from '../run';

const flat = (v: number) => new Array(12).fill(v) as unknown as Monthly;
const days = 730; // water years 2001 and 2002
const startDate = '2001-10-01';

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 1,
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
	};
}

/** A (dam, irrigation at 50 % efficiency, half the losses return) → B → gauge G. */
function input(observed: (sim: number[]) => (number | null)[] | null, series: Partial<ModelInput['series']> = {}): { input: ModelInput; natural: number[] } {
	const natural = Array.from({ length: days }, (_, t) => 2000 + 1500 * Math.sin((2 * Math.PI * t) / 365));
	const nodes = [
		node('A', { downstreamNodeId: 'B', pctRunoffToDam: 1, damCapacityM3: 50_000, damInitialPct: 0.5, damAreaFullM2: 10_000, irrigationEfficiency: 0.5, lossReturnFraction: 0.5 }),
		node('B', { downstreamNodeId: 'G', sortOrder: 1 }),
		node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 2 })
	];
	const base: ModelInput = {
		settings: { ewrPragmaticM3PerDay: flat(1500), apanMm: flat(150) },
		model: { nodes, crops: [{ id: 'c', name: 'Crop', cropFactor: [...flat(1)] }], cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 2000 }], transfers: [] },
		series: { rain_catchment_mm: { startDate, values: new Array(days).fill(1) }, ...series }
	};
	const first = runModelWith(base, () => ({ naturalFlowM3Day: natural }));
	const sim = first.series.find((s) => s.nodeId === null && s.key === 'simulated_outflow')!.values;
	const obs = observed(sim);
	if (obs) base.series.flow_observed_m3s = { startDate, values: obs };
	return { input: base, natural };
}

const get = (series: RunSeries[], nodeId: string | null, key: string) => series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('plausibility checks in a run', () => {
	it('naturalised: A = N − S splits into dams (ΔQ + evaporation − rain on the dam) and use net of returns (G − T)', () => {
		const { input: x, natural } = input((sim) => sim.map((v) => v / 86_400));
		const out = runModelWith(x, () => ({ naturalFlowM3Day: natural }));
		const c = out.summary.plausibility!.naturalised!;
		expect(c.flowKind).toBe('flow_observed_m3s');
		expect(c.years.map((y) => y.waterYear)).toEqual([2001, 2002]);
		// Observed = simulated: no gap, both years pass.
		expect(c.failedYears).toEqual([]);
		for (const y of c.years) expect(y.gapMm3).toBeCloseTo(0, 9);
		const s = out.series;
		const q = get(s, 'A', 'dam_storage');
		const evap = get(s, 'A', 'dam_evaporation');
		const rainOnDam = get(s, 'A', 'rain_on_dam');
		const supplied = get(s, 'A', 'supplied');
		const ret = get(s, 'A', 'return_flow');
		const y0 = c.years[0]!;
		const dams = q[364]! - 25_000 + sum(evap.slice(0, 365)) - sum(rainOnDam.slice(0, 365));
		expect(y0.damsMm3 * 1e6).toBeCloseTo(dams, 3);
		expect(y0.useMm3 * 1e6).toBeCloseTo(sum(supplied.slice(0, 365)) - sum(ret.slice(0, 365)), 3);
		expect(y0.landCoverMm3).toBe(0);
		expect(y0.abstractionMm3).toBeCloseTo(y0.damsMm3 + y0.landCoverMm3 + y0.useMm3, 12);
		expect(y0.abstractionMm3 * 1e6).toBeCloseTo(sum(natural.slice(0, 365)) - sum(get(s, null, 'simulated_outflow').slice(0, 365)), 3);
	});

	it('warns when the record implies more natural flow than simulated', () => {
		const { input: x, natural } = input((sim) => sim.map((v) => (3 * v) / 86_400));
		const out = runModelWith(x, () => ({ naturalFlowM3Day: natural }));
		expect(out.summary.plausibility!.naturalised!.failedYears).toEqual([2001, 2002]);
		expect(out.summary.warnings.some((w) => w.startsWith('Natural flow below observed + abstraction in 2 of 2 water years'))).toBe(true);
		// The low-flow curves see the same record, 3× the model in every dry season.
		const lf = out.summary.plausibility!.lowFlow!;
		expect(lf.comparison!.ratio).toBeCloseTo(1 / 3, 9);
		expect(out.summary.warnings.some((w) => w.startsWith('Dry-season low flows:'))).toBe(true);
		// The dry season comes from the calibration record.
		expect(out.summary.plausibility!.drySeason!.source).toBe('flow_observed_m3s');
	});

	it('rain source: a year whose station rain is blank and CHIRPS fills it is a fallback year', () => {
		const rain = Array.from({ length: days }, (_, t) => (t < 365 ? 1 : null));
		const { input: x, natural } = input(() => null, {
			rain_catchment_mm: { startDate, values: rain },
			rain_chirps_mm: { startDate, values: new Array(days).fill(1) }
		});
		const out = runModelWith(x, () => ({ naturalFlowM3Day: natural }));
		const r = out.summary.plausibility!.rainSource!;
		expect(r.hasStation).toBe(true);
		expect(r.years.map((y) => [y.waterYear, y.fallback, y.stationDays])).toEqual([
			[2001, false, 365],
			[2002, true, 0]
		]);
		expect(r.good.ewrDaysNotMet + r.fallback.ewrDaysNotMet).toBe(out.summary.catchment.ewrDaysNotMet);
		// Without an observed record there is nothing to naturalise or double-mass; the season comes from natural flow.
		expect(out.summary.plausibility!.naturalised).toBeNull();
		expect(out.summary.plausibility!.flowDoubleMass).toBeNull();
		expect(out.summary.plausibility!.recession).toBeNull();
		expect(out.summary.plausibility!.drySeason!.source).toBe('natural_flow');
	});

	it('recession diagnostics (engine ≥ 1.18.0): the calibration record’s dry recessions against the simulated outflow on the same days', () => {
		const { input: x, natural } = input((sim) => sim.map((v) => v / 86_400));
		const out = runModelWith(x, () => ({ naturalFlowM3Day: natural }));
		const r = out.summary.plausibility!.recession!;
		expect(r.flowKind).toBe('flow_observed_m3s');
		// Rain is 1 mm every day (at the threshold, so dry): the sine's falling half-years are the recessions, one a year.
		expect(r.segments.length).toBeGreaterThan(0);
		expect(r.segments.length).toBeLessThan(8);
		for (const [a, b] of r.segments) expect(b - a).toBeGreaterThanOrEqual(5);
		// Observed = simulated: the same fit.
		expect(r.simulated!.a).toBeCloseTo(r.observed!.a, 9);
		expect(r.simulated!.b).toBeCloseTo(r.observed!.b, 9);
		expect(r.agrees).toBeNull();
		expect(out.summary.warnings.filter((w) => w.startsWith('Recession diagnostics:'))).toHaveLength(1);
	});
});
