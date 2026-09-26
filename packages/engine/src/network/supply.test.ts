// Supply rules and the river pump (WP-3.8, issue #54 item 2c, docs/model.md
// §2.7e): hand-worked cases on a fixed natural flow, one per rule, and the
// default (no supply fields) running exactly as before.
import { describe, expect, it } from 'vitest';
import { SUPPLY_DEFAULTS, type ModelInput, type NetworkNode } from '../project';
import { runModel, runModelWith, withVerification } from '../run';
import { randomInput } from '../testing/fuzz';
import { sameOutput } from '../testing/invariants';
import { checkInvariants } from '../verify/checks';
import { pumpsRiverToday, supplyOf, type PlanSupply } from './supply';

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
 * A January run of dry days. Farm A needs `need` m³/day (31 000 m² of a crop
 * with factor 1, the January A-pan set to the need, efficiency 1, no effective
 * rain, a dam with no surface so no evaporation) and drains through `between`
 * (if any) into the outlet gauge G. A is the only farm, so its runoff I is the
 * natural flow.
 */
function input(a: Partial<NetworkNode>, need: number, days: number, between: NetworkNode[] = []): ModelInput {
	const apanMm = new Array(12).fill(0);
	apanMm[3] = need;
	const down = between.length ? between[0]!.id : 'G';
	return {
		settings: { apanMm: apanMm as never, effectiveRainFraction: 0, ewrPragmaticM3PerDay: flat(0) as never },
		model: {
			nodes: [node('G', 'gauge', null), ...between, node('A', 'farm', down, a)],
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 31_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(days).fill(0) } }
	};
}

const run = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));
const col = (o: ReturnType<typeof run>, id: string | null, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)?.values;
const passed = (o: ReturnType<typeof run>) => expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification!.checks.filter((c) => !c.passed))).toBe(true);

// A 10 000 m³ dam starting at 5000, half the farm's runoff into it (M), half below it (S).
const dam = { damCapacityM3: 10_000, damInitialPct: 0.5, pctRunoffToDam: 0.5 };

