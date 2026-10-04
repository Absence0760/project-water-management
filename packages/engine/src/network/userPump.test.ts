// A pump capacity on other water users (engine ≥ 1.58.0, WP-3.8, issue #54
// item 2b, docs/model.md §2.7c): hand-worked cases on a fixed natural flow, so
// every number below can be redone on paper; the default (no capacity)
// running exactly as before; and the invariants on random networks with pumps.
import { describe, expect, it } from 'vitest';
import type { ModelInput, NetworkNode } from '../project';
import { runModel, runModelWith, withVerification } from '../run';
import { randomInput } from '../testing/fuzz';
import { sameOutput } from '../testing/invariants';
import { checkInvariants } from '../verify/checks';
import { userPumpOf } from './supply';

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

/** A four-day January run with no rain; farm A (when `farmNeedM3Day` is set) needs that many m³/day (see users.test.ts). */
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

describe('a pump capacity on other water users (engine 1.58.0)', () => {
	it('a senior user takes at most its capacity, and the farm above passes only MIN(demand, capacity)', () => {
		// A (dam-less, needs 2000, all the natural flow) drains into U (senior, wants 800, pump 300), then G.
		const o = run(input([node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(800), pumpCapacityM3Day: 300 }), node('A', 'farm', 'U')], 2000));
		passed(o);
		// The claim on A is MIN(800, 300) = 300, not 800: A keeps back 300 and takes the rest (day 0: 700 of 1000).
		expect(col(o, 'A', 'senior_requirement')).toEqual([300, 300, 300, 300]);
		expect(col(o, 'A', 'passed_for_senior')).toEqual([300, 300, 300, 0]);
		expect(col(o, 'A', 'supplied')).toEqual([700, 2000, 2000, 0]);
		expect(col(o, 'U', 'supplied')).toEqual([300, 300, 300, 0]);
		expect(col(o, 'U', 'deficit')).toEqual([500, 500, 500, 800]);
		// Day 0 the river brought only the 300 passed; days 1 and 2 it had 8000 and 1000, so 500 was the pump's.
		expect(col(o, 'U', 'pump_limited')).toEqual([0, 500, 500, 0]);
		// Below U its whole claim is gone.
		expect(col(o, 'U', 'senior_requirement')).toEqual([0, 0, 0, 0]);
		expect(o.summary.users![0]).toMatchObject({ avgSuppliedM3Day: 225, avgRiverAbstractionM3Day: 225, avgPumpLimitedM3Day: 250, daysPumpLimited: 2 });
		// Mass balance closes with the capped take.
		expect(Math.abs(o.summary.waterBalance!.total.residualM3)).toBeLessThan(1e-9);
		expect(o.summary.waterBalance!.total.otherUseM3).toBeCloseTo(900, 9);
		// No capacity: the old rule, MIN(demand, what reaches it), and the farm passes the whole 800.
		const free = run(input([node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(800) }), node('A', 'farm', 'U')], 2000));
		expect(col(free, 'U', 'supplied')).toEqual([800, 800, 800, 0]);
		expect(col(free, 'A', 'supplied')).toEqual([200, 2000, 2000, 0]);
		expect(has(free, 'U', 'pump_limited')).toBe(false);
		expect(free.summary.users![0]!.avgPumpLimitedM3Day).toBeUndefined();
	});

	it('a junior user takes what the farm leaves, up to its capacity', () => {
		const o = run(input([node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(800), userPriority: 'junior', pumpCapacityM3Day: 600 }), node('A', 'farm', 'U')], 2000));
		passed(o);
		// A takes first: it leaves 0, 8000, 1000, 0; U takes MIN(that, 800, 600).
		expect(col(o, 'U', 'supplied')).toEqual([0, 600, 600, 0]);
		expect(col(o, 'U', 'pump_limited')).toEqual([0, 200, 200, 0]);
		// What the pump left stays in the river: outlet = what A leaves − U's take.
		expect(col(o, null, 'simulated_outflow')).toEqual([0, 7400, 400, 0]);
		expect(o.series.some((s) => s.key === 'senior_requirement')).toBe(false);
	});

	it('a capacity of 0 takes nothing from the river; a supplemental borehole still pumps, and the pump-limited part is what the river had', () => {
		const o = run(
			input(
				[node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(500), pumpCapacityM3Day: 0, boreholeCapacityM3Day: 200, boreholeRule: 'supplemental' }), node('A', 'farm', 'U')],
				null
			)
		);
		passed(o);
		expect(col(o, 'U', 'groundwater_used')).toEqual([200, 200, 200, 200]);
		// Its river take (supplied − groundwater) is 0: it has no river_abstraction series of its own.
		expect(has(o, 'U', 'river_abstraction')).toBe(false);
		expect(o.summary.users![0]!.avgRiverAbstractionM3Day).toBe(0);
		expect(col(o, 'U', 'supplied')).toEqual([200, 200, 200, 200]);
		// The river had 1000, 10 000, 3000, 0: the 300 the borehole didn't cover, except on the dry day.
		expect(col(o, 'U', 'pump_limited')).toEqual([300, 300, 300, 0]);
		// Nothing leaves the river at U: the outlet is the natural flow.
		expect(col(o, null, 'simulated_outflow')).toEqual(NATURAL);
	});

	it('the return share is of what it took, capped', () => {
		const o = run(input([node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(2000), userReturnPct: 0.25, pumpCapacityM3Day: 1200 }), node('A', 'farm', 'U')], null));
		passed(o);
		expect(col(o, 'U', 'supplied')).toEqual([1000, 1200, 1200, 0]);
		expect(col(o, 'U', 'return_flow')).toEqual([250, 300, 300, 0]);
		expect(col(o, null, 'simulated_outflow')).toEqual([250, 9100, 2100, 0]);
	});

	it('warnings: a supply rule on a user is ignored, a bad capacity runs as no limit, and none for the default', () => {
		const w: string[] = [];
		expect(userPumpOf(node('U', 'user', null, { pumpCapacityM3Day: null }), w)).toEqual({});
		expect(userPumpOf(node('U', 'user', null), w)).toEqual({});
		expect(w).toEqual([]);
		expect(userPumpOf(node('U', 'user', null, { pumpCapacityM3Day: 0 }), w)).toEqual({ userPumpM3Day: 0 });
		expect(userPumpOf(node('U', 'user', null, { pumpCapacityM3Day: -5 }), w)).toEqual({});
		expect(w[0]).toMatch(/user "U": pump capacity -5 m³\/day is not a size ≥ 0; no limit/);
		// A farm's and a gauge's are not a user's pump.
		expect(userPumpOf(node('A', 'farm', null, { pumpCapacityM3Day: 5 }), [])).toEqual({});
		const o = run(input([node('G', 'gauge', null, { pumpCapacityM3Day: 10 }), node('U', 'user', 'G', { userDemandM3Day: flat(100), supplyRule: 'riverFirst', pumpCapacityM3Day: 50 }), node('A', 'farm', 'U')], null));
		expect(o.summary.warnings.some((x) => x.startsWith('user "U": only a unit has a supply rule; ignored'))).toBe(true);
		expect(o.summary.warnings.some((x) => x.startsWith('gauge "G": only a unit has a supply rule and river pump; ignored'))).toBe(true);
		// The pump still applies on the user.
		expect(col(o, 'U', 'supplied')).toEqual([50, 50, 50, 0]);
	});

	it('the self-checks catch a user above its capacity, a wrong pump-limited day and a dropped series', () => {
		const i = input([node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(800), pumpCapacityM3Day: 300 }), node('A', 'farm', 'U')], 2000);
		const o = run(i);
		expect(checkInvariants(i, o)).toBeNull();
		const edit = (key: string, f: (v: number[]) => void) => {
			const x = structuredClone(o);
			f(x.series.find((s) => s.nodeId === 'U' && s.key === key)!.values);
			return x;
		};
		expect(checkInvariants(i, edit('supplied', (v) => (v[1] = 800)))).toMatch(/U day 1: user took 800/);
		expect(checkInvariants(i, edit('pump_limited', (v) => (v[1] = 0)))).toMatch(/U day 1: user pump_limited/);
		const dropped = structuredClone(o);
		dropped.series = dropped.series.filter((s) => !(s.nodeId === 'U' && s.key === 'pump_limited'));
		expect(checkInvariants(i, dropped)).toMatch(/U: user pump_limited missing/);
	});
});

