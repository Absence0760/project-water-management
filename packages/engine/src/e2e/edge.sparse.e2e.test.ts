// End-to-end, round 2: nearly empty networks and nearly empty inputs. A
// single gauge; a gauge with units of zero area; a single unit with no crops
// (with and without a dam, with and without a gauge); no series at all; an
// A-pan of 0 in every month. Each is worked by hand from docs/model.md
// (§2.5 fragmentation, §2.7 farm balance, §2.7a dam losses, §2.11/§2.11a's
// "no demand" rules, §2.11b's water account) and every run must pass the
// engine's own checks, with every value finite.
// Invented values only.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import { runModel, runModelChecked, runModelWith, withVerification } from '../run';

const APAN = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const EWR = [900, 800, 700, 650, 600, 650, 700, 800, 900, 1000, 1000, 950];

const NODE: Omit<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId'> = {
	sortOrder: 0,
	areaKm2: 0,
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
	damSeepagePerDay: 0
};
const gauge = (): NetworkNode => ({ ...NODE, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null });
const unit = (id: string, down: string | null, over: Partial<NetworkNode> = {}): NetworkNode => ({ ...NODE, id, name: `Unit ${id}`, kind: 'farm', downstreamNodeId: down, ...over });

function rainRecord(n: number, seed = 1): number[] {
	let s = seed >>> 0;
	const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
	return Array.from({ length: n }, () => {
		const u = r();
		return u < 0.6 ? 0 : u < 0.8 ? Math.round(r() * 40) / 10 : u < 0.97 ? Math.round(r() * 300) / 10 : 60 + Math.round(r() * 900) / 10;
	});
}

function input(nodes: NetworkNode[], settings: Record<string, unknown> = {}, days = 400): ModelInput {
	return {
		settings: { runoffModel: 'gr4j', apanMm: APAN as never, ewrPragmaticM3PerDay: EWR as never, ...settings } as ModelInput['settings'],
		model: { nodes, crops: [{ id: 'c', name: 'Crop', cropFactor: new Array(12).fill(0.8) }], cropAreas: [], transfers: [] },
		series: { rain_catchment_mm: { startDate: '2000-01-01', values: rainRecord(days, 11) } }
	};
}

