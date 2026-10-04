// End-to-end, round 2: magnitudes far from a real farm. Catchments of
// 0.001 km² and 100 000 km², dams of 1 m³ and 10¹⁰ m³, demands of 10⁻⁹ and
// 10⁹ m³/day, a transfer capped at 10⁻⁶ m³/s; and the scale invariance that
// follows from docs/model.md: every relation in §2.3–§2.7a is linear in the
// areas and volumes once the dam's full-supply area is entered (A = A_full ×
// (Q ÷ C)^b only reads the ratio Q ÷ C; GR4J works in mm, §2.4a; the
// fragmentation shares are ratios of areas, §2.5), so multiplying every area
// and volume by k multiplies every m³ and m² series by k and leaves every
// fraction, every day count and every class unchanged. The engine's
// thresholds are relative (served in full: D − G ≤ 10⁻⁹ D, §2.11a; an EWR
// shortfall below 10⁻¹² of the flows is noise, §2.9), which is what lets this
// hold at every scale. The one absolute threshold, the 1 L/s no-flow line
// (§2.9e), is left out on purpose.
// Invented values only.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput, NetworkNode, Transfer } from '../project';
import { runModelChecked, runModelWith, withVerification } from '../run';

const APAN = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const DIM = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30];
const EWR = [5, 6, 7, 8, 9, 9, 8, 6, 4, 3, 3, 4].map((v) => v * 1000);

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
	returnFlowFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0
};

/** Deterministic invented rain: dry spells, drizzle and storms. */
function rainRecord(n: number, seed = 1): number[] {
	let s = seed >>> 0;
	const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
	return Array.from({ length: n }, () => {
		const u = r();
		return u < 0.6 ? 0 : u < 0.8 ? Math.round(r() * 40) / 10 : u < 0.97 ? Math.round(r() * 300) / 10 : 60 + Math.round(r() * 900) / 10;
	});
}

const col = (o: ModelOutput, id: string | null, key: string): number[] => {
	const s = o.series.find((x) => x.nodeId === id && x.key === key);
	if (!s) throw new Error(`no series ${id}/${key}`);
	return s.values;
};
const checksPass = (o: ModelOutput) => expect(o.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);

/** No NaN or ±Infinity anywhere but the input columns that show a gap as NaN; no negative storage, supply or spill. */
function expectSane(o: ModelOutput) {
	for (const s of o.series) {
		if (['rain_final', 'rain_source', 'observed_flow'].includes(s.key)) continue;
		for (const v of s.values) expect(Number.isFinite(v), `${s.nodeId}/${s.key}`).toBe(true);
	}
	for (const s of o.series) {
		if (!['dam_storage', 'supplied', 'spill', 'demand', 'outflow', 'dam_evaporation', 'dam_seepage', 'rain_on_dam', 'natural_flow', 'simulated_outflow'].includes(s.key)) continue;
		for (const v of s.values) expect(v, `${s.nodeId}/${s.key}`).toBeGreaterThanOrEqual(0);
	}
}

/**
 * The run's catchment mass balance from its own series (§2.11b): Σ natural flow
 * + rain on dams + initial storage = Σ consumptive use + evaporation + outflow +
 * final storage, within relative float noise of the throughput.
 */
function massBalance(i: ModelInput, o: ModelOutput): { residual: number; scale: number } {
	const farms = i.model.nodes.filter((n) => n.kind === 'farm');
	let inn = col(o, null, 'natural_flow').reduce((a, b) => a + b, 0);
	let out = col(o, null, 'simulated_outflow').reduce((a, b) => a + b, 0);
	for (const n of farms) {
		const q = col(o, n.id, 'dam_storage');
		inn += n.damInitialPct * n.damCapacityM3 + col(o, n.id, 'rain_on_dam').reduce((a, b) => a + b, 0);
		const G = col(o, n.id, 'supplied');
		const T = col(o, n.id, 'return_flow');
		const E = col(o, n.id, 'dam_evaporation');
		for (let t = 0; t < o.days; t++) out += G[t]! - T[t]! + E[t]!;
		out += q[o.days - 1]!;
	}
	return { residual: inn - out, scale: Math.max(Math.abs(inn), Math.abs(out)) };
}

// --- a three-unit network scaled by k ------------------------------------------