describe('supply rules (WP-3.8)', () => {
	it('dam first (the default) never pumps from the river; river first pumps from below the dam up to the pump, then the dam', () => {
		const natural = [1000, 4000, 0];
		const damFirst = run(input(dam, 2000, 3), natural);
		const riverFirst = run(input({ ...dam, supplyRule: 'riverFirst', pumpCapacityM3Day: 800 }, 2000, 3), natural);
		passed(damFirst);
		passed(riverFirst);
		// Dam first: S = 500, 2000, 0 all pass; the dam gives 2000 a day: 5000 + 500 − 2000, + 2000 − 2000, + 0 − 2000.
		expect(col(damFirst, 'A', 'river_abstraction')).toBeUndefined();
		expect(col(damFirst, 'A', 'dam_storage')).toEqual([3500, 3500, 1500]);
		expect(col(damFirst, 'A', 'outflow')).toEqual([500, 2000, 0]);
		// River first: the pump takes MIN(800, S) = 500, 800, 0; the dam the rest (1500, 1200, 2000).
		expect(col(riverFirst, 'A', 'river_abstraction')).toEqual([500, 800, 0]);
		expect(col(riverFirst, 'A', 'supplied')).toEqual([2000, 2000, 2000]);
		expect(col(riverFirst, 'A', 'dam_storage')).toEqual([4000, 4800, 2800]);
		expect(col(riverFirst, 'A', 'outflow')).toEqual([0, 1200, 0]);
		// The pump never exceeds its capacity (the binding day 2), and the dam keeps 1300 m³ more by the end.
		expect(riverFirst.summary.farms[0]).toMatchObject({ avgRiverAbstractionM3Day: 1300 / 3, avgSuppliedM3Day: 2000 });
		expect(damFirst.summary.farms[0]!.avgRiverAbstractionM3Day).toBeUndefined();
	});

	it('run of river: no dam and no storage; the pump takes the river up to its capacity and the rest is a deficit', () => {
		const natural = [1000, 4000, 0];
		// The dam split fields are ignored: everything passes below the (absent) dam.
		const o = run(input({ supplyRule: 'runOfRiver', pumpCapacityM3Day: 1500, pctRunoffToDam: 1, divertCapacityM3Day: 1e6 }, 2000, 3), natural);
		passed(o);
		expect(col(o, 'A', 'runoff_to_dam')).toEqual([0, 0, 0]);
		expect(col(o, 'A', 'diverted_to_dam')).toEqual([0, 0, 0]);
		expect(col(o, 'A', 'river_abstraction')).toEqual([1000, 1500, 0]);
		expect(col(o, 'A', 'deficit')).toEqual([1000, 500, 2000]);
		expect(col(o, 'A', 'dam_storage')).toEqual([0, 0, 0]);
		expect(col(o, 'A', 'spill')).toEqual([0, 0, 0]);
		expect(col(o, 'A', 'outflow')).toEqual([0, 2500, 0]);
		// Without a pump capacity only the flow limits it, and the run says so.
		const open = run(input({ supplyRule: 'runOfRiver' }, 2000, 3), natural);
		passed(open);
		expect(col(open, 'A', 'river_abstraction')).toEqual([1000, 2000, 0]);
		expect(open.summary.warnings.some((w) => w.includes('no river pump capacity is set'))).toBe(true);
		// A pump of 0 takes nothing.
		expect(col(run(input({ supplyRule: 'runOfRiver', pumpCapacityM3Day: 0 }, 2000, 3), natural), 'A', 'supplied')).toEqual([0, 0, 0]);
	});

	it('the b023 stand-in for a river pump (a dam-less "pool" taking all inflow) supplies like an unlimited run-of-river pump', () => {
		// What the importer copies today (issue #54 item 2d): capacity 0, all runoff "into the dam".
		const natural = [1000, 4000, 0];
		const pool = run(input({ pctRunoffToDam: 1 }, 2000, 3), natural);
		const ror = run(input({ supplyRule: 'runOfRiver' }, 2000, 3), natural);
		expect(col(pool, 'A', 'supplied')).toEqual(col(ror, 'A', 'supplied'));
		expect(col(pool, 'A', 'outflow')).toEqual(col(ror, 'A', 'outflow'));
		// But the pool reports what passed as a dam spill; run of river has none.
		expect(col(pool, 'A', 'spill')).toEqual([0, 2000, 0]);
		expect(col(ror, 'A', 'spill')).toEqual([0, 0, 0]);
	});

	it('trigger: the dam until it falls below the trigger, river first until it is back at the stop level', () => {
		// Trigger 40 % (4000 m³), stop 60 % (6000 m³), pump 1000 m³/day, 2000 m³/day demand.
		const a = { ...dam, supplyRule: 'trigger' as const, pumpCapacityM3Day: 1000, supplyTriggerPct: 0.4, supplyStopPct: 0.6 };
		const natural = [2000, 2000, 2000, 4000, 10_000, 2000];
		const o = run(input(a, 2000, natural.length), natural);
		passed(o);
		// Day 0: 5000 ≥ 4000, the dam: 5000 + 1000 − 2000 = 4000. Day 1: 4000 is not below 4000, the dam: 3000.
		// Day 2: 3000 < 4000, the river: pump MIN(1000, S 1000), the dam 1000: 3000. Day 3: pump 1000 of S 2000: 4000.
		// Day 4: 4000 is below the stop level, so still the river: 4000 + 5000 − 1000 = 8000.
		// Day 5: 8000 ≥ 6000, back to the dam: 8000 + 1000 − 2000 = 7000.
		expect(col(o, 'A', 'river_abstraction')).toEqual([0, 0, 1000, 1000, 1000, 0]);
		expect(col(o, 'A', 'dam_storage')).toEqual([4000, 3000, 3000, 4000, 8000, 7000]);
		expect(col(o, 'A', 'supplied')).toEqual([2000, 2000, 2000, 2000, 2000, 2000]);
		// The hysteresis in isolation: in river mode the stop level applies, on the dam the trigger.
		const s: PlanSupply = { rule: 2, pumpM3Day: 1000, triggerM3: 4000, stopM3: 6000 };
		expect([pumpsRiverToday(s, false, 5000), pumpsRiverToday(s, true, 5000), pumpsRiverToday(s, true, 6000), pumpsRiverToday(s, false, 3999)]).toEqual([false, true, false, true]);
	});

	it('the pump leaves the senior users’ requirement in the river', () => {
		// A senior user below A wants 600 m³/day; A (no dam, river first, no pump limit) may take only S − 600.
		const user = node('U', 'user', 'G', { userDemandM3Day: flat(600), userPriority: 'senior' });
		const o = run(input({ supplyRule: 'riverFirst' }, 2000, 2, [user]), [1000, 300]);
		passed(o);
		expect(col(o, 'A', 'river_abstraction')).toEqual([400, 0]);
		expect(col(o, 'U', 'supplied')).toEqual([600, 300]);
	});

	it('the pump never takes what a pass-inflow release is there to keep flowing', () => {
		// Keep 700 m³/day below the dam; S = 500, so the release adds 200 and the pump gets nothing.
		const a = { ...dam, damReleaseRule: 'passInflow' as const, damReleaseM3Day: flat(700), supplyRule: 'riverFirst' as const };
		const o = run(input(a, 2000, 2), [1000, 4000]);
		passed(o);
		// Day 1: S = 2000, the pump takes the 1300 above the 700.
		expect(col(o, 'A', 'river_abstraction')).toEqual([0, 1300]);
		expect(col(o, 'A', 'dam_release')).toEqual([200, 0]);
		expect(col(o, 'A', 'outflow')).toEqual([700, 700]);
	});

	it('with boreholes the river is part of the surface supply: primary groundwater, the river, the dam, then supplemental', () => {
		const natural = [1000, 3000];
		const prim = run(input({ supplyRule: 'riverFirst', pumpCapacityM3Day: 800, boreholeCapacityM3Day: 500, boreholeRule: 'primary' }, 2000, 2), natural);
		const supp = run(input({ supplyRule: 'riverFirst', pumpCapacityM3Day: 2000, boreholeCapacityM3Day: 500, boreholeRule: 'supplemental' }, 2000, 2), natural);
		passed(prim);
		passed(supp);
		expect(col(prim, 'A', 'groundwater_used')).toEqual([500, 500]);
		expect(col(prim, 'A', 'river_abstraction')).toEqual([800, 800]);
		expect(col(supp, 'A', 'river_abstraction')).toEqual([1000, 2000]);
		expect(col(supp, 'A', 'groundwater_used')).toEqual([500, 0]);
	});
});

