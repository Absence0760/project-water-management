// River bed losses in the reach below a node (engine ≥ 1.75.0, issue #444,
// docs/model.md §2.6b): the arithmetic, hand-worked cases on a fixed natural
// flow so every number can be redone on paper, the senior users' requirement
// grossed up so it still arrives, the default (no losses) running exactly as
// before, and the invariants on random networks with bed losses.
import { describe, expect, it } from 'vitest';
import type { ModelInput, NetworkNode } from '../project';
import { runModel, runModelWith, withVerification } from '../run';
import { randomInput, withoutReachLosses } from '../testing/fuzz';
import { checkWaterAccount, sameOutput } from '../testing/invariants';
import { checkInvariants } from '../verify/checks';
import { modelRuleProblems } from '../modelRules';
import { reachGross, reachLossDay, reachLossOf, REACH_LOSS_FRAC_MAX } from './reachLoss';

/** Natural flow per day (m³/day): a dry day, a wet day, a middling day, nothing. */
const NATURAL = [1000, 10_000, 3000, 0];
const DAYS = NATURAL.length;

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
		returnFlowFraction: 0,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const flat = (v: number) => new Array(12).fill(v) as number[];

/** A four-day January run with no rain; farm A (when `farmNeedM3Day` is set) needs that many m³/day. */
function input(nodes: NetworkNode[], farmNeedM3Day: number | null): ModelInput {
	const apanMm = new Array(12).fill(0);
	apanMm[3] = farmNeedM3Day ?? 0;
	return {
		settings: { apanMm: apanMm as never, effectiveRainFraction: 0, ewrPragmaticM3PerDay: flat(0) as never },
		model: {
			nodes,
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: farmNeedM3Day === null ? [] : [{ nodeId: 'A', cropId: 'c', areaM2: 31_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(DAYS).fill(0) } }
	};
}

const run = (i: ModelInput) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: NATURAL })));
const col = (o: ReturnType<typeof run>, id: string | null, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)!.values;
const has = (o: ReturnType<typeof run>, id: string, key: string) => o.series.some((s) => s.nodeId === id && s.key === key);
const passed = (o: ReturnType<typeof run>) => expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);

describe('the reach arithmetic', () => {
	const p = { frac: 0.2, maxM3Day: 300 };

	it('loss = MIN(cap, f × flow): never negative, never falling as the flow rises, never more than the flow', () => {
		expect(reachLossDay(p, 0)).toBe(0);
		expect(reachLossDay(p, -5)).toBe(0);
		expect(reachLossDay(p, 1000)).toBe(200);
		expect(reachLossDay(p, 1500)).toBe(300);
		expect(reachLossDay(p, 1e9)).toBe(300);
		let prev = 0;
		for (let q = 0; q <= 5000; q += 37) {
			const l = reachLossDay(p, q);
			expect(l).toBeGreaterThanOrEqual(prev);
			expect(l).toBeLessThanOrEqual(q);
			prev = l;
		}
		expect(reachLossDay({ frac: 0.5, maxM3Day: Infinity }, 800)).toBe(400);
	});

	it('the gross-up is the inverse: passing reachGross(x) delivers x, on both sides of the cap', () => {
		for (const x of [0, 1, 100, 1199, 1200, 1201, 5000]) {
			const g = reachGross(p, x);
			expect(g - reachLossDay(p, g)).toBeCloseTo(x, 9);
		}
		// Below the cap it is x / (1 − f); above it, x + cap.
		expect(reachGross(p, 800)).toBe(1000);
		expect(reachGross(p, 2000)).toBe(2300);
	});

	it('reachLossOf: none by default, on the outlet (warned) or with a cap of 0; a share out of range clamped, a bad cap ignored, both warned', () => {
		const w: string[] = [];
		expect(reachLossOf(node('A', 'farm', 'G'), w)).toEqual({});
		expect(reachLossOf(node('A', 'farm', 'G', { reachLossFrac: 0, reachLossMaxM3Day: 50 }), w)).toEqual({});
		expect(reachLossOf(node('A', 'farm', 'G', { reachLossFrac: 0.3, reachLossMaxM3Day: 0 }), w)).toEqual({});
		expect(w).toEqual([]);
		expect(reachLossOf(node('A', 'farm', 'G', { reachLossFrac: 0.3 }), w)).toEqual({ reachLoss: { frac: 0.3, maxM3Day: Infinity } });
		expect(reachLossOf(node('U', 'user', 'G', { reachLossFrac: 0.1, reachLossMaxM3Day: 40 }), w)).toEqual({ reachLoss: { frac: 0.1, maxM3Day: 40 } });
		expect(reachLossOf(node('G', 'gauge', null, { reachLossFrac: 0.3 }), w)).toEqual({});
		expect(w[0]).toBe('gauge "G": bed losses below the outlet are ignored (the model has no reach below it)');
		expect(reachLossOf(node('A', 'farm', 'G', { reachLossFrac: 0.9 }), w)).toEqual({ reachLoss: { frac: REACH_LOSS_FRAC_MAX, maxM3Day: Infinity } });
		expect(w[1]).toBe('unit "A": bed losses 0.9 of the flow are not in [0, 0.5]; using 0.5');
		expect(reachLossOf(node('A', 'farm', 'G', { reachLossFrac: 0.2, reachLossMaxM3Day: -1 }), w)).toEqual({ reachLoss: { frac: 0.2, maxM3Day: Infinity } });
		expect(w[2]).toBe('unit "A": bed losses cap -1 m³/day is not a size ≥ 0; no cap');
	});
});

