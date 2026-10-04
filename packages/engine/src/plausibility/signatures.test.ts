// Validation signatures (engine ≥ 1.55.0, docs/model.md §2.10d "Validation
// signatures", calibration-research.md CR-16): BFI by two filters, the
// low-flow FDC's slope and bias, and the skill on withheld recession segments.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { fdcSignatures } from '../calibrate/objective';
import { gaugeSeriesKey, type Gr4jSettings, type ModelInput, type NetworkNode } from '../project';
import { Rng } from '../random';
import type { RecessionSegment } from '../recession/segments';
import { ECKHARDT_FILTER, filterBaseflow, HUGHES_FILTER } from '../reserve/baseflow';
import { runModel } from '../run';
import {
	BFI_MIN_RUN_DAYS,
	baseflowSignature,
	FDC_LOW_WARN_PCT,
	HOLDOUT_EVERY,
	isHeldOut,
	lowFlowFdcSignature,
	recessionHoldout,
	recessionLawFlow,
	SIGNATURE_MIN_DAYS,
	signatureWarnings,
	validationSignatures,
	type ValidationSignatures
} from './signatures';

const none = (n: number) => new Uint8Array(n);

describe('baseflowSignature', () => {
	it('a steady river: BFI 1 by Hughes (all base flow), BFImax by Eckhardt (its steady state)', () => {
		const q = new Array(400).fill(3);
		const b = baseflowSignature(q, q, none(400))!;
		expect(b.days).toBe(400);
		expect(b.runs).toBe(1);
		expect(b.hughes!.observed).toBeCloseTo(1, 12);
		expect(b.eckhardt!.observed).toBeCloseTo(ECKHARDT_FILTER.bfiMax, 12);
		expect(b.hughes!.difference).toBe(0);
		expect(b.withinLimit).toBe(true);
		expect(b.hughesFilter).toEqual(HUGHES_FILTER);
		expect(b.eckhardtFilter).toEqual(ECKHARDT_FILTER);
	});

	it('is Σ base flow ÷ Σ flow over each stretch of scored days, the simulated flow on the same stretches', () => {
		const rng = new Rng(16);
		const n = 500;
		const obs: (number | null)[] = Array.from({ length: n }, () => rng.logFloat(0.01, 20));
		const sim = Array.from({ length: n }, () => rng.logFloat(0.01, 20));
		// A 10-day gap (too short a stretch either side of it? no: 200 and 290 days) and an excluded 5-day stretch at the end.
		for (let t = 200; t < 210; t++) obs[t] = null;
		const excluded = none(n);
		for (let t = 495; t < 500; t++) excluded[t] = 1;
		const b = baseflowSignature(obs, sim, excluded)!;
		expect(b.runs).toBe(2);
		expect(b.days).toBe(200 + 285);
		const by = (x: ArrayLike<number>) => {
			let base = 0;
			let q = 0;
			for (const [s, e] of [
				[0, 199],
				[210, 494]
			] as const) {
				const chunk = Array.from({ length: e - s + 1 }, (_, i) => x[s + i]!);
				const f = filterBaseflow(chunk, HUGHES_FILTER);
				for (let i = 0; i < chunk.length; i++) {
					base += f[i]!;
					q += chunk[i]!;
				}
			}
			return base / q;
		};
		expect(b.hughes!.observed).toBeCloseTo(by(obs as number[]), 12);
		expect(b.hughes!.simulated).toBeCloseTo(by(sim), 12);
	});

	it('leaves out stretches shorter than BFI_MIN_RUN_DAYS, and needs a year of days', () => {
		expect(BFI_MIN_RUN_DAYS).toBe(30);
		expect(SIGNATURE_MIN_DAYS).toBe(365);
		// Every 20th day missing: every stretch is 19 days, none counts.
		const q = Array.from({ length: 1000 }, (_, t) => (t % 20 === 19 ? null : 1));
		expect(baseflowSignature(q, new Array(1000).fill(1), none(1000))).toBeNull();
		expect(baseflowSignature(new Array(364).fill(1), new Array(364).fill(1), none(364))).toBeNull();
	});

	it('by hand on a step: flow 1 then 2 m³/s, against a steady 1.5 (BFI 1 by Hughes, BFImax by Eckhardt)', () => {
		const n = 400;
		const obs = Array.from({ length: n }, (_, t) => (t < 200 ? 1 : 2));
		const b = baseflowSignature(obs, new Array(n).fill(1.5), none(n))!;
		expect([b.days, b.runs]).toEqual([400, 1]);
		// Hughes (α 0.995, β 0.5, one forward pass): quick flow is 0 on the steady days, jumps to
		// β(1 + α)·1 = 0.9975 at the step and decays by α a day after it. The start's reflection is
		// all 1s and the end's lies after the days scored, so neither moves it.
		const quick = (0.9975 * (1 - 0.995 ** 200)) / (1 - 0.995);
		const total = 200 * 1 + 200 * 2;
		expect(b.hughes!.observed).toBeCloseTo(1 - quick / total, 12);
		expect(b.hughes!.simulated).toBeCloseTo(1, 12);
		expect(b.hughes!.difference).toBeCloseTo(quick / total, 12);
		// Eckhardt (a 0.98, BFImax B 0.25): b_t = c1·b_{t−1} + c2·Q_t with c1 = (1 − B)a ÷ (1 − aB), steady state B·Q, so
		// B·1 before the step and 2B − B·c1^(k+1) on the k-th day after it.
		const B = 0.25;
		const c1 = ((1 - B) * 0.98) / (1 - 0.98 * B);
		let base = 200 * B;
		for (let k = 0; k < 200; k++) base += 2 * B - B * c1 ** (k + 1);
		expect(b.eckhardt!.observed).toBeCloseTo(base / total, 12);
		expect(b.eckhardt!.simulated).toBeCloseTo(B, 12);
		// Hughes' difference, 0.21, is beyond ±0.15: the pair is outside the limit even though Eckhardt's is inside.
		expect(Math.abs(b.eckhardt!.difference)).toBeLessThan(0.15);
		expect(b.hughes!.difference).toBeGreaterThan(0.15);
		expect(b.withinLimit).toBe(false);
	});

	it('zero flow: no BFI (nothing to divide), not a pass or a fail', () => {
		const b = baseflowSignature(new Array(400).fill(0), new Array(400).fill(1), none(400))!;
		expect(b.days).toBe(400);
		expect([b.hughes, b.eckhardt, b.withinLimit]).toEqual([null, null, null]);
		// A dry model against a flowing river is the same: the simulated sum is zero.
		expect(baseflowSignature(new Array(400).fill(1), new Array(400).fill(0), none(400))!.hughes).toBeNull();
	});

	it('gaps split the record into stretches; a stretch under 30 days is left out, the simulated flow with it', () => {
		const n = 460;
		const obs: (number | null)[] = Array.from({ length: n }, (_, t) => 1 + (t % 9));
		obs[400] = null;
		const a = baseflowSignature(obs, obs.map((v) => v ?? 99), none(n))!;
		// [0, 399] and [401, 459]: 400 + 59 days.
		expect([a.days, a.runs]).toEqual([459, 2]);
		obs[430] = null;
		// [401, 429] and [431, 459] are 29 days each: only [0, 399] counts, and the simulated 99 on the gap days never enters.
		const b = baseflowSignature(obs, obs.map((v) => v ?? 99), none(n))!;
		expect([b.days, b.runs]).toEqual([400, 1]);
		expect(b.hughes!.difference).toBeCloseTo(0, 12);
		expect(b.eckhardt!.difference).toBeCloseTo(0, 12);
		// 365 days in stretches is enough; 364 isn't.
		expect(baseflowSignature(new Array(365).fill(1), new Array(365).fill(1), none(365))).not.toBeNull();
	});

	it('invariants on random records: 0 ≤ BFI ≤ 1 by both filters', () => {
		const rng = new Rng(1502);
		for (let k = 0; k < 40; k++) {
			const n = rng.int(365, 900);
			const obs = Array.from({ length: n }, () => (rng.bool(0.02) ? null : rng.bool(0.1) ? 0 : rng.logFloat(1e-4, rng.bool(0.05) ? 1e4 : 10)));
			const sim = Array.from({ length: n }, () => (rng.bool(0.1) ? 0 : rng.logFloat(1e-4, 100)));
			const b = baseflowSignature(obs, sim, none(n));
			if (!b) continue;
			for (const p of [b.hughes, b.eckhardt]) {
				if (!p) continue;
				for (const v of [p.observed, p.simulated]) {
					expect(v).toBeGreaterThanOrEqual(0);
					expect(v).toBeLessThanOrEqual(1);
				}
			}
		}
	});
});

