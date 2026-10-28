// A unit's base-flow loss and gain (engine 1.86.0, issue #523 B1, #90 R4 (a),
// docs/model.md §2.6b): the arithmetic, hand-worked runs on a fixed natural
// flow so every number can be redone on paper, the mass balance with both set,
// the natural flow a Reserve site reads, the EWR charge (the land's water is no
// unit's impact), the default (none) running exactly as before, and the
// invariants on random networks with base flow. Invented numbers only.
import { describe, expect, it } from 'vitest';
import type { ModelInput, NetworkNode } from '../project';
import { naturalAtOutlet, runModel, runModelWith, withVerification } from '../run';
import { randomInput } from '../testing/fuzz';
import { checkAll, checkWaterAccount, sameOutput } from '../testing/invariants';
import { checkInvariants } from '../verify/checks';
import { modelRuleProblems } from '../modelRules';
import { applyScenario, classifyOp, nodeFieldError } from '../scenario';
import { routeNatural } from './reachLoss';
import { baseflowLossDay, baseflowOf, baseflowRunoff, hasBaseflow } from './baseflow';

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

/** A four-day January run with no rain; unit A (when `needM3Day` is set) needs that many m³/day; a pragmatic EWR of `ewr` m³/day. */
function input(nodes: NetworkNode[], needM3Day: number | null, ewr = 0): ModelInput {
	const apanMm = new Array(12).fill(0);
	apanMm[3] = needM3Day ?? 0;
	return {
		settings: { apanMm: apanMm as never, effectiveRainFraction: 0, ewrPragmaticM3PerDay: flat(ewr) as never },
		model: {
			nodes,
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: needM3Day === null ? [] : [{ nodeId: 'A', cropId: 'c', areaM2: 31_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(DAYS).fill(0) } }
	};
}

const run = (i: ModelInput) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: NATURAL })));
const col = (o: ReturnType<typeof run>, id: string | null, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)!.values;
const has = (o: ReturnType<typeof run>, id: string, key: string) => o.series.some((s) => s.nodeId === id && s.key === key);
const passed = (o: ReturnType<typeof run>) => expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);

describe('the base-flow arithmetic', () => {
	const p = { lossM3Day: 2000, gainM3Day: 300 };

	it('loss = MIN(L, runoff): never negative, never more than the runoff; the gain is added every day', () => {
		expect([1000, 10_000, 3000, 0, -5].map((i) => baseflowLossDay(p, i))).toEqual([1000, 2000, 2000, 0, 0]);
		expect([1000, 10_000, 3000, 0].map((i) => baseflowRunoff(p, i))).toEqual([300, 8300, 1300, 300]);
	});

	it('baseflowOf: none by default or at 0; a bad size runs as none, warned; on a gauge or user, ignored and warned', () => {
		const w: string[] = [];
		expect(baseflowOf(node('A', 'farm', 'G'), w)).toEqual({});
		expect(baseflowOf(node('A', 'farm', 'G', { baseflowLossM3Day: 0, baseflowGainM3Day: 0 }), w)).toEqual({});
		expect(w).toEqual([]);
		expect(baseflowOf(node('A', 'farm', 'G', { baseflowLossM3Day: 50 }), w)).toEqual({ baseflow: { lossM3Day: 50, gainM3Day: 0 } });
		expect(baseflowOf(node('A', 'farm', 'G', { baseflowLossM3Day: -1, baseflowGainM3Day: 7 }), w)).toEqual({ baseflow: { lossM3Day: 0, gainM3Day: 7 } });
		expect(w).toEqual(['unit "A": base-flow loss -1 m³/day is not a size ≥ 0; none']);
		expect(baseflowOf(node('A', 'farm', 'G', { baseflowGainM3Day: Number.NaN }), w)).toEqual({});
		expect(baseflowOf(node('G', 'gauge', null, { baseflowGainM3Day: 5 }), w)).toEqual({});
		expect(w.at(-1)).toBe('gauge "G": a base-flow loss or gain is a unit\'s; ignored here');
		expect(hasBaseflow([node('A', 'farm', 'G'), node('B', 'farm', 'G', { baseflowGainM3Day: 1 })])).toBe(true);
		expect(hasBaseflow([node('A', 'farm', 'G', { baseflowLossM3Day: 0 })])).toBe(false);
	});
});

