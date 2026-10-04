// A water source per demand (engine ≥ 1.65.0, issue #344, docs/model.md
// §2.7j): river abstractions beside a unit's dam, each with its own pump and
// an optional pool. Hand-worked cases on a fixed natural flow, the default
// (no water source) running to the bit as before, and a resumed run.
import { describe, expect, it } from 'vitest';
import { estimatedDamAreaM2, type DemandObject, type ModelInput, type NetworkNode } from './project';
import { runModelWith, runModelWithoutChecks, withVerification } from './run';
import { randomInput } from './testing/fuzz';
import { sameOutput } from './testing/invariants';
import { checkResume } from './testing/warmstartInvariants';
import { poolLosses, riverSourcesOf } from './network/riverSource';
import { diffInputs } from './compare';
import { modelRuleIssues } from './modelRules';
import { applyScenario } from './scenario/overrides';

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
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const flat = (v: number) => new Array(12).fill(v) as number[];

/** A demand object on unit A: `m3Day` every day, all year, internal with no return, 'shared' unless said. */
function obj(id: string, m3Day: number, over: Partial<DemandObject> = {}): DemandObject {
	return {
		id,
		nodeId: 'A',
		name: id,
		category: 'industrial',
		sizing: 'monthly',
		monthlyM3Day: flat(m3Day),
		count: null,
		litresPerUnitDay: null,
		lossPct: 0,
		monthlyFactor: null,
		returnPct: 0,
		priority: 'shared',
		destination: 'internal',
		enabled: true,
		note: '',
		...over
	};
}

/**
 * A January run of dry days. Unit A (the only farm, so its runoff I is the
 * natural flow) drains into the outlet gauge G. Its crops need `need` m³/day
 * (31 000 m² of a crop with factor 1 and the January A-pan set to the need,
 * efficiency 1, no effective rain; 0 = no crops and no A-pan, so a pool
 * doesn't evaporate), and it carries the demand objects `objects`.
 */
function input(a: Partial<NetworkNode>, objects: DemandObject[], need: number, days: number): ModelInput {
	const apanMm = new Array(12).fill(0);
	apanMm[3] = need;
	return {
		settings: { apanMm: apanMm as never, effectiveRainFraction: 0, ewrPragmaticM3PerDay: flat(0) as never },
		model: {
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', a)],
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: need > 0 ? [{ nodeId: 'A', cropId: 'c', areaM2: 31_000 }] : [],
			transfers: [],
			...(objects.length ? { demandObjects: objects } : {})
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(days).fill(0) } }
	};
}

const run = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));
const col = (o: ReturnType<typeof run>, id: string | null, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)?.values;
const passed = (o: ReturnType<typeof run>) => expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification!.checks.filter((c) => !c.passed))).toBe(true);
const close = (got: readonly number[] | undefined, want: number[]) => {
	expect(got).toBeDefined();
	got!.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(want[t]!, 6));
};

// A 10 000 m³ dam starting at 5000, half the unit's runoff into it (M), half below it (S).
const dam = { damCapacityM3: 10_000, damInitialPct: 0.5, pctRunoffToDam: 0.5 };