describe('lowFlowFdcSignature', () => {
	// 399 days of 1 … 399 m³/s: Weibull positions i ÷ 400, so Q70 is the 280th highest (120) and Q95 the 380th (20).
	const obs = Array.from({ length: 399 }, (_, i) => i + 1);

	it('by hand: slope ln(Q70 ÷ Q95) ÷ 0.25; the bias as Yilmaz et al.’s %BiasFMS', () => {
		const same = lowFlowFdcSignature(obs, obs.map((q) => 2 * q), none(399))!;
		expect(same.observedQ70M3s).toBe(120);
		expect(same.observedQ95M3s).toBe(20);
		expect(same.observedSlope).toBeCloseTo(Math.log(6) / 0.25, 12);
		// Doubling every flow moves the curve, not its slope.
		expect(same.simulatedSlope).toBeCloseTo(same.observedSlope, 12);
		expect(same.slopeBiasPct).toBeCloseTo(0, 9);
		expect(same.lowVolumeBiasPct).toBe(fdcSignatures(obs, obs.map((q) => 2 * q)).fdcLowPct);
		expect(same.range).toEqual([70, 95]);
		// Q^0.4: every log flow × 0.4, so the slope is 60 % flatter.
		const flat = lowFlowFdcSignature(obs, obs.map((q) => q ** 0.4), none(399))!;
		expect(flat.slopeBiasPct).toBeCloseTo(-60, 9);
		expect(flat.withinLimit).toBe(false);
	});

	it('floors flows at 0.001 m³/s, and has no bias when the observed slope is flat', () => {
		const dry = new Array(400).fill(0);
		const s = lowFlowFdcSignature(dry, new Array(400).fill(0.5), none(400))!;
		expect(s.observedSlope).toBe(0);
		expect(s.slopeBiasPct).toBeNull();
	});

	it('no slope bias where either curve is at the 0.001 m³/s floor at Q95: the floored slope would measure the floor', () => {
		// A model that dries out: its curve floors flat, which is not a flatter river; %BiasFLV judges it instead.
		const dry = lowFlowFdcSignature(obs, new Array(399).fill(0), none(399))!;
		expect([dry.simulatedQ70M3s, dry.simulatedQ95M3s, dry.simulatedSlope]).toEqual([0, 0, 0]);
		expect(dry.slopeBiasPct).toBeNull();
		// An intermittent river and a model that both stop at Q95, with Q70 either side of the floor
		// (the example Sandspruit: 0.00104 against 0.00077 m³/s): the same curve, not −100 % apart.
		const river = obs.map((_, i) => (i < 30 ? 0 : 0.00104 * (1 + i / 400)));
		const model = obs.map((_, i) => (i < 30 ? 0 : 0.00077 * (1 + i / 400)));
		const i = lowFlowFdcSignature(river, model, none(399))!;
		expect([i.observedQ95M3s, i.simulatedQ95M3s]).toEqual([0, 0]);
		expect(i.observedSlope).toBeGreaterThan(0);
		expect(i.slopeBiasPct).toBeNull();
		// Just above the floor on both curves it is computed: a steeper simulated curve, Q², doubles every log flow, so +100 %.
		expect(lowFlowFdcSignature(obs, obs.map((q) => q * q), none(399))!.slopeBiasPct).toBeCloseTo(100, 9);
	});

	it('leaves excluded and missing days out, and needs a year of them', () => {
		const withGap: (number | null)[] = [...obs, null, null];
		const ex = none(401);
		ex[0] = 1;
		expect(lowFlowFdcSignature(withGap, new Array(401).fill(1), ex)!.days).toBe(398);
		expect(lowFlowFdcSignature(obs.slice(0, 364), obs.slice(0, 364), none(364))).toBeNull();
	});
});