describe('supplyOf (WP-3.8)', () => {
	const farm = (over: Partial<NetworkNode>) => node('F', 'farm', 'G', over);
	it('dam first, the default, has no plan; only a farm has a supply rule', () => {
		const w: string[] = [];
		expect(supplyOf(farm({}), w)).toEqual({});
		expect(supplyOf(farm({ supplyRule: 'damFirst', pumpCapacityM3Day: 500 }), w)).toEqual({});
		expect(w).toEqual([]);
		expect(supplyOf(node('U', 'user', 'G', { supplyRule: 'riverFirst' }), w)).toEqual({});
		expect(w[0]).toMatch(/only a farm has a supply rule/);
	});

	// Issue #54: a dam-less farm irrigates from the river routed to its (absent) dam with no limit; the run says so.
	it('warns about a dam-only farm with no dam that has river routed to it, and nothing else', () => {
		const warned = (over: Partial<NetworkNode>) => {
			const w: string[] = [];
			supplyOf(farm(over), w);
			return w;
		};
		for (const over of [{ pctUpstreamToDam: 1 }, { pctRunoffToDam: 0.3 }, { divertCapacityM3Day: 8640 }])
			expect(warned({ damCapacityM3: 0, ...over }), JSON.stringify(over)).toEqual([
				'farm "F": it has no dam, so what is routed to its dam (upstream inflow, runoff, diversion) is irrigated straight from the river, with no pump limit; to cap it, set the supply rule to run of river with a pump capacity'
			]);
		expect(warned({ damCapacityM3: 50_000, pctUpstreamToDam: 1 })).toEqual([]); // a real dam
		expect(warned({ damCapacityM3: 0 })).toEqual([]); // nothing routed to it
		expect(warned({ damCapacityM3: 0, pctUpstreamToDam: 1, supplyRule: 'runOfRiver', pumpCapacityM3Day: 500 })).toEqual([]); // capped
	});

	it('trigger without a dam and run of river with one run as river first, with a warning', () => {
		const w: string[] = [];
		expect(supplyOf(farm({ supplyRule: 'trigger', pumpCapacityM3Day: 10 }), w).supply!.rule).toBe(1);
		expect(supplyOf(farm({ supplyRule: 'runOfRiver', pumpCapacityM3Day: 10, damCapacityM3: 100 }), w).supply!.rule).toBe(1);
		expect(w).toHaveLength(2);
	});

	it('clamps the stop level to at least the trigger, and levels to [0, 1]', () => {
		const w: string[] = [];
		const s = supplyOf(farm({ supplyRule: 'trigger', pumpCapacityM3Day: 10, damCapacityM3: 1000, supplyTriggerPct: 0.5, supplyStopPct: 0.2 }), w).supply!;
		expect(s).toEqual({ rule: 2, pumpM3Day: 10, triggerM3: 500, stopM3: 500 });
		expect(w[0]).toMatch(/supply stop level 0.2 is outside \[0.5, 1\]/);
	});
});

