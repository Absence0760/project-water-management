// A pool at a run-of-river farm's pump intake (engine ≥ 1.64.0, docs/model.md
// §2.7j): hand-worked days on a fixed natural flow, the hands-off flow it must
// still pass, evaporation, a farm without one running exactly as before, the
// warnings, and the invariants catching a pool that breaks its rules.
import { describe, expect, it } from 'vitest';
import type { ModelInput, NetworkNode } from '../project';
import { runModel, runModelWith, withVerification } from '../run';
import { randomInput } from '../testing/fuzz';
import { checkInvariants } from '../verify/checks';
import { poolDay, poolLosses, supplyOf } from './supply';

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
	};
}

const flat = (v: number) => new Array(12).fill(v) as number[];

/**
 * January dry days: run-of-river farm A needs `need` m³/day (31 000 m² of a
 * crop with factor 1, the January A-pan set to the need, efficiency 1, no
 * effective rain) and drains into the outlet gauge G; its runoff is the
 * natural flow. The lake evaporation factor is 0 unless `evap` is set, so the
 * pool loses nothing unless a test asks it to.
 */
function input(a: Partial<NetworkNode>, need: number, days: number, evap = false): ModelInput {
	const apanMm = new Array(12).fill(0);
	apanMm[3] = need;
	return {
		settings: { apanMm: apanMm as never, effectiveRainFraction: 0, ewrPragmaticM3PerDay: flat(0) as never, ...(evap ? {} : { lakeEvapFactor: 0 }) },
		model: {
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { supplyRule: 'runOfRiver', pumpCapacityM3Day: 1500, ...a })],
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 31_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(days).fill(0) } }
	};
}

const run = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));
const col = (o: ReturnType<typeof run>, key: string) => o.series.find((s) => s.nodeId === 'A' && s.key === key)?.values;
const passed = (o: ReturnType<typeof run>) => expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification!.checks.filter((c) => !c.passed))).toBe(true);

// A full 3000 m³ pool with no surface (no evaporation), and a pump of 1500 m³/day against a need of 2000.
const pool = { poolCapacityM3: 3000, poolAreaM2: 0 };
const natural = [1000, 4000, 0, 0, 0];

describe('a run-of-river pool (engine 1.64.0)', () => {
	it('the pump takes the flow first, then draws the pool down; the pool refills from the flow', () => {
		const o = run(input(pool, 2000, 5), natural);
		passed(o);
		// Day 0: 1000 of flow + 500 from the pool. Day 1: 1500 from the flow, then 500 refills the pool.
		// Days 2–3: no flow, 1500 a day from the pool until it is empty. Day 4: nothing left.
		expect(col(o, 'river_abstraction')).toEqual([1500, 1500, 1500, 1500, 0]);
		expect(col(o, 'pool_drawn')).toEqual([500, 0, 1500, 1500, 0]);
		expect(col(o, 'pool_storage')).toEqual([2500, 3000, 1500, 0, 0]);
		expect(col(o, 'deficit')).toEqual([500, 500, 500, 500, 2000]);
		// The river below loses what the pump took from the flow and the refill: 4000 − 1500 − 500.
		expect(col(o, 'outflow')).toEqual([0, 2000, 0, 0, 0]);
		expect(col(o, 'dam_storage')).toEqual([0, 0, 0, 0, 0]);
	});

	it('without a pool the same farm pumps only what flows, as before', () => {
		const o = run(input({}, 2000, 5), natural);
		passed(o);
		expect(col(o, 'river_abstraction')).toEqual([1000, 1500, 0, 0, 0]);
		expect(col(o, 'outflow')).toEqual([0, 2500, 0, 0, 0]);
		expect(col(o, 'pool_storage')).toBeUndefined();
	});

	it('a pool that starts empty fills before the river below gets anything past the pump', () => {
		const o = run(input({ ...pool, poolInitialPct: 0 }, 2000, 5), natural);
		passed(o);
		// Day 0: 1000 flows, all pumped. Day 1: 1500 pumped, the pool takes 2500 of the 2500 left, nothing passes.
		expect(col(o, 'pool_storage')).toEqual([0, 2500, 1000, 0, 0]);
		expect(col(o, 'outflow')).toEqual([0, 0, 0, 0, 0]);
		expect(col(o, 'river_abstraction')).toEqual([1000, 1500, 1500, 1000, 0]);
	});

	it('the hands-off flow still passes: the pool is drawn instead, and refills only from flow above it', () => {
		const o = run(input({ ...pool, handsOffM3Day: flat(800) }, 2000, 2), [1000, 4000]);
		passed(o);
		// Day 0: 200 of flow above the 800 kept, 1300 from the pool. Day 1: 3200 free: 1500 pumped, 1300 refills.
		expect(col(o, 'pool_drawn')).toEqual([1300, 0]);
		expect(col(o, 'pool_storage')).toEqual([1700, 3000]);
		expect(col(o, 'outflow')).toEqual([800, 1200]);
	});

	it('a pump of 0 takes nothing, and the pool only fills', () => {
		const o = run(input({ ...pool, poolInitialPct: 0.5, pumpCapacityM3Day: 0 }, 2000, 2), [1000, 4000]);
		passed(o);
		expect(col(o, 'river_abstraction')).toEqual([0, 0]);
		expect(col(o, 'pool_storage')).toEqual([2500, 3000]);
		expect(col(o, 'outflow')).toEqual([0, 3500]);
	});

	it('the pool loses its evaporation, from the surface its storage covers, and the run still balances', () => {
		const o = run(input({ poolCapacityM3: 3000, poolAreaM2: 2000 }, 500, 5, true), [0, 0, 0, 0, 0]);
		passed(o);
		const ev = col(o, 'pool_evaporation')!;
		const area = col(o, 'pool_area')!;
		expect(area[0]).toBe(2000);
		expect(ev.every((v) => v > 0)).toBe(true);
		// A shrinking pool has a smaller surface, so it loses less each day.
		for (let t = 1; t < 5; t++) expect(area[t]!).toBeLessThan(area[t - 1]!);
		const s = col(o, 'pool_storage')!;
		const drawn = col(o, 'pool_drawn')!;
		expect(s[0]).toBeCloseTo(3000 - ev[0]! - drawn[0]!, 9);
	});
});