function scaled(k: number, days = 1500): ModelInput {
	const transfer: Transfer = {
		id: 't',
		fromNodeId: 'B',
		toNodeId: 'A',
		months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
		maxRateM3s: 0.01 * k,
		dailyCapM3: 500 * k,
		minStoragePct: 0.1,
		enabled: true,
		priority: 1
	};
	return {
		settings: { runoffModel: 'gr4j', apanMm: APAN as never, ewrPragmaticM3PerDay: EWR.map((v) => v * k) as never, lakeEvapFactor: 0.75 } as ModelInput['settings'],
		model: {
			nodes: [
				{ ...NODE, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null },
				{ ...NODE, id: 'A', name: 'A', kind: 'farm', downstreamNodeId: 'G', areaKm2: 10 * k, damCapacityM3: 200_000 * k, damInitialPct: 0.5, damMinPct: 0.1, damAreaFullM2: 40_000 * k, damSeepagePerDay: 0.001 },
				{
					...NODE,
					id: 'B',
					name: 'B',
					kind: 'farm',
					downstreamNodeId: 'A',
					areaKm2: 5 * k,
					damCapacityM3: 50_000 * k,
					damInitialPct: 0.2,
					damAreaFullM2: 15_000 * k,
					pctUpstreamToDam: 0.5,
					pctRunoffToDam: 0.7,
					divertCapacityM3Day: 300 * k,
					irrigationEfficiency: 0.8,
					returnFlowFraction: 0.1
				},
				{ ...NODE, id: 'C', name: 'C', kind: 'farm', downstreamNodeId: 'A', areaKm2: 2 * k, irrigationEfficiency: 0.9, returnFlowFraction: 0.03 }
			],
			crops: [{ id: 'c', name: 'Crop', cropFactor: new Array(12).fill(0.8) }],
			cropAreas: [
				{ nodeId: 'A', cropId: 'c', areaM2: 3_000_000 * k },
				{ nodeId: 'B', cropId: 'c', areaM2: 1_500_000 * k },
				{ nodeId: 'C', cropId: 'c', areaM2: 800_000 * k }
			],
			transfers: [transfer]
		},
		series: { rain_catchment_mm: { startDate: '2000-01-01', values: rainRecord(days, 7) } }
	};
}

/** Volume and area units scale with k; everything else (mm, fractions, codes) doesn't. */
const isVolume = (unit: string) => /m³|m²/.test(unit);

describe('scale invariance: every area and volume × k', () => {
	const base = runModelChecked(scaled(1));

	it('the base run is a fair test: shortages, failure runs, dead storage and EWR failures all happen', () => {
		checksPass(base);
		expectSane(base);
		const sa = base.summary.supplyAssurance!;
		expect(sa.reliability.some((r) => r.failureRuns > 0)).toBe(true);
		expect(base.summary.catchment.ewrDaysNotMet).toBeGreaterThan(0);
		expect(base.summary.catchment.ewrDaysNotMet).toBeLessThan(base.days);
		expect(base.summary.farms.find((f) => f.nodeId === 'A')!.damDaysAtMin).toBeGreaterThan(0);
		expect(Math.min(...col(base, 'B', 'transfer'))).toBeLessThan(0);
		expect(Math.max(...col(base, 'A', 'spill'))).toBeGreaterThan(0);
	});

	for (const k of [1e-3, 1e3, 1e-4, 1e6]) {
		it(`k = ${k}: m³ and m² series × k, every other series and every count and class unchanged`, () => {
			const o = runModelChecked(scaled(k));
			checksPass(o);
			expectSane(o);
			expect(o.series.map((s) => `${s.nodeId}|${s.key}`)).toEqual(base.series.map((s) => `${s.nodeId}|${s.key}`));
			// 1e-9 relative: the volumes pass through differences (a dam's room, its water above dead storage) that lose
			// a few digits; anything beyond that is a scale-dependent rule, not rounding.
			for (const s of base.series) {
				// The balance residual is float noise at any scale; it is checked against its own scale below.
				if (s.key === 'balance_residual') continue;
				const t = o.series.find((x) => x.nodeId === s.nodeId && x.key === s.key)!;
				const f = isVolume(s.unit) ? k : 1;
				const ref = Math.max(...s.values.map(Math.abs)) * f;
				for (let d = 0; d < s.values.length; d++) {
					const want = s.values[d]! * f;
					expect(Math.abs(t.values[d]! - want), `${s.nodeId}/${s.key} day ${d}`).toBeLessThanOrEqual(1e-9 * Math.max(Math.abs(want), 1e-6 * ref) + 1e-300);
				}
			}
			const a = base.summary;
			const b = o.summary;
			expect(b.catchment.ewrDaysNotMet).toBe(a.catchment.ewrDaysNotMet);
			expect(b.catchment.ewrFractionDaysNotMet).toBe(a.catchment.ewrFractionDaysNotMet);
			for (const f of a.farms) {
				const g = b.farms.find((x) => x.nodeId === f.nodeId)!;
				expect(g.fractionSupplied).toBeCloseTo(f.fractionSupplied, 9);
				expect(g.daysEwrNotMet).toBe(f.daysEwrNotMet);
				// damDaysAtMin and damFigures only exist for a dam of at least 1 m³ (§2.8); the smallest k here keeps that.
				expect(g.damDaysAtMin).toBe(f.damDaysAtMin);
				if (f.damEndM3 !== undefined) expect(g.damEndM3! / k).toBeCloseTo(f.damEndM3, 6);
			}
			for (const r of a.supplyAssurance!.reliability) {
				const s = b.supplyAssurance!.reliability.find((x) => x.nodeId === r.nodeId)!;
				expect([s.demandDays, s.metDays, s.failureRuns, s.longestFailureDays, s.waterYears, s.waterYearsMet]).toEqual([r.demandDays, r.metDays, r.failureRuns, r.longestFailureDays, r.waterYears, r.waterYearsMet]);
				expect(s.timeReliability).toBe(r.timeReliability);
				expect(s.volumetricReliability!).toBeCloseTo(r.volumetricReliability!, 9);
				expect(s.maxFailureDeficitM3 / k).toBeCloseTo(r.maxFailureDeficitM3, 6);
			}
			expect(b.supplyAssurance!.stress.system.stressClass).toEqual(a.supplyAssurance!.stress.system.stressClass);
			expect(b.ewrCompliance!.outlet.daysNotMet).toEqual(a.ewrCompliance!.outlet.daysNotMet);
			expect(b.curtailment!.equitableFraction!).toBeCloseTo(a.curtailment!.equitableFraction!, 9);
			const wa = b.supplyAssurance!.waterAccount.total;
			expect(Math.abs(wa.residualM3)).toBeLessThanOrEqual(1e-10 * wa.scaleM3);
			expect(wa.outflowM3 / k).toBeCloseTo(a.supplyAssurance!.waterAccount.total.outflowM3, 3);
			const mb = massBalance(scaled(k), o);
			expect(Math.abs(mb.residual)).toBeLessThanOrEqual(1e-10 * mb.scale);
		});
	}
});