describe('the default supply fields run exactly as before (WP-3.8)', () => {
	it('fields absent, or set to their defaults (with an inert pump capacity), give the same output to the bit', () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			const base = randomInput(seed, { maxDays: 300 });
			for (const n of base.model.nodes) {
				delete n.supplyRule;
				delete n.pumpCapacityM3Day;
				delete n.supplyTriggerPct;
				delete n.supplyStopPct;
			}
			const explicit = structuredClone(base);
			for (const n of explicit.model.nodes) Object.assign(n, SUPPLY_DEFAULTS, n.kind === 'farm' ? { pumpCapacityM3Day: 1234 } : {});
			const a = runModel(base);
			expect(sameOutput(a, runModel(explicit)), `seed ${seed}`).toBe(true);
			expect(a.series.some((s) => s.key === 'river_abstraction'), `seed ${seed}`).toBe(false);
		}
	});
});

describe('the invariants see the river pump (WP-3.8)', () => {
	it('the random networks pump from the river, and every invariant holds there', () => {
		let pumping = 0;
		for (let seed = 1; seed < 400 && pumping < 6; seed++) {
			const x = randomInput(seed, { maxDays: 300 });
			if (!x.model.nodes.some((n) => n.supplyRule && n.supplyRule !== 'damFirst')) continue;
			const out = runModel(x);
			if (!out.series.some((s) => s.key === 'river_abstraction' && s.values.some((v) => v > 0))) continue;
			pumping++;
			expect(checkInvariants(x, out), `seed ${seed}`).toBeNull();
		}
		expect(pumping).toBe(6);
	});

	it('catch a pump above its capacity, water taken that must pass, and a run-of-river farm that stores', () => {
		const i = input({ ...dam, supplyRule: 'riverFirst', pumpCapacityM3Day: 800 }, 2000, 3);
		const out = runModelWith(i, () => ({ naturalFlowM3Day: [1000, 4000, 0] }));
		expect(checkInvariants(i, out)).toBeNull();
		const edit = (key: string, f: (v: number[]) => void) => {
			const o = structuredClone(out);
			f(o.series.find((s) => s.nodeId === 'A' && s.key === key)!.values);
			return o;
		};
		expect(checkInvariants(i, edit('river_abstraction', (v) => (v[1] = 900)))).toMatch(/pump capacity|balance/);
		// Day 0: S = 500; 600 is more than flows below the dam.
		const tight = { ...i, model: { ...i.model, nodes: i.model.nodes.map((n) => (n.id === 'A' ? { ...n, pumpCapacityM3Day: 5000 } : n)) } };
		const out2 = runModelWith(tight, () => ({ naturalFlowM3Day: [1000, 4000, 0] }));
		const o2 = structuredClone(out2);
		o2.series.find((s) => s.nodeId === 'A' && s.key === 'river_abstraction')!.values[0] = 600;
		expect(checkInvariants(tight, o2)).toMatch(/more than the 500 below the dam|balance/);
		// Run of river on a dam-less farm: any storage breaks it.
		const r = input({ supplyRule: 'runOfRiver', pumpCapacityM3Day: 1500 }, 2000, 3);
		const outR = runModelWith(r, () => ({ naturalFlowM3Day: [1000, 4000, 0] }));
		expect(checkInvariants(r, outR)).toBeNull();
		const oR = structuredClone(outR);
		oR.series.find((s) => s.nodeId === 'A' && s.key === 'dam_storage')!.values[1] = 10;
		expect(checkInvariants(r, oR)).toMatch(/storage|balance/);
	});
});