describe('recessionHoldout', () => {
	it('holds out every third segment in date order, the same every time', () => {
		expect(HOLDOUT_EVERY).toBe(3);
		expect([0, 1, 2, 3, 4, 5, 6, 7, 8].filter(isHeldOut)).toEqual([2, 5, 8]);
		const segs: RecessionSegment[] = Array.from({ length: 9 }, (_, i) => [i * 10, i * 10 + 6]);
		const q = Array.from({ length: 90 }, (_, t) => 10 * Math.exp(-0.1 * (t % 10)));
		const h = recessionHoldout(q, q, segs);
		expect(h.heldOut).toEqual([segs[2], segs[5], segs[8]]);
		expect(recessionHoldout(q, q, segs)).toEqual(h);
	});

	it('skill by hand, against no recession: the same fall scores 1, a flat line 0, a rise −3', () => {
		// One segment, held out as the third; obs 8 → 4 → 2, ln falls −ln 2, −2 ln 2.
		const segs: RecessionSegment[] = [
			[0, 2],
			[3, 5],
			[6, 8]
		];
		const obs = [8, 4, 2, 8, 4, 2, 8, 4, 2];
		const skill = (sim: number[]) => recessionHoldout(obs, [...obs.slice(0, 6), ...sim], segs).modelSkill;
		expect(skill([4, 2, 1])).toBeCloseTo(1, 12);
		expect(skill([8, 8, 8])).toBeCloseTo(0, 12);
		// Rise ln 2, 2 ln 2: errors 2 ln 2 and 4 ln 2 → 1 − 20 ÷ 5.
		expect(skill([1, 2, 4])).toBeCloseTo(-3, 12);
		// A zero day leaves the segment out of the model's score.
		const h = recessionHoldout(obs, [...obs.slice(0, 6), 1, 0, 1], segs);
		expect([h.modelSegments, h.modelSkill, h.days]).toEqual([0, null, 2]);
	});

	it('pools the held-out segments: Σ over all their days, not a mean of per-segment skills; log RMSE by hand', () => {
		// Six 8-day segments (days 1–7 after each start scored), starting at different flows; the 3rd and 6th are held out.
		const segs: RecessionSegment[] = Array.from({ length: 6 }, (_, i) => [i * 8, i * 8 + 7]);
		const rate = [0.1, 0.1, 0.1, 0.1, 0.1, 0.2];
		const obs = Array.from({ length: 48 }, (_, t) => (1 + Math.floor(t / 8)) * Math.exp(-rate[Math.floor(t / 8)]! * (t % 8)));
		// Simulated: rate 0.2 on both held-out segments (and anything elsewhere).
		const sim = Array.from({ length: 48 }, (_, t) => 3 * Math.exp(-0.2 * (t % 8)));
		const h = recessionHoldout(obs, sim, segs);
		expect(h.heldOut).toEqual([segs[2], segs[5]]);
		expect([h.days, h.modelSegments, h.modelDays]).toEqual([14, 2, 14]);
		// Errors: 0.1·τ on the first, 0 on the second; Σ τ² = 140. Σ err² = 0.01·140, Σ obs² = 0.01·140 + 0.04·140:
		// a skill of 0.8, where the mean of the two segments' own skills (0 and 1) would be 0.5.
		expect(h.modelSkill).toBeCloseTo(1 - 1.4 / 7, 12);
		expect(h.modelLogRmse).toBeCloseTo(Math.sqrt(1.4 / 14), 12);
		// Six segments: under RECESSION_MIN_SEGMENTS, so reported but not judged.
		expect(h.agrees).toBeNull();
		// The law is scored on the same days from the segment's first observed flow.
		const law = h.law!;
		let ssLaw = 0;
		for (const [s] of h.heldOut) {
			for (let tau = 1; tau <= 7; tau++) ssLaw += (Math.log(recessionLawFlow(law, obs[s]!, tau) / obs[s]!) - Math.log(obs[s + tau]! / obs[s]!)) ** 2;
		}
		expect(h.lawSkill).toBeCloseTo(1 - ssLaw / 7, 12);
		expect(h.lawLogRmse).toBeCloseTo(Math.sqrt(ssLaw / 14), 12);
		// Fitted on the 0.1-a-day segments alone, it follows the first held-out segment, not the second.
		expect(law.b).toBeCloseTo(1, 1);
		// A zero simulated day in one held-out segment drops that segment from the model's score only.
		const dry = [...sim];
		dry[20] = 0;
		const d = recessionHoldout(obs, dry, segs);
		expect([d.days, d.modelSegments, d.modelDays]).toEqual([14, 1, 7]);
		expect(d.modelSkill).toBeCloseTo(1, 12);
	});

	it('no segments: nothing held out, nothing scored, not judged', () => {
		expect(recessionHoldout([1, 2, 3], [1, 2, 3], [])).toEqual({
			every: HOLDOUT_EVERY,
			segments: 0,
			heldOut: [],
			law: null,
			days: 0,
			modelSegments: 0,
			modelDays: 0,
			modelSkill: null,
			lawSkill: null,
			modelLogRmse: null,
			lawLogRmse: null,
			agrees: null
		});
	});

	it('the law −dQ/dt = a·Q^b, solved exactly', () => {
		expect(recessionLawFlow({ a: 0.1, b: 1 }, 5, 3)).toBeCloseTo(5 * Math.exp(-0.3), 14);
		// b = 2: 1/Q = 1/Q0 + a·t.
		expect(recessionLawFlow({ a: 0.5, b: 2 }, 2, 4)).toBeCloseTo(1 / (0.5 + 2), 14);
		// b = 0.5: √Q = √Q0 − a·t ÷ 2, zero once that reaches 0.
		expect(recessionLawFlow({ a: 1, b: 0.5 }, 4, 2)).toBeCloseTo(1, 14);
		expect(recessionLawFlow({ a: 1, b: 0.5 }, 4, 5)).toBe(0);
	});

	it('exponential recessions: the law fitted on the other segments predicts the held-out ones; judged from 8 segments', () => {
		const segs: RecessionSegment[] = Array.from({ length: 9 }, (_, i) => [i * 12, i * 12 + 9]);
		const q = Array.from({ length: 108 }, (_, t) => (1 + (Math.floor(t / 12) % 4)) * Math.exp(-0.08 * (t % 12)));
		const h = recessionHoldout(q, q, segs);
		expect(h.law!.b).toBeCloseTo(1, 1);
		expect(h.lawSkill!).toBeGreaterThan(0.95);
		expect(h.modelSkill).toBeCloseTo(1, 12);
		expect(h.agrees).toBe(true);
		// A flat simulation: skill 0, not below the limit.
		expect(recessionHoldout(q, new Array(108).fill(1), segs).agrees).toBe(true);
		// A rising one fails.
		expect(recessionHoldout(q, Array.from({ length: 108 }, (_, t) => 1 + (t % 12)), segs).agrees).toBe(false);
		// Seven segments: reported, not judged.
		expect(recessionHoldout(q, Array.from({ length: 108 }, (_, t) => 1 + (t % 12)), segs.slice(0, 7)).agrees).toBeNull();
	});
});

