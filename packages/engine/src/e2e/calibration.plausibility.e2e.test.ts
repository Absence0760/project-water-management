// End to end: the hydrologist plausibility checks (docs/model.md §2.10d) and
// the validation signatures, run on a record that IS the model's simulated
// outflow (every comparison must then agree exactly), and on records known
// to be too high or too low (the documented warnings must fire). Invented
// catchments and values only (the repo is public).
import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearOf } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';

const SEC = 86_400;
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
function rain(days: number, start: string, seed: number): number[] {
	const rng = new Rng(seed);
	const d0 = toEpochDay(start);
	return Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		const wet = [5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08;
		return rng.bool(wet) ? Math.round(rng.logFloat(0.5, rng.bool(0.05) ? 150 : 40) * 10) / 10 : 0;
	});
}
const START = '1995-10-01';
const TRUTH = { x1: 420, x2: 0, x3: 85, x4: 2.3 };
const series = (out: ReturnType<typeof runModel>, key: string, nodeId: string | null = null) => out.series.find((s) => s.key === key && s.nodeId === nodeId)!.values;

/** Invented "Bloukrans": a farm with a dam to the outlet gauge, 12 years; the record is the truth run's outflow × `scale`. */
function bloukrans(scale = 1, years = 12): ModelInput {
	const days = toEpochDay(`${1995 + years}-10-01`) - toEpochDay(START);
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { ...TRUTH, warmupDays: 365 } },
		model: {
			nodes: [
				node({ id: 'G', name: 'Bloukrans weir', kind: 'gauge' }),
				node({ id: 'F', name: 'Farm Blou', downstreamNodeId: 'G', areaKm2: 40, damCapacityM3: 200_000, damInitialPct: 0.5, pctRunoffToDam: 0.5, damAreaFullM2: 40_000 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: rain(days, START, 91) } }
	};
	input.series.flow_observed_m3s = { startDate: START, values: series(runModel(input), 'simulated_outflow').map((v) => (v / SEC) * scale) };
	return input;
}

describe('a record equal to the simulated outflow agrees with it in every check', () => {
	const out = runModel(bloukrans());
	const p = out.summary.plausibility!;

	it('check 1, naturalised: O + A − N = 0 every year, so no year fails', () => {
		expect(p.naturalised!.judgedYears).toBeGreaterThanOrEqual(10);
		expect(p.naturalised!.failedYears).toEqual([]);
		for (const y of p.naturalised!.years) expect(y.gapMm3).toBeCloseTo(0, 9);
	});

	it('check 4, dry-season Q90: the ratio is exactly 1', () => {
		const c = p.lowFlow!.comparison!;
		expect(c.ratio).toBeCloseTo(1, 12);
		expect(c.withinFactor).toBe(true);
	});

	it('recession diagnostics: the same segments give the same fit, so the rate ratio is 1 and b differs by 0', () => {
		const r = p.recession!;
		expect(r.segments.length).toBeGreaterThan(0);
		if (r.observed) {
			expect(r.rateRatio!).toBeCloseTo(1, 9);
			expect(r.bDiff!).toBeCloseTo(0, 9);
		}
		if (r.segments.length >= 8) expect(r.agrees).toBe(true);
	});

	it('check 3, flow double mass: no break the model does not show too (every hint is "rain")', () => {
		for (const b of p.flowDoubleMass?.breaks ?? []) expect(b.hint).toBe('rain');
	});

	it('validation signatures: BFI and low-flow FDC differences are 0', () => {
		const s = p.signatures!;
		if (s.baseflow?.hughes) expect(s.baseflow.hughes.difference).toBeCloseTo(0, 12);
		if (s.baseflow?.eckhardt) expect(s.baseflow.eckhardt.difference).toBeCloseTo(0, 12);
		if (s.lowFlowFdc?.slopeBiasPct !== null && s.lowFlowFdc?.slopeBiasPct !== undefined) expect(s.lowFlowFdc.slopeBiasPct).toBeCloseTo(0, 9);
		if (s.lowFlowFdc?.lowVolumeBiasPct !== null && s.lowFlowFdc?.lowVolumeBiasPct !== undefined) expect(s.lowFlowFdc.lowVolumeBiasPct).toBeCloseTo(0, 9);
	});

	it('no plausibility warning is raised', () => {
		expect(out.summary.warnings.filter((w) => /Natural flow below|Dry-season low flows|Recession diagnostics|double mass/i.test(w))).toEqual([]);
	});
});

describe('records known to disagree raise the documented findings', () => {
	it('a record reading 3× the river: every judged year fails check 1 (S < O − 10 %), and Q90 is a factor 3 off', () => {
		const out = runModel(bloukrans(3));
		const p = out.summary.plausibility!;
		const n = p.naturalised!;
		expect(n.failedYears).toEqual(n.years.filter((y) => y.judged).map((y) => y.waterYear));
		// Hand: the gap is O − S = 2·S per year.
		const sim = series(out, 'simulated_outflow');
		const d0 = toEpochDay(START);
		const s = new Map<number, number>();
		sim.forEach((v, t) => s.set(waterYearOf(d0 + t), (s.get(waterYearOf(d0 + t)) ?? 0) + v));
		for (const y of n.years) expect(y.gapMm3).toBeCloseTo((2 * s.get(y.waterYear)!) / 1e6, 6);
		expect(p.lowFlow!.comparison!.ratio).toBeCloseTo(Math.max(p.lowFlow!.comparison!.simulatedQ90M3s, 0.001) / Math.max(p.lowFlow!.comparison!.observedQ90M3s, 0.001), 12);
		expect(out.summary.warnings.some((w) => w.startsWith('Natural flow below'))).toBe(true);
	});

	it('a record reading half the river: check 1 passes (the model may take less than it does), the volumes say why', () => {
		const n = runModel(bloukrans(0.5)).summary.plausibility!.naturalised!;
		expect(n.failedYears).toEqual([]);
	});
});