describe('the pool day (supply.ts)', () => {
	it('splits what the pump took between the flow and the pool, and refills from what flow is left', () => {
		const p = { capM3: 1000, initialM3: 1000, areaFullM2: 0 };
		expect(poolDay(p, 300, 500, 800)).toEqual([300, 0, 200, 1000]);
		expect(poolDay(p, 900, 500, 800)).toEqual([500, 400, 0, 400]);
		// It never draws more than it holds.
		expect(poolDay(p, 900, 0, 100)).toEqual([0, 100, 0, 0]);
	});

	it('evaporates from the area its storage covers, never more than it holds, and nothing when empty', () => {
		const p = { capM3: 1000, initialM3: 1000, areaFullM2: 1000 };
		expect(poolLosses(p, 1000, 5)).toEqual([1000, 5]);
		expect(poolLosses(p, 0, 5)).toEqual([0, 0]);
		const [A] = poolLosses(p, 500, 5);
		expect(A).toBeCloseTo(1000 * 0.5 ** 0.7, 9);
		expect(poolLosses({ ...p, areaFullM2: 1e9 }, 1, 5)[1]).toBe(1);
	});
});

describe('supplyOf: the pool', () => {
	const farm = (over: Partial<NetworkNode>) => node('A', 'farm', 'G', { supplyRule: 'runOfRiver', ...over });

	it('is a run-of-river unit’s; under another rule, or with a dam, it is ignored with a warning', () => {
		const w: string[] = [];
		expect(supplyOf(farm({ poolCapacityM3: 500, poolAreaM2: 10 }), w).supply?.pool).toEqual({ capM3: 500, initialM3: 500, areaFullM2: 10 });
		for (const over of [{ supplyRule: 'riverFirst' as const }, { supplyRule: 'damFirst' as const }, { damCapacityM3: 1000 }]) {
			const ws: string[] = [];
			expect(supplyOf(farm({ poolCapacityM3: 500, ...over }), ws).supply?.pool).toBeUndefined();
			expect(ws.some((x) => /pool/.test(x)), JSON.stringify(over)).toBe(true);
		}
	});

	it('estimates an unknown area from the capacity and says so; clamps the start; refuses a capacity that isn’t a size', () => {
		const w: string[] = [];
		const p = supplyOf(farm({ poolCapacityM3: 1000, poolInitialPct: 2 }), w).supply!.pool!;
		expect(p.initialM3).toBe(1000);
		expect(p.areaFullM2).toBeGreaterThan(0);
		expect(w.some((x) => x.includes('surface area is not set'))).toBe(true);
		expect(w.some((x) => x.includes('pool start 2'))).toBe(true);
		const bad: string[] = [];
		expect(supplyOf(farm({ poolCapacityM3: -5 }), bad).supply!.pool).toBeUndefined();
		expect(bad.some((x) => x.includes('not a size > 0'))).toBe(true);
	});
});

describe('the invariants see the pool (engine 1.64.0)', () => {
	it('the random networks have pools that draw and refill, and every invariant holds there', () => {
		let drawing = 0;
		for (let seed = 1; seed < 3000 && drawing < 6; seed++) {
			const x = randomInput(seed, { maxDays: 300 });
			if (!x.model.nodes.some((n) => (n.poolCapacityM3 ?? 0) > 0)) continue;
			const out = runModel(x);
			if (!out.series.some((s) => s.key === 'pool_drawn' && s.values.some((v) => v > 0))) continue;
			drawing++;
			expect(checkInvariants(x, out), `seed ${seed}`).toBeNull();
		}
		expect(drawing).toBe(6);
	});

	it('catch a pool above its capacity, water drawn it didn’t hold, and a refill that takes what must pass', () => {
		const i = input({ ...pool, handsOffM3Day: flat(800) }, 2000, 3);
		const out = runModelWith(i, () => ({ naturalFlowM3Day: [1000, 4000, 0] }));
		expect(checkInvariants(i, out)).toBeNull();
		const edit = (key: string, f: (v: number[]) => void) => {
			const o = structuredClone(out);
			f(o.series.find((s) => s.nodeId === 'A' && s.key === key)!.values);
			return o;
		};
		expect(checkInvariants(i, edit('pool_storage', (v) => (v[1] = 3500)))).toMatch(/pool|balance/);
		expect(checkInvariants(i, edit('pool_drawn', (v) => (v[0] = 0)))).toMatch(/pool/);
		// The river below kept only 400 of the 800 that must pass on day 0: the routing check sees it first (the outlet's inflow no longer adds up).
		expect(checkInvariants(i, edit('outflow', (v) => (v[0] = 400)))).toMatch(/routed inflow 400/);
	});
});