describe('signatureWarnings', () => {
	const base: ValidationSignatures = { flowKind: 'flow_observed_m3s', baseflow: null, lowFlowFdc: null, recessionHoldout: null };

	it('none when every signature is within its limit or not computed', () => {
		expect(signatureWarnings(null)).toEqual([]);
		expect(signatureWarnings(base)).toEqual([]);
	});

	it('names the site, the filter that is off, and the FDC bias', () => {
		const q = Array.from({ length: 400 }, (_, i) => i + 1);
		const sig: ValidationSignatures = {
			...base,
			siteNodeId: 'H',
			siteName: 'Weir',
			baseflow: {
				hughesFilter: { ...HUGHES_FILTER },
				eckhardtFilter: { ...ECKHARDT_FILTER },
				days: 400,
				runs: 1,
				hughes: { observed: 0.6, simulated: 0.3, difference: -0.3 },
				eckhardt: { observed: 0.2, simulated: 0.22, difference: 0.02 },
				withinLimit: false
			},
			lowFlowFdc: lowFlowFdcSignature(q, q.map((v) => v ** 0.4), none(400))
		};
		const w = signatureWarnings(sig);
		expect(w).toHaveLength(2);
		expect(w[0]).toContain('of the observed gauge record at gauge "Weir"');
		expect(w[0]).toContain('0.30 simulated against 0.60 observed by the Hughes et al. (2003) filter');
		expect(w[0]).not.toContain('Eckhardt');
		expect(w[0]).toContain('too little of its flow as slow base flow');
		expect(w[1]).toContain('flatter simulated than observed (slope bias −60 %');
		expect(w[1]).toContain(`beyond ±${FDC_LOW_WARN_PCT} %`);
	});
});

