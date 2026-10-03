// End-to-end: the farm dam's daily balance (docs/model.md §2.7, §2.7a) run
// through the whole model on small synthetic catchments, each day checked
// against values worked by hand from the formulas in model.md, not from the
// engine's code. The natural flow is fixed (runModelWith) so the inflows are
// known exactly; everything after the runoff model is the real run.
// Invented names and values only (the repo is public).
import { describe, expect, it } from 'vitest';
import type { DamCurvePoint, ModelInput, ModelOutput, NetworkNode } from '../project';
import { runModel, runModelWith, withVerification } from '../run';

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: kind === 'farm' ? 1 : 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 1,
		pctRunoffToDam: 1,
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

const flat = (v: number) => new Array(12).fill(v) as number[];
// Oct–Sep A-pan (mm/month); January (index 3) is 285 mm over 31 days.
const APAN = [180, 230, 270, 285, 245, 210, 140, 90, 60, 65, 90, 130];
const JAN_APAN_DAY = 285 / 31;
/** Crop area (m², crop factor 1) whose January gross demand is `need` m³/day. */
const janArea = (need: number) => (need * 31_000) / 285;

interface Spec {
	nodes: NetworkNode[];
	days: number;
	start?: string;
	settings?: ModelInput['settings'];
	need?: Record<string, number>;
	rain?: number[];
	boreholes?: ModelInput['model']['boreholes'];
}

function input(s: Spec): ModelInput {
	return {
		settings: { apanMm: APAN as never, effectiveRainFraction: 0, lakeEvapFactor: 0, ewrPragmaticM3PerDay: flat(0) as never, ...(s.settings ?? {}) },
		model: {
			nodes: s.nodes,
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: Object.entries(s.need ?? {}).map(([nodeId, need]) => ({ nodeId, cropId: 'c', areaM2: janArea(need) })),
			transfers: [],
			...(s.boreholes ? { boreholes: s.boreholes } : {})
		},
		series: { rain_catchment_mm: { startDate: s.start ?? '2021-01-01', values: s.rain ?? new Array(s.days).fill(0) } }
	};
}

const run = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));
const col = (o: ModelOutput, id: string | null, key: string): number[] => {
	const s = o.series.find((x) => x.nodeId === id && x.key === key);
	if (!s) throw new Error(`no series ${id}/${key}; have ${o.series.filter((x) => x.nodeId === id).map((x) => x.key).join(', ')}`);
	return s.values;
};
const opt = (o: ModelOutput, id: string | null, key: string): number[] | undefined => o.series.find((x) => x.nodeId === id && x.key === key)?.values;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);
const checksPass = (o: ModelOutput) => expect(o.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);

describe('a dam fills and spills exactly at capacity', () => {
	it('stores inflow until full, then spills only the excess, and the spill reaches the node below the same day', () => {
		const days = 6;
		const i = input({ nodes: [node('G', 'gauge', null), node('B', 'farm', 'G', { areaKm2: 0 }), node('A', 'farm', 'B', { damCapacityM3: 1000 })], days });
		// All of the natural flow is A's (B has no area); B passes everything (no dam, no demand).
		const o = run(i, new Array(days).fill(300));
		expect(col(o, 'A', 'runoff')).toEqual(new Array(days).fill(300));
		expect(col(o, 'A', 'dam_storage')).toEqual([300, 600, 900, 1000, 1000, 1000]);
		expect(col(o, 'A', 'spill')).toEqual([0, 0, 0, 200, 300, 300]);
		expect(col(o, 'A', 'outflow')).toEqual([0, 0, 0, 200, 300, 300]);
		expect(col(o, 'B', 'inflow_upstream')).toEqual([0, 0, 0, 200, 300, 300]);
		expect(col(o, 'G', 'outflow')).toEqual([0, 0, 0, 200, 300, 300]);
		checksPass(o);
	});

	it('a dam that ends a day exactly full does not spill; one m³ more spills one m³', () => {
		const i = input({ nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 1000, damInitialPct: 0.5 })], days: 2 });
		const exact = run(i, [500, 1]);
		expect(col(exact, 'A', 'dam_storage')).toEqual([1000, 1000]);
		expect(col(exact, 'A', 'spill')).toEqual([0, 1]);
	});

	it('the split above/below the dam: K = H × pct, M = I × pct; only K + M enter the dam', () => {
		const days = 3;
		const i = input({
			nodes: [node('G', 'gauge', null), node('B', 'farm', 'G', { damCapacityM3: 10_000, pctUpstreamToDam: 0.25, pctRunoffToDam: 0.6 }), node('A', 'farm', 'B')],
			days
		});
		// Shares 0.5 each (equal areas). A has no dam: its runoff passes to B.
		const o = run(i, new Array(days).fill(800));
		// H_B = 400, I_B = 400. K = 100, M = 240 enter; L = 300, N = 160 pass.
		expect(col(o, 'B', 'inflow_upstream')).toEqual([400, 400, 400]);
		expect(col(o, 'B', 'dam_storage')).toEqual([340, 680, 1020]);
		expect(col(o, 'B', 'outflow')).toEqual([460, 460, 460]);
	});
});