const col = (o: ModelOutput, id: string | null, key: string): number[] => {
	const s = o.series.find((x) => x.nodeId === id && x.key === key);
	if (!s) throw new Error(`no series ${id}/${key}`);
	return s.values;
};
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const checksPass = (o: ModelOutput) => expect(o.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
function allFinite(o: ModelOutput) {
	for (const s of o.series) if (!['rain_final', 'rain_source', 'observed_flow'].includes(s.key)) expect(s.values.every(Number.isFinite), `${s.nodeId}/${s.key}`).toBe(true);
}
/** §2.9: a day is short when the outlet flow is below the EWR (by more than float noise). */
const hand = (o: ModelOutput) => {
	const q = col(o, null, 'simulated_outflow');
	const e = col(o, null, 'ewr');
	return q.filter((v, t) => v - e[t]! < -1e-12 * Math.max(v, e[t]!)).length;
};

describe('a single gauge and nothing else', () => {
	// With no unit the catchment's area has to come from Settings → calibration (else the run refuses, below).
	const i = input([gauge()], { calibration: { catchmentAreaKm2: 5 } });
	const o = runModelChecked(i);

	it('runs, passes its checks and is finite', () => {
		checksPass(o);
		allFinite(o);
		expect(o.summary.farms).toEqual([]);
	});

	it('the natural flow reaches no unit, so the gauge sees 0 and the water account books it all as unallocated (§2.5, §2.11b)', () => {
		const nat = col(o, null, 'natural_flow');
		expect(sum(nat)).toBeGreaterThan(0);
		expect(col(o, null, 'simulated_outflow')).toEqual(new Array(o.days).fill(0));
		expect(col(o, 'G', 'outflow')).toEqual(new Array(o.days).fill(0));
		const wa = o.summary.supplyAssurance!.waterAccount.total;
		expect(wa.naturalFlowM3).toBeCloseTo(sum(nat), 6);
		expect(wa.unallocatedM3).toBeCloseTo(sum(nat), 6);
		expect(wa.outflowM3).toBe(0);
		expect(Math.abs(wa.residualM3)).toBeLessThanOrEqual(1e-10 * wa.scaleM3);
		// Every day of a positive EWR is then a day not met, and the summary says so.
		expect(o.summary.catchment.ewrDaysNotMet).toBe(o.days);
		expect(hand(o)).toBe(o.days);
		expect(o.summary.supplyAssurance!.reliability).toEqual([]);
	});

	it('the natural flow is the GR4J depth × the calibration area (mm × km² × 1000 = m³, §2.4a)', () => {
		const b = o.summary.runoff!;
		expect(b.areaKm2).toBe(5);
		expect(sum(col(o, null, 'natural_flow'))).toBeCloseTo(b.flowMm * 5 * 1000, 4);
	});

	it('without a calibration area the run refuses, naming the fix', () => {
		expect(() => runModel(input([gauge()]))).toThrow(/catchment area is 0/);
	});
});

describe('a gauge with units of zero area', () => {
	const i = input([gauge(), unit('A', 'G'), unit('B', 'G', { damCapacityM3: 5000, damInitialPct: 0.5, damAreaFullM2: 2000 })], { calibration: { catchmentAreaKm2: 5 }, lakeEvapFactor: 0.75 });
	const o = runModelChecked(i);

	it('gives every unit a share of 0, warns that nothing is allocated, and passes its checks', () => {
		checksPass(o);
		allFinite(o);
		expect(o.summary.farms.map((f) => f.flowShare)).toEqual([0, 0]);
		expect(o.summary.warnings).toContain('area flow shares: total unit area is 0');
		expect(o.summary.warnings.some((w) => /flow shares sum to 0\.00%.*not fully allocated/.test(w))).toBe(true);
		for (const id of ['A', 'B']) expect(col(o, id, 'runoff')).toEqual(new Array(o.days).fill(0));
	});

	it('the zero-area dam only loses water: it evaporates (§2.7a) and passes nothing but its seepage, which is 0', () => {
		const q = col(o, 'B', 'dam_storage');
		const e = col(o, 'B', 'dam_evaporation');
		const pd = col(o, 'B', 'rain_on_dam');
		let prev = 2500;
		for (let t = 0; t < o.days; t++) {
			// Q[t] = Q[t−1] + Pd − E, never above capacity, never below 0.
			expect(Math.abs(q[t]! - Math.min(prev + pd[t]! - e[t]!, 5000))).toBeLessThanOrEqual(1e-9 * 5000);
			expect(q[t]!).toBeGreaterThanOrEqual(0);
			prev = q[t]!;
		}
		expect(sum(col(o, 'B', 'outflow'))).toBe(sum(col(o, 'B', 'spill')));
	});
});

describe('a single unit with no crops', () => {
	it('without a dam and without a gauge: the unit is the outlet and passes the natural flow unchanged', () => {
		const o = runModelChecked(input([unit('A', null, { areaKm2: 3 })]));
		checksPass(o);
		allFinite(o);
		expect(col(o, 'A', 'outflow')).toEqual(col(o, null, 'natural_flow'));
		expect(col(o, null, 'simulated_outflow')).toEqual(col(o, null, 'natural_flow'));
		expect(col(o, 'A', 'demand')).toEqual(new Array(o.days).fill(0));
		expect(o.summary.catchment.ewrDaysNotMet).toBe(hand(o));
	});

	it('the "no demand" rules: reliability null, fractions null, no stress class, no failure (§2.11, §2.11a)', () => {
		const o = runModelChecked(input([gauge(), unit('A', 'G', { areaKm2: 3 })]));
		checksPass(o);
		const r = o.summary.supplyAssurance!.reliability[0]!;
		expect([r.demandDays, r.metDays, r.timeReliability, r.volumetricReliability, r.annualReliability, r.failureRuns, r.meanFailureDays, r.meanFailureDeficitM3]).toEqual([0, 0, null, null, null, 0, null, null]);
		expect(o.summary.supplyAssurance!.stress.system.stressClass.flat().every((c) => c === null)).toBe(true);
		const c = o.summary.curtailment!;
		expect(c.equitableFraction).toBeNull();
		expect([c.farms[0]!.fractionSupplied, c.farms[0]!.targetFraction, c.farms[0]!.fractionOfDemandLeft]).toEqual([null, null, null]);
	});

	it('with a dam: it fills from its runoff by Q[t] = MIN(Q[t−1] + Pd − E + I, C) and spills the rest (§2.7, §2.7a)', () => {
		const C = 40_000;
		const i = input([gauge(), unit('A', 'G', { areaKm2: 3, damCapacityM3: C, damAreaFullM2: 15_000 })], { lakeEvapFactor: 0.75 });
		const o = runModelChecked(i);
		checksPass(o);
		allFinite(o);
		const [I, Pd, E, Q, R, U] = ['runoff', 'rain_on_dam', 'dam_evaporation', 'dam_storage', 'spill', 'outflow'].map((k) => col(o, 'A', k));
		const rain = col(o, null, 'rain_final');
		let prev = 0;
		for (let t = 0; t < o.days; t++) {
			// A = A_full × (Q/C)^0.7, 0 when empty; Pd = rain × A ÷ 1000; E = MIN(0.75 × A-pan/day × A ÷ 1000, Q + Pd).
			const area = prev > 0 ? 15_000 * (prev / C) ** 0.7 : 0;
			const m = (new Date(Date.UTC(2000, 0, 1 + t)).getUTCMonth() + 3) % 12;
			const dim = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30][m]!;
			const pd = (rain[t]! * area) / 1000;
			const e = Math.min((0.75 * (APAN[m]! / dim) * area) / 1000, prev + pd);
			const p = prev + pd - e + I![t]!;
			const tol = 1e-9 * Math.max(1, p);
			expect(Math.abs(Pd![t]! - pd)).toBeLessThanOrEqual(tol);
			expect(Math.abs(E![t]! - e)).toBeLessThanOrEqual(tol);
			expect(Math.abs(Q![t]! - Math.min(p, C))).toBeLessThanOrEqual(tol);
			expect(Math.abs(R![t]! - Math.max(p - C, 0))).toBeLessThanOrEqual(tol);
			expect(Math.abs(U![t]! - R![t]!)).toBeLessThanOrEqual(tol);
			prev = Q![t]!;
		}
		expect(Math.max(...R!)).toBeGreaterThan(0);
		// damFigures (§2.8): end and 30 days before, the low of the last 365 days.
		const f = o.summary.farms[0]!;
		expect(f.damEndM3).toBe(Q!.at(-1));
		expect(f.damAgoM3).toBe(Q![o.days - 31]);
		expect(f.damLowM3).toBe(Math.min(...Q!.slice(-365)));
		expect(f.damDaysAtMin).toBe(0);
	});
});

