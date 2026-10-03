// End to end: the uncertainty ensemble (docs/model.md §2.10e), sensitivity
// runs (§2.10g), recession diagnostics (§2.10d, CR-13), the gauge-vs-logger
// agreement and the double-mass check (§2.10a), on synthetic catchments and
// records built here. Invented names and values only (the repo is public).
import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearOf } from '../calendar';
import { kgePrime } from '../calibrate/objective';
import { pettittP, doubleMass } from '../doublemass';
import type { ModelInput, NetworkNode } from '../project';
import { observedAgreement } from '../quality';
import { Rng } from '../random';
import { fitRecession, recessionPoints, recessionSegments } from '../recession';
import { runModel } from '../run';
import { resolveEnsembleOptions, runEnsemble, summariseEnsemble, type MemberMetrics } from '../uncertainty/ensemble';
import { band } from '../uncertainty/bands';
import { sensitivityRuns } from '../uncertainty/sensitivity';

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
	lossReturnFraction: 0,
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
const START = '2002-10-01';
const TRUTH = { x1: 420, x2: 0, x3: 85, x4: 2.3 };
const series = (out: ReturnType<typeof runModel>, key: string, nodeId: string | null = null) => out.series.find((s) => s.key === key && s.nodeId === nodeId)?.values;

/** Invented "Witdraai": a farm with a dam to the outlet gauge, observed = truth run; the project's parameters ARE the truth. */
function witdraai(): ModelInput {
	const days = Math.round(5 * 365.25);
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { ...TRUTH, warmupDays: 365 } },
		model: {
			nodes: [
				node({ id: 'G', name: 'Witdraai weir', kind: 'gauge' }),
				node({ id: 'F', name: 'Farm Wit', downstreamNodeId: 'G', areaKm2: 35, damCapacityM3: 150_000, damInitialPct: 0.5, pctRunoffToDam: 0.5, damAreaFullM2: 30_000 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: rain(days, START, 61) } }
	};
	input.series.flow_observed_m3s = { startDate: START, values: series(runModel(input), 'simulated_outflow')!.map((v) => v / SEC) };
	return input;
}

describe('uncertainty ensemble (§2.10e)', () => {
	const input = witdraai();
	const { options } = resolveEnsembleOptions(input, { members: 40, seed: 11 });
	const result = runEnsemble(input, options);
	const summary = summariseEnsemble(result);

	it("member 0 is the run itself: the project's parameters, and its metrics equal a plain run's", () => {
		const m0 = result.members[0]!;
		expect(m0.reference).toBe(true);
		expect(m0.params).toMatchObject(TRUTH);
		expect(m0.panOffset).toBe(0);
		expect(m0.accepted).toBe(true);
		const out = runModel(input);
		expect(m0.metrics!.ewrDaysNotMet).toBe(out.summary.catchment.ewrDaysNotMet);
		const nat = series(out, 'natural_flow')!;
		const mar = (nat.reduce((a, b) => a + b, 0) / nat.length) * 365.25 / 1e6;
		expect(m0.metrics!.marNaturalMm3).toBeCloseTo(mar, 4);
	});

	it("member 0's skill is KGE′ on the scored days before the split date (the median scored day), computed by hand", () => {
		const obs = input.series.flow_observed_m3s!.values;
		const scored = obs.flatMap((v, t) => (v !== null && Number.isFinite(v) && v >= 0 ? [t] : []));
		const split = scored[Math.floor(scored.length / 2)]!;
		const acc = scored.filter((t) => t < split);
		const sim = series(runModel(input), 'simulated_outflow')!;
		const k = kgePrime(acc.map((t) => obs[t]! * SEC), acc.map((t) => sim[t]!))!;
		expect(result.members[0]!.scores.skill!).toBeCloseTo(k, 5);
		const d0 = toEpochDay(START);
		expect(result.header.splitDate).toBe(new Date((d0 + split) * 86_400_000).toISOString().slice(0, 10));
	});

	it("when the run's own parameters pass, every band's [min, max] contains the run (the documented guarantee)", () => {
		expect(summary.referenceAccepted).toBe(true);
		const ref = summary.reference!;
		const holds = (b: ReturnType<typeof band>, x: number | null | undefined, what: string) => {
			if (x === null || x === undefined || b.n === 0) return;
			expect(b.min!, what).toBeLessThanOrEqual(x + 1e-9 * Math.max(1, Math.abs(x)));
			expect(b.max!, what).toBeGreaterThanOrEqual(x - 1e-9 * Math.max(1, Math.abs(x)));
		};
		const b = summary.bands;
		holds(b.ewrDaysNotMet, ref.ewrDaysNotMet, 'ewrDaysNotMet');
		b.ewrDaysNotMetByMonth.forEach((x, i) => holds(x, ref.ewrDaysNotMetByMonth[i], `month ${i}`));
		holds(b.shortfallMm3, ref.shortfallMm3, 'shortfall');
		holds(b.marNaturalMm3, ref.marNaturalMm3, 'MAR natural');
		holds(b.marOutflowMm3, ref.marOutflowMm3, 'MAR outflow');
		b.annual.forEach((y, i) => {
			holds(y.natural, ref.annualNaturalMm3[i], `natural ${y.waterYear}`);
			holds(y.outflow, ref.annualOutflowMm3[i], `outflow ${y.waterYear}`);
		});
		b.curtailment.forEach((c) => holds(c.band, ref.curtailmentM3Day[c.nodeId], `curtailment ${c.name}`));
		b.fdc.forEach((m, i) => m.points.forEach((p, j) => holds(p, ref.fdcM3Day[(m.month + 2) % 12]?.[j], `fdc ${i}/${j}`)));
		holds(b.noFlowDays!, ref.noFlowDays, 'noFlowDays');
	});

	it('bands are type-7 percentiles of the kept members only; the 30-member gate holds', () => {
		const kept = result.members.filter((m) => m.accepted).map((m) => m.metrics!) as MemberMetrics[];
		expect(summary.accepted).toBe(kept.length);
		const v = kept.map((m) => m.marNaturalMm3).sort((a, b) => a - b);
		const q = (p: number) => {
			const h = ((v.length - 1) * p) / 100;
			const i = Math.floor(h);
			return i >= v.length - 1 ? v[v.length - 1]! : v[i]! + (h - i) * (v[i + 1]! - v[i]!);
		};
		if (kept.length >= 30) {
			expect(summary.bands.marNaturalMm3.p5!).toBeCloseTo(q(5), 9);
			expect(summary.bands.marNaturalMm3.p95!).toBeCloseTo(q(95), 9);
		} else {
			expect(summary.bands.marNaturalMm3.p5).toBeNull();
			expect(summary.gated).toBe(true);
		}
		// Every rejected member fails at least one threshold, every kept one none.
		for (const m of result.members) expect(m.accepted).toBe(m.rejected.length === 0);
	});

	it('is deterministic for its options', () => {
		expect(runEnsemble(input, options)).toEqual(result);
	});
});