describe('dead storage (minimum operating level, §2.7 Q5)', () => {
	it('irrigation draws the dam down to dead storage and never below; deficit and summary follow', () => {
		const days = 6;
		const i = input({ nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 10_000, damInitialPct: 0.5, damMinPct: 0.2 })], days, need: { A: 1000 } });
		const o = run(i, new Array(days).fill(0));
		const D = col(o, 'A', 'demand');
		for (const d of D) expect(d).toBeCloseTo(1000, 9);
		// 5000 → 4000 → 3000 → 2000 (= dead), then nothing.
		const sup = col(o, 'A', 'supplied');
		expect(sup[0]).toBeCloseTo(1000, 9);
		expect(sup[1]).toBeCloseTo(1000, 9);
		expect(sup[2]).toBeCloseTo(1000, 9);
		expect(sup.slice(3)).toEqual([0, 0, 0]);
		const q = col(o, 'A', 'dam_storage');
		expect(q[2]).toBeCloseTo(2000, 6);
		for (const v of q) expect(v).toBeGreaterThanOrEqual(2000 - 1e-6);
		const f = o.summary.farms.find((x) => x.nodeId === 'A')!;
		expect(f.avgSuppliedM3Day).toBeCloseTo(3000 / days, 6);
		expect(f.avgDemandM3Day).toBeCloseTo(1000, 6);
		expect(f.fractionSupplied).toBeCloseTo(0.5, 9);
		expect(f.avgDeficitM3Day).toBeCloseTo(500, 6);
		checksPass(o);
	});

	it('a dam starting below dead storage supplies nothing until inflow lifts it above, then only the part above', () => {
		const days = 4;
		const i = input({ nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 10_000, damInitialPct: 0.1, damMinPct: 0.2 })], days, need: { A: 1000 } });
		const o = run(i, [500, 500, 1500, 0]);
		// 1000 + 500 = 1500 < 2000: nothing; 2000: nothing; 2000 + 1500 − dead → 1500 supplied; then 0.
		const sup = col(o, 'A', 'supplied');
		expect(sup[0]).toBe(0);
		expect(sup[1]).toBe(0);
		expect(sup[2]).toBeCloseTo(1000, 9);
		expect(sup[3]).toBeCloseTo(500, 9);
		expect(col(o, 'A', 'dam_storage')[3]).toBeCloseTo(2000, 6);
	});

	it('a day whose demand exactly equals the water above dead storage is supplied in full and leaves the dam at dead storage', () => {
		const i = input({ nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 4000, damInitialPct: 0.5, damMinPct: 0.25 })], days: 2, need: { A: 1000 } });
		const o = run(i, [0, 0]);
		const D = col(o, 'A', 'demand')[0]!;
		expect(col(o, 'A', 'supplied')[0]).toBeCloseTo(D, 9);
		expect(col(o, 'A', 'deficit')[0]).toBeCloseTo(0, 9);
		expect(col(o, 'A', 'dam_storage')[0]).toBeCloseTo(2000 - D, 9);
	});
});