describe('a unit’s base-flow loss and gain in a run (engine 1.86.0)', () => {
	it('the loss is MIN(L, I) and the gain joins I before the split; both balances close and count them', () => {
		const o = run(input([node('G', 'gauge', null), node('A', 'farm', 'G', { baseflowLossM3Day: 2000, baseflowGainM3Day: 300 })], null));
		passed(o);
		// The runoff column stays natural × share; the unit passes I − MIN(2000, I) + 300.
		expect(col(o, 'A', 'runoff')).toEqual(NATURAL);
		expect(col(o, 'A', 'baseflow_loss')).toEqual([1000, 2000, 2000, 0]);
		expect(col(o, 'A', 'baseflow_gain')).toEqual([300, 300, 300, 300]);
		expect(col(o, 'A', 'outflow')).toEqual([300, 8300, 1300, 300]);
		expect(col(o, null, 'simulated_outflow')).toEqual([300, 8300, 1300, 300]);
		const wb = o.summary.waterBalance!.total;
		expect(wb.baseflowLossM3).toBe(5000);
		expect(wb.baseflowGainM3).toBe(1200);
		expect(wb.farmRunoffM3).toBe(14_000);
		expect(Math.abs(wb.residualM3)).toBeLessThan(1e-9);
		const acct = o.summary.supplyAssurance!.waterAccount.total;
		expect(acct.baseflowLossM3).toBe(5000);
		expect(acct.baseflowGainM3).toBe(1200);
		expect(Math.abs(acct.residualM3)).toBeLessThan(1e-9);
		expect(acct.outM3).toBe(acct.inM3);
	});

	it('the runoff after them is what the dam and the crops see: a gain fills the dam on a day with no runoff', () => {
		// No crops; a full 5 000 m³ dam that all the runoff goes into.
		const o = run(input([node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 5000, damInitialPct: 1, baseflowGainM3Day: 400 })], null));
		passed(o);
		// Day 3 has no runoff: the gain alone flows into the full dam and spills.
		expect(col(o, 'A', 'dam_storage')).toEqual([5000, 5000, 5000, 5000]);
		expect(col(o, 'A', 'spill')).toEqual([1400, 10_400, 3400, 400]);
		expect(col(o, 'A', 'outflow')[3]).toBe(400);
	});

	it('only the loss: series for the loss alone, and none for a gain', () => {
		const o = run(input([node('G', 'gauge', null), node('A', 'farm', 'G', { baseflowLossM3Day: 500 })], null));
		passed(o);
		expect(col(o, 'A', 'baseflow_loss')).toEqual([500, 500, 500, 0]);
		expect(has(o, 'A', 'baseflow_gain')).toBe(false);
		expect(o.summary.waterBalance!.total.baseflowGainM3).toBeUndefined();
		expect(o.summary.waterBalance!.total.baseflowLossM3).toBe(1500);
	});

	it('the loss is the land’s, not the unit’s use: an undeveloped catchment short of the EWR charges no unit', () => {
		// EWR 3 000 m³/day at the outlet; the loss makes days 0 and 2 short. No crop, no dam: every shortfall is natural.
		const o = run(input([node('G', 'gauge', null), node('A', 'farm', 'G', { baseflowLossM3Day: 2000 })], null, 3000));
		passed(o);
		expect(col(o, 'G', 'ewr_shortfall').some((v) => v < 0)).toBe(true);
		expect(col(o, null, 'ewr_charged').every((v) => v === 0)).toBe(true);
		expect(col(o, 'A', 'ewr_charge').every((v) => v === 0)).toBe(true);
		// Positive control: a unit that irrigates is charged its share of the same shortfall.
		const used = run(input([node('G', 'gauge', null), node('A', 'farm', 'G', { baseflowLossM3Day: 2000 })], 100, 3000));
		passed(used);
		expect(col(used, 'A', 'ewr_charge').some((v) => v < 0)).toBe(true);
	});

	it('a gauge or user with base flow: ignored with a warning and no series; a save refuses it (positive control: on a unit it is fine)', () => {
		const o = run(input([node('G', 'gauge', null, { baseflowLossM3Day: 100 }), node('A', 'farm', 'G')], null));
		passed(o);
		expect(has(o, 'G', 'baseflow_loss')).toBe(false);
		expect(o.summary.warnings).toContain('gauge "G": a base-flow loss or gain is a unit\'s; ignored here');
		const m = (g: number, a: number) => input([node('G', 'gauge', null, { baseflowGainM3Day: g }), node('A', 'farm', 'G', { baseflowGainM3Day: a })], null).model;
		expect(modelRuleProblems(m(5, 0)).join()).toMatch(/"G": only a hydrological unit has a base-flow loss or gain/);
		expect(modelRuleProblems(m(0, 5))).toEqual([]);
	});

	it('the self-checks catch a wrong loss, a wrong gain and a dropped series', () => {
		const i = input([node('A', 'farm', 'G', { baseflowLossM3Day: 2000, baseflowGainM3Day: 300 }), node('G', 'gauge', null)], null);
		const o = run(i);
		expect(checkInvariants(i, o)).toBeNull();
		const edit = (key: string, f: (v: number[]) => void) => {
			const x = structuredClone(o);
			f(x.series.find((s) => s.nodeId === 'A' && s.key === key)!.values);
			return x;
		};
		expect(checkInvariants(i, edit('baseflow_loss', (v) => (v[1] = 1000)))).toMatch(/A day 1: base-flow loss 1000/);
		expect(checkInvariants(i, edit('baseflow_gain', (v) => (v[2] = 0)))).toMatch(/A day 2: base-flow gain 0/);
		const dropped = structuredClone(o);
		dropped.series = dropped.series.filter((s) => s.key !== 'baseflow_gain');
		expect(checkInvariants(i, dropped)).toMatch(/A: base-flow series/);
	});
});