// --- extremes in one network ---------------------------------------------------

/** Crop area (m², kc 0.8) whose January demand is `need` m³/day at e = 1. */
const janArea = (need: number) => (need * 1000 * DIM[3]!) / (0.8 * APAN[3]!);

function extremes(areaKm2: number): ModelInput {
	return {
		settings: { runoffModel: 'gr4j', apanMm: APAN as never, ewrPragmaticM3PerDay: EWR as never, effectiveRainFraction: 0, lakeEvapFactor: 0.75 } as ModelInput['settings'],
		model: {
			nodes: [
				{ ...NODE, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null },
				// A 1 m³ dam (full at the start, a 1 m² surface) taking a 10⁻⁹ m³/day demand.
				{ ...NODE, id: 'S', name: 'Small', kind: 'farm', downstreamNodeId: 'G', areaKm2, damCapacityM3: 1, damInitialPct: 1, damAreaFullM2: 1 },
				// A 10¹⁰ m³ dam (10⁹ m² surface) with dead storage, taking 10⁹ m³/day.
				{ ...NODE, id: 'L', name: 'Large', kind: 'farm', downstreamNodeId: 'S', areaKm2, damCapacityM3: 1e10, damInitialPct: 0.3, damMinPct: 0.25, damAreaFullM2: 1e9 }
			],
			crops: [{ id: 'c', name: 'Crop', cropFactor: new Array(12).fill(0.8) }],
			cropAreas: [
				{ nodeId: 'S', cropId: 'c', areaM2: janArea(1e-9) },
				{ nodeId: 'L', cropId: 'c', areaM2: janArea(1e9) }
			],
			// A transfer capped at 10⁻⁶ m³/s (0.0864 m³/day) from the large dam to the small one.
			transfers: [{ id: 't', fromNodeId: 'L', toNodeId: 'S', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxRateM3s: 1e-6, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 1 }]
		},
		series: { rain_catchment_mm: { startDate: '2000-01-01', values: rainRecord(800, 3) } }
	};
}