describe('evaporation, rain on the dam and seepage (§2.7a)', () => {
	const lake = 0.75;
	const depth = lake * JAN_APAN_DAY; // mm/day in January

	it('power-law surface at yesterday’s storage, open-water evaporation and seepage, day by day for a month', () => {
		const days = 31;
		const cap = 100_000;
		const Afull = 30_000;
		const b = 0.7;
		const s = 0.002;
		const ret = 0.25;
		const rain = Array.from({ length: days }, (_, t) => (t === 9 ? 20 : t === 20 ? 5.5 : 0));
		const i = input({
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: cap, damInitialPct: 0.5, damAreaFullM2: Afull, damAreaExponent: b, damSeepagePerDay: s, damSeepageReturnPct: ret })],
			days,
			rain,
			settings: { lakeEvapFactor: lake },
			need: { A: 300 }
		});
		const natural = Array.from({ length: days }, (_, t) => (t % 7 === 0 ? 2500 : 100));
		const o = run(i, natural);
		const D = col(o, 'A', 'demand');
		let q = 0.5 * cap;
		const want = { A: [] as number[], Pd: [] as number[], E: [] as number[], Sp: [] as number[], G: [] as number[], Q: [] as number[], R: [] as number[], U: [] as number[] };
		for (let t = 0; t < days; t++) {
			const A = Afull * Math.pow(q / cap, b);
			const Pd = (rain[t]! * A) / 1000;
			const E = Math.min((depth * A) / 1000, q + Pd);
			const Sp = Math.min(s * q, q + Pd - E);
			const avail = q + Pd - E - Sp + natural[t]!;
			const G = Math.min(Math.max(avail, 0), D[t]!);
			const P = avail - G;
			const Q = Math.min(P, cap);
			const R = Math.max(P - cap, 0);
			want.A.push(A);
			want.Pd.push(Pd);
			want.E.push(E);
			want.Sp.push(Sp);
			want.G.push(G);
			want.Q.push(Q);
			want.R.push(R);
			want.U.push(R + Sp * ret);
			q = Q;
		}
		const close = (got: number[], exp: number[], what: string) => exp.forEach((v, t) => expect(got[t], `${what} day ${t}`).toBeCloseTo(v, 6));
		close(col(o, 'A', 'dam_area'), want.A, 'area');
		close(col(o, 'A', 'rain_on_dam'), want.Pd, 'rain on dam');
		close(col(o, 'A', 'dam_evaporation'), want.E, 'evaporation');
		close(col(o, 'A', 'dam_seepage'), want.Sp, 'seepage');
		close(col(o, 'A', 'supplied'), want.G, 'supplied');
		close(col(o, 'A', 'dam_storage'), want.Q, 'storage');
		close(col(o, 'A', 'spill'), want.R, 'spill');
		close(col(o, 'A', 'outflow'), want.U, 'outflow');
		close(col(o, 'A', 'dam_seepage_lost'), want.Sp.map((v) => v * (1 - ret)), 'seepage lost');
		// A real 100 000 m³ dam of 3 ha at half full loses ~150 m³/day to evaporation here.
		expect(want.E[0]).toBeGreaterThan(100);
		expect(want.Pd[9]).toBeGreaterThan(0);
		checksPass(o);
	});

	it('an empty dam has no surface: no evaporation, no rain on it, no seepage', () => {
		const i = input({ nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 1000, damAreaFullM2: 500, damSeepagePerDay: 0.1 })], days: 2, rain: [30, 30], settings: { lakeEvapFactor: 0.75 } });
		const o = run(i, [0, 100]);
		expect(col(o, 'A', 'dam_area')[0]).toBe(0);
		expect(col(o, 'A', 'rain_on_dam')[0]).toBe(0);
		expect(col(o, 'A', 'dam_evaporation')[0]).toBe(0);
		expect(col(o, 'A', 'dam_seepage')[0]).toBe(0);
		expect(col(o, 'A', 'dam_storage')[0]).toBe(0);
		// Day 1 starts empty too: the 100 m³ arrives today, the area follows yesterday's storage.
		expect(col(o, 'A', 'dam_evaporation')[1]).toBe(0);
		expect(col(o, 'A', 'dam_storage')[1]).toBe(100);
	});

	it('evaporation takes at most what is there: a tiny dam with a huge surface ends the day at 0, never below', () => {
		const i = input({ nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 10, damInitialPct: 1, damAreaFullM2: 1_000_000, damSeepagePerDay: 0.5 })], days: 2, settings: { lakeEvapFactor: 0.75 } });
		const o = run(i, [0, 0]);
		expect(col(o, 'A', 'dam_evaporation')[0]).toBeCloseTo(10, 9);
		expect(col(o, 'A', 'dam_seepage')[0]).toBe(0);
		expect(col(o, 'A', 'dam_storage')).toEqual([0, 0]);
	});

	it('a survey curve sets the area by linear interpolation in volume', () => {
		const SURVEY: DamCurvePoint[] = [
			{ levelM: 100, areaM2: 0, volumeM3: 0 },
			{ levelM: 101, areaM2: 8_000, volumeM3: 4_000 },
			{ levelM: 102, areaM2: 14_000, volumeM3: 15_000 },
			{ levelM: 103, areaM2: 20_000, volumeM3: 32_000 },
			{ levelM: 104, areaM2: 25_000, volumeM3: 55_000 },
			{ levelM: 105, areaM2: 30_000, volumeM3: 100_000 }
		];
		const days = 20;
		const i = input({
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 100_000, damInitialPct: 0.775, damAreaFullM2: 1, damCurve: SURVEY })],
			days,
			settings: { lakeEvapFactor: lake },
			need: { A: 2000 }
		});
		const o = run(i, new Array(days).fill(0));
		const areaAt = (v: number) => {
			for (let k = 1; k < SURVEY.length; k++) {
				const a = SURVEY[k - 1]!;
				const c = SURVEY[k]!;
				if (v <= c.volumeM3) return a.areaM2 + ((c.areaM2 - a.areaM2) * (v - a.volumeM3)) / (c.volumeM3 - a.volumeM3);
			}
			return SURVEY.at(-1)!.areaM2;
		};
		expect(col(o, 'A', 'dam_area')[0]).toBeCloseTo(27_500, 6);
		let q = 77_500;
		const D = col(o, 'A', 'demand');
		for (let t = 0; t < days; t++) {
			const A = areaAt(q);
			const E = (depth * A) / 1000;
			expect(col(o, 'A', 'dam_area')[t], `day ${t}`).toBeCloseTo(A, 6);
			expect(col(o, 'A', 'dam_evaporation')[t], `day ${t}`).toBeCloseTo(E, 6);
			q = q - E - Math.min(q - E, D[t]!);
			expect(col(o, 'A', 'dam_storage')[t], `day ${t}`).toBeCloseTo(q, 6);
		}
		checksPass(o);
	});

	it('twelve equal monthly lake factors run exactly as the single factor', () => {
		const days = 40;
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 50_000, damInitialPct: 0.6, damAreaFullM2: 20_000 })];
		const natural = Array.from({ length: days }, (_, t) => 50 + 10 * t);
		const one = run(input({ nodes, days, settings: { lakeEvapFactor: 0.7 }, need: { A: 150 } }), natural);
		const twelve = run(input({ nodes, days, settings: { lakeEvapFactor: 0.2, lakeEvapFactorMonthly: flat(0.7) as never }, need: { A: 150 } }), natural);
		expect(col(twelve, 'A', 'dam_storage')).toEqual(col(one, 'A', 'dam_storage'));
		expect(col(twelve, 'A', 'dam_evaporation')).toEqual(col(one, 'A', 'dam_evaporation'));
	});

	it('the evaporation depth follows the calendar month: January days at Jan’s rate, then February’s (28.25 days)', () => {
		const days = 33;
		const cap = 1e9;
		const i = input({ nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: cap, damInitialPct: 1, damAreaFullM2: 10_000, damAreaExponent: 1 })], days, settings: { lakeEvapFactor: 1 } });
		const o = run(i, new Array(days).fill(0));
		const E = col(o, 'A', 'dam_evaporation');
		const Q = col(o, 'A', 'dam_storage');
		// b = 1: A = A_full × Q[t−1] / cap.
		expect(E[30]).toBeCloseTo(((285 / 31) * 10_000 * (Q[29]! / cap)) / 1000, 9);
		// February: the configured 28.25 days (§2.3) by default.
		expect(E[31]).toBeCloseTo(((245 / 28.25) * 10_000 * (Q[30]! / cap)) / 1000, 9);
	});
});