describe('sensitivity runs (§2.10g)', () => {
	it('the central run is the plain run, and the envelope is min/max over the central and every low/high', () => {
		const input = witdraai();
		const r = sensitivityRuns(input);
		const out = runModel(input);
		const outlet = out.summary.curtailment!.ewrSites!.find((s) => s.isOutlet)!;
		expect(r.central[0]!.daysNotMet).toBe(outlet.daysNotMet);
		const all = [r.central[0]!, ...r.factors.flatMap((f) => [f.low.values[0]!, f.high.values[0]!])];
		const v = r.verdicts[0]!;
		const metric = v.metric;
		const xs = all.map((x) => x[metric]).filter((x): x is number => x !== null);
		expect(v.min).toBe(Math.min(...xs));
		expect(v.max).toBe(Math.max(...xs));
		expect(v.verdict).toBe(v.min! >= v.threshold ? 'meets' : v.max! < v.threshold ? 'fails' : 'notDeterminable');
		// More rain never gives more days not met at the outlet.
		const rainF = r.factors.find((f) => f.factor === 'rain')!;
		expect(rainF.high.values[0]!.daysNotMet).toBeLessThanOrEqual(rainF.low.values[0]!.daysNotMet);
	});
});

describe('recession diagnostics (§2.10d, CR-13)', () => {
	/** Storms every 40 days, each followed by a dry recession −dQ/dt = a·Q^b (exact solution). */
	function record(a: number, b: number, n = 40 * 12) {
		const q: number[] = [];
		const r: number[] = [];
		for (let t = 0; t < n; t++) {
			const k = t % 40;
			r.push(k === 0 ? 30 : 0);
			const q0 = 5 + (Math.floor(t / 40) % 3); // peaks vary a little
			const tau = k; // days since the storm
			q.push(b === 1 ? q0 * Math.exp(-a * tau) : (q0 ** (1 - b) + a * (b - 1) * tau) ** (1 / (1 - b)));
		}
		return { q, r };
	}

	it('segments: the first step after a storm day never counts, so each segment runs from two days after the storm to the day before the next', () => {
		const { q, r } = record(0.05, 1);
		const seg = recessionSegments({ flowM3s: q, rainMm: r });
		// Storm on day 40k: steps 40k → 40k+1 (rain on 40k) excluded; peak 40k+1, segment [40k+2, 40k+39].
		expect(seg.length).toBe(12);
		seg.forEach(([s, e], k) => {
			expect(s).toBe(40 * k + 2);
			expect(e).toBe(Math.min(40 * k + 39, q.length - 1));
		});
	});

	it('BN on an exponential recession: b = 1 and a = 2(1 − k)/(1 + k) exactly', () => {
		const { q, r } = record(0.05, 1);
		const fit = fitRecession(recessionPoints(q, recessionSegments({ flowM3s: q, rainMm: r }), 'BN'))!;
		const k = Math.exp(-0.05);
		expect(fit.b).toBeCloseTo(1, 9);
		expect(fit.a).toBeCloseTo((2 * (1 - k)) / (1 + k), 9);
	});

	it('ETS (the default) recovers a non-linear store: b within 0.1 of 1.5', () => {
		const { q, r } = record(0.02, 1.5);
		const fit = fitRecession(recessionPoints(q, recessionSegments({ flowM3s: q, rainMm: r }), 'ETS'))!;
		expect(Math.abs(fit.b - 1.5)).toBeLessThan(0.1);
	});

	it('excluded days and a wet day inside a recession split it as documented', () => {
		const { q, r } = record(0.05, 1, 80);
		const ex = new Uint8Array(80);
		ex[20] = 1;
		const seg = recessionSegments({ flowM3s: q, rainMm: r, excluded: ex });
		// 0–19 then 21–39: [2, 19] (peak 1, end 19), and peak 21 → [22, 39].
		expect(seg.slice(0, 2)).toEqual([
			[2, 19],
			[22, 39]
		]);
	});
});