describe('extreme magnitudes side by side', () => {
	for (const area of [0.001, 100_000]) {
		it(`units of ${area} km² each: 1 m³ and 10¹⁰ m³ dams, 10⁻⁹ and 10⁹ m³/day demands, a 10⁻⁶ m³/s transfer`, () => {
			const i = extremes(area);
			const o = runModelChecked(i);
			checksPass(o);
			expectSane(o);
			// January demand by hand (§2.3, e = 1, no effective rain).
			const jan = o.series.length && col(o, 'S', 'demand')[0]!;
			expect(jan).toBeCloseTo(1e-9, 20);
			expect(col(o, 'L', 'demand')[0]! / 1e9).toBeCloseTo(1, 12);
			// The transfer never moves more than 10⁻⁶ m³/s × 86 400 s in a day, and nets to 0 (§2.6).
			const J = col(o, 'S', 'transfer');
			const JL = col(o, 'L', 'transfer');
			for (let t = 0; t < o.days; t++) {
				expect(J[t]!).toBeLessThanOrEqual(0.0864 * (1 + 1e-12));
				expect(J[t]! + JL[t]!).toBe(0);
			}
			// The large dam never supplies from below its dead storage (§2.7 Q5): a day it supplies, the storage it
			// started from (after its losses) plus the inflow was above 0.25 × 10¹⁰, and it never ends below that by supply.
			const Q = col(o, 'L', 'dam_storage');
			const G = col(o, 'L', 'supplied');
			const E = col(o, 'L', 'dam_evaporation');
			const Pd = col(o, 'L', 'rain_on_dam');
			const K = col(o, 'L', 'upstream_to_dam');
			const M = col(o, 'L', 'runoff_to_dam');
			let prev = 0.3e10;
			for (let t = 0; t < o.days; t++) {
				const above = prev + Pd[t]! - E[t]! + K[t]! + M[t]! + JL[t]! - 0.25e10;
				expect(Math.abs(G[t]! - Math.min(Math.max(above, 0), col(o, 'L', 'demand')[t]!))).toBeLessThanOrEqual(1e-6 + 1e-12 * 1e10);
				if (G[t]! > 0) expect(Q[t]!).toBeGreaterThanOrEqual(0.25e10 * (1 - 1e-12));
				prev = Q[t]!;
			}
			// The 10⁻⁹ m³/day demand is served in full on every day: a 1 m³ full dam with a 0.0864 m³/day top-up can't fail it.
			const rS = o.summary.supplyAssurance!.reliability.find((x) => x.nodeId === 'S')!;
			expect(rS.metDays).toBe(rS.demandDays);
			expect(rS.timeReliability).toBe(1);
			// The 10⁹ m³/day demand outruns any inflow, so it fails on most days but is a real number of days, never NaN.
			const rL = o.summary.supplyAssurance!.reliability.find((x) => x.nodeId === 'L')!;
			expect(rL.metDays).toBeLessThan(rL.demandDays);
			expect(Number.isFinite(rL.volumetricReliability!)).toBe(true);
			// A dam of exactly 1 m³ is a dam for the farm summary's dam figures (capacity ≥ 1 m³, §2.8).
			const fS = o.summary.farms.find((x) => x.nodeId === 'S')!;
			expect(fS.damEndM3).toBe(col(o, 'S', 'dam_storage').at(-1));
			expect(fS.damEndM3!).toBeLessThanOrEqual(1);
			const mb = massBalance(i, o);
			expect(Math.abs(mb.residual)).toBeLessThanOrEqual(1e-10 * mb.scale);
			const wa = o.summary.supplyAssurance!.waterAccount;
			for (const y of [...wa.years, wa.total]) expect(Math.abs(y.residualM3)).toBeLessThanOrEqual(1e-10 * y.scaleM3);
		});
	}

	it('a 10⁻⁹ m³/day demand from a dam at dead storage is not "served in full" by float noise', () => {
		// Natural flow 0: the small dam sits exactly at its dead storage, so the tiny demand gets nothing.
		const i = extremes(1);
		i.model.nodes[1] = { ...i.model.nodes[1]!, damInitialPct: 0.5, damMinPct: 0.5 } as NetworkNode;
		i.model.transfers = [];
		i.settings.lakeEvapFactor = 0;
		const n = 40;
		i.series = { rain_catchment_mm: { startDate: '2000-01-01', values: new Array(n).fill(0) } };
		const o = withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: new Array(n).fill(0) })));
		checksPass(o);
		expect(col(o, 'S', 'supplied')).toEqual(new Array(n).fill(0));
		const r = o.summary.supplyAssurance!.reliability.find((x) => x.nodeId === 'S')!;
		expect([r.metDays, r.demandDays, r.failureRuns, r.longestFailureDays]).toEqual([0, n, 1, n]);
		expect(r.volumetricReliability).toBe(0);
	});
});