describe('daily balance closure and summaries on a 4-node network', () => {
	it('start + inflow − outflow − losses − consumptive supply = end, every farm, every day; summaries = means of the series', () => {
		const days = 120;
		const nodes = [
			node('OUT', 'gauge', null),
			node('C', 'farm', 'OUT', { areaKm2: 2, damCapacityM3: 30_000, damInitialPct: 0.3, damMinPct: 0.1, damAreaFullM2: 12_000, damSeepagePerDay: 0.003, damSeepageReturnPct: 0.5, irrigationEfficiency: 0.8, lossReturnFraction: 0.5, pctUpstreamToDam: 0.5, pctRunoffToDam: 0.7, divertCapacityM3Day: 200 }),
			node('B', 'farm', 'C', { areaKm2: 1, damCapacityM3: 8_000, damInitialPct: 1, damAreaFullM2: 4_000, irrigationEfficiency: 0.9, lossReturnFraction: 0.3 }),
			node('A', 'farm', 'C', { areaKm2: 1, irrigationEfficiency: 0.75, lossReturnFraction: 1 })
		];
		const rain = Array.from({ length: days }, (_, t) => (t % 11 === 3 ? 18 : 0));
		const natural = Array.from({ length: days }, (_, t) => 400 + 3000 * Math.max(0, Math.sin(t / 9)));
		const i = input({ nodes, days, rain, settings: { lakeEvapFactor: 0.75 }, need: { A: 150, B: 250, C: 600 } });
		const o = run(i, natural);
		checksPass(o);
		for (const id of ['A', 'B', 'C']) {
			const H = col(o, id, 'inflow_upstream');
			const I = col(o, id, 'runoff');
			const G = col(o, id, 'supplied');
			const U = col(o, id, 'outflow');
			const Q = col(o, id, 'dam_storage');
			const T = col(o, id, 'return_flow');
			const Pd = opt(o, id, 'rain_on_dam') ?? new Array(days).fill(0);
			const E = opt(o, id, 'dam_evaporation') ?? new Array(days).fill(0);
			const lost = opt(o, id, 'dam_seepage_lost') ?? new Array(days).fill(0);
			const n = nodes.find((x) => x.id === id)!;
			let prev = n.damInitialPct * n.damCapacityM3;
			for (let t = 0; t < days; t++) {
				const resid = H[t]! + I[t]! + Pd[t]! - (G[t]! - T[t]!) - E[t]! - (Q[t]! - prev) - U[t]! - lost[t]!;
				expect(Math.abs(resid), `${id} day ${t}`).toBeLessThan(1e-9 * Math.max(1, H[t]! + I[t]! + prev));
				// T = β(1 − e)G
				expect(T[t]!, `${id} T day ${t}`).toBeCloseTo(n.lossReturnFraction * (1 - n.irrigationEfficiency) * G[t]!, 9);
				// G ≤ D, storage within 0 … capacity
				expect(G[t]!).toBeLessThanOrEqual(col(o, id, 'demand')[t]! * (1 + 1e-12));
				expect(Q[t]!).toBeGreaterThanOrEqual(0);
				expect(Q[t]!).toBeLessThanOrEqual(n.damCapacityM3 + 1e-9);
				prev = Q[t]!;
			}
			const f = o.summary.farms.find((x) => x.nodeId === id)!;
			expect(f.avgSuppliedM3Day).toBeCloseTo(mean(G), 9);
			expect(f.avgDemandM3Day).toBeCloseTo(mean(col(o, id, 'demand')), 9);
			expect(f.avgDeficitM3Day).toBeCloseTo(mean(col(o, id, 'deficit')), 9);
			expect(f.fractionSupplied).toBeCloseTo(mean(G) / mean(col(o, id, 'demand')), 12);
			// D = F / e
			col(o, id, 'demand').forEach((d, t) => expect(d).toBeCloseTo(col(o, id, 'crop_requirement')[t]! / n.irrigationEfficiency, 9));
		}
		// The outlet sees C's outflow; C sees A + B.
		expect(col(o, 'OUT', 'outflow')).toEqual(col(o, 'C', 'outflow'));
		col(o, 'C', 'inflow_upstream').forEach((h, t) => expect(h).toBeCloseTo(col(o, 'A', 'outflow')[t]! + col(o, 'B', 'outflow')[t]!, 9));
		// The catchment water balance closes over the run.
		const wb = o.summary.waterBalance!;
		expect(Math.abs(wb.total.residualM3)).toBeLessThan(1e-6 * (wb.total.naturalFlowM3 + wb.total.openingStorageM3));
		expect(wb.total.closingStorageM3).toBeCloseTo(['B', 'C'].reduce((a, id) => a + col(o, id, 'dam_storage')[days - 1]!, 0), 6);
	});
});