describe('bed losses in a run (engine 1.75.0)', () => {
	it('the node below receives the outflow less the loss; the loss leaves the catchment and both balances close', () => {
		const o = run(input([node('G', 'gauge', null), node('A', 'farm', 'G', { reachLossFrac: 0.2 })], null));
		passed(o);
		// A's own outflow is all its runoff; 20 % of it is lost on the way to G.
		expect(col(o, 'A', 'outflow')).toEqual(NATURAL);
		expect(col(o, 'A', 'reach_loss')).toEqual([200, 2000, 600, 0]);
		expect(col(o, 'G', 'inflow_upstream')).toEqual([800, 8000, 2400, 0]);
		expect(col(o, null, 'simulated_outflow')).toEqual([800, 8000, 2400, 0]);
		const wb = o.summary.waterBalance!.total;
		expect(wb.reachLossM3).toBe(2800);
		expect(Math.abs(wb.residualM3)).toBeLessThan(1e-9);
		const acct = o.summary.supplyAssurance!.waterAccount.total;
		expect(acct.reachLossM3).toBe(2800);
		expect(Math.abs(acct.residualM3)).toBeLessThan(1e-9);
		expect(acct.outM3).toBe(acct.inM3);
	});

	it('the daily cap binds on the wet days', () => {
		const o = run(input([node('G', 'gauge', null), node('A', 'farm', 'G', { reachLossFrac: 0.5, reachLossMaxM3Day: 1000 })], null));
		passed(o);
		expect(col(o, 'A', 'reach_loss')).toEqual([500, 1000, 1000, 0]);
		expect(col(o, null, 'simulated_outflow')).toEqual([500, 9000, 2000, 0]);
	});

	it('a gauge or a user loses in the reach below it too, and the EWR requirement crosses the reach as it is', () => {
		// A → G1 (a gauge, losing 10 % below it) → G (outlet). The EWR is 100 m³/day at the outlet, all A's share.
		const i = input([node('G', 'gauge', null), node('G1', 'gauge', 'G', { reachLossFrac: 0.1 }), node('A', 'farm', 'G1')], null);
		i.settings.ewrPragmaticM3PerDay = flat(100) as never;
		const o = run(i);
		passed(o);
		expect(col(o, 'G1', 'reach_loss')).toEqual([100, 1000, 300, 0]);
		expect(col(o, null, 'simulated_outflow')).toEqual([900, 9000, 2700, 0]);
		// The requirement at G is A's share in full: the loss shows as less flow against it, not a smaller requirement.
		expect(col(o, 'G', 'ewr_cumulative')).toEqual(col(o, 'G1', 'ewr_cumulative'));
	});

	it('a senior user’s claim is grossed up for the reach, so its demand still arrives', () => {
		// A (dam-less, needs 2000, all the natural flow), losing 20 % below it, drains into U (senior, wants 800), then G.
		const o = run(input([node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(800) }), node('A', 'farm', 'U', { reachLossFrac: 0.2 })], 2000));
		passed(o);
		// A must pass 800 / (1 − 0.2) = 1000 for 800 to reach U.
		expect(col(o, 'A', 'senior_requirement')).toEqual([1000, 1000, 1000, 1000]);
		expect(col(o, 'A', 'supplied')).toEqual([0, 2000, 2000, 0]);
		expect(col(o, 'A', 'reach_loss')).toEqual([200, 1600, 200, 0]);
		expect(col(o, 'U', 'inflow_upstream')).toEqual([800, 6400, 800, 0]);
		expect(col(o, 'U', 'supplied')).toEqual([800, 800, 800, 0]);
		// What arrives of the requirement is exactly the user's demand: none is left to pass below it.
		expect(col(o, 'U', 'senior_requirement')).toEqual([0, 0, 0, 0]);
	});

	it('with a cap the gross-up is the claim plus the cap, and it compounds over two reaches', () => {
		const capped = run(input([node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(800) }), node('A', 'farm', 'U', { reachLossFrac: 0.2, reachLossMaxM3Day: 100 })], 2000));
		passed(capped);
		// MIN(800 / 0.8, 800 + 100) = 900; the reach loses MIN(100, 180) = 100 of it.
		expect(col(capped, 'A', 'senior_requirement')[0]).toBe(900);
		expect(col(capped, 'U', 'supplied')[0]).toBe(800);
		// A → G1 (A loses 20 %) → U (G1 loses 50 %) → G: A passes 800 / 0.5 / 0.8 = 2000; 1000 reaches U on the wet day only.
		const two = run(
			input(
				[node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(800) }), node('G1', 'gauge', 'U', { reachLossFrac: 0.5 }), node('A', 'farm', 'G1', { reachLossFrac: 0.2 })],
				2000
			)
		);
		passed(two);
		expect(col(two, 'A', 'senior_requirement')[1]).toBeCloseTo(2000, 9);
		expect(col(two, 'G1', 'senior_requirement')[1]).toBeCloseTo(1600, 9);
		// Day 2 (3000 natural): A passes 2000 and takes 1000; 2000 → 1600 at G1 → 800 at U.
		expect(col(two, 'A', 'supplied')[2]).toBeCloseTo(1000, 9);
		expect(col(two, 'U', 'supplied')[2]).toBeCloseTo(800, 9);
	});

	it('several claims across one capped reach net exactly: nothing is left to hold back below the senior user', () => {
		// A and B (equal shares, no demand) → C (a gauge losing 20 %, at most 100 a day) → U (senior, 800) → J (junior, 100) → G.
		const o = run(
			input(
				[
					node('G', 'gauge', null),
					node('J', 'user', 'G', { userDemandM3Day: flat(100), userPriority: 'junior' }),
					node('U', 'user', 'J', { userDemandM3Day: flat(800) }),
					node('C', 'gauge', 'U', { reachLossFrac: 0.2, reachLossMaxM3Day: 100 }),
					node('A', 'farm', 'C'),
					node('B', 'farm', 'C')
				],
				null
			)
		);
		passed(o);
		// Each claim of 400 is grossed up to MIN(400 / 0.8, 400 + 100) = 500; the two put 100 each on the reach.
		expect(col(o, 'A', 'senior_requirement')[0]).toBe(500);
		expect(col(o, 'C', 'senior_requirement')[0]).toBe(1000);
		expect(col(o, 'C', 'senior_reach_loss')[0]).toBe(200);
		// What arrives at U is its demand: below it nothing is held back for nobody, and the junior user takes what is left.
		expect(col(o, 'U', 'senior_requirement')).toEqual([0, 0, 0, 0]);
		expect(col(o, 'C', 'reach_loss')).toEqual([100, 100, 100, 0]);
		expect(col(o, 'U', 'supplied')).toEqual([800, 800, 800, 0]);
		expect(col(o, 'J', 'supplied')).toEqual([100, 100, 100, 0]);
	});

	it('a save refuses bed losses on the outlet (positive control: on a unit they are fine)', () => {
		const at = (outlet: number, unit: number) => input([node('G', 'gauge', null, { reachLossFrac: outlet }), node('A', 'farm', 'G', { reachLossFrac: unit })], null).model;
		expect(modelRuleProblems(at(0.2, 0)).join()).toMatch(/"G" is the outlet: there is no reach below it in the model to lose water in/);
		expect(modelRuleProblems(at(0, 0.2))).toEqual([]);
	});

	it('bed losses below the outlet are ignored, with a warning and no series', () => {
		const o = run(input([node('G', 'gauge', null, { reachLossFrac: 0.3 }), node('A', 'farm', 'G')], null));
		passed(o);
		expect(has(o, 'G', 'reach_loss')).toBe(false);
		expect(col(o, null, 'simulated_outflow')).toEqual(NATURAL);
		expect(o.summary.warnings).toContain('gauge "G": bed losses below the outlet are ignored (the model has no reach below it)');
		expect(o.summary.waterBalance!.total.reachLossM3).toBeUndefined();
	});

	it('the self-checks catch a wrong loss, a dropped series and an inflow that ignores the loss', () => {
		// A listed first, so its own day is checked before G's inflow.
		const i = input([node('A', 'farm', 'G', { reachLossFrac: 0.2 }), node('G', 'gauge', null)], null);
		const o = run(i);
		expect(checkInvariants(i, o)).toBeNull();
		const edit = (id: string, key: string, f: (v: number[]) => void) => {
			const x = structuredClone(o);
			f(x.series.find((s) => s.nodeId === id && s.key === key)!.values);
			return x;
		};
		expect(checkInvariants(i, edit('A', 'reach_loss', (v) => (v[1] = 1000)))).toMatch(/A day 1: bed losses 1000/);
		// A gauge's flow that ignores the loss: it no longer matches A's outflow less the loss.
		const inflow = edit('G', 'outflow', (v) => (v[2] = 3000));
		expect(checkInvariants(i, inflow)).toMatch(/G day 2: routed inflow 2400 ≠ upstream sum/);
		const dropped = structuredClone(o);
		dropped.series = dropped.series.filter((s) => s.key !== 'reach_loss');
		expect(checkInvariants(i, dropped)).toMatch(/A: bed losses without a bed-loss series/);
	});
});