describe('the natural flow is net of the base flow, as it is of the bed losses', () => {
	it('routeNatural takes each unit’s runoff through its base flow before the reach below it (worked by hand)', () => {
		// A (0) → O (2), B (1) → O. A loses up to 400 and its reach half; B gains 100.
		const r = {
			order: [0, 1, 2],
			upstream: [[], [], [0, 1]],
			reach: [{ frac: 0.5, maxM3Day: Infinity }, undefined, undefined],
			baseflow: [{ lossM3Day: 400, gainM3Day: 0 }, { lossM3Day: 0, gainM3Day: 100 }, undefined]
		};
		const own = [
			[1000, 300],
			[200, 0],
			[0, 0]
		];
		const [o] = routeNatural(r, (i, t) => own[i]![t]!, 2, [2]);
		// Day 0: A (1000 − 400) × 0.5 = 300, B 200 + 100 = 300. Day 1: A 0, B 100.
		expect([...o!]).toEqual([600, 100]);
	});

	it('naturalAtOutlet reads it with base flow alone, no reach losing (null with neither)', () => {
		const plan = {
			nodes: [{ kind: 'farm' as const, share: 0.5, baseflow: { lossM3Day: 0, gainM3Day: 50 } }, { kind: 'farm' as const, share: 0.3 }, { kind: 'gauge' as const, share: 0 }],
			order: Int32Array.from([0, 1, 2]),
			upstream: [Int32Array.from([]), Int32Array.from([]), Int32Array.from([0, 1])]
		} as unknown as Parameters<typeof naturalAtOutlet>[0];
		// 1000: 500 + 50, 300, the rest 200.
		expect([...naturalAtOutlet(plan, 2, [1000, 0])!]).toEqual([1050, 50]);
		const none = { ...plan, nodes: plan.nodes.map((n) => ({ ...n, baseflow: undefined })) };
		expect(naturalAtOutlet(none, 2, [1000])).toBeNull();
	});
});

describe('a base-flow loss or gain is a baseline assumption in a scenario', () => {
	it('node.set takes a size ≥ 0 on a unit, classified baseline', () => {
		expect(nodeFieldError('baseflowLossM3Day', 1500)).toBeNull();
		expect(nodeFieldError('baseflowGainM3Day', -1)).not.toBeNull();
		const base = input([node('G', 'gauge', null), node('A', 'farm', 'G')], null);
		const op = { op: 'node.set', nodeId: 'A', field: 'baseflowGainM3Day', value: 250 } as const;
		const r = applyScenario(base, [op]);
		expect(r.problems).toEqual([]);
		expect(r.input.model.nodes.find((n) => n.id === 'A')!.baseflowGainM3Day).toBe(250);
		// The applicant's own unit: still a baseline assumption, like its land and bed losses.
		expect(classifyOp(op, ['A'], base)).toBe('baseline');
	});
});

describe('no base flow runs exactly as before (engine 1.86.0)', () => {
	it('absent or 0: the same values to the bit, and no base-flow series', () => {
		for (let seed = 1; seed <= 12; seed++) {
			const base = randomInput(seed, { maxDays: 300 });
			for (const n of base.model.nodes) {
				delete n.baseflowLossM3Day;
				delete n.baseflowGainM3Day;
			}
			const zeros = structuredClone(base);
			for (const n of zeros.model.nodes) {
				n.baseflowLossM3Day = 0;
				n.baseflowGainM3Day = 0;
			}
			const a = runModel(base);
			expect(sameOutput(a, runModel(zeros)), `seed ${seed}`).toBe(true);
			expect(a.series.some((s) => s.key === 'baseflow_loss' || s.key === 'baseflow_gain'), `seed ${seed}`).toBe(false);
		}
	});
});

describe('the invariants see base flow (engine 1.86.0)', () => {
	it('random networks with base-flow losses and gains: every invariant holds, both water balances included', () => {
		let seen = 0;
		for (let seed = 1; seed < 200 && seen < 8; seed++) {
			const x = randomInput(seed, { maxDays: 300, baseflow: true });
			const out = withVerification(x, runModel(x));
			if (!out.series.some((s) => (s.key === 'baseflow_loss' || s.key === 'baseflow_gain') && s.values.some((v) => v > 0))) continue;
			seen++;
			expect(checkAll(x, seed), `seed ${seed}`).toBeNull();
			expect(checkWaterAccount(out), `seed ${seed}`).toBeNull();
			const wb = out.summary.waterBalance!.total;
			expect((wb.baseflowLossM3 ?? 0) + (wb.baseflowGainM3 ?? 0), `seed ${seed}`).toBeGreaterThan(0);
			const scale = Math.max(1, wb.naturalFlowM3, wb.baseflowGainM3 ?? 0);
			expect(Math.abs(wb.residualM3), `seed ${seed}`).toBeLessThan(1e-6 * scale);
		}
		expect(seen).toBe(8);
	});
});