// End to end: a run's signatures follow the scored record (settings.calibrationSiteNodeId).
const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const START = '1990-10-01';
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

/** Farm A drains to the inner gauge H, then the outlet G; farm B straight to G. H's record is its own simulated flow; the outlet's is another parameter set's. */
function network(): ModelInput {
	const days = Math.round(5 * 365.25);
	const rng = new Rng(11);
	const d0 = toEpochDay(START);
	const rain = Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		return rng.bool([5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08) ? Math.round(rng.logFloat(0.5, 40) * 10) / 10 : 0;
	});
	const params: Gr4jSettings = { x1: 520, x2: 0, x3: 110, x4: 2.3, warmupDays: 365 };
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: params },
		model: {
			nodes: [
				node({ id: 'G', name: 'Outlet', kind: 'gauge' }),
				node({ id: 'H', name: 'Weir', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 1 }),
				node({ id: 'A', name: 'Farm A', downstreamNodeId: 'H', areaKm2: 40, sortOrder: 2 }),
				node({ id: 'B', name: 'Farm B', downstreamNodeId: 'G', areaKm2: 60, sortOrder: 3 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: rain } }
	};
	const at = (out: ReturnType<typeof runModel>, nodeId: string | null, key: string) => out.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
	const truth = runModel(input);
	input.series[gaugeSeriesKey('flow_observed_m3s', 'H')] = { startDate: START, values: at(truth, 'H', 'outflow').map((q) => q / 86_400) };
	const other = runModel({ ...input, settings: { ...input.settings, gr4j: { x1: 150, x2: 0, x3: 40, x4: 1.1, warmupDays: 365 } } });
	input.series.flow_observed_m3s = { startDate: START, values: at(other, null, 'simulated_outflow').map((q) => q / 86_400) };
	return input;
}