describe('water source per demand (engine 1.65.0, docs/model.md §2.7j)', () => {
	it('absent, null or "dam" runs to the bit as before, with a pump and pool on a dam-sourced demand inert', () => {
		for (let seed = 1; seed <= 30; seed++) {
			const base = randomInput(seed);
			for (const n of base.model.nodes) {
				delete n.cropWaterSource;
				delete n.cropRiverPumpM3Day;
				delete n.cropRiverPoolM3;
			}
			for (const o of base.model.demandObjects ?? []) {
				delete o.waterSource;
				delete o.riverPumpM3Day;
				delete o.riverPoolM3;
			}
			const dammed = structuredClone(base);
			for (const n of dammed.model.nodes) Object.assign(n, { cropWaterSource: 'dam', cropRiverPumpM3Day: 123, cropRiverPoolM3: 4567 });
			for (const o of dammed.model.demandObjects ?? []) Object.assign(o, { waterSource: seed % 2 ? 'dam' : null, riverPumpM3Day: 89, riverPoolM3: 1000 });
			expect(sameOutput(runModelWithoutChecks(base), runModelWithoutChecks(dammed)), `seed ${seed}`).toBe(true);
		}
	});

	it('a river abstraction beside the dam takes from the flow below it, up to its pump, and never touches the dam', () => {
		const natural = [1000, 4000, 0];
		const town = obj('town', 600, { waterSource: 'river', riverPumpM3Day: 500 });
		const onDam = run(input(dam, [], 2000, 3), natural);
		const both = run(input(dam, [town], 2000, 3), natural);
		passed(both);
		// The dam serves the crops alone, as without the town: S = 500, 2000, 0; the dam gives 2000 a day.
		expect(col(both, 'A', 'dam_storage')).toEqual(col(onDam, 'A', 'dam_storage'));
		expect(col(both, 'A', 'dam_storage')).toEqual([3500, 3500, 1500]);
		// The town pumps MIN(600, its 500 m³/day pump, the flow below the dam).
		close(col(both, 'A', 'river_take@town'), [500, 500, 0]);
		close(col(both, 'A', 'object_supplied@town'), [500, 500, 0]);
		close(col(both, 'A', 'supplied'), [2500, 2500, 2000]);
		close(col(both, 'A', 'outflow'), [0, 1500, 0]);
		// The unit's own supply-rule pump is the dam side's: there is none here.
		expect(col(both, 'A', 'river_abstraction')).toBeUndefined();
		const f = both.summary.farms.find((x) => x.nodeId === 'A')!;
		// Day 1 the river had 2000 below the dam and the pump took 500 of the town's 600: 100 pump-limited (engine ≥ 1.66.0).
		close(col(both, 'A', 'river_pump_limited@town'), [0, 100, 0]);
		expect(f.riverTakes).toEqual([{ key: 'town', name: 'town', avgTakeM3Day: 1000 / 3, pumpM3Day: 500, avgPumpLimitedM3Day: 100 / 3, daysPumpLimited: 1 }]);
	});

	it('the crops on the river leave the dam to the demand objects on it', () => {
		const natural = [1000, 4000, 0];
		const o = run(input({ ...dam, cropWaterSource: 'river', cropRiverPumpM3Day: null }, [obj('mine', 300)], 2000, 3), natural);
		passed(o);
		// The dam gives the mine its 300: 5000 + 500 − 300, + 2000 − 300, − 300. The crops pump S, uncapped.
		close(col(o, 'A', 'dam_storage'), [5200, 6900, 6600]);
		close(col(o, 'A', 'river_take@crops'), [500, 2000, 0]);
		close(col(o, 'A', 'object_supplied@mine'), [300, 300, 300]);
		expect(o.summary.warnings.some((w) => /the crops' river abstraction: no river pump capacity is set/.test(w))).toBe(true);
	});

	it('a full dam’s spill reaches the river abstraction the same day', () => {
		// All the runoff into a full dam, which spills it; the abstraction below takes 600 of the 1000 spilled.
		const full = { damCapacityM3: 10_000, damInitialPct: 1, pctRunoffToDam: 1 };
		const o = run(input(full, [obj('town', 600, { waterSource: 'river', riverPumpM3Day: null })], 0, 2), [1000, 0]);
		passed(o);
		close(col(o, 'A', 'spill'), [1000, 0]);
		close(col(o, 'A', 'river_take@town'), [600, 0]);
		close(col(o, 'A', 'outflow'), [400, 0]);
	});

	it('leaves the unit’s hands-off flow in the river', () => {
		const full = { damCapacityM3: 10_000, damInitialPct: 1, pctRunoffToDam: 1, handsOffM3Day: flat(700) };
		const o = run(input(full, [obj('town', 600, { waterSource: 'river', riverPumpM3Day: null })], 0, 1), [1000]);
		passed(o);
		close(col(o, 'A', 'river_take@town'), [300]);
		close(col(o, 'A', 'outflow'), [700]);
	});

	it('shares the river by supply level: first, then the crops with shared pro rata, then last', () => {
		const objects = [
			obj('first', 600, { priority: 'first', waterSource: 'river', riverPumpM3Day: null }),
			obj('s1', 400, { waterSource: 'river', riverPumpM3Day: null }),
			obj('s2', 800, { waterSource: 'river', riverPumpM3Day: null }),
			obj('last', 600, { priority: 'last', waterSource: 'river', riverPumpM3Day: null })
		];
		// No dam: all 1200 passes the unit. 'first' 600; the shared pair 600 of their 1200, pro rata; 'last' none.
		const o = run(input({}, objects, 0, 1), [1200]);
		passed(o);
		close(col(o, 'A', 'river_take@first'), [600]);
		close(col(o, 'A', 'river_take@s1'), [200]);
		close(col(o, 'A', 'river_take@s2'), [400]);
		close(col(o, 'A', 'river_take@last'), [0]);
		close(col(o, 'A', 'outflow'), [0]);
		// A pump below its share takes no more; the rest of the level's flow goes on to the next level.
		const capped = run(input({}, [{ ...objects[0]!, riverPumpM3Day: 100 }, objects[3]!], 0, 1), [1200]);
		passed(capped);
		close(col(capped, 'A', 'river_take@first'), [100]);
		close(col(capped, 'A', 'river_take@last'), [600]);
	});

	it('draws its pool down once the flow it may take is used, and refills it from the flow left', () => {
		// A pool of 1000 m³ (no A-pan, so no evaporation), a demand of 500 a day, no pump limit.
		const town = obj('town', 500, { waterSource: 'river', riverPumpM3Day: null, riverPoolM3: 1000 });
		const o = run(input({}, [town], 0, 5), [200, 0, 0, 2000, 1200]);
		passed(o);
		// Day 0: 200 from the flow, 300 from the pool (700 left); day 1: 500 (200 left); day 2: the last 200;
		// day 3: 500 from the flow, then 1000 refills the pool and 500 flows on; day 4: 500, the pool full, 700 on.
		close(col(o, 'A', 'river_take@town'), [500, 500, 200, 500, 500]);
		close(col(o, 'A', 'river_pool@town'), [700, 200, 0, 1000, 1000]);
		close(col(o, 'A', 'river_pool_evaporation@town'), [0, 0, 0, 0, 0]);
		close(col(o, 'A', 'outflow'), [0, 0, 0, 500, 700]);
		const f = o.summary.farms.find((x) => x.nodeId === 'A')!;
		expect(f.riverTakes![0]!.poolM3).toBe(1000);
		expect(f.riverTakes![0]!.avgPoolStorageM3).toBeCloseTo(2900 / 5, 9);
		// The pool's start (full) and end are in the water balance's storage, so it closes.
		expect(Math.abs(o.summary.waterBalance!.total.residualM3)).toBeLessThan(1e-6);
		expect(o.summary.waterBalance!.total.openingStorageM3).toBeCloseTo(1000, 9);
		expect(o.summary.waterBalance!.total.closingStorageM3).toBeCloseTo(1000, 9);
		expect(o.summary.waterBalance!.total.poolEvaporationM3).toBe(0);
	});

	it('a pool evaporates from the surface its start-of-day storage covers, estimated from its capacity', () => {
		const pool = riverSourcesOf(node('A', 'farm', 'G', { cropWaterSource: 'river', cropRiverPoolM3: 50_000 }), undefined, []).river!.takes[0]!.pool!;
		expect(pool).toEqual({ capM3: 50_000, areaFullM2: estimatedDamAreaM2(50_000) });
		const [A, E] = poolLosses(pool, 25_000, 6);
		expect(A).toBeCloseTo(pool.areaFullM2 * Math.pow(0.5, 0.7), 9);
		expect(E).toBeCloseTo((6 * A) / 1000, 9);
		// Never more than it holds, nothing from an empty one.
		expect(poolLosses(pool, 1e-6, 1e6)[1]).toBe(1e-6);
		expect(poolLosses(pool, 0, 6)).toEqual([0, 0]);
		// In a run: crops on the river (the January A-pan, so the pool evaporates), checked by the self-checks.
		const o = run(input({ cropWaterSource: 'river', cropRiverPumpM3Day: 1000, cropRiverPoolM3: 50_000 }, [], 2000, 4), [0, 0, 3000, 0]);
		passed(o);
		expect(col(o, 'A', 'river_pool_evaporation@crops')![0]!).toBeGreaterThan(0);
		expect(o.summary.waterBalance!.total.poolEvaporationM3!).toBeGreaterThan(0);
		expect(Math.abs(o.summary.waterBalance!.total.residualM3)).toBeLessThan(1e-6);
	});

	it('a run resumed part-way keeps each pool where it was, to the bit', () => {
		const town = obj('town', 500, { waterSource: 'river', riverPumpM3Day: 800, riverPoolM3: 1000 });
		const i = input({ ...dam, cropWaterSource: 'river', cropRiverPumpM3Day: 300, cropRiverPoolM3: 400 }, [town], 2000, 40);
		i.series.rain_catchment_mm!.values = Array.from({ length: 40 }, (_, t) => (t % 9 === 0 ? 30 : 0));
		for (const k of [1, 7, 20]) expect(checkResume(i, k)).toBeNull();
	});

	it('records the demand each pump left unmet while the river or its pool had it (engine 1.66.0)', () => {
		// 'first' (pump 100) ranks above 'last': the 1100 its level leaves was there for it, so 500 of its 600 is
		// pump-limited although 'last' then takes 600 of that flow. 'last' (no pump limit) has no such series.
		const objects = [obj('first', 600, { priority: 'first', waterSource: 'river', riverPumpM3Day: 100 }), obj('last', 600, { priority: 'last', waterSource: 'river', riverPumpM3Day: null })];
		const o = run(input({}, objects, 0, 2), [1200, 50]);
		passed(o);
		close(col(o, 'A', 'river_take@first'), [100, 50]);
		// Day 1: 50 in the river, pump not spent: the river is what limited it.
		close(col(o, 'A', 'river_pump_limited@first'), [500, 0]);
		expect(col(o, 'A', 'river_pump_limited@last')).toBeUndefined();
		const f = o.summary.farms.find((x) => x.nodeId === 'A')!;
		expect(f.riverTakes!.map((k) => [k.key, k.avgPumpLimitedM3Day, k.daysPumpLimited])).toEqual([
			['first', 250, 1],
			['last', undefined, undefined]
		]);
		// A pool counts: a dry river, a 300 m³/day pump drawing a 1000 m³ pool, 200 of the 500 left unmet while 700 is held.
		const pooled = run(input({}, [obj('town', 500, { waterSource: 'river', riverPumpM3Day: 300, riverPoolM3: 1000 })], 0, 1), [0]);
		passed(pooled);
		close(col(pooled, 'A', 'river_take@town'), [300]);
		close(col(pooled, 'A', 'river_pool@town'), [700]);
		close(col(pooled, 'A', 'river_pump_limited@town'), [200]);
		// A pump of 0 (no pump: a demand that can't pump) leaves all of it unmet while the river has it, never more
		// than the river had: read it as "the river had this and there is no pump", not as a pump too small.
		const none = run(input({}, [obj('town', 600, { waterSource: 'river', riverPumpM3Day: 0 })], 0, 2), [1000, 250]);
		passed(none);
		close(col(none, 'A', 'river_take@town'), [0, 0]);
		close(col(none, 'A', 'river_pump_limited@town'), [600, 250]);
		// Its own unit's dam side and the pump-limited figure change nothing else: the outflow is the run's without it.
		close(col(none, 'A', 'outflow'), [1000, 250]);
	});

	it('the self-checks catch a pump-limited figure on a day the pump had room, above the shortfall, or above what the river had left', () => {
		const make = () => input({}, [obj('town', 600, { waterSource: 'river', riverPumpM3Day: 500 })], 0, 3);
		for (const [day, v] of [
			[0, 50],
			[1, 150],
			[2, 100]
		] as const) {
			// Day 0 the river had only 300 (pump not spent); day 1 the shortfall is 100; day 2 the river's 500 and
			// the pump ran out together, so nothing was left for it (an overstated figure, the costlier mistake).
			const o = run(make(), [300, 1000, 500]);
			passed(o);
			o.series.find((x) => x.key === 'river_pump_limited@town')!.values[day] = v;
			const again = withVerification(make(), { ...o, summary: { ...o.summary, verification: undefined } });
			expect(again.summary.verification!.passed, `day ${day}`).toBe(false);
		}
	});

	it('the self-checks catch a take tampered above its pump', () => {
		const o = run(input({}, [obj('town', 600, { waterSource: 'river', riverPumpM3Day: 500 })], 0, 2), [1000, 1000]);
		passed(o);
		const s = o.series.find((x) => x.key === 'river_take@town')!;
		s.values[1] = 550;
		const sup = o.series.find((x) => x.nodeId === 'A' && x.key === 'object_supplied@town')!;
		sup.values[1] = 550;
		const again = withVerification(input({}, [obj('town', 600, { waterSource: 'river', riverPumpM3Day: 500 })], 0, 2), { ...o, summary: { ...o.summary, verification: undefined } });
		expect(again.summary.verification!.passed).toBe(false);
	});

	it('save rules: a known source, sizes ≥ 0, the crops’ source on a unit only; a scenario sets and the run comparison lists them', () => {
		const ok = input({ cropWaterSource: 'river', cropRiverPumpM3Day: 0, cropRiverPoolM3: null }, [obj('mill', 40, { waterSource: 'river', riverPumpM3Day: 480, riverPoolM3: 3000 })], 0, 2);
		expect([...modelRuleIssues(ok.model).values()]).toEqual([]);
		const bad = structuredClone(ok);
		bad.model.nodes[0]!.cropWaterSource = 'river';
		Object.assign(bad.model.nodes[1]!, { cropRiverPumpM3Day: -1 });
		Object.assign(bad.model.demandObjects![0]!, { waterSource: 'well', riverPoolM3: Number.NaN });
		const issues = modelRuleIssues(bad.model);
		expect([...issues.keys()].sort()).toEqual(['cropRiverPump:A', 'cropSourceKind:G', 'riverPool:mill', 'waterSource:mill']);
		// A scenario moves the mill back to the dam and gives the crops a pool; the comparison lists both.
		const s = applyScenario(ok, [
			{ op: 'demandObject.set', demandObjectId: 'mill', field: 'waterSource', value: null },
			{ op: 'node.set', nodeId: 'A', field: 'cropRiverPoolM3', value: 2000 }
		]);
		expect(s.problems).toEqual([]);
		const texts = diffInputs({ settings: ok.settings, model: ok.model, series: {} }, { settings: s.input.settings, model: s.input.model, series: {} }).map((c) => c.text);
		expect(texts.some((t) => /crops’ pool at the river pump none → 2\s000 m³/.test(t))).toBe(true);
		expect(texts.some((t) => /demand object "mill".*from a river abstraction \(pump 480 m³\/day, pool 3\s000 m³\) → .*from the unit’s supply \(a river pump 480 m³\/day, pool 3\s000 m³ kept, unused\)/.test(t))).toBe(true);
	});
});

describe('a run with no A-pan on any day warns that open water evaporates nothing (engine 1.67.0, persona-hydrologist round 4)', () => {
	const WARN = /A-pan evaporation is 0 on every day, so the dams and river pools lose nothing to evaporation/;
	const warned = (i: ModelInput) => runModelWith(i, () => ({ naturalFlowM3Day: [1000, 1000] })).summary.warnings.some((w) => WARN.test(w));

	it('on a unit with a dam, or a river abstraction with a pool', () => {
		expect(warned(input(dam, [], 0, 2))).toBe(true);
		expect(warned(input({}, [obj('town', 100, { waterSource: 'river', riverPumpM3Day: null, riverPoolM3: 500 })], 0, 2))).toBe(true);
		expect(warned(input({ cropWaterSource: 'river', cropRiverPumpM3Day: null, cropRiverPoolM3: 500 }, [], 0, 2))).toBe(true);
	});

	it('not with an A-pan on some day, nor without a dam or a pool', () => {
		// The January A-pan set (input's `need`): the dam evaporates, nothing to say.
		expect(warned(input(dam, [], 50, 2))).toBe(false);
		// A daily A-pan series covers it as well as the monthly row.
		const daily = input(dam, [], 0, 2);
		daily.series.evap_apan_mm = { startDate: '2021-01-01', values: [5, 5] };
		expect(warned(daily)).toBe(false);
		expect(warned(input({}, [obj('town', 100, { waterSource: 'river', riverPumpM3Day: null })], 0, 2))).toBe(false);
		// A pool on a demand that draws on the dam is inert: no pool.
		expect(warned(input({}, [obj('town', 100, { riverPoolM3: 500 })], 0, 2))).toBe(false);
	});
});