describe('inputs that are empty or zero', () => {
	it('no series at all inside an explicit window: GR4J drains its stores, and the run says there is no rain series', () => {
		const i = input([gauge(), unit('A', 'G', { areaKm2: 3 })], { simulationStart: '2000-06-01', simulationEnd: '2000-09-08' });
		i.series = {};
		const o = runModelChecked(i);
		checksPass(o);
		allFinite(o);
		expect(o.days).toBe(100);
		expect(col(o, null, 'rain_used')).toEqual(new Array(100).fill(0));
		expect(o.summary.warnings.some((w) => w.startsWith('no rainfall series: natural flow is only what drains from the stores'))).toBe(true);
		// No rain in: the runoff model only loses storage (rain − AET − Q + exchange = ΔS with rain 0, §2.4a).
		const b = o.summary.runoff!;
		expect(b.rainMm).toBe(0);
		expect(b.storageEndMm).toBeLessThanOrEqual(b.storageStartMm + b.exchangeMm + 1e-9);
	});

	it('an A-pan of 0 in every month: GR4J refuses (it would never dry out, §2.4a)', () => {
		expect(() => runModel(input([gauge(), unit('A', 'G', { areaKm2: 3 })], { apanMm: new Array(12).fill(0) }))).toThrow(/GR4J needs potential evaporation/);
	});

	it('an A-pan of 0 with natural flow given: no crop demand, no dam evaporation, and the run says so (§2.7a, engine ≥ 1.67.0)', () => {
		const i = input([gauge(), unit('A', 'G', { areaKm2: 3, damCapacityM3: 10_000, damInitialPct: 0.5, damAreaFullM2: 5000 })], { apanMm: new Array(12).fill(0), lakeEvapFactor: 0.75 }, 60);
		i.model.cropAreas = [{ nodeId: 'A', cropId: 'c', areaM2: 50_000 }];
		const o = withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: new Array(60).fill(100) })));
		checksPass(o);
		expect(col(o, 'A', 'demand')).toEqual(new Array(60).fill(0));
		expect(col(o, 'A', 'dam_evaporation')).toEqual(new Array(60).fill(0));
		expect(o.summary.warnings.some((w) => w.startsWith('A-pan evaporation is 0 on every day'))).toBe(true);
		// Storage climbs by the inflow plus the rain on the dam until full (5000 + 100 t + Σ Pd, capped at 10 000).
		const q = col(o, 'A', 'dam_storage');
		const pd = col(o, 'A', 'rain_on_dam');
		let prev = 5000;
		for (let t = 0; t < 60; t++) {
			expect(q[t]).toBeCloseTo(Math.min(prev + 100 + pd[t]!, 10_000), 9);
			prev = q[t]!;
		}
	});
});
