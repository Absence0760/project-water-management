// End-to-end: firm yield and the storage–yield curve (docs/model.md §2.13)
// checked against whole runs of the model. A yield search probes the network
// with a draft; here the draft found is put back into an ordinary runModel as
// a demand object on the dam's unit (a constant m³/day, D = the draft), and
// the run must show what §2.13 promises: no failure day at the yield (or no
// more failed water years than 1 − p allows), and a failure at the draft the
// search reports as failing. The mean-supply bound B and the zero-capacity
// yield are worked by hand from the run's own series. Synthetic catchment.
import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearOf } from '../calendar';
import type { DemandObject, ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { firmYield, prepareYield, storageYieldCurve } from '../network/yield';
import { testCatchment } from '../outlook/testCatchment';

function series(out: ModelOutput, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}:${key}`);
	return s.values;
}

const object = (nodeId: string, monthly: number[]): DemandObject => ({
	id: `draft-${nodeId}`,
	nodeId,
	name: 'Draft',
	category: 'industrial',
	sizing: 'monthly',
	monthlyM3Day: monthly,
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'first',
	destination: 'external',
	enabled: true,
	note: ''
});

/** The catchment with Farm A's crops taken off and a demand object drawing `monthly` m³/day (Oct–Sep) instead. */
function withDraft(base: ModelInput, monthly: number[], nodeId = 'a'): ModelInput {
	return {
		...base,
		model: {
			...base.model,
			cropAreas: base.model.cropAreas.filter((c) => c.nodeId !== nodeId),
			demandObjects: [object(nodeId, monthly)]
		}
	};
}

/** Failure days and failed water years of the unit in a run (§2.13: deficit > 10⁻⁹ of the draft). */
function failures(out: ModelOutput, nodeId: string): { days: number; years: number; yearsInRecord: number } {
	const d = series(out, nodeId, 'demand');
	const def = series(out, nodeId, 'deficit');
	const d0 = toEpochDay(out.startDate);
	const failedYears = new Set<number>();
	let days = 0;
	for (let t = 0; t < out.days; t++) {
		if (d[t]! > 0 && def[t]! > 1e-9 * d[t]!) {
			days++;
			failedYears.add(waterYearOf(d0 + t));
		}
	}
	return { days, years: failedYears.size, yearsInRecord: waterYearOf(d0 + out.days - 1) - waterYearOf(d0) + 1 };
}

const flat = (v: number) => new Array(12).fill(v) as number[];

// 6 water years (two leap days), the farms' dams entered with their areas: evaporation and rain on the dam in play.
const BASE = testCatchment({ start: '2002-10-01', end: '2008-09-30', seed: 3 });
// The same, but a part water year at each end: 2002/03 from 1 Apr, 2008/09 to 31 Dec.
const PART = testCatchment({ start: '2003-04-01', end: '2008-12-31', seed: 3 });

describe('outputs e2e: firm yield against whole runs (§2.13)', () => {
	it('a constant draft at the firm yield never fails in runModel; the reported failing draft does', () => {
		const y = firmYield(BASE, 'a');
		expect(y.yieldM3Day).toBeGreaterThan(0);
		expect(y.failureDays).toBe(0);
		expect(y.failsAtM3Day).not.toBeNull();
		expect(y.failsAtM3Day!).toBeLessThanOrEqual(y.yieldM3Day * 1.001 + 1e-6);
		const atYield = runModel(withDraft(BASE, flat(y.yieldM3Day)));
		expect(failures(atYield, 'a').days).toBe(0);
		const atFail = runModel(withDraft(BASE, flat(y.failsAtM3Day!)));
		expect(failures(atFail, 'a').days).toBeGreaterThan(0);
	});

	it('the mean-supply bound B is (Σ upstream inflow + own runoff + rain on the full dam + initial storage) ÷ days, from a run with no draft', () => {
		const noDam = { ...BASE, model: { ...BASE.model, nodes: BASE.model.nodes.map((n) => (n.id === 'a' ? { ...n, damAreaFullM2: 0 } : n)) } };
		const y = firmYield(noDam, 'a');
		const out = runModel(withDraft(noDam, flat(0)));
		const a = noDam.model.nodes.find((n) => n.id === 'a')!;
		const inflow = series(out, 'a', 'inflow_upstream').reduce((s, v) => s + v, 0) + series(out, 'a', 'runoff').reduce((s, v) => s + v, 0);
		const B = (inflow + a.damCapacityM3 * a.damInitialPct) / out.days;
		expect(y.boundM3Day).toBeCloseTo(B, 6);
		expect(y.yieldM3Day).toBeLessThanOrEqual(B);
	});

	it('at assurance p the yield fails in at most ⌊(1 − p) × years⌋ water years, part years counted, and the failing draft in more', () => {
		for (const input of [BASE, PART]) {
			for (const p of [0.5, 0.8, 0.95]) {
				const y = firmYield(input, 'a', { assurance: p });
				const at = failures(runModel(withDraft(input, flat(y.yieldM3Day))), 'a');
				const allowed = Math.floor((1 - p) * at.yearsInRecord + 1e-9);
				expect(at.years, `p ${p} at yield`).toBeLessThanOrEqual(allowed);
				expect(y.failedYears).toBe(at.years);
				if (y.failsAtM3Day !== null) {
					const f = failures(runModel(withDraft(input, flat(y.failsAtM3Day))), 'a');
					expect(f.years, `p ${p} at the failing draft`).toBeGreaterThan(allowed);
				}
			}
		}
	});

	it('the yield at assurance p never falls as p falls (a looser criterion passes more)', () => {
		const ys = [1, 0.95, 0.9, 0.8, 0.5].map((p) => firmYield(BASE, 'a', { assurance: p }).yieldM3Day);
		for (let k = 1; k < ys.length; k++) expect(ys[k]!).toBeGreaterThanOrEqual(ys[k - 1]! * (1 - 0.002));
	});

	it('a monthly pattern is normalised to a mean of 1 over the record: the draft × factor ÷ mean factor never fails', () => {
		// Summer-heavy (Oct … Sep), zero in winter.
		const factors = [2, 3, 4, 4, 3, 2, 1, 0, 0, 0, 0, 1];
		const y = firmYield(BASE, 'a', { pattern: factors });
		const out0 = runModel(withDraft(BASE, flat(0)));
		const d0 = toEpochDay(out0.startDate);
		let total = 0;
		for (let t = 0; t < out0.days; t++) {
			const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
			total += factors[(m + 2) % 12]!;
		}
		const scale = out0.days / total;
		const at = runModel(withDraft(BASE, factors.map((f) => y.yieldM3Day * f * scale)));
		expect(failures(at, 'a').days).toBe(0);
		// Its mean daily draft over the record is the yield.
		const d = series(at, 'a', 'demand');
		expect(d.reduce((s, v) => s + v, 0) / at.days).toBeCloseTo(y.yieldM3Day, 6);
		const fail = runModel(withDraft(BASE, factors.map((f) => y.failsAtM3Day! * f * scale)));
		expect(failures(fail, 'a').days).toBeGreaterThan(0);
	});

	it('storage–yield: 11 capacities from 0 to 2 × the dam’s, the own-capacity point is the firm yield, capacity 0 is the smallest daily supply reaching the dam', () => {
		const lossless = {
			...BASE,
			model: { ...BASE.model, nodes: BASE.model.nodes.map((n) => (n.id === 'a' ? { ...n, damAreaFullM2: 0, damMinPct: 0, damInitialPct: 1 } : n)) }
		};
		const p = prepareYield(lossless);
		const curve = storageYieldCurve(p, 'a');
		const cap = 300_000;
		expect(curve.points.map((x) => x.capacityM3)).toEqual(Array.from({ length: 11 }, (_, k) => (2 * cap * k) / 10));
		expect(curve.points[5]!.yieldM3Day).toBe(firmYield(p, 'a').yieldM3Day);
		expect(curve.monotone).toBe(true);
		// At capacity 0, what the unit can take each day is the water reaching the dam site (K + M + O, §2.7).
		const zeroCap = {
			...lossless,
			model: { ...lossless.model, nodes: lossless.model.nodes.map((n) => (n.id === 'a' ? { ...n, damCapacityM3: 0 } : n)) }
		};
		const out = runModel(withDraft(zeroCap, flat(0)));
		const K = series(out, 'a', 'upstream_to_dam');
		const M = series(out, 'a', 'runoff_to_dam');
		const O = series(out, 'a', 'diverted_to_dam');
		let min = Infinity;
		for (let t = 0; t < out.days; t++) min = Math.min(min, K[t]! + M[t]! + O[t]!);
		const y0 = curve.points[0]!.yieldM3Day;
		expect(y0).toBeLessThanOrEqual(min * (1 + 1e-9) + 1e-9);
		expect(y0).toBeGreaterThanOrEqual(min * (1 - 0.001) - 1e-6);
	});

	it('a lossless dam that drains a record shorter than its storage: the firm yield is (C + Σ inflow) ÷ days (the bound itself)', () => {
		// Dry record: almost no inflow, a big full dam, no evaporating surface, no dead storage.
		const dry: ModelInput = {
			...BASE,
			settings: { ...BASE.settings, gr4j: { x1: 300, x2: 0, x3: 80, x4: 1.5, warmupDays: 0 } },
			model: { ...BASE.model, nodes: BASE.model.nodes.map((n) => (n.id === 'a' ? { ...n, damAreaFullM2: 0, damMinPct: 0, damInitialPct: 1, damCapacityM3: 20_000_000 } : n)) },
			series: { rain_catchment_mm: { startDate: '2002-10-01', values: new Array(730).fill(0) } }
		};
		const out = runModel(withDraft(dry, flat(0)));
		const q = series(out, 'a', 'upstream_to_dam').map((v, t) => v + series(out, 'a', 'runoff_to_dam')[t]!);
		const exact = (20_000_000 + q.reduce((s, v) => s + v, 0)) / out.days;
		// A draft this size is above every day's inflow, so the dam never spills and the last day binds.
		expect(Math.max(...q)).toBeLessThan(exact);
		const y = firmYield(dry, 'a');
		expect(y.yieldM3Day).toBeLessThanOrEqual(exact * (1 + 1e-9));
		expect(y.yieldM3Day).toBeGreaterThanOrEqual(exact * (1 - 0.001));
	});
});

describe('outputs e2e: a resized dam in the yield search (§2.13)', () => {
	it('the mean-supply bound at 0.5×, 1× and 2× capacity takes rain on the resized full area A_full × (C_new ÷ C)^b and the initial storage as the same fraction', () => {
		const a = BASE.model.nodes.find((n) => n.id === 'a')!;
		const out = runModel(withDraft(BASE, flat(0)));
		const inflow = series(out, 'a', 'inflow_upstream').reduce((s, v) => s + v, 0) + series(out, 'a', 'runoff').reduce((s, v) => s + v, 0);
		const rainMm = series(out, null, 'rain_final').reduce((s, v) => s + v, 0);
		const p = prepareYield(BASE);
		for (const ratio of [0.5, 1, 2]) {
			const cap = a.damCapacityM3 * ratio;
			const area = a.damAreaFullM2! * ratio ** a.damAreaExponent;
			const B = (inflow + (rainMm * area) / 1000 + a.damCapacityM3 * a.damInitialPct * ratio) / out.days;
			const y = firmYield(p, 'a', { capacityM3: cap });
			expect(y.boundM3Day, `×${ratio}`).toBeCloseTo(B, 6);
		}
		// The doc's worked example: doubling a 100 000 m³ dam of 3 m mean depth gives 54 150 m², not 66 667.
		expect((100_000 / 3) * 2 ** 0.7).toBeCloseTo(54_150, -1);
	});
});