describe('users without a capacity run exactly as before (engine 1.58.0)', () => {
	it('absent, null, or a capacity above any flow: the same values to the bit, and only a capacity adds pump_limited', () => {
		let users = 0;
		for (let seed = 1; seed < 200 && users < 8; seed++) {
			const base = randomInput(seed, { maxDays: 300 });
			if (!base.model.nodes.some((n) => n.kind === 'user')) continue;
			users++;
			for (const n of base.model.nodes) if (n.kind === 'user') delete n.pumpCapacityM3Day;
			const nulls = structuredClone(base);
			for (const n of nulls.model.nodes) if (n.kind === 'user') n.pumpCapacityM3Day = null;
			const a = runModel(base);
			expect(sameOutput(a, runModel(nulls)), `seed ${seed}`).toBe(true);
			expect(a.series.some((s) => s.key === 'pump_limited'), `seed ${seed}`).toBe(false);
			// A capacity no day's flow or demand reaches changes no value: only pump_limited is new.
			const huge = structuredClone(base);
			for (const n of huge.model.nodes) if (n.kind === 'user') n.pumpCapacityM3Day = Number.MAX_VALUE;
			const b = runModel(huge);
			const key = (s: { nodeId: string | null; key: string }) => `${s.nodeId}|${s.key}`;
			const before = new Map(a.series.map((s) => [key(s), s.values]));
			for (const s of b.series) {
				if (s.key === 'pump_limited') continue;
				expect(s.values, `seed ${seed} ${key(s)}`).toEqual(before.get(key(s)));
			}
		}
		expect(users).toBe(8);
	});
});

describe('the invariants see the users’ pumps (engine 1.58.0)', () => {
	it('random networks whose users’ pumps bind: every invariant holds, the water balance included', () => {
		let binding = 0;
		for (let seed = 1; seed < 1500 && binding < 6; seed++) {
			const x = randomInput(seed, { maxDays: 300 });
			if (!x.model.nodes.some((n) => n.kind === 'user' && typeof n.pumpCapacityM3Day === 'number')) continue;
			const out = runModel(x);
			if (!out.series.some((s) => s.key === 'pump_limited' && s.values.some((v) => v > 0))) continue;
			binding++;
			expect(checkInvariants(x, out), `seed ${seed}`).toBeNull();
			// checkInvariants replays the balance; the water account's residual (when the run has one) closes too.
			const wb = out.summary.waterBalance?.total;
			if (wb) expect(Math.abs(wb.residualM3), `seed ${seed}`).toBeLessThan(1e-6 * Math.max(1, wb.naturalFlowM3));
		}
		expect(binding).toBe(6);
	});
});