describe('no bed losses runs exactly as before (engine 1.75.0)', () => {
	it('absent, 0, or 0 with a cap: the same values to the bit, and no reach_loss series', () => {
		for (let seed = 1; seed <= 12; seed++) {
			const base = withoutReachLosses(randomInput(seed, { maxDays: 300 }));
			for (const n of base.model.nodes) {
				delete n.reachLossFrac;
				delete n.reachLossMaxM3Day;
			}
			const zeros = structuredClone(base);
			for (const n of zeros.model.nodes) {
				n.reachLossFrac = 0;
				n.reachLossMaxM3Day = 500;
			}
			const a = runModel(base);
			expect(sameOutput(a, runModel(zeros)), `seed ${seed}`).toBe(true);
			expect(a.series.some((s) => s.key === 'reach_loss'), `seed ${seed}`).toBe(false);
		}
	});
});

describe('the invariants see bed losses (engine 1.75.0)', () => {
	it('random networks with bed losses: every invariant holds, both water balances included', () => {
		let losing = 0;
		for (let seed = 1; seed < 1500 && losing < 8; seed++) {
			const x = randomInput(seed, { maxDays: 300 });
			if (!x.model.nodes.some((n) => (n.reachLossFrac ?? 0) > 0 && n.downstreamNodeId !== null)) continue;
			const out = withVerification(x, runModel(x));
			if (!out.series.some((s) => s.key === 'reach_loss' && s.values.some((v) => v > 0))) continue;
			losing++;
			expect(checkInvariants(x, out), `seed ${seed}`).toBeNull();
			expect(checkWaterAccount(out), `seed ${seed}`).toBeNull();
			const wb = out.summary.waterBalance!.total;
			expect(wb.reachLossM3, `seed ${seed}`).toBeGreaterThan(0);
			// Every senior claim is taken out at its user, so nothing of the requirement reaches the outlet.
			const outlet = x.model.nodes.find((n) => n.downstreamNodeId === null)!;
			const zsOut = out.series.find((s) => s.nodeId === outlet.id && s.key === 'senior_requirement')?.values ?? [];
			const zsMax = Math.max(0, ...out.series.filter((s) => s.key === 'senior_requirement').flatMap((s) => s.values));
			for (const v of zsOut) expect(v, `seed ${seed}`).toBeLessThanOrEqual(1e-9 * Math.max(1, zsMax));
			expect(Math.abs(wb.residualM3), `seed ${seed}`).toBeLessThan(1e-6 * Math.max(1, wb.naturalFlowM3));
		}
		expect(losing).toBe(8);
	});
});