describe('validation signatures in a run', () => {
	it('score the outlet by default and the calibration site when one is set', () => {
		const input = network();
		const outlet = runModel(input).summary.plausibility!.signatures!;
		expect(outlet.flowKind).toBe('flow_observed_m3s');
		expect(outlet.siteNodeId).toBeUndefined();
		// The outlet's record is another parameter set's: the signatures see a difference.
		expect(Math.abs(outlet.baseflow!.hughes!.difference)).toBeGreaterThan(1e-3);

		const site = runModel({ ...input, settings: { ...input.settings, calibrationSiteNodeId: 'H' } });
		const s = site.summary.plausibility!.signatures!;
		expect([s.siteNodeId, s.siteName]).toEqual(['H', 'Weir']);
		// H's record is H's simulated flow under the run's own parameters: every signature agrees exactly.
		expect(s.baseflow!.hughes!.difference).toBeCloseTo(0, 12);
		expect(s.baseflow!.eckhardt!.difference).toBeCloseTo(0, 12);
		expect(s.lowFlowFdc!.slopeBiasPct).toBeCloseTo(0, 9);
		const h = s.recessionHoldout!;
		expect(h.segments).toBeGreaterThanOrEqual(3);
		expect(h.heldOut.length).toBe(Math.floor(h.segments / 3));
		expect(h.modelSkill).toBeCloseTo(1, 12);
		expect(site.summary.warnings.filter((w) => w.startsWith('Validation signatures'))).toEqual([]);
		// Only a report: the flows are the same whichever record is scored.
		const flows = (o: ReturnType<typeof runModel>) => o.series.find((x) => x.nodeId === null && x.key === 'simulated_outflow')!.values;
		expect(flows(site)).toEqual(flows(runModel(input)));
	});

	it('null without an observed record', () => {
		const input = network();
		delete input.series.flow_observed_m3s;
		delete input.series[gaugeSeriesKey('flow_observed_m3s', 'H')];
		expect(runModel(input).summary.plausibility!.signatures).toBeNull();
	});

	it('validationSignatures without rain: no recession segments to hold out', () => {
		const q = Array.from({ length: 400 }, (_, t) => 1 + Math.sin(t / 30) ** 2);
		const s = validationSignatures({ flowKind: 'flow_logger_m3s', observedM3s: q, simulatedM3Day: q.map((v) => v * 86_400), excluded: none(400), segmentMask: none(400), rainMm: null });
		expect(s.recessionHoldout).toBeNull();
		expect(s.baseflow!.hughes!.difference).toBeCloseTo(0, 12);
	});
});