describe('gauge vs logger agreement (§2.10a)', () => {
	it('flags exactly the water years whose volume ratio is outside 2/3 … 3/2 on ≥ 90 shared days', () => {
		const start = '2005-10-01';
		const d0 = toEpochDay(start);
		const n = toEpochDay('2009-10-01') - d0; // WY 2005 … 2008
		const gauge: (number | null)[] = Array.from({ length: n }, (_, t) => 1 + Math.sin(t / 30) ** 2);
		const logger: (number | null)[] = gauge.map((v, t) => {
			const wy = waterYearOf(d0 + t);
			if (wy === 2006) return v! * 0.5; // reads half: flagged
			if (wy === 2007) return t % 5 === 0 ? v! * 0.5 : null; // half too, but only ~73 shared days: not judged
			if (wy === 2008) return v! * 1.4; // inside the band
			return v;
		});
		logger[3] = -2; // a negative reading isn't a shared day
		const ag = observedAgreement({ flow_observed_m3s: { startDate: start, values: gauge }, flow_logger_m3s: { startDate: start, values: logger } })!;
		expect(ag.flaggedYears).toEqual([2006]);
		const y5 = ag.years.find((y) => y.waterYear === 2005)!;
		expect(y5.days).toBe(365 - 1);
		const y7 = ag.years.find((y) => y.waterYear === 2007)!;
		expect(y7.days).toBeLessThan(90);
		expect(y7.flagged).toBe(false);
		const y8 = ag.years.find((y) => y.waterYear === 2008)!;
		expect(y8.ratio!).toBeCloseTo(1 / 1.4, 12);
	});
});

describe('double mass of catchment rain against CHIRPS (§2.10a)', () => {
	it('Pettitt p matches 2·exp(−6K²/(T³ + T²)) with K = max |U_t|', () => {
		const xs = [1, 1.1, 0.9, 1, 1.05, 1.5, 1.6, 1.4, 1.55, 1.5, 1.45];
		const n = xs.length;
		let k = 0;
		for (let t = 0; t < n - 1; t++) {
			let u = 0;
			for (let i = 0; i <= t; i++) for (let j = t + 1; j < n; j++) u += Math.sign(xs[i]! - xs[j]!);
			k = Math.max(k, Math.abs(u));
		}
		expect(pettittP(xs)).toBeCloseTo(Math.min(1, 2 * Math.exp((-6 * k * k) / (n ** 3 + n ** 2))), 12);
	});

	it('a 40 % rise in the catchment / CHIRPS ratio after year 10 of 20 is found at that year with that change', () => {
		const start = '1990-10-01';
		const d0 = toEpochDay(start);
		const n = toEpochDay('2010-10-01') - d0;
		const chirps = rain(n, start, 71).map((v) => v + 0.2); // never a zero run
		const rng = new Rng(4);
		const catchment = chirps.map((v, t) => v * (waterYearOf(d0 + t) >= 2000 ? 1.4 : 1) * (0.98 + 0.04 * rng.next()));
		const dm = doubleMass({ rain_catchment_mm: { startDate: start, values: catchment }, rain_chirps_mm: { startDate: start, values: chirps } })!;
		expect(dm.years).toHaveLength(20);
		expect(dm.breaks).toHaveLength(1);
		expect(dm.breaks[0]!.afterWaterYear).toBe(1999);
		expect(dm.breaks[0]!.change).toBeCloseTo(0.4, 1);
		// Departure from the whole-record line ends at 0 by construction.
		expect(dm.years[dm.years.length - 1]!.residualPct!).toBeCloseTo(0, 9);
	});
});