describe('the whole pipeline with the runoff model (runModel)', () => {
	it('closes every farm’s day on GR4J flow, with rain on the dams and the A-pan evaporation', () => {
		const days = 365;
		const rain = Array.from({ length: days }, (_, t) => (t % 6 === 0 ? 12 + (t % 5) : t % 17 === 1 ? 35 : 0));
		const nodes = [
			node('OUT', 'gauge', null),
			node('B', 'farm', 'OUT', { areaKm2: 3, damCapacityM3: 60_000, damInitialPct: 0.4, damAreaFullM2: 18_000, damMinPct: 0.15, damSeepagePerDay: 0.001, irrigationEfficiency: 0.85, lossReturnFraction: 0.4 }),
			node('A', 'farm', 'B', { areaKm2: 2, damCapacityM3: 20_000, damInitialPct: 0.8, damAreaFullM2: 7_000, irrigationEfficiency: 0.9, lossReturnFraction: 0.5 })
		];
		const i: ModelInput = {
			...input({ nodes, days, rain, start: '2020-10-01', settings: { lakeEvapFactor: 0.75 }, need: { A: 80, B: 200 } })
		};
		const o = withVerification(i, runModel(i));
		checksPass(o);
		const nat = col(o, null, 'natural_flow');
		for (const id of ['A', 'B']) {
			const n = nodes.find((x) => x.id === id)!;
			const share = n.areaKm2 / 5;
			col(o, id, 'runoff').forEach((v, t) => expect(v).toBeCloseTo(nat[t]! * share, 6));
			col(o, id, 'rain_on_dam').forEach((v, t) => expect(v).toBeCloseTo((rain[t]! * col(o, id, 'dam_area')[t]!) / 1000, 9));
			let prev = n.damInitialPct * n.damCapacityM3;
			const H = col(o, id, 'inflow_upstream');
			const I = col(o, id, 'runoff');
			const G = col(o, id, 'supplied');
			const T = col(o, id, 'return_flow');
			const E = col(o, id, 'dam_evaporation');
			const Pd = col(o, id, 'rain_on_dam');
			const Q = col(o, id, 'dam_storage');
			const U = col(o, id, 'outflow');
			for (let t = 0; t < days; t++) {
				const r = H[t]! + I[t]! + Pd[t]! - (G[t]! - T[t]!) - E[t]! - (Q[t]! - prev) - U[t]!;
				expect(Math.abs(r), `${id} day ${t}`).toBeLessThan(1e-9 * Math.max(1, prev + H[t]! + I[t]!));
				prev = Q[t]!;
			}
		}
	});
});

describe('the b > 1 limiter, releases and the dam summary figures (§2.7a)', () => {
	it('with b > 1 evaporation is at most (1 − seepage) × store[t−1] / b', () => {
		const i = input({
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 1000, damInitialPct: 1, damAreaFullM2: 1_000_000, damAreaExponent: 2, damSeepagePerDay: 0.1 })],
			days: 1,
			settings: { lakeEvapFactor: 0.75 }
		});
		const o = run(i, [0]);
		expect(col(o, 'A', 'dam_evaporation')[0]).toBeCloseTo((0.9 * 1000) / 2, 9);
		expect(col(o, 'A', 'dam_seepage')[0]).toBeCloseTo(100, 9);
		expect(col(o, 'A', 'dam_storage')[0]).toBeCloseTo(450, 9);
		expect(o.summary.warnings.some((w) => w.includes('dam area exponent 2'))).toBe(true);
	});

	it('a fixed release leaves from storage above dead storage, capped by the outlet, before irrigation', () => {
		const days = 6;
		const i = input({
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 10_000, damInitialPct: 0.5, damMinPct: 0.2, damReleaseRule: 'fixed', damReleaseM3Day: flat(1000), damOutletCapacityM3Day: 800 })],
			days,
			need: { A: 100 }
		});
		const o = run(i, new Array(days).fill(0));
		// Release 800, irrigate 100: 5000 → 4100 → 3200 → 2300; then 300 above dead: 300 released, 0 irrigated.
		const rel = col(o, 'A', 'dam_release');
		closeTo(rel, [800, 800, 800, 300, 0, 0], 'release');
		closeTo(col(o, 'A', 'supplied'), [100, 100, 100, 0, 0, 0], 'supplied');
		closeTo(col(o, 'A', 'dam_storage'), [4100, 3200, 2300, 2000, 2000, 2000], 'storage');
		closeTo(col(o, 'A', 'outflow'), rel, 'outflow');
		checksPass(o);
	});

	it('pass inflow lets through today’s inflow up to what the river below still lacks of Z, whatever the level', () => {
		const days = 3;
		const i = input({
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 10_000, damInitialPct: 0, damReleaseRule: 'passInflow' })],
			days,
			settings: { ewrPragmaticM3PerDay: flat(300) as never }
		});
		const o = run(i, [1000, 100, 0]);
		closeTo(col(o, 'A', 'dam_release'), [300, 100, 0], 'release');
		closeTo(col(o, 'A', 'dam_storage'), [700, 700, 700], 'storage');
		checksPass(o);
	});

	it('the summary’s dam figures are the storage series’: the end, 30 days before, the lowest of the last 365 and days at the minimum level', () => {
		const days = 400;
		const natural = Array.from({ length: days }, (_, t) => (t >= 150 && t < 300 ? 0 : t % 50 === 0 ? 4000 : 50));
		const i = input({ nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 8000, damInitialPct: 0.5, damMinPct: 0.25 })], days, need: { A: 300 } });
		const o = run(i, natural);
		const q = col(o, 'A', 'dam_storage');
		const f = o.summary.farms[0]!;
		expect(f.damEndM3).toBe(q[days - 1]);
		expect(f.damAgoM3).toBe(q[days - 1 - 30]);
		const window = q.slice(days - 365);
		const low = Math.min(...window);
		expect(f.damLowM3).toBe(low);
		const lowDay = days - 365 + window.indexOf(low);
		const d = new Date(Date.UTC(2021, 0, 1 + lowDay)).toISOString().slice(0, 10);
		expect(f.damLowDate).toBe(d);
		expect(f.damDaysAtMin).toBe(window.filter((v) => v <= 2000 * (1 + 1e-8)).length);
		expect(f.damDaysAtMin).toBeGreaterThan(0);
	});
});

function closeTo(got: number[], want: number[], what: string) {
	expect(got.length, what).toBe(want.length);
	want.forEach((v, t) => expect(got[t], `${what} day ${t}`).toBeCloseTo(v, 6));
}
