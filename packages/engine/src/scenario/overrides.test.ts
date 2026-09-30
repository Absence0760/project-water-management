// Scenario overrides (roadmap WP-3.2): each op applies, bad targets become
// problems, node.remove keeps a valid tree, the base is never mutated, the
// classifier's rules, the validator, and a dam raise run end to end.
// Synthetic catchment: invented names and values only (public repo).
import { describe, expect, it } from 'vitest';
import { monthOfEpochDay, toEpochDay } from '../calendar';
import { diffInputs } from '../compare';
import { buildTopology } from '../network/topology';
import { blankEwrRuleTable, type EwrRuleTable } from '../reserve/rules';
import { runModel } from '../run';
import type { ModelInput, NetworkNode, RunSeries } from '../project';
import type { AllocationEntry } from '../allocations/compare';
import { scrambleOrder } from '../testing/fuzz';
import { checkAll } from '../testing/invariants';
import { MASKED_RULE, applyScenario, cloneData, classifyOp, classifyScenario, scenarioSteps, type ScenarioMask } from './overrides';
import { structureIssues } from './structure';
import { validateScenarioOps, type ScenarioOp } from './ops';

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Farm ${id}`,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 5,
		areaHiKm2: 2.5,
		areaLoKm2: 2.5,
		flowShareManual: null,
		pctUpstreamToDam: 0.5,
		pctRunoffToDam: 0.8,
		damCapacityM3: 0,
		damInitialPct: 0.5,
		damMinPct: 0,
		divertCapacityM3Day: 5000,
		irrigationEfficiency: 0.8,
		lossReturnFraction: 0,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

/** Outlet gauge G; farms A (dam) and B drain into it; farm C drains into A. */
function base(): ModelInput {
	const days = 500;
	const rain = Array.from({ length: days }, (_, t) => (t % 17 === 0 ? 40 : t % 5 === 0 ? 6 : 0));
	return {
		settings: {
			apanMm: [150, 180, 210, 220, 190, 160, 110, 80, 60, 60, 80, 110],
			ewrPragmaticM3PerDay: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			ewrRules: [blankEwrRuleTable('G'), blankEwrRuleTable('A')]
		},
		model: {
			nodes: [
				node('G', { name: 'Outlet gauge', kind: 'gauge', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, divertCapacityM3Day: 0 }),
				node('A', { downstreamNodeId: 'G', damCapacityM3: 200_000, sortOrder: 1 }),
				node('B', { downstreamNodeId: 'G', sortOrder: 2 }),
				node('C', { downstreamNodeId: 'A', damCapacityM3: 50_000, sortOrder: 3 })
			],
			crops: [{ id: 'c1', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: [
				{ nodeId: 'A', cropId: 'c1', areaM2: 400_000 },
				{ nodeId: 'C', cropId: 'c1', areaM2: 200_000 }
			],
			transfers: [{ id: 't1', fromNodeId: 'C', toNodeId: 'A', months: [1, 2, 3], maxRateM3s: 0.05, dailyCapM3: null, minStoragePct: 0.2, enabled: true, priority: 0 }],
			landCover: [{ id: 'lc1', nodeId: 'B', coverClass: 'pine', areaKm2: 1, densityPct: 0.5, factors: null }]
		},
		series: { rain_catchment_mm: { startDate: '2020-10-01', values: rain } }
	};
}

function deepFreeze<T>(v: T): T {
	if (v && typeof v === 'object') {
		for (const x of Object.values(v)) deepFreeze(x);
		Object.freeze(v);
	}
	return v;
}

const one = (op: ScenarioOp, b = base()) => applyScenario(b, [op]);
const nodeOf = (x: ModelInput, id: string) => x.model.nodes.find((n) => n.id === id);

describe('applyScenario: each op', () => {
	it('node.set changes one whitelisted field', () => {
		const r = one({ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 240_000 });
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'A')!.damCapacityM3).toBe(240_000);
		expect(r.applied).toHaveLength(1);
	});

	it('a dam enlarged or shrunk by node.set keeps its own area–volume relation (engine 1.10.0, model.md §2.13)', () => {
		const set = (id: string, field: string, value: unknown) => ({ op: 'node.set', nodeId: id, field, value }) as ScenarioOp;
		// Estimated area (capacity ÷ 3 m): doubling 100 000 m³ gives 33 333 × 2^0.7 = 54 150 m², not 66 667.
		const b = base();
		nodeOf(b, 'A')!.damCapacityM3 = 100_000;
		const r = applyScenario(b, [set('A', 'damCapacityM3', 200_000)]);
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'A')!.damAreaFullM2).toBeCloseTo((100_000 / 3) * 2 ** 0.7, 6);
		expect(r.applied[0]!.notes[0]).toMatch(/33333 → 54150 m² .*from the capacity ÷ 3 m estimate/);
		// An entered area and exponent: A_full × ratio^b; the same capacity changes nothing.
		const e = base();
		Object.assign(nodeOf(e, 'A')!, { damAreaFullM2: 50_000, damAreaExponent: 0.8 });
		expect(nodeOf(applyScenario(e, [set('A', 'damCapacityM3', 100_000)]).input, 'A')!.damAreaFullM2).toBeCloseTo(50_000 * 0.5 ** 0.8, 6);
		const same = applyScenario(e, [set('A', 'damCapacityM3', 200_000)]);
		expect(nodeOf(same.input, 'A')!.damAreaFullM2).toBe(50_000);
		expect(same.applied[0]!.notes).toEqual([]);
		// A later area op sets the new dam's own area; an earlier one is resized with the dam.
		expect(nodeOf(applyScenario(e, [set('A', 'damCapacityM3', 400_000), set('A', 'damAreaFullM2', 70_000)]).input, 'A')!.damAreaFullM2).toBe(70_000);
		expect(nodeOf(applyScenario(e, [set('A', 'damAreaFullM2', 70_000), set('A', 'damCapacityM3', 400_000)]).input, 'A')!.damAreaFullM2).toBeCloseTo(70_000 * 2 ** 0.8, 6);
		// A new dam (from 0) keeps an unknown area unknown.
		expect(nodeOf(applyScenario(base(), [set('B', 'damCapacityM3', 10_000)]).input, 'B')!.damAreaFullM2).toBeNull();
		// A survey curve: cut when smaller, extrapolated (and said so) when larger.
		const c = base();
		nodeOf(c, 'A')!.damCurve = [
			{ levelM: 0, areaM2: 0, volumeM3: 0 },
			{ levelM: 4, areaM2: 40_000, volumeM3: 100_000 },
			{ levelM: 7, areaM2: 60_000, volumeM3: 200_000 }
		];
		const cut = applyScenario(c, [set('A', 'damCapacityM3', 150_000)]);
		expect(nodeOf(cut.input, 'A')!.damCurve!.at(-1)).toEqual({ levelM: 5.5, areaM2: 50_000, volumeM3: 150_000 });
		expect(cut.applied[0]!.notes[0]).toMatch(/cut at 150000 m³/);
		const up = applyScenario(c, [set('A', 'damCapacityM3', 400_000)]);
		expect(nodeOf(up.input, 'A')!.damCurve).toHaveLength(4);
		expect(nodeOf(up.input, 'A')!.damCurve!.at(-1)!.areaM2).toBeCloseTo(60_000 * 2 ** (Math.log(1.5) / Math.log(2)), 6);
		expect(up.applied[0]!.notes[0]).toMatch(/extrapolated beyond the survey/);
		// The base is never touched.
		expect(nodeOf(c, 'A')!.damCurve).toHaveLength(3);
	});

	it('node.set sets a dam survey curve, so a raise can carry the enlarged dam’s own survey (engine 1.20.0)', () => {
		const set = (id: string, field: string, value: unknown) => ({ op: 'node.set', nodeId: id, field, value }) as ScenarioOp;
		const surveyed = [
			{ levelM: 0, areaM2: 0, volumeM3: 0 },
			{ levelM: 4, areaM2: 45_000, volumeM3: 150_000 },
			{ levelM: 9, areaM2: 80_000, volumeM3: 400_000 }
		];
		const c = base();
		nodeOf(c, 'A')!.damCurve = [
			{ levelM: 0, areaM2: 0, volumeM3: 0 },
			{ levelM: 7, areaM2: 60_000, volumeM3: 200_000 }
		];
		deepFreeze(c);
		// The raise's own survey, before or after the capacity op: kept as entered either way, not resized.
		for (const ops of [
			[set('A', 'damCapacityM3', 400_000), set('A', 'damCurve', surveyed)],
			[set('A', 'damCurve', surveyed), set('A', 'damCapacityM3', 400_000)]
		]) {
			const r = applyScenario(c, ops);
			expect(r.problems).toEqual([]);
			expect(nodeOf(r.input, 'A')!.damCurve).toEqual(surveyed);
			expect(nodeOf(r.input, 'A')!.damCapacityM3).toBe(400_000);
		}
		expect(applyScenario(c, [set('A', 'damCurve', surveyed), set('A', 'damCapacityM3', 400_000)]).applied[1]!.notes[0]).toMatch(/survey curve left as it is: its top is within 1 % of the new capacity/);
		// So is the base's own curve for a change within 1 % (before 1.20.0 it was stretched by the 0.75 %).
		const small = applyScenario(c, [set('A', 'damCapacityM3', 201_500)]);
		expect(nodeOf(small.input, 'A')!.damCurve).toEqual(nodeOf(c, 'A')!.damCurve);
		expect(small.applied[0]!.notes[0]).toMatch(/left as it is/);
		// A curve set before the capacity op that fits the old capacity described the old dam, so it is resized with it (as an earlier area op is).
		const redrawn = surveyed.map((r) => ({ ...r, volumeM3: r.volumeM3 / 2 }));
		expect(nodeOf(applyScenario(c, [set('A', 'damCurve', redrawn), set('A', 'damCapacityM3', 100_000)]).input, 'A')!.damCurve!.at(-1)!.volumeM3).toBe(100_000);
		// null goes back to the power law; the op is copied, so a later edit of it can't reach the scenario's input.
		expect(nodeOf(applyScenario(c, [set('A', 'damCurve', null)]).input, 'A')!.damCurve).toBeNull();
		const op = set('A', 'damCurve', structuredClone(surveyed));
		const r = applyScenario(c, [op]);
		((op as { value: { areaM2: number }[] }).value[1]!).areaM2 = 1;
		expect(nodeOf(r.input, 'A')!.damCurve![1]!.areaM2).toBe(45_000);
		// Rows that aren't three numbers are refused by the op check; a curve that isn't usable by the model rules.
		expect(one(set('A', 'damCurve', [{ levelM: 0, areaM2: -1, volumeM3: 0 }])).problems[0]).toMatch(/damCurve must be up to 200 rows/);
		expect(one(set('A', 'damCurve', [{ levelM: 0, areaM2: 1, volumeM3: 0, note: 'x' }])).problems[0]).toMatch(/damCurve must be/);
		expect(one(set('A', 'damCurve', [surveyed[1]])).problems[0]).toMatch(/dam survey curve: a survey curve needs at least two rows/);
		expect(one(set('B', 'damCurve', surveyed)).problems).toEqual([]);
		expect(one(set('G', 'damCurve', surveyed)).problems[0]).toMatch(/can't be set on a gauge/);
		// It runs: the scenario's dam fills along the survey it carries.
		const raised = applyScenario(c, [set('A', 'damCapacityM3', 400_000), set('A', 'damCurve', surveyed)]).input;
		expect(checkAll(raised)).toBeNull();
		expect(runModel(raised).summary.warnings.join(' ')).not.toMatch(/survey/);
	});

	it('node.set rejects a missing node, a field the kind lacks and an out-of-range value', () => {
		expect(one({ op: 'node.set', nodeId: 'nope', field: 'damCapacityM3', value: 1 }).problems[0]).toMatch(/op 1 \(node\.set\): node nope not found/);
		expect(one({ op: 'node.set', nodeId: 'G', field: 'damCapacityM3', value: 1 }).problems[0]).toMatch(/can't be set on a gauge/);
		expect(one({ op: 'node.set', nodeId: 'A', field: 'damInitialPct', value: 1.5 }).problems[0]).toMatch(/at most 1/);
		// Not a field at all (a caller bypassing the types): refused, not written.
		const r = one({ op: 'node.set', nodeId: 'A', field: 'downstreamNodeId', value: 'B' } as unknown as ScenarioOp);
		expect(r.problems).toHaveLength(1);
		expect(nodeOf(r.input, 'A')!.downstreamNodeId).toBe('G');
	});

	it('node.set refuses a duplicate name (compare matches by name across copies)', () => {
		const r = one({ op: 'node.set', nodeId: 'A', field: 'name', value: 'farm b' });
		expect(r.problems[0]).toMatch(/duplicate node name/);
		expect(nodeOf(r.input, 'A')!.name).toBe('Farm A');
	});

	it('refuses flow shares over 100 % (the run would refuse them) and takes ones that fit', () => {
		const b = base();
		b.settings = { ...b.settings, flowShareMethod: 'manual' };
		for (const [id, v] of [['A', 0.4], ['B', 0.3], ['C', 0.3]] as const) nodeOf(b, id)!.flowShareManual = v;
		const r = one({ op: 'node.set', nodeId: 'A', field: 'flowShareManual', value: 0.9 }, b);
		expect(r.problems[0]).toMatch(/flow shares sum to 150\.00%, more than 100%/);
		expect(nodeOf(r.input, 'A')!.flowShareManual).toBe(0.4);
		expect(one({ op: 'node.set', nodeId: 'A', field: 'flowShareManual', value: 0.2 }, b).problems).toEqual([]);
		const hiLo = base();
		hiLo.settings = { ...hiLo.settings, flowShareMethod: 'hiLo' };
		expect(one({ op: 'settings.set', path: 'hiLoSplit.hi', value: 0.95 }, hiLo).problems[0]).toMatch(/sum to 145\.00%/);
	});

	it('node.set takes a gauge off the EWR sites (engine ≥ 1.5.0), never the outlet, always a baseline assumption', () => {
		const b = base();
		b.model.nodes.push(node('W', { name: 'Weir', kind: 'gauge', downstreamNodeId: 'G', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, divertCapacityM3Day: 0 }));
		nodeOf(b, 'B')!.downstreamNodeId = 'W';
		const op: ScenarioOp = { op: 'node.set', nodeId: 'W', field: 'ewrSite', value: false };
		const r = one(op, b);
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'W')!.ewrSite).toBe(false);
		// Where the EWR is assessed is the Reserve's: never the applicant's proposal, even on a node they own.
		expect(classifyOp(op, ['W', 'B'], b)).toBe('baseline');
		expect(one({ op: 'node.set', nodeId: 'G', field: 'ewrSite', value: false }, b).problems[0]).toMatch(/is the outlet, which is always an EWR site/);
		expect(one({ op: 'node.set', nodeId: 'A', field: 'ewrSite', value: false }, b).problems[0]).toMatch(/can't be set on a farm/);
		expect(validateScenarioOps([{ op: 'node.set', nodeId: 'W', field: 'ewrSite', value: 'no' }]).errors).toEqual(['ops[0].value: must be true or false']);
	});

	it('node.set refuses a drought borehole rule on a farm without a dam', () => {
		const b = base();
		nodeOf(b, 'B')!.boreholeCapacityM3Day = 100;
		expect(one({ op: 'node.set', nodeId: 'B', field: 'boreholeRule', value: 'drought' }, b).problems[0]).toMatch(/drought borehole rule needs a farm dam/);
		expect(one({ op: 'node.set', nodeId: 'A', field: 'boreholeRule', value: 'drought' }, b).problems).toEqual([]);
	});

	it('node.set changes a farm\'s supply rule and river pump (WP-3.8): river first at 1,200 m³/day', () => {
		const r = applyScenario(base(), [
			{ op: 'node.set', nodeId: 'A', field: 'supplyRule', value: 'riverFirst' },
			{ op: 'node.set', nodeId: 'A', field: 'pumpCapacityM3Day', value: 1200 }
		]);
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'A')).toMatchObject({ supplyRule: 'riverFirst', pumpCapacityM3Day: 1200 });
		// The run pumps from the river at A (it irrigates lucerne), never more than the pump's capacity; the base never does.
		expect(runModel(base()).series.some((x) => x.key === 'river_abstraction')).toBe(false);
		const out = runModel(r.input);
		const pumped = out.series.find((x) => x.nodeId === 'A' && x.key === 'river_abstraction')!.values;
		expect(Math.max(...pumped)).toBeGreaterThan(0);
		expect(Math.max(...pumped)).toBeLessThanOrEqual(1200 + 1e-9);
		// null lifts the limit; the trigger rule's levels are fractions with stop ≥ trigger.
		const a = applyScenario(base(), [
			{ op: 'node.set', nodeId: 'A', field: 'pumpCapacityM3Day', value: null },
			{ op: 'node.set', nodeId: 'A', field: 'supplyRule', value: 'trigger' },
			{ op: 'node.set', nodeId: 'A', field: 'supplyStopPct', value: 0.8 },
			{ op: 'node.set', nodeId: 'A', field: 'supplyTriggerPct', value: 0.5 }
		]);
		expect(a.problems).toEqual([]);
		expect(nodeOf(a.input, 'A')).toMatchObject({ supplyRule: 'trigger', pumpCapacityM3Day: null, supplyTriggerPct: 0.5, supplyStopPct: 0.8 });
	});

	it('node.set refuses a supply rule or pump that doesn\'t fit the node (the save rules, modelRules.ts)', () => {
		const b = base();
		const err = (op: ScenarioOp, x = b) => one(op, x).problems;
		// Only a farm has them: the kind rule names the field.
		expect(err({ op: 'node.set', nodeId: 'G', field: 'supplyRule', value: 'riverFirst' })[0]).toMatch(/"supplyRule" can't be set on a gauge/);
		const withUser = base();
		withUser.model.nodes.push(node('U', { name: 'Town', kind: 'user', downstreamNodeId: 'B', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, sortOrder: 4 }));
		expect(err({ op: 'node.set', nodeId: 'U', field: 'pumpCapacityM3Day', value: 500 }, withUser)[0]).toMatch(/"pumpCapacityM3Day" can't be set on a user/);
		// Values: a known rule, a pump ≥ 0 or null, levels 0–1.
		expect(err({ op: 'node.set', nodeId: 'B', field: 'supplyRule', value: 'always' } as unknown as ScenarioOp)[0]).toMatch(/supplyRule must be one of damFirst, riverFirst, trigger, runOfRiver/);
		expect(err({ op: 'node.set', nodeId: 'B', field: 'pumpCapacityM3Day', value: -1 })[0]).toMatch(/pumpCapacityM3Day must be at least 0/);
		expect(err({ op: 'node.set', nodeId: 'A', field: 'supplyTriggerPct', value: 1.2 })[0]).toMatch(/supplyTriggerPct must be at most 1/);
		// Trigger switches on a dam: B has none; A has one (positive control).
		expect(err({ op: 'node.set', nodeId: 'B', field: 'supplyRule', value: 'trigger' })[0]).toMatch(/"Farm B": the trigger supply rule needs a farm dam/);
		expect(err({ op: 'node.set', nodeId: 'A', field: 'supplyRule', value: 'trigger' })).toEqual([]);
		// Run of river has no dam: A has one; B hasn't (positive control).
		expect(err({ op: 'node.set', nodeId: 'A', field: 'supplyRule', value: 'runOfRiver' })[0]).toMatch(/"Farm A": run of river has no dam/);
		expect(err({ op: 'node.set', nodeId: 'B', field: 'supplyRule', value: 'runOfRiver' })).toEqual([]);
		// Stop ≥ trigger under the trigger rule (defaults 40 % / 60 %).
		const trig = applyScenario(base(), [{ op: 'node.set', nodeId: 'A', field: 'supplyRule', value: 'trigger' }]).input;
		expect(err({ op: 'node.set', nodeId: 'A', field: 'supplyTriggerPct', value: 0.7 }, trig)[0]).toMatch(/stop level must be at least its trigger level/);
		expect(err({ op: 'node.set', nodeId: 'A', field: 'supplyStopPct', value: 0.3 }, trig)[0]).toMatch(/stop level must be at least its trigger level/);
		expect(err({ op: 'node.set', nodeId: 'A', field: 'supplyTriggerPct', value: 0.6 }, trig)).toEqual([]);
		// And the dam rules the other way round: a trigger or run-of-river farm can't lose or gain its dam.
		expect(err({ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 0 }, trig)[0]).toMatch(/trigger supply rule needs a farm dam/);
		const ror = applyScenario(base(), [{ op: 'node.set', nodeId: 'B', field: 'supplyRule', value: 'runOfRiver' }]).input;
		expect(err({ op: 'node.set', nodeId: 'B', field: 'damCapacityM3', value: 5000 }, ror)[0]).toMatch(/run of river has no dam/);
	});

	it('node.set sets a farm\'s hands-off flow and River to dam by month (engine 1.32.0, issue #204), and checks them', () => {
		const winter = [0, 0, 0, 0, 0, 0, 5000, 5000, 5000, 5000, 5000, 5000];
		const r = applyScenario(base(), [
			{ op: 'node.set', nodeId: 'A', field: 'handsOffM3Day', value: new Array(12).fill(800) },
			{ op: 'node.set', nodeId: 'A', field: 'handsOffEwr', value: true },
			{ op: 'node.set', nodeId: 'A', field: 'divertMonthlyM3Day', value: winter }
		]);
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'A')).toMatchObject({ handsOffM3Day: new Array(12).fill(800), handsOffEwr: true, divertMonthlyM3Day: winter });
		// null clears them; the classification is the applicant's own proposal, like the supply rule.
		expect(applyScenario(r.input, [{ op: 'node.set', nodeId: 'A', field: 'handsOffM3Day', value: null }]).problems).toEqual([]);
		expect(classifyOp({ op: 'node.set', nodeId: 'A', field: 'handsOffM3Day', value: null }, ['A'])).toBe('proposal');
		const err = (op: ScenarioOp) => one(op).problems;
		expect(err({ op: 'node.set', nodeId: 'A', field: 'handsOffM3Day', value: [1, 2, 3] })[0]).toMatch(/handsOffM3Day must be 12 monthly values/);
		expect(err({ op: 'node.set', nodeId: 'A', field: 'divertMonthlyM3Day', value: [...winter.slice(0, 11), -1] })[0]).toMatch(/divertMonthlyM3Day/);
		expect(err({ op: 'node.set', nodeId: 'A', field: 'handsOffEwr', value: 1 } as unknown as ScenarioOp)[0]).toMatch(/handsOffEwr must be true or false/);
		expect(err({ op: 'node.set', nodeId: 'G', field: 'handsOffEwr', value: true } as unknown as ScenarioOp)[0]).toMatch(/"handsOffEwr" can't be set on a gauge/);
	});

	it('node.add adds a leaf with the engine defaults for fields it leaves out', () => {
		const add = node('N', { name: 'New dam', downstreamNodeId: 'B', damCapacityM3: 30_000, areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		const r = one({ op: 'node.add', node: add });
		expect(r.problems).toEqual([]);
		const n = nodeOf(r.input, 'N')!;
		expect(n.boreholeRule).toBe('supplemental');
		expect(n.userPriority).toBe('senior');
		expect(() => buildTopology(r.input.model.nodes)).not.toThrow();
	});

	it('node.add takes a supply rule and river pump, and checks them (WP-3.8)', () => {
		const add = (over: Record<string, unknown>) =>
			one({ op: 'node.add', node: node('N', { name: 'Pump scheme', downstreamNodeId: 'B', damCapacityM3: 0, areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, ...over }) });
		const r = add({ supplyRule: 'runOfRiver', pumpCapacityM3Day: 1200, supplyTriggerPct: 0.4, supplyStopPct: 0.6 });
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'N')).toMatchObject({ supplyRule: 'runOfRiver', pumpCapacityM3Day: 1200 });
		expect(add({ supplyRule: 'always' }).problems[0]).toMatch(/supplyRule must be one of damFirst, riverFirst, trigger, runOfRiver/);
		expect(add({ pumpCapacityM3Day: -1 }).problems[0]).toMatch(/pumpCapacityM3Day/);
		expect(add({ supplyStopPct: 1.5 }).problems[0]).toMatch(/supplyStopPct/);
	});

	it('node.add takes the GN 538 property area and rate, and checks them (engine 1.12.0)', () => {
		const add = (over: Record<string, unknown>) =>
			one({ op: 'node.add', node: node('N', { name: 'New farm', downstreamNodeId: 'B', damCapacityM3: 0, areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, ...over }) });
		const r = add({ gaPropertyAreaHa: 60, gaRateM3HaYear: 45 });
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'N')).toMatchObject({ gaPropertyAreaHa: 60, gaRateM3HaYear: 45 });
		expect(add({ gaPropertyAreaHa: null, gaRateM3HaYear: null }).problems).toEqual([]);
		expect(add({ gaRateM3HaYear: 100 }).problems[0]).toMatch(/gaRateM3HaYear.*must be one of the GN 538 Table 2 rates: 0, 45, 75, 150, 275, 400/);
		expect(add({ gaPropertyAreaHa: -1 }).problems[0]).toMatch(/gaPropertyAreaHa/);
	});

	it('node.add rejects a used id, an unknown downstream node and a duplicate name', () => {
		expect(one({ op: 'node.add', node: node('A', { name: 'X', downstreamNodeId: 'G' }) }).problems[0]).toMatch(/already in use/);
		expect(one({ op: 'node.add', node: node('N', { downstreamNodeId: 'nowhere' }) }).problems[0]).toMatch(/unknown node nowhere/);
		expect(one({ op: 'node.add', node: node('N', { name: 'Farm A', downstreamNodeId: 'G' }) }).problems[0]).toMatch(/duplicate node name/);
	});

	it('node.remove re-links upstream nodes and drops every reference to the node', () => {
		const r = one({ op: 'node.remove', nodeId: 'A' });
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'A')).toBeUndefined();
		expect(nodeOf(r.input, 'C')!.downstreamNodeId).toBe('G');
		expect(r.input.model.cropAreas.map((a) => a.nodeId)).toEqual(['C']);
		expect(r.input.model.transfers).toEqual([]);
		expect((r.input.settings.ewrRules ?? []).map((t) => t.siteNodeId)).toEqual(['G']);
		expect(r.applied[0]!.notes.join('; ')).toMatch(/now drains into G.*1 crop area.*1 transfer.*1 EWR rule table/);
		const topo = buildTopology(r.input.model.nodes);
		expect(r.input.model.nodes[topo.outflow]!.id).toBe('G');
	});

	it('node.remove drops land cover on the node, and refuses the outflow node and a missing one', () => {
		expect(one({ op: 'node.remove', nodeId: 'B' }).input.model.landCover).toEqual([]);
		expect(one({ op: 'node.remove', nodeId: 'G' }).problems[0]).toMatch(/outflow node and can't be removed/);
		expect(one({ op: 'node.remove', nodeId: 'nope' }).problems[0]).toMatch(/not found/);
	});

	it('node.remove keeps a valid tree on a deep chain with a fan above the removed node', () => {
		const b = base();
		b.model.nodes.push(node('D', { downstreamNodeId: 'C' }), node('E', { downstreamNodeId: 'C' }), node('F', { downstreamNodeId: 'E' }));
		let x = b;
		for (const id of ['C', 'E', 'A']) {
			const r = applyScenario(x, [{ op: 'node.remove', nodeId: id }]);
			expect(r.problems).toEqual([]);
			expect(() => buildTopology(r.input.model.nodes)).not.toThrow();
			x = r.input;
		}
		expect(x.model.nodes.map((n) => `${n.id}→${n.downstreamNodeId}`).sort()).toEqual(['B→G', 'D→G', 'F→G', 'G→null']);
	});

	it('cropArea.set upserts one row, 0 removes it, and it refuses non-farms and unknown crops', () => {
		expect(one({ op: 'cropArea.set', nodeId: 'A', cropId: 'c1', areaM2: 1 }).input.model.cropAreas[0]).toEqual({ nodeId: 'A', cropId: 'c1', areaM2: 1 });
		expect(one({ op: 'cropArea.set', nodeId: 'B', cropId: 'c1', areaM2: 5 }).input.model.cropAreas).toHaveLength(3);
		expect(one({ op: 'cropArea.set', nodeId: 'A', cropId: 'c1', areaM2: 0 }).input.model.cropAreas.map((a) => a.nodeId)).toEqual(['C']);
		expect(one({ op: 'cropArea.set', nodeId: 'G', cropId: 'c1', areaM2: 5 }).problems[0]).toMatch(/crops grow on farms/);
		expect(one({ op: 'cropArea.set', nodeId: 'A', cropId: 'zz', areaM2: 5 }).problems[0]).toMatch(/crop zz not found/);
	});

	it('crop.add adds a crop and refuses a used id or name', () => {
		const crop = { id: 'c2', name: 'Citrus', cropFactor: new Array(12).fill(0.7) };
		expect(one({ op: 'crop.add', crop }).input.model.crops.map((c) => c.id)).toEqual(['c1', 'c2']);
		expect(one({ op: 'crop.add', crop: { ...crop, id: 'c1' } }).problems[0]).toMatch(/already in use/);
		expect(one({ op: 'crop.add', crop: { ...crop, name: 'lucerne' } }).problems[0]).toMatch(/duplicate crop name/);
	});

	it('transfer.add / set / remove', () => {
		const t = { id: 't2', fromNodeId: 'A', toNodeId: 'B', months: [12, 1, 1], maxRateM3s: 0.1, dailyCapM3: 500, minStoragePct: 0.3, enabled: true, priority: 1 };
		const added = one({ op: 'transfer.add', transfer: t });
		expect(added.input.model.transfers[1]!.months).toEqual([1, 12]);
		expect(one({ op: 'transfer.add', transfer: { ...t, toNodeId: 'A' } }).problems[0]).toMatch(/from a node to itself/);
		expect(one({ op: 'transfer.add', transfer: { ...t, toNodeId: 'zz' } }).problems[0]).toMatch(/toNodeId zz not found/);
		expect(one({ op: 'transfer.add', transfer: { ...t, id: 't1' } }).problems[0]).toMatch(/already in use/);

		expect(one({ op: 'transfer.set', transferId: 't1', field: 'maxRateM3s', value: 0.2 }).input.model.transfers[0]!.maxRateM3s).toBe(0.2);
		expect(one({ op: 'transfer.set', transferId: 't1', field: 'toNodeId', value: 'C' }).problems[0]).toMatch(/itself/);
		expect(one({ op: 'transfer.set', transferId: 'zz', field: 'enabled', value: false }).problems[0]).toMatch(/transfer zz not found/);

		// Monthly rates (engine 1.14.0): setting them also sets the months and max rate; a months or max-rate
		// edit on a rule with monthly rates would disagree with them, so it is refused as a save would be.
		const rates = [0, 0.3, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0];
		const monthly = one({ op: 'transfer.set', transferId: 't1', field: 'monthlyRateM3s', value: rates });
		expect(monthly.problems).toEqual([]);
		expect(monthly.input.model.transfers[0]).toMatchObject({ monthlyRateM3s: rates, months: [1, 11], maxRateM3s: 0.3 });
		const both = applyScenario(base(), [
			{ op: 'transfer.set', transferId: 't1', field: 'monthlyRateM3s', value: rates },
			{ op: 'transfer.set', transferId: 't1', field: 'maxRateM3s', value: 2 }
		]);
		expect(both.problems[0]).toMatch(/max rate must be the largest monthly rate/);
		expect(one({ op: 'transfer.add', transfer: { ...t, monthlyRateM3s: rates } }).input.model.transfers[1]).toMatchObject({ months: [1, 11], maxRateM3s: 0.3 });
		expect(one({ op: 'transfer.set', transferId: 't1', field: 'monthlyRateM3s', value: [1] }).problems[0]).toMatch(/12 monthly values/);

		expect(one({ op: 'transfer.remove', transferId: 't1' }).input.model.transfers).toEqual([]);
		expect(one({ op: 'transfer.remove', transferId: 'zz' }).problems).toHaveLength(1);
	});

	it('landCover.add / remove', () => {
		const p = { id: 'lc2', nodeId: 'A', coverClass: 'invasive' as const, areaKm2: 0.5, densityPct: 1, factors: null };
		expect(one({ op: 'landCover.add', patch: p }).input.model.landCover).toHaveLength(2);
		expect(one({ op: 'landCover.add', patch: { ...p, nodeId: 'G' } }).problems[0]).toMatch(/lies on a farm/);
		expect(one({ op: 'landCover.add', patch: { ...p, id: 'lc1' } }).problems[0]).toMatch(/already in use/);
		expect(one({ op: 'landCover.remove', patchId: 'lc1' }).input.model.landCover).toEqual([]);
		expect(one({ op: 'landCover.remove', patchId: 'zz' }).problems[0]).toMatch(/not found/);
	});

	it('a removed node takes its demand objects with it (engine 1.7.0)', () => {
		const b = base();
		b.model.demandObjects = [
			{ id: 'do1', nodeId: 'B', name: 'Town', category: 'municipal', sizing: 'monthly', monthlyM3Day: new Array(12).fill(10), count: null, litresPerUnitDay: null, lossPct: 0, monthlyFactor: null, returnPct: 0, priority: 'first', destination: 'internal', enabled: true, note: '' }
		];
		const gone = applyScenario(b, [{ op: 'node.remove', nodeId: 'B' }]);
		expect(gone.input.model.demandObjects).toEqual([]);
		expect(gone.applied.flatMap((a) => a.notes)).toContain('dropped 1 demand object(s)');
	});

	it('borehole.add / remove (WP-3.9), and a removed node takes its boreholes with it', () => {
		const b = { id: 'bh1', nodeId: 'A', name: 'New', capacityM3Day: 500, annualCapM3: 40_000, mode: 'supplemental' as const, emergencyBelowPct: 0.3, target: 'direct' as const, depletionFactor: 0.2 };
		const added = one({ op: 'borehole.add', borehole: b });
		expect(added.input.model.boreholes).toEqual([b]);
		expect(one({ op: 'borehole.add', borehole: { ...b, nodeId: 'G' } }).problems[0]).toMatch(/is a gauge/);
		expect(applyScenario(base(), [{ op: 'borehole.add', borehole: b }, { op: 'borehole.add', borehole: b }]).problems[0]).toMatch(/already in use/);
		expect(applyScenario(base(), [{ op: 'borehole.add', borehole: b }, { op: 'borehole.remove', boreholeId: 'bh1' }]).input.model.boreholes).toEqual([]);
		expect(one({ op: 'borehole.remove', boreholeId: 'zz' }).problems[0]).toMatch(/not found/);
		const gone = applyScenario(base(), [{ op: 'borehole.add', borehole: { ...b, nodeId: 'B' } }, { op: 'node.remove', nodeId: 'B' }]);
		expect(gone.input.model.boreholes).toEqual([]);
		expect(gone.applied.flatMap((a) => a.notes)).toContain('dropped 1 borehole(s)');
		expect(validateScenarioOps([{ op: 'borehole.add', borehole: { ...b, mode: 'sometimes' } }]).errors[0]).toMatch(/ops\[0\]\.borehole\.mode/);
		expect(classifyOp({ op: 'borehole.add', borehole: b }, ['A'], base())).toBe('proposal');
		expect(classifyOp({ op: 'borehole.add', borehole: { ...b, nodeId: 'B' } }, ['A'], base())).toBe('baseline');
	});

	it('settings.set writes a whitelisted path, nested ones over what is there', () => {
		const r = applyScenario(base(), [
			{ op: 'settings.set', path: 'lakeEvapFactor', value: 0.7 },
			{ op: 'settings.set', path: 'calibration.rainThresholdMm', value: 3 },
			{ op: 'settings.set', path: 'calibration.catchmentAreaKm2', value: 12.5 }
		]);
		expect(r.problems).toEqual([]);
		expect(r.input.settings.lakeEvapFactor).toBe(0.7);
		expect(r.input.settings.calibration).toEqual({ rainThresholdMm: 3, catchmentAreaKm2: 12.5 });
	});

	it('settings.set refuses an unknown path, a bad value and a window that ends before it starts', () => {
		expect(one({ op: 'settings.set', path: 'fitRecord', value: null } as unknown as ScenarioOp).problems[0]).toMatch(/not a setting a scenario can change/);
		// The legacy runoff model's paths (engine 1.0.0): a stored op on one names why it is refused.
		for (const [path, value] of [['runoffModel', 'legacy'], ['calibration.a', 0.2], ['calibration.summerMonths', [1]]] as const) {
			expect(one({ op: 'settings.set', path, value } as unknown as ScenarioOp).problems[0], path).toMatch(/legacy runoff model, removed in engine 1\.0\.0: delete this change/);
			expect(validateScenarioOps([{ op: 'settings.set', path, value }]).errors[0], path).toMatch(/legacy runoff model, removed in engine 1\.0\.0/);
		}
		const r = applyScenario(base(), [
			{ op: 'settings.set', path: 'reportStart', value: '2021-06-01' },
			{ op: 'settings.set', path: 'reportEnd', value: '2021-01-01' }
		]);
		expect(r.applied).toHaveLength(1);
		expect(r.problems[0]).toMatch(/op 2 \(settings\.set\): the reporting window starts/);
	});

	it('settings.set pe replaces GR4J\'s PE input whole, checked, and is baseline (engine ≥ 0.31.0)', () => {
		const mm = [110, 130, 150, 160, 140, 115, 75, 45, 30, 30, 45, 75];
		const monthly = { kind: 'monthly', mm, source: 'farm AWS FAO-56 ET₀' } as const;
		const r = applyScenario(base(), [{ op: 'settings.set', path: 'pe', value: monthly as never }]);
		expect(r.problems).toEqual([]);
		expect(r.input.settings.pe).toEqual(monthly);
		// A copy: editing the op afterwards doesn't reach the applied input.
		expect(r.input.settings.pe).not.toBe(monthly);
		expect(one({ op: 'settings.set', path: 'pe', value: { kind: 'pan' } }).input.settings.pe).toEqual({ kind: 'pan' });
		const err = (value: unknown) => one({ op: 'settings.set', path: 'pe', value } as unknown as ScenarioOp).problems[0];
		expect(err('monthly')).toMatch(/must be a PE input/);
		expect(err({ kind: 'etc' })).toMatch(/kind must be one of pan, monthly/);
		expect(err({ kind: 'pan', mm })).toMatch(/unknown field\(s\) mm for kind pan/);
		expect(err({ ...monthly, mm: mm.slice(1) })).toMatch(/mm must be 12 monthly values/);
		expect(err({ ...monthly, mm: [...mm.slice(1), -1] })).toMatch(/mm month 12: must be at least 0/);
		expect(err({ ...monthly, mm: [NaN, ...mm.slice(1)] })).toMatch(/mm month 1: must be a finite number/);
		expect(err({ ...monthly, mm: [10_001, ...mm.slice(1)] })).toMatch(/mm month 1: must be at most 10000/);
		expect(err({ ...monthly, source: ' ' })).toMatch(/source must say where the monthly PE came from/);
		expect(err({ kind: 'monthly', mm })).toMatch(/source must say/);
		expect(err({ ...monthly, source: 'x'.repeat(601) })).toMatch(/at most 600 characters/);
		expect(err({ ...monthly, note: 'x' })).toMatch(/unknown field\(s\) note/);
		// Positive control: the longest source note is fine.
		expect(err({ ...monthly, source: 'x'.repeat(600) })).toBeUndefined();
		// Validated at the API boundary too, and rebuilt as given.
		const v = validateScenarioOps([{ op: 'settings.set', path: 'pe', value: monthly }, { op: 'settings.set', path: 'pe', value: { kind: 'monthly', mm } }]);
		expect(v.ops).toEqual([{ op: 'settings.set', path: 'pe', value: monthly }]);
		expect(v.errors).toEqual(['ops[1].value: source must say where the monthly PE came from']);
		expect(classifyOp({ op: 'settings.set', path: 'pe', value: monthly as never }, ['A'])).toBe('baseline');
	});

	it('series.scale scales the days in range, keeps missing days, and copies only that series', () => {
		const b = base();
		b.series.rain_catchment_mm!.values[34] = null;
		const r = one({ op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.9, from: '2020-11-04', to: '2020-11-06' }, b);
		const [before, after] = [b.series.rain_catchment_mm!.values, r.input.series.rain_catchment_mm!.values];
		// 2020-11-04 is day 34 (missing), 35 is 6 mm, 36 is 0.
		expect(after.slice(33, 38)).toEqual([before[33], null, 6 * 0.9, 0, before[37]]);
		expect(r.applied[0]!.notes).toEqual(['2 day(s) scaled']);
		expect(after).not.toBe(before);
		const whole = one({ op: 'series.scale', kind: 'rain_catchment_mm', factor: 2 }, b);
		expect(whole.input.series.rain_catchment_mm!.values[0]).toBe(80);
	});

	it('series.scale refuses a series the base lacks, a range outside it and an unscalable kind', () => {
		expect(one({ op: 'series.scale', kind: 'rain_chirps_mm', factor: 2 }).problems[0]).toMatch(/no rain_chirps_mm series/);
		expect(one({ op: 'series.scale', kind: 'rain_catchment_mm', factor: 2, from: '2030-01-01' }).problems[0]).toMatch(/no day/);
		expect(one({ op: 'series.scale', kind: 'flow_observed_m3s', factor: 2 } as unknown as ScenarioOp).problems[0]).toMatch(/can't be scaled/);
	});
});

describe('applyScenario: edit groups (consecutive node.set on one node, checked once)', () => {
	const set = (nodeId: string, field: string, value: unknown) => ({ op: 'node.set', nodeId, field, value }) as ScenarioOp;
	/** A on the trigger rule (it has a dam). */
	const trig = () => applyScenario(base(), [set('A', 'supplyRule', 'trigger')]).input;

	it('takes a trigger farm straight to run of river in one group of 3 ops, in either order', () => {
		const orders: ScenarioOp[][] = [
			[set('A', 'supplyRule', 'runOfRiver'), set('A', 'damCapacityM3', 0), set('A', 'pumpCapacityM3Day', 1500)],
			[set('A', 'damCapacityM3', 0), set('A', 'pumpCapacityM3Day', 1500), set('A', 'supplyRule', 'runOfRiver')]
		];
		for (const ops of orders) {
			const r = applyScenario(trig(), ops);
			expect(r.problems).toEqual([]);
			expect(r.applied.map((a) => a.index)).toEqual([0, 1, 2]);
			expect(nodeOf(r.input, 'A')).toMatchObject({ supplyRule: 'runOfRiver', damCapacityM3: 0, pumpCapacityM3Day: 1500 });
		}
		// Each op alone still breaks a rule (positive control for what grouping buys).
		expect(one(set('A', 'supplyRule', 'runOfRiver'), trig()).problems[0]).toMatch(/run of river has no dam/);
		expect(one(set('A', 'damCapacityM3', 0), trig()).problems[0]).toMatch(/trigger supply rule needs a farm dam/);
	});

	it('raises both trigger levels in either order', () => {
		for (const ops of [
			[set('A', 'supplyTriggerPct', 0.7), set('A', 'supplyStopPct', 0.9)],
			[set('A', 'supplyStopPct', 0.9), set('A', 'supplyTriggerPct', 0.7)]
		]) {
			const r = applyScenario(trig(), ops);
			expect(r.problems).toEqual([]);
			expect(nodeOf(r.input, 'A')).toMatchObject({ supplyTriggerPct: 0.7, supplyStopPct: 0.9 });
		}
	});

	it('skips a group that still breaks a rule whole, with one problem naming all its ops, and applies the ops around it', () => {
		const ops = [
			set('B', 'damCapacityM3', 10_000),
			set('A', 'pumpCapacityM3Day', 800),
			set('A', 'supplyRule', 'runOfRiver'),
			set('A', 'supplyStopPct', 0.9),
			set('C', 'damCapacityM3', 60_000)
		];
		const r = applyScenario(trig(), ops);
		expect(r.problems).toEqual([expect.stringMatching(/^ops 2–4 \(node\.set, "Farm A"\): .*run of river has no dam/)]);
		expect(r.applied.map((a) => a.index)).toEqual([0, 4]);
		// All or nothing: A keeps its pump, rule and levels as they were.
		expect(nodeOf(r.input, 'A')).toMatchObject({ supplyRule: 'trigger', damCapacityM3: 200_000 });
		expect(nodeOf(r.input, 'A')!.pumpCapacityM3Day ?? null).toBeNull();
		expect(nodeOf(r.input, 'B')!.damCapacityM3).toBe(10_000);
		expect(nodeOf(r.input, 'C')!.damCapacityM3).toBe(60_000);
	});

	it('refuses an op that fails its own check on its own, and names only the group ops that applied', () => {
		const ops = [set('A', 'supplyRule', 'runOfRiver'), set('A', 'damInitialPct', 1.5), set('A', 'pumpCapacityM3Day', 800)];
		const r = applyScenario(trig(), ops);
		expect(r.problems).toEqual([
			expect.stringMatching(/^op 2 \(node\.set\): damInitialPct .*at most 1/),
			expect.stringMatching(/^ops 1, 3 \(node\.set, "Farm A"\): .*run of river has no dam/)
		]);
		expect(r.applied).toEqual([]);
		// The bad value alone doesn't sink a group that fits.
		const ok = applyScenario(trig(), [set('A', 'supplyRule', 'runOfRiver'), set('A', 'damInitialPct', 1.5), set('A', 'damCapacityM3', 0)]);
		expect(ok.problems).toEqual([expect.stringMatching(/^op 2 \(node\.set\): /)]);
		expect(ok.applied.map((a) => a.index)).toEqual([0, 2]);
		expect(nodeOf(ok.input, 'A')).toMatchObject({ supplyRule: 'runOfRiver', damCapacityM3: 0 });
	});

	it('an op on another node in between splits the ops into two groups, each checked on its own', () => {
		const r = applyScenario(trig(), [set('A', 'supplyRule', 'runOfRiver'), set('B', 'pumpCapacityM3Day', 500), set('A', 'damCapacityM3', 0)]);
		expect(r.problems).toEqual([expect.stringMatching(/^op 1 \(node\.set\): .*run of river has no dam/), expect.stringMatching(/^op 3 \(node\.set\): .*trigger supply rule needs a farm dam/)]);
		expect(r.applied.map((a) => a.index)).toEqual([1]);
		// Any other op kind in between splits them too.
		const s = applyScenario(trig(), [set('A', 'supplyRule', 'runOfRiver'), { op: 'cropArea.set', nodeId: 'A', cropId: 'c1', areaM2: 1 }, set('A', 'damCapacityM3', 0)]);
		expect(s.problems).toHaveLength(2);
		expect(s.applied.map((a) => a.index)).toEqual([1]);
	});

	it('scenarioSteps: each op meets the earlier ops of its group, and `after` keeps an incomplete last group', () => {
		const ops = [set('A', 'supplyRule', 'runOfRiver'), set('A', 'damCapacityM3', 0)];
		const { before, after } = scenarioSteps(trig(), ops);
		expect(nodeOf(before[0]!, 'A')!.supplyRule).toBe('trigger');
		expect(nodeOf(before[1]!, 'A')!.supplyRule).toBe('runOfRiver');
		expect(nodeOf(after, 'A')).toMatchObject({ supplyRule: 'runOfRiver', damCapacityM3: 0 });
		// An incomplete group (the rule alone) is what the next op would build on, though it doesn't apply yet.
		expect(nodeOf(scenarioSteps(trig(), ops.slice(0, 1)).after, 'A')!.supplyRule).toBe('runOfRiver');
		expect(applyScenario(trig(), ops.slice(0, 1)).problems).toHaveLength(1);
		// After a group that breaks a rule and is closed by another op, the next op meets the input without it.
		const closed = scenarioSteps(trig(), [ops[0]!, set('B', 'pumpCapacityM3Day', 500), set('C', 'pumpCapacityM3Day', 400)]);
		expect(nodeOf(closed.before[2]!, 'A')!.supplyRule).toBe('trigger');
		expect(nodeOf(closed.before[2]!, 'B')!.pumpCapacityM3Day).toBe(500);
	});
});

describe('applyScenario: the whole list', () => {
	it('never mutates the base (deep-frozen), whatever the ops do', () => {
		const b = deepFreeze(base());
		const ops: ScenarioOp[] = [
			{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 1 },
			{ op: 'transfer.set', transferId: 't1', field: 'months', value: [4, 2] },
			{ op: 'node.remove', nodeId: 'A' },
			{ op: 'cropArea.set', nodeId: 'C', cropId: 'c1', areaM2: 9 },
			{ op: 'landCover.remove', patchId: 'lc1' },
			{ op: 'settings.set', path: 'calibration.rainThresholdMm', value: 4 },
			{ op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.5 }
		];
		const snapshot = JSON.stringify(b);
		const r = applyScenario(b, ops);
		expect(r.problems).toEqual([]);
		expect(JSON.stringify(b)).toBe(snapshot);
		expect(r.input.model).not.toBe(b.model);
	});

	it('applies in order: a later op sees an earlier one, and one on a removed target is a problem', () => {
		const r = applyScenario(base(), [
			{ op: 'node.set', nodeId: 'A', field: 'name', value: 'Upper dam' },
			{ op: 'node.remove', nodeId: 'C' },
			{ op: 'cropArea.set', nodeId: 'C', cropId: 'c1', areaM2: 1 },
			{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 1 }
		]);
		expect(r.applied.map((a) => a.index)).toEqual([0, 1, 3]);
		expect(r.problems).toEqual(['op 3 (cropArea.set): node C not found']);
	});

	it('an empty list returns an equal input', () => {
		const b = base();
		const r = applyScenario(b, []);
		expect(r.input).toEqual(b);
		expect(r).toMatchObject({ applied: [], problems: [] });
	});

	it('refuses to remove the last land: runModel needs a catchment area', () => {
		const b = base();
		for (const id of ['A', 'C']) Object.assign(nodeOf(b, id)!, { areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		expect(one({ op: 'node.remove', nodeId: 'B' }, b).problems[0]).toMatch(/no area left/);
		expect(one({ op: 'node.set', nodeId: 'B', field: 'areaKm2', value: 0 }, b).problems[0]).toMatch(/no area left/);
		// With the area set by hand the land can go.
		b.settings.calibration = { catchmentAreaKm2: 20 } as never;
		expect(one({ op: 'node.remove', nodeId: 'B' }, b).problems).toEqual([]);
	});

	it('a renamed node whose name has parentheses still passes every invariant', () => {
		// The order-invariance check sorts the name lists in warnings; a "(…)" in a name once broke that.
		const r = one({ op: 'node.set', nodeId: 'A', field: 'name', value: 'Farm A (upper)' });
		expect(runModel(r.input).summary.warnings.join(' ')).toMatch(/\(Farm A \(upper\); Farm C\)/);
		for (const seed of [1, 2, 3, 4, 5, 6]) expect(checkAll(r.input, seed)).toBeNull();
	});

	it('an op on a base that already has a structural issue still applies when it adds none', () => {
		const b = base();
		b.model.transfers.push({ ...b.model.transfers[0]!, id: 't9', fromNodeId: 'G' });
		b.model.nodes[0]!.kind = 'user';
		// The base has a transfer from a user; renaming a farm doesn't make that worse.
		expect(one({ op: 'node.set', nodeId: 'A', field: 'name', value: 'Renamed' }, b).problems).toEqual([]);
	});
});

describe('a dam raise', () => {
	const series = (out: { series: RunSeries[] }, nodeId: string) =>
		Object.fromEntries(out.series.filter((s) => s.nodeId === nodeId).map((s) => [s.key, s.values]));

	it('raising A’s dam 20 % changes A and what is downstream of it, never C upstream or B beside it', () => {
		const b = base();
		// Nothing else couples them: no transfer (t1 would let C send more into a bigger dam) and no EWR to share.
		b.model.transfers = [];
		const r = applyScenario(b, [{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 200_000 * 1.2 }]);
		expect(r.problems).toEqual([]);
		const before = runModel(b);
		const after = runModel(r.input);
		expect(series(after, 'C')).toEqual(series(before, 'C'));
		expect(series(after, 'B')).toEqual(series(before, 'B'));
		expect(series(after, 'A').dam_storage).not.toEqual(series(before, 'A').dam_storage);
		const peak = (xs: number[]) => Math.max(...xs);
		expect(peak(series(after, 'A').dam_storage!)).toBeGreaterThan(peak(series(before, 'A').dam_storage!));
		expect(peak(series(after, 'A').dam_storage!)).toBeLessThanOrEqual(240_000);
	});

	it('gives identical results whatever the node order after applying (model.md §6)', () => {
		const r = applyScenario(base(), [{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 240_000 }]);
		const a = runModel(r.input);
		for (const seed of [1, 2, 3]) {
			const s = runModel(scrambleOrder(r.input, seed));
			const key = (x: RunSeries) => `${x.nodeId}|${x.key}`;
			expect(new Map(s.series.map((x) => [key(x), x.values]))).toEqual(new Map(a.series.map((x) => [key(x), x.values])));
		}
	});
});

describe('demand.scale (issue #53 R1)', () => {
	const series = (out: { series: RunSeries[] }, nodeId: string) =>
		Object.fromEntries(out.series.filter((s) => s.nodeId === nodeId).map((s) => [s.key, s.values]));
	/** The base with an other water user U below A taking 1,000 m³/day every month. */
	const withUser = () => {
		const b = base();
		b.model.nodes.push(node('U', { name: 'Town', kind: 'user', downstreamNodeId: 'G', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, userDemandM3Day: new Array(12).fill(1000), sortOrder: 4 }));
		return b;
	};
	const ones = new Array<number>(12).fill(1);

	it('scales every farm by default, some farms and months when asked, and stacks', () => {
		const all = one({ op: 'demand.scale', factor: 0.85 });
		expect(all.problems).toEqual([]);
		expect(all.applied[0]!.notes).toEqual(['3 farm(s) scaled']);
		for (const id of ['A', 'B', 'C']) expect(nodeOf(all.input, id)!.demandFactor).toEqual(new Array(12).fill(0.85));
		expect(nodeOf(all.input, 'G')!.demandFactor).toBeUndefined();
		// Only A, in October and November (calendar months 10 and 11: water-year months 0 and 1).
		const some = one({ op: 'demand.scale', factor: 0.7, nodeIds: ['A'], months: [11, 10] });
		expect(some.applied[0]!.notes).toEqual([]);
		expect(nodeOf(some.input, 'A')!.demandFactor).toEqual([0.7, 0.7, ...ones.slice(2)]);
		expect(nodeOf(some.input, 'B')!.demandFactor).toBeUndefined();
		// January is water-year month 3, September month 11.
		expect(nodeOf(one({ op: 'demand.scale', factor: 0.5, nodeIds: ['B'], months: [1, 9] }).input, 'B')!.demandFactor).toEqual([1, 1, 1, 0.5, 1, 1, 1, 1, 1, 1, 1, 0.5]);
		const twice = applyScenario(base(), [
			{ op: 'demand.scale', factor: 0.9, nodeIds: ['A'] },
			{ op: 'demand.scale', factor: 0.9, nodeIds: ['A'], months: [10] }
		]);
		expect(nodeOf(twice.input, 'A')!.demandFactor![0]).toBeCloseTo(0.81, 12);
		expect(nodeOf(twice.input, 'A')!.demandFactor![1]).toBe(0.9);
	});

	it("scales the farm's crop requirement and abstraction, never its gross demand, rain or efficiency", () => {
		const b = base();
		const r = applyScenario(b, [{ op: 'demand.scale', factor: 0.85, nodeIds: ['A'], months: [12, 1, 2] }]);
		const out = runModel(b);
		const [x, y] = [series(out, 'A'), series(runModel(r.input), 'A')];
		expect(y.gross_demand).toEqual(x.gross_demand);
		expect(y.effective_rain).toEqual(x.effective_rain);
		expect(y.soil_water).toEqual(x.soil_water);
		let scaled = 0;
		const day0 = toEpochDay(out.startDate);
		for (let t = 0; t < x.demand!.length; t++) {
			const k = [12, 1, 2].includes(monthOfEpochDay(day0 + t)) ? 0.85 : 1;
			if (k !== 1 && x.demand![t]! > 0) scaled++;
			expect(y.crop_requirement![t]).toBeCloseTo(k * x.crop_requirement![t]!, 9);
			expect(y.demand![t]).toBeCloseTo(k * x.demand![t]!, 9);
			expect(y.demand![t]).toBeCloseTo(y.crop_requirement![t]! / 0.8, 9);
			expect(y.supplied![t]!).toBeLessThanOrEqual(y.demand![t]! * (1 + 1e-12));
		}
		expect(scaled).toBeGreaterThan(30);
		expect(checkAll(r.input)).toBeNull();
	});

	it("category 'user' scales the other water users' demand only", () => {
		const b = withUser();
		const r = applyScenario(b, [{ op: 'demand.scale', factor: 0.5, category: 'user' }]);
		expect(r.problems).toEqual([]);
		expect(r.applied[0]!.notes).toEqual(['1 other water user(s) scaled']);
		expect(nodeOf(r.input, 'A')!.demandFactor).toBeUndefined();
		const [x, y] = [runModel(b), runModel(r.input)];
		expect(series(y, 'U').demand!.every((v) => v === 500)).toBe(true);
		expect(series(y, 'A').demand).toEqual(series(x, 'A').demand);
		expect(checkAll(r.input)).toBeNull();
	});

	it('refuses a missing node, a node of another category and a category the model has none of', () => {
		expect(one({ op: 'demand.scale', factor: 0.8, nodeIds: ['A', 'Z'] }).problems).toEqual(['op 1 (demand.scale): node Z not found']);
		expect(one({ op: 'demand.scale', factor: 0.8, nodeIds: ['G'] }).problems).toEqual(['op 1 (demand.scale): "Outlet gauge" is a gauge, not a farm']);
		expect(one({ op: 'demand.scale', factor: 0.8, nodeIds: ['U'] }, withUser()).problems).toEqual(['op 1 (demand.scale): "Town" is an other water user, not a farm']);
		expect(one({ op: 'demand.scale', factor: 0.8, nodeIds: ['A'], category: 'user' }, withUser()).problems).toEqual(['op 1 (demand.scale): "Farm A" is a farm, not an other water user']);
		expect(one({ op: 'demand.scale', factor: 0.8, category: 'user' }).problems).toEqual(['op 1 (demand.scale): the model has no other water user to scale']);
		// Unchecked input (a stored op from before a validator change) meets the same rules.
		expect(one({ op: 'demand.scale', factor: 3 }).problems).toEqual(['op 1 (demand.scale): factor must be at most 2']);
		expect(one({ op: 'demand.scale', factor: 1, months: [] }).problems[0]).toMatch(/months must be a list of at least one calendar month/);
		// A skipped op changes nothing.
		expect(one({ op: 'demand.scale', factor: 0.8, nodeIds: ['A', 'Z'] }).input.model).toEqual(base().model);
	});

	it('run comparison lists it', () => {
		const r = one({ op: 'demand.scale', factor: 0.85, nodeIds: ['A'], months: [10] });
		const snap = (x: ModelInput) => ({ settings: x.settings, model: x.model, series: {} });
		expect(diffInputs(snap(base()), snap(r.input)).map((c) => c.text)).toEqual(['Farm A: demand factor none → 0.85, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 × (Oct–Sep)']);
	});
});

describe('ewrRule.set (engine ≥ 1.6.0, WP-3.7)', () => {
	/** A usable rule table at `site`: invented values, falling with the % point. */
	const table = (site: string | null, over: Partial<EwrRuleTable> = {}): EwrRuleTable => ({
		...blankEwrRuleTable(site),
		source: 'Invented Reserve study, table 4',
		sourceKind: 'gazetted',
		ewr: Array.from({ length: 12 }, () => [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05]),
		...over
	});
	const set = (t: EwrRuleTable): ScenarioOp => ({ op: 'ewrRule.set', table: t });
	/** The base with a second gauge W (an EWR site) on B's way to the outlet, and no table at the farm A. */
	const withWeir = () => {
		const b = base();
		b.model.nodes.push(node('W', { name: 'Weir', kind: 'gauge', downstreamNodeId: 'G', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, divertCapacityM3Day: 0, sortOrder: 4 }));
		nodeOf(b, 'B')!.downstreamNodeId = 'W';
		b.settings.ewrRules = [blankEwrRuleTable('G')];
		return b;
	};

	it('replaces the outlet’s table, whether the base keys it by null or by the outlet’s id, never touching the base', () => {
		const b = deepFreeze(withWeir());
		const r = applyScenario(b, [set(table(null))]);
		expect(r.problems).toEqual([]);
		// It keeps the key the site's table had, so run comparison sees that table changed.
		expect(r.input.settings.ewrRules).toEqual([table('G')]);
		expect(r.applied[0]!.notes).toEqual([]);
		expect(b.settings.ewrRules).toEqual([blankEwrRuleTable('G')]);
	});

	it('adds a table at a gauge without one, and a later op replaces it', () => {
		const desktop = table('W', { source: '  Desktop Reserve Model run  ', sourceKind: 'desktop' });
		const r = applyScenario(withWeir(), [set(desktop), set(table('W', { sourceKind: 'other' }))]);
		expect(r.problems).toEqual([]);
		expect(r.applied).toHaveLength(2);
		expect(r.input.settings.ewrRules).toEqual([blankEwrRuleTable('G'), table('W', { sourceKind: 'other' })]);
		// The source is kept trimmed, as Settings saves it.
		expect(applyScenario(withWeir(), [set(desktop)]).input.settings.ewrRules![1]!.source).toBe('Desktop Reserve Model run');
	});

	it('carries the determination’s natural MAR (engine ≥ 1.11.0) when set, drops a null one, and refuses a bad one', () => {
		const r = applyScenario(withWeir(), [set(table('W', { naturalMarMcm: 14 })), set(table(null, { naturalMarMcm: null }))]);
		expect(r.problems).toEqual([]);
		const [outlet, weir] = r.input.settings.ewrRules!;
		expect(weir!.naturalMarMcm).toBe(14);
		expect(outlet).not.toHaveProperty('naturalMarMcm');
		const bad = applyScenario(withWeir(), [set(table('W', { naturalMarMcm: 0 }))]);
		expect(bad.problems).toEqual([expect.stringMatching(/naturalMarMcm The natural MAR must be above 0/)]);
		const text = applyScenario(withWeir(), [set(table('W', { naturalMarMcm: '14' as never }))]);
		expect(text.problems).toEqual([expect.stringMatching(/naturalMarMcm must be a finite number/)]);
	});

	it('carries the REC (ER9) when set, drops a null one, and refuses a malformed one', () => {
		const r = applyScenario(withWeir(), [set(table('W', { category: 'B/C' })), set(table(null, { category: null }))]);
		expect(r.problems).toEqual([]);
		const [outlet, weir] = r.input.settings.ewrRules!;
		expect(weir!.category).toBe('B/C');
		expect(outlet).not.toHaveProperty('category');
		expect(applyScenario(withWeir(), [set(table('W', { category: 'b/c' }))]).problems).toEqual([expect.stringMatching(/category The REC is one category A to F/)]);
		expect(applyScenario(withWeir(), [set(table('W', { category: 2 as never }))]).problems).toEqual([expect.stringMatching(/category must be text/)]);
	});

	it('changes no result: the REC is a label (ER9, no ENGINE_VERSION bump)', () => {
		const plain = runModel(one(set(table(null)), withWeir()).input);
		const rec = runModel(one(set(table(null, { category: 'D' })), withWeir()).input);
		expect(plain.summary.ewrAssurance).toHaveLength(1);
		expect(rec.summary).toEqual(plain.summary);
		expect(rec.series).toEqual(plain.series);
	});

	it('is used by the run: the scenario’s table is the one assessed at the site', () => {
		const r = one(set(table(null, { naturalSource: 'run' })), withWeir());
		const sites = runModel(r.input).summary.ewrAssurance ?? [];
		expect(sites.map((x) => [x.isOutlet, x.source, x.sourceKind])).toEqual([[true, 'Invented Reserve study, table 4', 'gazetted']]);
		// The base's blank table isn't usable, so the base assesses no site.
		expect(runModel(withWeir()).summary.ewrAssurance ?? []).toEqual([]);
	});

	it('refuses a site that isn’t the outlet or a gauge marked as an EWR site, and a table Settings wouldn’t save', () => {
		const b = withWeir();
		expect(one(set(table('A')), b).problems).toEqual(['op 1 (ewrRule.set): an EWR site is the outlet or a gauge; "Farm A" is a farm']);
		expect(one(set(table('Z')), b).problems).toEqual(['op 1 (ewrRule.set): node Z not found']);
		nodeOf(b, 'W')!.ewrSite = false;
		expect(one(set(table('W')), b).problems).toEqual(['op 1 (ewrRule.set): "Weir" is not marked as an EWR site: set its EWR site flag first']);
		// Flag it first in the same scenario, and the table applies.
		expect(applyScenario(b, [{ op: 'node.set', nodeId: 'W', field: 'ewrSite', value: true }, set(table('W'))]).problems).toEqual([]);
		// Unchecked input (a stored op) meets the Settings form's checks.
		expect(one(set(table(null, { source: ' ' })), b).problems[0]).toMatch(/^op 1 \(ewrRule\.set\): the rule table isn't usable: source Say where the table comes from/);
		expect(one(set(table(null, { points: [50, 10] })), b).problems[0]).toMatch(/points The % points must rise/);
		// At most EWR_RULE_TABLES_MAX tables: a 21st site is refused.
		const full = withWeir();
		full.settings.ewrRules = Array.from({ length: 20 }, (_, i) => blankEwrRuleTable(`s${i}`));
		expect(one(set(table('W')), full).problems).toEqual(['op 1 (ewrRule.set): At most 20 rule tables.']);
		// A skipped op changes nothing.
		expect(one(set(table('A')), withWeir()).input.settings).toEqual(withWeir().settings);
	});

	it('is always a baseline assumption, even with the site’s gauge and every node owned', () => {
		const b = withWeir();
		const all = b.model.nodes.map((n) => n.id);
		expect(classifyOp(set(table('W')), all, b)).toBe('baseline');
		expect(classifyOp(set(table(null)), all)).toBe('baseline');
		expect(classifyScenario(b, [{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 1 }, set(table(null))], ['A'])).toEqual(['proposal', 'baseline']);
	});

	it('applies in an application’s namespace like any op (the Reserve is a setting the applicant sees in full), still baseline', () => {
		const masked = { nodes: { B: 'Farm 1', C: 'Farm 2' } };
		const b = withWeir();
		const r = applyScenario(b, [set(table('W'))], { mask: masked });
		expect(r.problems).toEqual([]);
		expect(r.input.settings.ewrRules![1]).toEqual(table('W'));
		expect(classifyScenario(b, [set(table('W'))], ['A'], { mask: masked })).toEqual(['baseline']);
		// A hidden farm as the site reads by the name the applicant sees it by.
		expect(applyScenario(b, [set(table('B'))], { mask: masked }).problems).toEqual(['op 1 (ewrRule.set): an EWR site is the outlet or a gauge; "Farm 1" is a farm']);
	});

	it('run comparison lists the changed table, with its kind of source', () => {
		const snap = (x: ModelInput) => ({ settings: x.settings, model: x.model, series: {} });
		const r = one(set(table(null)), withWeir());
		const text = diffInputs(snap(withWeir()), snap(r.input)).map((c) => c.text);
		expect(text).toContain('EWR rule table at Outlet gauge: source none → "Invented Reserve study, table 4"');
		expect(text).toContain('EWR rule table at Outlet gauge: kind of source not stated → Gazetted Reserve');
		expect(text).toContain('EWR rule table at Outlet gauge: EWR values changed in Oct, Nov, Dec, Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep');
	});
});

describe('later ops (engine ≥ 1.34.0): moving and inserting nodes', () => {
	const snap = (x: ModelInput) => ({ settings: x.settings, model: x.model, series: {} });
	const texts = (a: ModelInput, b: ModelInput) => diffInputs(snap(a), snap(b)).map((c) => c.text);

	it('node.move makes a node drain into another, carrying what drains into it, and never touches the base', () => {
		const b = deepFreeze(base());
		// C drains into A: move A (with C behind it) to drain into B instead.
		const r = applyScenario(b, [{ op: 'node.move', nodeId: 'A', downstreamNodeId: 'B' }]);
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'A')!.downstreamNodeId).toBe('B');
		expect(nodeOf(r.input, 'C')!.downstreamNodeId).toBe('A');
		expect(() => buildTopology(r.input.model.nodes)).not.toThrow();
		expect(nodeOf(b, 'A')!.downstreamNodeId).toBe('G');
		expect(texts(b, r.input)).toEqual(['Farm A: drains into Farm B (was Outlet gauge)']);
	});

	it('node.move refuses a loop, the outflow, itself and missing nodes, and changes nothing then', () => {
		// A drains into C, which drains into A: a loop (a model rule).
		const loop = one({ op: 'node.move', nodeId: 'A', downstreamNodeId: 'C' });
		expect(loop.problems).toEqual(['op 1 (node.move): the network has a loop through "Farm A"; the network has a loop through "Farm C"']);
		expect(loop.input.model).toEqual(base().model);
		expect(one({ op: 'node.move', nodeId: 'G', downstreamNodeId: 'A' }).problems).toEqual(['op 1 (node.move): "Outlet gauge" is the outflow node and can\'t be moved']);
		expect(one({ op: 'node.move', nodeId: 'A', downstreamNodeId: 'A' }).problems).toEqual(['op 1 (node.move): "Farm A" can\'t drain into itself']);
		expect(one({ op: 'node.move', nodeId: 'Z', downstreamNodeId: 'A' }).problems).toEqual(['op 1 (node.move): node Z not found']);
		expect(one({ op: 'node.move', nodeId: 'A', downstreamNodeId: 'Z' }).problems).toEqual(['op 1 (node.move): node Z not found']);
		// A river off-take whose destination would drain into its source is refused too (a model rule).
		const b = base();
		b.model.transfers = [{ id: 'r1', fromNodeId: 'B', toNodeId: 'C', months: [1], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0, source: 'river' }];
		expect(applyScenario(b, [{ op: 'node.move', nodeId: 'C', downstreamNodeId: 'B' }]).problems[0]).toMatch(/^op 1 \(node\.move\): river off-take "Farm B" → "Farm C": its destination drains into its source/);
	});

	it('node.insert puts a new node on a reach: the named nodes drain into it, it drains where they did', () => {
		const weir = node('W', { name: 'New weir', kind: 'gauge', downstreamNodeId: 'G', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, divertCapacityM3Day: 0 });
		const b = deepFreeze(base());
		const r = applyScenario(b, [{ op: 'node.insert', node: weir, upstreamNodeIds: ['A', 'B'] }]);
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'W')!.downstreamNodeId).toBe('G');
		expect(['A', 'B', 'C'].map((id) => nodeOf(r.input, id)!.downstreamNodeId)).toEqual(['W', 'W', 'A']);
		expect(r.applied[0]!.notes).toEqual(['"Farm A" now drains into "New weir"', '"Farm B" now drains into "New weir"']);
		expect(() => buildTopology(r.input.model.nodes)).not.toThrow();
		expect(texts(b, r.input)).toEqual([
			'Gauge "New weir" added (0 km², drains into Outlet gauge)',
			'Farm A: drains into New weir (was Outlet gauge)',
			'Farm B: drains into New weir (was Outlet gauge)',
			'EWR sites: Outlet gauge (outlet) → Outlet gauge (outlet), New weir (added New weir (new node))'
		]);
		// An on-channel dam below C alone: C drains into it, it into A.
		const dam = node('D', { name: 'New dam', downstreamNodeId: 'A', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, damCapacityM3: 80_000 });
		const d = one({ op: 'node.insert', node: dam, upstreamNodeIds: ['C'] });
		expect(d.problems).toEqual([]);
		expect(nodeOf(d.input, 'C')!.downstreamNodeId).toBe('D');
	});

	it('node.insert refuses a node that doesn’t drain there, an empty or repeating list, and what node.add refuses, changing nothing', () => {
		const n = node('D', { name: 'New dam', downstreamNodeId: 'G', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		const r = one({ op: 'node.insert', node: n, upstreamNodeIds: ['A', 'C'] });
		expect(r.problems).toEqual(['op 1 (node.insert): "Farm C" doesn\'t drain into the node the new one drains into, so the new node can\'t sit between them']);
		expect(r.input.model).toEqual(base().model);
		expect(one({ op: 'node.insert', node: n, upstreamNodeIds: [] }).problems).toEqual(['op 1 (node.insert): upstreamNodeIds names no node: with none, add the node instead']);
		expect(one({ op: 'node.insert', node: n, upstreamNodeIds: ['A', 'A'] }).problems).toEqual(['op 1 (node.insert): upstreamNodeIds names a node more than once']);
		expect(one({ op: 'node.insert', node: { ...n, id: 'A' }, upstreamNodeIds: ['B'] }).problems).toEqual(['op 1 (node.insert): node id A is already in use']);
		expect(one({ op: 'node.insert', node: { ...n, name: 'farm b' }, upstreamNodeIds: ['B'] }).problems).toEqual(['op 1 (node.insert): duplicate node name "farm b"']);
		// The outflow drains into nothing, so nothing can be inserted below it.
		expect(one({ op: 'node.insert', node: n, upstreamNodeIds: ['G'] }).problems[0]).toMatch(/"Outlet gauge" doesn't drain into the node the new one drains into/);
	});

	it('classifies a move of the own land-free leaf as the proposal, any other move as baseline; an insert as node.add', () => {
		const b = base();
		const pump = node('P', { name: 'Pump', downstreamNodeId: 'A', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		b.model.nodes.push(pump);
		const move = (nodeId: string): ScenarioOp => ({ op: 'node.move', nodeId, downstreamNodeId: 'B' });
		expect(classifyOp(move('P'), ['P'], b)).toBe('proposal');
		expect(classifyOp(move('P'), ['P'])).toBe('baseline');
		expect(classifyOp(move('P'), ['A'], b)).toBe('baseline');
		// A has land, and C drains into it.
		expect(classifyOp(move('A'), ['A'], b)).toBe('baseline');
		Object.assign(nodeOf(b, 'A')!, { areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		expect(classifyOp(move('A'), ['A'], b)).toBe('baseline');
		expect(classifyOp(move('A'), ['A', 'C'], b)).toBe('baseline');
		const dam = node('D', { name: 'New dam', downstreamNodeId: 'G', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		expect(classifyOp({ op: 'node.insert', node: dam, upstreamNodeIds: ['B'] }, [], b)).toBe('proposal');
		expect(classifyOp({ op: 'node.insert', node: { ...dam, kind: 'gauge' }, upstreamNodeIds: ['B'] }, [], b)).toBe('baseline');
		expect(classifyOp({ op: 'node.insert', node: { ...dam, areaKm2: 1 }, upstreamNodeIds: ['B'] }, [], b)).toBe('baseline');
		// An inserted node is the scenario's own: moving it next is the proposal too.
		expect(classifyScenario(base(), [{ op: 'node.insert', node: dam, upstreamNodeIds: ['B'] }, { op: 'node.move', nodeId: 'D', downstreamNodeId: 'A' }], [])).toEqual(['proposal', 'baseline']);
		expect(classifyScenario(base(), [{ op: 'node.add', node: { ...dam, downstreamNodeId: 'B' } }, { op: 'node.move', nodeId: 'D', downstreamNodeId: 'A' }], [])).toEqual(['proposal', 'proposal']);
	});

	it('masked: a hidden node moves and takes new nodes by its mask name, and a loop through it keeps its words (the shape is visible)', () => {
		const mask: ScenarioMask = { nodes: { B: 'Farm 1', C: 'Farm 2' } };
		const r = applyScenario(base(), [{ op: 'node.move', nodeId: 'B', downstreamNodeId: 'A' }], { mask });
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'B')!.name).toBe('Farm B');
		expect(applyScenario(base(), [{ op: 'node.move', nodeId: 'A', downstreamNodeId: 'C' }], { mask }).problems).toEqual([
			'op 1 (node.move): the network has a loop through "Farm A"; the network has a loop through "Farm 2"'
		]);
		const dam = node('D', { name: 'New dam', downstreamNodeId: 'G', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		expect(applyScenario(base(), [{ op: 'node.insert', node: dam, upstreamNodeIds: ['B'] }], { mask }).applied[0]!.notes).toEqual(['"Farm 1" now drains into "New dam"']);
	});
});

describe('later ops (engine ≥ 1.34.0): crops, land cover, rule tables, registered volumes', () => {
	const snap = (x: ModelInput) => ({ settings: x.settings, model: x.model, series: {} });
	const texts = (a: ModelInput, b: ModelInput) => diffInputs(snap(a), snap(b)).map((c) => c.text);
	const alloc = (over: Partial<AllocationEntry> = {}): AllocationEntry => ({ id: 'al1', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 120_000, ...over });
	const withAllocations = () => {
		const b = base();
		b.model.allocations = [alloc(), alloc({ id: 'al2', nodeId: 'B', volumeM3PerYear: 50_000 })];
		return b;
	};

	it('crop.set changes a crop’s name, factors or own efficiency, and run comparison lists it', () => {
		const b = deepFreeze(base());
		const factors = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1, 0.9, 0.8, 0.7, 0.6, 0.5];
		const r = applyScenario(b, [
			{ op: 'crop.set', cropId: 'c1', field: 'cropFactor', value: factors },
			{ op: 'crop.set', cropId: 'c1', field: 'irrigationEfficiency', value: 0.9 },
			{ op: 'crop.set', cropId: 'c1', field: 'name', value: '  Drip lucerne ' }
		]);
		expect(r.problems).toEqual([]);
		expect(r.input.model.crops).toEqual([{ id: 'c1', name: 'Drip lucerne', cropFactor: factors, irrigationEfficiency: 0.9 }]);
		expect(b.model.crops[0]!.name).toBe('Lucerne');
		expect(texts(b, r.input)).toEqual(expect.arrayContaining([expect.stringMatching(/Drip lucerne/), expect.stringMatching(/irrigation efficiency: the farm's → 90/)]));
		// The run: a lower crop factor lowers the farms' demand for it.
		const lower = applyScenario(base(), [{ op: 'crop.set', cropId: 'c1', field: 'cropFactor', value: new Array(12).fill(0.1) }]).input;
		const d = (x: ModelInput) => runModel(x).series.find((s) => s.nodeId === 'A' && s.key === 'demand')!.values.reduce((s, v) => s + v, 0);
		expect(d(lower)).toBeLessThan(d(base()));
	});

	it('crop.set refuses a missing crop, a bad value, a field it can’t set and a duplicate name', () => {
		expect(one({ op: 'crop.set', cropId: 'cx', field: 'name', value: 'X' }).problems).toEqual(['op 1 (crop.set): crop cx not found']);
		expect(one({ op: 'crop.set', cropId: 'c1', field: 'cropFactor', value: [1] } as unknown as ScenarioOp).problems).toEqual(['op 1 (crop.set): cropFactor must be 12 crop factors ≥ 0']);
		expect(one({ op: 'crop.set', cropId: 'c1', field: 'irrigationEfficiency', value: 0 }).problems).toEqual(['op 1 (crop.set): irrigationEfficiency must be above 0']);
		expect(one({ op: 'crop.set', cropId: 'c1', field: 'id', value: 'c9' } as unknown as ScenarioOp).problems).toEqual(['op 1 (crop.set): id "id" is not a crop field a scenario can set']);
		const b = base();
		b.model.crops.push({ id: 'c2', name: 'Citrus', cropFactor: new Array(12).fill(0.7) });
		expect(applyScenario(b, [{ op: 'crop.set', cropId: 'c2', field: 'name', value: 'LUCERNE' }]).problems).toEqual(['op 1 (crop.set): duplicate crop name "lucerne"']);
	});

	it('crop.remove drops the crop and every farm’s area of it, counting only what a masked caller sees', () => {
		const r = one({ op: 'crop.remove', cropId: 'c1' });
		expect(r.problems).toEqual([]);
		expect(r.input.model.crops).toEqual([]);
		expect(r.input.model.cropAreas).toEqual([]);
		expect(r.applied[0]!.notes).toEqual(['dropped 2 crop area(s)']);
		expect(texts(base(), r.input)).toEqual(expect.arrayContaining([expect.stringMatching(/Lucerne/)]));
		expect(one({ op: 'crop.remove', cropId: 'cx' }).problems).toEqual(['op 1 (crop.remove): crop cx not found']);
		// C (hidden) grows it too: the applicant is told of their own farm's area only.
		const masked = applyScenario(base(), [{ op: 'crop.remove', cropId: 'c1' }], { mask: { nodes: { B: 'Farm 1', C: 'Farm 2' } } });
		expect(masked.applied[0]!.notes).toEqual(['dropped 1 crop area(s)']);
		expect(masked.input.model.cropAreas).toEqual([]);
	});

	it('crop.set and crop.remove are the proposal only on a crop the scenario added', () => {
		const add: ScenarioOp = { op: 'crop.add', crop: { id: 'c9', name: 'Olives', cropFactor: new Array(12).fill(0.5) } };
		const set = (cropId: string): ScenarioOp => ({ op: 'crop.set', cropId, field: 'irrigationEfficiency', value: 0.95 });
		expect(classifyOp(set('c1'), ['A', 'B', 'C'], base())).toBe('baseline');
		expect(classifyOp({ op: 'crop.remove', cropId: 'c1' }, ['A', 'B', 'C'], base())).toBe('baseline');
		expect(classifyOp(set('c9'), [], base(), ['c9'])).toBe('proposal');
		expect(classifyScenario(base(), [add, set('c9'), { op: 'crop.remove', cropId: 'c9' }, set('c1')], [])).toEqual(['proposal', 'proposal', 'proposal', 'baseline']);
		// A crop.add that didn't apply (its id taken) adds nothing to change.
		expect(classifyScenario(base(), [{ ...add, crop: { ...add.crop, id: 'c1' } } as ScenarioOp, set('c1')], [])).toEqual(['proposal', 'baseline']);
	});

	it('landCover.set changes a patch in place; run comparison lists the area, the cover and the reductions', () => {
		const b = deepFreeze(base());
		const r = applyScenario(b, [
			{ op: 'landCover.set', patchId: 'lc1', field: 'densityPct', value: 0.1 },
			{ op: 'landCover.set', patchId: 'lc1', field: 'factors', value: { mar: 0.2, lowFlow: 0.3 } }
		]);
		expect(r.problems).toEqual([]);
		expect(r.input.model.landCover).toEqual([{ id: 'lc1', nodeId: 'B', coverClass: 'pine', areaKm2: 1, densityPct: 0.1, factors: { mar: 0.2, lowFlow: 0.3 } }]);
		expect(texts(b, r.input)).toEqual(['Farm B: land cover "pine" 0.5 km² → 0.1 km² condensed, reductions changed']);
		// A patch at no cover: its area alone moves, and its cover alone does, each listed.
		const bare = base();
		bare.model.landCover![0]!.densityPct = 0;
		expect(texts(bare, one({ op: 'landCover.set', patchId: 'lc1', field: 'areaKm2', value: 2 }, bare).input)).toEqual(['Farm B: land cover "pine" 0 km² → 0 km² condensed (area 1 km² → 2 km²)']);
		const none = base();
		none.model.landCover![0]!.areaKm2 = 0;
		expect(texts(none, one({ op: 'landCover.set', patchId: 'lc1', field: 'densityPct', value: 0.9 }, none).input)).toEqual(['Farm B: land cover "pine" 0 km² → 0 km² condensed, its patches’ cover changed']);
		// Another class is another patch group: removed from one, added to the other.
		expect(texts(base(), one({ op: 'landCover.set', patchId: 'lc1', field: 'coverClass', value: 'eucalyptus' }).input)).toHaveLength(2);
	});

	it('landCover.set refuses a missing patch, a bad value and nodeId; classified by the patch’s farm', () => {
		expect(one({ op: 'landCover.set', patchId: 'lx', field: 'areaKm2', value: 1 }).problems).toEqual(['op 1 (landCover.set): land-cover patch lx not found']);
		expect(one({ op: 'landCover.set', patchId: 'lc1', field: 'densityPct', value: 2 }).problems).toEqual(['op 1 (landCover.set): densityPct must be at most 1']);
		expect(one({ op: 'landCover.set', patchId: 'lc1', field: 'nodeId', value: 'A' } as unknown as ScenarioOp).problems).toEqual(['op 1 (landCover.set): nodeId "nodeId" is not a land-cover field a scenario can set']);
		const op: ScenarioOp = { op: 'landCover.set', patchId: 'lc1', field: 'densityPct', value: 0 };
		expect(classifyOp(op, ['B'], base())).toBe('proposal');
		expect(classifyOp(op, ['A'], base())).toBe('baseline');
		expect(classifyOp(op, ['B'])).toBe('baseline');
	});

	it('ewrRule.remove removes a site’s table however it is keyed, always a baseline assumption', () => {
		// base() keys the outlet's table by its id (G) and has one at the farm A.
		const b = deepFreeze(base());
		const r = applyScenario(b, [{ op: 'ewrRule.remove', siteNodeId: null }]);
		expect(r.problems).toEqual([]);
		expect(r.input.settings.ewrRules).toEqual([blankEwrRuleTable('A')]);
		expect(b.settings.ewrRules).toHaveLength(2);
		expect(texts(b, r.input)).toEqual([expect.stringMatching(/^EWR rule table at Outlet gauge/)]);
		expect(one({ op: 'ewrRule.remove', siteNodeId: 'G' }).input.settings.ewrRules).toEqual([blankEwrRuleTable('A')]);
		// Removed once, it's gone: a second remove is a problem, and so is a site with none.
		expect(applyScenario(base(), [{ op: 'ewrRule.remove', siteNodeId: null }, { op: 'ewrRule.remove', siteNodeId: 'G' }]).problems).toEqual(['op 2 (ewrRule.remove): there is no EWR rule table at the outlet']);
		expect(one({ op: 'ewrRule.remove', siteNodeId: 'B' }).problems).toEqual(['op 1 (ewrRule.remove): there is no EWR rule table at node B']);
		expect(classifyOp({ op: 'ewrRule.remove', siteNodeId: null }, ['A', 'B', 'C', 'G'], base())).toBe('baseline');
	});

	it('allocation.set adds or replaces a registered volume by id; allocation.remove removes one', () => {
		const b = deepFreeze(withAllocations());
		const r = applyScenario(b, [
			{ op: 'allocation.set', allocation: alloc({ volumeM3PerYear: 200_000, months: [3, 1, 2], maxRateM3s: 0.05 }) },
			{ op: 'allocation.set', allocation: alloc({ id: 'al3', nodeId: 'C', waterSource: 'groundwater', volumeM3PerYear: 10_000, storageM3: 5_000 }) },
			{ op: 'allocation.remove', allocationId: 'al2' }
		]);
		expect(r.problems).toEqual([]);
		expect(r.input.model.allocations).toEqual([
			alloc({ volumeM3PerYear: 200_000, months: [1, 2, 3], maxRateM3s: 0.05 }),
			alloc({ id: 'al3', nodeId: 'C', waterSource: 'groundwater', volumeM3PerYear: 10_000, storageM3: 5_000 })
		]);
		expect(b.model.allocations).toHaveLength(2);
		const t = texts(b, r.input);
		expect(t).toContain('Farm A: registered volume surface 120 000 m³/a → surface 200 000 m³/a, months 1 2 3, at most 0.05 m³/s');
		expect(t).toContain('Registered volume added to Farm C (groundwater 10 000 m³/a, storage 5 000 m³)');
		expect(t).toContain('Registered volume removed from Farm B (was surface 50 000 m³/a)');
		// A licence condition on its own is listed too.
		expect(texts(b, one({ op: 'allocation.set', allocation: alloc({ maxRateM3s: 0.02 }) }, withAllocations()).input)).toEqual(['Farm A: registered volume surface 120 000 m³/a → surface 120 000 m³/a, at most 0.02 m³/s']);
	});

	it('allocation.set refuses a gauge, a missing node, a bad entry; allocation.remove a missing id', () => {
		expect(one({ op: 'allocation.set', allocation: alloc({ nodeId: 'G' }) }).problems).toEqual(['op 1 (allocation.set): a registered volume is held for a farm or other water user; "Outlet gauge" is a gauge']);
		expect(one({ op: 'allocation.set', allocation: alloc({ nodeId: 'Z' }) }).problems).toEqual(['op 1 (allocation.set): node Z not found']);
		expect(one({ op: 'allocation.set', allocation: alloc({ volumeM3PerYear: -1 }) }).problems).toEqual(["op 1 (allocation.set): the registered volume isn't usable: volumeM3PerYear must be a number of m³ from 0 to below 10¹²"]);
		expect(one({ op: 'allocation.set', allocation: alloc({ validFrom: '2022-01-01', validTo: '2021-01-01' }) }).problems).toEqual(["op 1 (allocation.set): the registered volume isn't usable: validTo is before valid from (2022-01-01)"]);
		expect(one({ op: 'allocation.remove', allocationId: 'al9' }).problems).toEqual(['op 1 (allocation.remove): registered volume al9 not found']);
	});

	it('a volume on the own unit is the proposal; on another’s, or replacing another’s, baseline', () => {
		const b = withAllocations();
		expect(classifyOp({ op: 'allocation.set', allocation: alloc({ volumeM3PerYear: 1 }) }, ['A'], b)).toBe('proposal');
		expect(classifyOp({ op: 'allocation.set', allocation: alloc({ id: 'new' }) }, ['A'], b)).toBe('proposal');
		expect(classifyOp({ op: 'allocation.set', allocation: alloc({ id: 'new' }) }, ['A'])).toBe('baseline');
		expect(classifyOp({ op: 'allocation.set', allocation: alloc({ id: 'new', nodeId: 'B' }) }, ['A'], b)).toBe('baseline');
		// al2 is B's: moving it onto A takes another's volume.
		expect(classifyOp({ op: 'allocation.set', allocation: alloc({ id: 'al2' }) }, ['A'], b)).toBe('baseline');
		expect(classifyOp({ op: 'allocation.remove', allocationId: 'al1' }, ['A'], b)).toBe('proposal');
		expect(classifyOp({ op: 'allocation.remove', allocationId: 'al2' }, ['A'], b)).toBe('baseline');
	});

	it('the run caps use at a scenario’s volume (allocationMode cap)', () => {
		const b = withAllocations();
		b.settings.allocationMode = 'cap';
		const use = (x: ModelInput) => runModel(x).series.find((s) => s.nodeId === 'A' && s.key === 'supplied')!.values.reduce((s, v) => s + v, 0);
		const capped = applyScenario(b, [{ op: 'allocation.set', allocation: alloc({ volumeM3PerYear: 1_000 }) }]).input;
		expect(use(capped)).toBeLessThan(use(b));
	});

	it('masked: a hidden volume answers exactly as a free id, and one reusing its id moves to a fresh id', () => {
		const mask: ScenarioMask = { nodes: { B: 'Farm 1', C: 'Farm 2' }, allocations: ['al2'] };
		const told = (r: ReturnType<typeof applyScenario>, id: string) => JSON.stringify([r.applied, r.problems]).replaceAll(id, 'ID');
		const rm = (id: string): ScenarioOp => ({ op: 'allocation.remove', allocationId: id });
		const h = applyScenario(withAllocations(), [rm('al2')], { mask });
		expect(h.problems).toEqual([expect.stringMatching(/not found$/)]);
		expect(told(h, 'al2')).toBe(told(applyScenario(withAllocations(), [rm('free')], { mask }), 'free'));
		expect(applyScenario(withAllocations(), [rm('al2')]).problems).toEqual([]);
		const set = (id: string): ScenarioOp => ({ op: 'allocation.set', allocation: alloc({ id, volumeM3PerYear: 9 }) });
		const reuse = applyScenario(deepFreeze(withAllocations()), [set('al2')], { mask });
		expect(reuse.problems).toEqual([]);
		expect(told(reuse, 'al2')).toBe(told(applyScenario(withAllocations(), [set('free')], { mask }), 'free'));
		expect(reuse.reIds).toEqual([{ kind: 'allocation', id: 'al2', as: 'al2-2' }]);
		expect(reuse.input.model.allocations).toEqual([alloc(), alloc({ id: 'al2', nodeId: 'B', volumeM3PerYear: 50_000 }), alloc({ id: 'al2-2', volumeM3PerYear: 9 })]);
		// Classified as it applies: a new volume on the own unit, never a replacement of the hidden one.
		expect(classifyScenario(withAllocations(), [set('al2')], ['A'], { mask })).toEqual(['proposal']);
		expect(classifyScenario(withAllocations(), [set('al2')], ['A'])).toEqual(['baseline']);
	});
});

describe('classifyOp', () => {
	const owned = ['A'];
	const b = base();
	const cls = (op: ScenarioOp) => classifyOp(op, owned, b);

	it('the applicant’s own dam, crops, transfers and land cover are the proposal', () => {
		expect(cls({ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 1 })).toBe('proposal');
		expect(cls({ op: 'cropArea.set', nodeId: 'A', cropId: 'c1', areaM2: 1 })).toBe('proposal');
		expect(cls({ op: 'crop.add', crop: { id: 'x', name: 'x', cropFactor: new Array(12).fill(1) } })).toBe('proposal');
		expect(cls({ op: 'landCover.add', patch: { id: 'p', nodeId: 'A', coverClass: 'pine', areaKm2: 1, densityPct: 1, factors: null } })).toBe('proposal');
		// How the own farm takes water (WP-3.8) is the licence ask itself, like a new pump.
		expect(cls({ op: 'node.set', nodeId: 'A', field: 'supplyRule', value: 'riverFirst' })).toBe('proposal');
		expect(cls({ op: 'node.set', nodeId: 'A', field: 'pumpCapacityM3Day', value: 1200 })).toBe('proposal');
		expect(cls({ op: 'node.set', nodeId: 'A', field: 'supplyTriggerPct', value: 0.3 })).toBe('proposal');
		expect(cls({ op: 'node.set', nodeId: 'B', field: 'supplyRule', value: 'riverFirst' })).toBe('baseline');
		expect(classifyOp({ op: 'transfer.remove', transferId: 't1' }, ['A', 'C'], b)).toBe('proposal');
	});

	it('settings, series, other parties’ nodes and the own farm’s land and flow share are baseline', () => {
		expect(cls({ op: 'settings.set', path: 'lakeEvapFactor', value: 0.5 })).toBe('baseline');
		expect(cls({ op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.9 })).toBe('baseline');
		// demand.scale: a proposal only on the author's own nodes, named (issue #53 R1).
		expect(cls({ op: 'demand.scale', factor: 0.85, nodeIds: ['A'] })).toBe('proposal');
		expect(cls({ op: 'demand.scale', factor: 0.85, nodeIds: ['A'], months: [1], category: 'farm' })).toBe('proposal');
		expect(cls({ op: 'demand.scale', factor: 0.85, nodeIds: ['A', 'B'] })).toBe('baseline');
		expect(cls({ op: 'demand.scale', factor: 0.85 })).toBe('baseline');
		expect(classifyOp({ op: 'demand.scale', factor: 0.85, category: 'user' }, ['A', 'B', 'C'], b)).toBe('baseline');
		expect(cls({ op: 'node.set', nodeId: 'B', field: 'damCapacityM3', value: 1 })).toBe('baseline');
		expect(cls({ op: 'node.set', nodeId: 'A', field: 'areaKm2', value: 9 })).toBe('baseline');
		expect(cls({ op: 'node.set', nodeId: 'A', field: 'flowShareManual', value: 0.9 })).toBe('baseline');
		expect(cls({ op: 'landCover.remove', patchId: 'lc1' })).toBe('baseline');
		// t1 runs C → A: it touches C, which A's owner doesn't own.
		expect(cls({ op: 'transfer.set', transferId: 't1', field: 'enabled', value: false })).toBe('baseline');
		expect(classifyOp({ op: 'transfer.set', transferId: 't1', field: 'fromNodeId', value: 'B' }, ['A', 'C'], b)).toBe('baseline');
	});

	it('new nodes: a pump or dam without land is a proposal, a gauge or new land is baseline', () => {
		const pump = node('N', { downstreamNodeId: 'A', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		expect(cls({ op: 'node.add', node: pump })).toBe('proposal');
		expect(cls({ op: 'node.add', node: { ...pump, areaKm2: 1 } })).toBe('baseline');
		expect(cls({ op: 'node.add', node: { ...pump, kind: 'gauge' } })).toBe('baseline');
		expect(cls({ op: 'node.add', node: { ...pump, flowShareManual: 0.9 } })).toBe('baseline');
	});

	it('removing a node needs the input, and is baseline for land or a gauge', () => {
		const noLand = base();
		Object.assign(nodeOf(noLand, 'A')!, { areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		noLand.settings.ewrRules = [blankEwrRuleTable('G')];
		expect(classifyOp({ op: 'node.remove', nodeId: 'A' }, owned, noLand)).toBe('proposal');
		expect(classifyOp({ op: 'node.remove', nodeId: 'A' }, owned)).toBe('baseline');
		expect(cls({ op: 'node.remove', nodeId: 'A' })).toBe('baseline');
		// A (land-free) still hosts an EWR rule table, which the removal drops.
		expect(classifyOp({ op: 'node.remove', nodeId: 'A' }, owned, { ...noLand, settings: { ...noLand.settings, ewrRules: [blankEwrRuleTable('A')] } })).toBe('baseline');
		Object.assign(nodeOf(noLand, 'A')!, { flowShareManual: 0.3 });
		expect(classifyOp({ op: 'node.remove', nodeId: 'A' }, owned, noLand)).toBe('baseline');
	});

	it('classifyScenario counts nodes the scenario added as owned', () => {
		const pump = node('N', { downstreamNodeId: 'A', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, damCapacityM3: 1000 });
		const ops: ScenarioOp[] = [
			{ op: 'node.add', node: pump },
			{ op: 'node.set', nodeId: 'N', field: 'damCapacityM3', value: 2000 },
			{ op: 'transfer.add', transfer: { id: 't2', fromNodeId: 'N', toNodeId: 'A', months: [1], maxRateM3s: 0.1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 } },
			{ op: 'transfer.set', transferId: 't2', field: 'maxRateM3s', value: 0.2 },
			{ op: 'node.set', nodeId: 'B', field: 'damCapacityM3', value: 1 }
		];
		expect(classifyScenario(base(), ops, owned)).toEqual(['proposal', 'proposal', 'proposal', 'proposal', 'baseline']);
	});
});

describe('validateScenarioOps', () => {
	it('accepts every op kind and rebuilds it from known fields only', () => {
		const raw = [
			{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 1, extra: 'dropped' },
			{ op: 'node.add', node: { ...node('N', { downstreamNodeId: 'A' }), junk: 1 } },
			{ op: 'node.remove', nodeId: 'A' },
			{ op: 'cropArea.set', nodeId: 'A', cropId: 'c1', areaM2: 0 },
			{ op: 'crop.add', crop: { id: 'c2', name: 'Citrus', cropFactor: new Array(12).fill(0.7) } },
			{ op: 'transfer.add', transfer: { id: 't2', fromNodeId: 'A', toNodeId: 'B', months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 } },
			{ op: 'transfer.set', transferId: 't1', field: 'dailyCapM3', value: null },
			{ op: 'transfer.remove', transferId: 't1' },
			{ op: 'landCover.add', patch: { id: 'p', nodeId: 'A', coverClass: 'pine', areaKm2: 1, densityPct: 1, factors: { mar: 0.1, lowFlow: 0.2 } } },
			{ op: 'landCover.remove', patchId: 'lc1' },
			{ op: 'settings.set', path: 'reportStart', value: null },
			{ op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.9, from: '2021-01-01', to: '2021-12-31' },
			{ op: 'demand.scale', factor: 0.85 },
			{ op: 'demand.scale', factor: 0.7, nodeIds: ['A', 'B'], months: [12, 1], category: 'farm', junk: true },
			{ op: 'ewrRule.set', table: { ...blankEwrRuleTable(null), source: 'Invented study', junk: 1, highFlows: [{ label: 'Freshet', months: [11], peakM3s: 2, durationDays: 3, perYear: 1, junk: 2 }] } }
		];
		const { ops, errors } = validateScenarioOps(raw);
		expect(errors).toEqual([]);
		expect(ops).toHaveLength(raw.length);
		expect(ops[0]).toEqual({ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 1 });
		expect('junk' in (ops[1] as { node: object }).node).toBe(false);
		// Optional fields stay out when not given, so the stored op (and its hash) is what was sent.
		expect(ops[12]).toEqual({ op: 'demand.scale', factor: 0.85 });
		expect(ops[13]).toEqual({ op: 'demand.scale', factor: 0.7, nodeIds: ['A', 'B'], months: [12, 1], category: 'farm' });
		expect(ops[14]).toEqual({ op: 'ewrRule.set', table: { ...blankEwrRuleTable(null), source: 'Invented study', highFlows: [{ label: 'Freshet', months: [11], peakM3s: 2, durationDays: 3, perYear: 1 }] } });
	});

	it('takes the later ops (engine ≥ 1.34.0), rebuilt from known fields, and names each error by path', () => {
		const n = node('N', { downstreamNodeId: 'G' });
		const raw = [
			{ op: 'node.move', nodeId: 'A', downstreamNodeId: 'B', junk: 1 },
			{ op: 'node.insert', node: { ...n, junk: 1 }, upstreamNodeIds: ['A', 'B'] },
			{ op: 'crop.set', cropId: 'c1', field: 'cropFactor', value: new Array(12).fill(0.4) },
			{ op: 'crop.set', cropId: 'c1', field: 'irrigationEfficiency', value: null },
			{ op: 'crop.remove', cropId: 'c1' },
			{ op: 'landCover.set', patchId: 'lc1', field: 'factors', value: { mar: 0.1, lowFlow: 0.2 } },
			{ op: 'ewrRule.remove', siteNodeId: null },
			{ op: 'ewrRule.remove', siteNodeId: 'W' },
			{ op: 'allocation.set', allocation: { id: 'al1', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 1000, holder: 'dropped' } },
			{ op: 'allocation.set', allocation: { id: 'al2', nodeId: 'A', waterSource: 'groundwater', volumeM3PerYear: 0, storageM3: null, validFrom: '2020-10-01', validTo: null, months: [10, 11], maxRateM3s: 0.1 } },
			{ op: 'allocation.remove', allocationId: 'al1' }
		];
		const { ops, errors } = validateScenarioOps(raw);
		expect(errors).toEqual([]);
		expect(ops).toHaveLength(raw.length);
		expect(ops[0]).toEqual({ op: 'node.move', nodeId: 'A', downstreamNodeId: 'B' });
		expect('junk' in (ops[1] as { node: object }).node).toBe(false);
		expect(ops[8]).toEqual({ op: 'allocation.set', allocation: { id: 'al1', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 1000 } });
		const bad = validateScenarioOps([
			{ op: 'node.move', nodeId: 'A' },
			{ op: 'node.insert', node: n, upstreamNodeIds: [] },
			{ op: 'node.insert', node: n, upstreamNodeIds: ['A', 'A'] },
			{ op: 'crop.set', cropId: 'c1', field: 'sortOrder', value: 1 },
			{ op: 'crop.set', cropId: 'c1', field: 'name', value: ' ' },
			{ op: 'landCover.set', patchId: 'lc1', field: 'factors', value: { mar: 2, lowFlow: 0 } },
			{ op: 'landCover.set', patchId: 'lc1', field: 'nodeId', value: 'A' },
			{ op: 'ewrRule.remove' },
			{ op: 'allocation.set', allocation: { id: 'x', nodeId: null, waterSource: 'rain', volumeM3PerYear: 1e12 } },
			{ op: 'allocation.set', allocation: { id: 'x', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 1, months: [1, 1], validFrom: '2021-01-01', validTo: '2020-01-01' } },
			{ op: 'allocation.remove' }
		]);
		expect(bad.ops).toEqual([]);
		expect(bad.errors).toEqual([
			'ops[0].downstreamNodeId: missing',
			'ops[1].upstreamNodeIds: must be a list of at least one node id (the nodes that will drain into the new one; with none, add the node instead)',
			'ops[2].upstreamNodeIds: names a node more than once',
			'ops[3].field: is not a crop field a scenario can set',
			'ops[4].value: must be a name of 1–100 characters',
			'ops[5].value: must be { mar, lowFlow }, each 0–1',
			'ops[6].field: is not a land-cover field a scenario can set',
			'ops[7].siteNodeId: missing',
			'ops[8].allocation.nodeId: must be an id (1–100 characters)',
			'ops[8].allocation.waterSource: must be one of surface, groundwater',
			'ops[8].allocation.volumeM3PerYear: must be a number of m³ from 0 to below 10¹²',
			'ops[9].allocation.months: names a month more than once',
			'ops[9].allocation.validTo: is before valid from (2021-01-01)',
			'ops[10].allocationId: missing'
		]);
	});

	it('checks ewrRule.set’s table with the Settings form’s own checks (engine ≥ 1.6.0)', () => {
		const t = { ...blankEwrRuleTable('W'), source: 'Invented study' };
		const { ops, errors } = validateScenarioOps([
			{ op: 'ewrRule.set', table: t },
			{ op: 'ewrRule.set', table: { ...t, sourceKind: 'desktop' } },
			{ op: 'ewrRule.set' },
			{ op: 'ewrRule.set', table: { ...t, source: '' } },
			{ op: 'ewrRule.set', table: { ...t, sourceKind: 'rumour', unit: 'gallons' } },
			{ op: 'ewrRule.set', table: { ...t, naturalSource: 'table', natural: null } },
			{ op: 'ewrRule.set', table: { ...t, siteNodeId: undefined } },
			{ op: 'ewrRule.set', table: { ...t, ewr: [[1]] } },
			{ op: 'ewrRule.set', table: { ...t, highFlows: [{ label: 'Flood', months: [1], peakM3s: 1, durationDays: 90, perYear: 12 }] } }
		]);
		expect(ops).toHaveLength(2);
		expect(errors).toEqual([
			'ops[2].table: must be a rule table',
			'ops[3].table.source: Say where the table comes from (Reserve determination, gazette notice, table).',
			'ops[4].table.sourceKind: must be one of gazetted, desktop, other',
			'ops[4].table.unit: must be one of mcm, m3s',
			'ops[5].table.natural: Enter the natural flow at each point, or find the percentile from the run.',
			'ops[6].table.siteNodeId: missing',
			'ops[7].table.ewr: Enter 12 rows of EWR values (Oct … Sep).',
			"ops[8].table.highFlows: High flow 1: 12 events of 90 days don't fit in a year."
		]);
	});

	it('takes node.set of the supply rule and river pump (WP-3.8), each value checked', () => {
		const { ops, errors } = validateScenarioOps([
			{ op: 'node.set', nodeId: 'A', field: 'supplyRule', value: 'riverFirst' },
			{ op: 'node.set', nodeId: 'A', field: 'pumpCapacityM3Day', value: 1200 },
			{ op: 'node.set', nodeId: 'A', field: 'pumpCapacityM3Day', value: null },
			{ op: 'node.set', nodeId: 'A', field: 'supplyTriggerPct', value: 0.3 },
			{ op: 'node.set', nodeId: 'A', field: 'supplyStopPct', value: 0.7 },
			{ op: 'node.set', nodeId: 'A', field: 'supplyRule', value: 'pumpAlways' },
			{ op: 'node.set', nodeId: 'A', field: 'pumpCapacityM3Day', value: -5 },
			{ op: 'node.set', nodeId: 'A', field: 'supplyStopPct', value: 2 }
		]);
		expect(ops).toHaveLength(5);
		expect(errors).toEqual([
			'ops[5].value: must be one of damFirst, riverFirst, trigger, runOfRiver',
			'ops[6].value: must be at least 0',
			'ops[7].value: must be at most 1'
		]);
	});

	it('checks demand.scale: the factor 0–2, a non-empty list of distinct nodes and months, the category', () => {
		const { ops, errors } = validateScenarioOps([
			{ op: 'demand.scale', factor: 2.5 },
			{ op: 'demand.scale', factor: -0.1 },
			{ op: 'demand.scale' },
			{ op: 'demand.scale', factor: 1, nodeIds: [] },
			{ op: 'demand.scale', factor: 1, nodeIds: ['A', 'A'] },
			{ op: 'demand.scale', factor: 1, nodeIds: 'A' },
			{ op: 'demand.scale', factor: 1, months: [] },
			{ op: 'demand.scale', factor: 1, months: [0, 13] },
			{ op: 'demand.scale', factor: 1, months: [3, 3] },
			{ op: 'demand.scale', factor: 1, category: 'gauge' },
			{ op: 'demand.scale', factor: 0, nodeIds: ['A'], months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], category: 'user' }
		]);
		expect(errors).toEqual([
			'ops[0].factor: must be at most 2',
			'ops[1].factor: must be at least 0',
			'ops[2].factor: missing',
			'ops[3].nodeIds: must be a list of at least one node id (leave it out for every node of the category)',
			'ops[4].nodeIds: names a node more than once',
			'ops[5].nodeIds: must be a list of at least one node id (leave it out for every node of the category)',
			'ops[6].months: must be a list of at least one calendar month (leave it out for every month)',
			'ops[7].months: months must be whole numbers 1–12',
			'ops[8].months: names a month more than once',
			'ops[9].category: must be one of farm, user'
		]);
		expect(ops).toEqual([{ op: 'demand.scale', factor: 0, nodeIds: ['A'], months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], category: 'user' }]);
	});

	it('takes a crop’s own irrigation efficiency and the monthly effective-rain fraction (engine 0.43.0)', () => {
		const crop = { id: 'c2', name: 'Citrus', cropFactor: new Array(12).fill(0.5) };
		const f = new Array(12).fill(0.6);
		const good = validateScenarioOps([
			{ op: 'crop.add', crop: { ...crop, irrigationEfficiency: 0.9 } },
			{ op: 'crop.add', crop: { ...crop, id: 'c3', name: 'Olives', irrigationEfficiency: null } },
			{ op: 'settings.set', path: 'effectiveRainFractionMonthly', value: f },
			{ op: 'settings.set', path: 'effectiveRainFractionMonthly', value: null }
		]);
		expect(good.errors).toEqual([]);
		expect((good.ops[0] as { crop: { irrigationEfficiency?: number } }).crop.irrigationEfficiency).toBe(0.9);
		const bad = validateScenarioOps([
			{ op: 'crop.add', crop: { ...crop, irrigationEfficiency: 0 } },
			{ op: 'settings.set', path: 'effectiveRainFractionMonthly', value: [...f.slice(0, 11), 1.5] }
		]);
		expect(bad.ops).toEqual([]);
		expect(bad.errors).toHaveLength(2);
		// Applied, the scenario runs the crop on its own efficiency.
		expect(one({ op: 'crop.add', crop: { ...crop, irrigationEfficiency: 0.9 } }).input.model.crops.find((c) => c.id === 'c2')?.irrigationEfficiency).toBe(0.9);
	});

	it('names every error by path and drops the bad entries', () => {
		const { ops, errors } = validateScenarioOps([
			{ op: 'node.set', nodeId: 'A', field: 'kind', value: 'gauge' },
			{ op: 'node.set', nodeId: 'A', field: 'damMinPct', value: 2 },
			{ op: 'settings.set', path: 'simulationStart', value: '2021-02-30' },
			{ op: 'series.scale', kind: 'flow_observed_m3s', factor: 1 },
			{ op: 'series.scale', kind: 'rain_catchment_mm', factor: 11, from: '2022-01-01', to: '2021-01-01' },
			{ op: 'crop.add', crop: { id: 'c', name: '', cropFactor: [1] } },
			{ op: 'teleport' },
			'node.remove',
			{ op: 'node.remove', nodeId: 'A' }
		]);
		expect(ops).toEqual([{ op: 'node.remove', nodeId: 'A' }]);
		expect(errors).toEqual([
			'ops[0].field: is not a node field a scenario can set',
			'ops[1].value: must be at most 1',
			'ops[2].value: must be an ISO date (YYYY-MM-DD)',
			'ops[3].kind: must be one of rain_catchment_mm, rain_chirps_mm, rain_forecast_mm, evap_apan_mm',
			'ops[4].factor: must be at most 10',
			'ops[4]: from 2022-01-01 is after to 2021-01-01',
			'ops[5].crop.name: must be a name of 1–100 characters',
			'ops[5].crop.cropFactor: must be 12 crop factors ≥ 0',
			expect.stringMatching(/^ops\[6\]\.op: must be one of node\.set/),
			'ops[7]: must be an object'
		]);
	});

	it('rejects a non-list and an over-long list', () => {
		expect(validateScenarioOps({}).errors).toEqual(['ops: must be a list']);
		expect(validateScenarioOps(new Array(501).fill({ op: 'node.remove', nodeId: 'A' })).errors[0]).toMatch(/at most 500/);
	});
});

describe('mask: names (an application judged in its applicant’s namespace, WP-3.3)', () => {
	// The applicant owns A; B and C are hidden, shown to them as "Farm 1" and "Farm 2".
	const masked = { nodes: { B: 'Farm 1', C: 'Farm 2' }, crops: ['c1'] };
	const rename = (nodeId: string, value: string): ScenarioOp => ({ op: 'node.set', nodeId, field: 'name', value });

	it('never mutates the base, and restores every hidden name when nothing took it', () => {
		const b = deepFreeze(base());
		const r = applyScenario(b, [{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 250_000 }], { mask: masked });
		expect(r.problems).toEqual([]);
		expect(r.renamed).toEqual([]);
		expect(r.input.model.nodes.map((n) => n.name)).toEqual(b.model.nodes.map((n) => n.name));
		expect(r.input.model.crops.map((c) => c.name)).toEqual(['Lucerne']);
	});

	it('lets an op take a hidden name, and suffixes the hidden one past every name in use', () => {
		const added: ScenarioOp = { op: 'node.add', node: { ...nodeOf(base(), 'B')!, id: 'N', name: 'Farm B (2)', downstreamNodeId: 'G' } };
		const r = applyScenario(base(), [added, rename('A', 'farm b')], { mask: masked });
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'A')!.name).toBe('farm b');
		expect(nodeOf(r.input, 'B')!.name).toBe('Farm B (3)');
		expect(r.renamed).toEqual([{ kind: 'node', id: 'B', name: 'Farm B', as: 'Farm B (3)' }]);
		// Unmasked, the same rename is refused.
		expect(applyScenario(base(), [rename('A', 'farm b')]).problems).toEqual(['op 1 (node.set): duplicate node name "farm b"']);
	});

	it('quotes the mask name, never the real one, in what it says about a hidden node', () => {
		const r = applyScenario(base(), [{ op: 'node.remove', nodeId: 'A' }], { mask: masked });
		expect(r.applied[0]!.notes[0]).toBe('"Farm 2" now drains into G');
		expect(JSON.stringify([r.applied, r.problems])).not.toContain('Farm C');
	});

	it('classifies as applyScenario applies: a node added under a hidden name is still the applicant’s', () => {
		const add: ScenarioOp = { op: 'node.add', node: { ...nodeOf(base(), 'B')!, id: 'N', name: 'Farm C', downstreamNodeId: 'A', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 } };
		const set: ScenarioOp = { op: 'node.set', nodeId: 'N', field: 'damCapacityM3', value: 10 };
		expect(classifyScenario(base(), [add, set], ['A'], { mask: masked })).toEqual(['proposal', 'proposal']);
		// Unmasked the add collides, so N never exists and the set on it is the baseline's.
		expect(classifyScenario(base(), [add, set], ['A'])).toEqual(['proposal', 'baseline']);
	});

	it('leaves a hidden node an op renamed under the op’s name', () => {
		const r = applyScenario(base(), [rename('B', 'Something else')], { mask: masked });
		expect(nodeOf(r.input, 'B')!.name).toBe('Something else');
		expect(r.renamed).toEqual([]);
	});
});

describe('mask: ids, counts and value rules (docs/followups.md "Hidden ids and counts")', () => {
	// The applicant owns A. Hidden: nodes B and C, crop c2 (on C), transfer t2
	// (C → B), land-cover patch lc1 (on B) and borehole bh1 (on C). t1 (C → A)
	// touches A, so they see it.
	function baseM(): ModelInput {
		const b = base();
		b.model.crops.push({ id: 'c2', name: 'Pecans', cropFactor: new Array(12).fill(0.6) });
		b.model.cropAreas.push({ nodeId: 'C', cropId: 'c2', areaM2: 100_000 });
		b.model.transfers.push({ id: 't2', fromNodeId: 'C', toNodeId: 'B', months: [6], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 });
		b.model.boreholes = [
			{ id: 'bh1', nodeId: 'C', name: 'Secret hole', capacityM3Day: 100, annualCapM3: null, mode: 'emergency', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0 }
		];
		return b;
	}
	const mask: ScenarioMask = { nodes: { B: 'Farm 1', C: 'Farm 2' }, crops: ['c2'], transfers: ['t2'], landCover: ['lc1'], boreholes: ['bh1'] };
	const apply = (ops: ScenarioOp[], b = baseM()) => applyScenario(b, ops, { mask });
	/** What the applicant is told: what applied (with its notes) and the problems, the probed id written as ID. */
	const told = (r: ReturnType<typeof applyScenario>, id: string) => JSON.stringify([r.applied, r.problems]).replaceAll(id, 'ID');

	const targeting: [string, string, (id: string) => ScenarioOp][] = [
		['transfer.set', 't2', (id) => ({ op: 'transfer.set', transferId: id, field: 'maxRateM3s', value: 1 })],
		['transfer.remove', 't2', (id) => ({ op: 'transfer.remove', transferId: id })],
		['landCover.remove', 'lc1', (id) => ({ op: 'landCover.remove', patchId: id })],
		['borehole.remove', 'bh1', (id) => ({ op: 'borehole.remove', boreholeId: id })],
		['cropArea.set', 'c2', (id) => ({ op: 'cropArea.set', nodeId: 'A', cropId: id, areaM2: 10 })]
	];

	it.each(targeting)('%s on a hidden id answers exactly as on a free one (not found)', (_, hidden, op) => {
		const h = apply([op(hidden)]);
		const f = apply([op('free-id')]);
		expect(h.problems).toEqual([expect.stringMatching(/not found$/)]);
		expect(told(h, hidden)).toBe(told(f, 'free-id'));
		expect([h.renamed, h.reIds]).toEqual([[], []]);
		// Positive control: unmasked (a team scenario) the hidden id is found and the op applies.
		expect(applyScenario(baseM(), [op(hidden)]).problems).toEqual([]);
	});

	const reusing: [string, string, (id: string) => ScenarioOp][] = [
		['transfer', 't2', (id) => ({ op: 'transfer.add', transfer: { id, fromNodeId: 'A', toNodeId: 'C', months: [1], maxRateM3s: 0.02, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 1 } })],
		['crop', 'c2', (id) => ({ op: 'crop.add', crop: { id, name: 'Olives', cropFactor: new Array(12).fill(0.5) } })],
		['landCover', 'lc1', (id) => ({ op: 'landCover.add', patch: { id, nodeId: 'A', coverClass: 'pine', areaKm2: 0.5, densityPct: 0.4, factors: null } })],
		[
			'borehole',
			'bh1',
			(id) => ({
				op: 'borehole.add',
				borehole: { id, nodeId: 'A', name: 'New hole', capacityM3Day: 50, annualCapM3: null, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0 }
			})
		]
	];
	const listOf = (x: ModelInput, kind: string) =>
		(({ crop: x.model.crops, transfer: x.model.transfers, landCover: x.model.landCover ?? [], borehole: x.model.boreholes ?? [] }) as Record<string, { id: string }[]>)[kind]!;

	it.each(reusing)('a new %s reusing a hidden id applies exactly as a free one, and moves to a fresh id', (kind, hidden, op) => {
		// Frozen: masking and restoring never touch the base.
		const h = apply([op(hidden)], deepFreeze(baseM()));
		const f = apply([op('free-id')]);
		expect(h.problems).toEqual([]);
		expect(told(h, hidden)).toBe(told(f, 'free-id'));
		expect(h.reIds).toEqual([{ kind, id: hidden, as: `${hidden}-2` }]);
		expect(f.reIds).toEqual([]);
		// The hidden item keeps its id and everything else, so it still lines up with the base by id.
		expect(listOf(h.input, kind).find((x) => x.id === hidden)).toEqual(listOf(baseM(), kind).find((x) => x.id === hidden));
		expect(listOf(h.input, kind).filter((x) => x.id === `${hidden}-2`)).toHaveLength(1);
		expect(structureIssues(h.input)).toEqual(structureIssues(baseM()));
		// Positive control: unmasked, the id is in use.
		expect(applyScenario(baseM(), [op(hidden)]).problems).toEqual([expect.stringMatching(/already in use$/)]);
	});

	it('moves the crop areas an op gave a new crop under a hidden crop’s id with it, and leaves the hidden one’s alone', () => {
		const r = apply([reusing[1]![2]('c2'), { op: 'cropArea.set', nodeId: 'A', cropId: 'c2', areaM2: 5_000 }]);
		expect(r.problems).toEqual([]);
		expect(r.input.model.cropAreas.filter((a) => a.cropId.startsWith('c2'))).toEqual([
			{ nodeId: 'C', cropId: 'c2', areaM2: 100_000 },
			{ nodeId: 'A', cropId: 'c2-2', areaM2: 5_000 }
		]);
		expect(r.input.model.crops.find((c) => c.id === 'c2')!.name).toBe('Pecans');
	});

	it('meets no hidden crop whatever the new crop is named (the opaque names are ones no op holds)', () => {
		for (const name of ['#crop1#', '#crop2#', 'pecans']) {
			const r = apply([{ op: 'crop.add', crop: { id: 'n1', name, cropFactor: new Array(12).fill(0.5) } }]);
			expect(r.problems, name).toEqual([]);
		}
	});

	it('counts only what the applicant sees of what a removed node drops', () => {
		// C carries crop areas of c1 and of the hidden c2, t1 (C → A, visible), and the hidden t2 and bh1.
		expect(apply([{ op: 'node.remove', nodeId: 'C' }]).applied[0]!.notes).toEqual(['dropped 1 transfer(s)']);
		expect(apply([{ op: 'node.remove', nodeId: 'B' }]).applied[0]!.notes).toEqual([]);
		// Positive control: unmasked, every count.
		expect(applyScenario(baseM(), [{ op: 'node.remove', nodeId: 'C' }]).applied[0]!.notes).toEqual(['dropped 2 crop area(s)', 'dropped 2 transfer(s)', 'dropped 1 borehole(s)']);
		expect(applyScenario(baseM(), [{ op: 'node.remove', nodeId: 'B' }]).applied[0]!.notes).toEqual(['dropped 1 transfer(s)', 'dropped 1 land-cover patch(es)']);
		// Their own farm still counts what is theirs, and the EWR table sited there (settings are theirs to see).
		expect(apply([{ op: 'node.remove', nodeId: 'A' }]).applied[0]!.notes).toEqual([
			'"Farm 2" now drains into G',
			'dropped 1 crop area(s)',
			'dropped 1 transfer(s)',
			'dropped 1 EWR rule table(s) sited there'
		]);
	});

	it('says only that the op doesn’t apply to the catchment as modelled when hidden data breaks a rule', () => {
		// C's dam gone: the hidden borehole bh1 (emergency mode) and C's drought rule both need it.
		const b = baseM();
		Object.assign(nodeOf(b, 'C')!, { boreholeCapacityM3Day: 200, boreholeRule: 'drought' });
		const op: ScenarioOp = { op: 'node.set', nodeId: 'C', field: 'damCapacityM3', value: 0 };
		expect(apply([op], b).problems).toEqual([`op 1 (node.set): ${MASKED_RULE}`]);
		// Positive control: unmasked, the rules and the borehole are named.
		const plain = applyScenario(b, [op]).problems;
		expect(plain).toHaveLength(1);
		expect(plain[0]).toContain('Secret hole');
		expect(plain[0]).toContain('drought borehole rule');
	});

	it('masks a supply rule that trips on a hidden node\'s dam, and names it unmasked (WP-3.8)', () => {
		// C (hidden) has a dam: run of river doesn't fit it, which only its dam says.
		const op: ScenarioOp = { op: 'node.set', nodeId: 'C', field: 'supplyRule', value: 'runOfRiver' };
		expect(apply([op]).problems).toEqual([`op 1 (node.set): ${MASKED_RULE}`]);
		expect(applyScenario(baseM(), [op]).problems[0]).toMatch(/run of river has no dam/);
		// Their own farm A keeps the rule's words.
		expect(apply([{ ...op, nodeId: 'A' }]).problems[0]).toMatch(/"Farm A": run of river has no dam/);
	});

	it('masks a group\'s rule the same way, naming the hidden node by its mask name', () => {
		// C (hidden) to run of river with its dam emptied: the group fits the supply rule, but C's hidden borehole bh1 needs the dam.
		const ops: ScenarioOp[] = [
			{ op: 'node.set', nodeId: 'C', field: 'supplyRule', value: 'runOfRiver' },
			{ op: 'node.set', nodeId: 'C', field: 'damCapacityM3', value: 0 }
		];
		const r = apply(ops);
		expect(r.problems).toEqual([`ops 1–2 (node.set, "Farm 2"): ${MASKED_RULE}`]);
		expect(r.applied).toEqual([]);
		// Unmasked, the real name and the borehole are named.
		const plain = applyScenario(baseM(), ops).problems;
		expect(plain).toEqual([expect.stringMatching(/^ops 1–2 \(node\.set, "Farm C"\): .*Secret hole/)]);
	});

	it('says only that for the catchment-wide value rules too, while any node is hidden', () => {
		const b = baseM();
		(b.settings as Record<string, unknown>).flowShareMethod = 'manual';
		nodeOf(b, 'C')!.flowShareManual = 0.5;
		const shares: ScenarioOp = { op: 'node.set', nodeId: 'A', field: 'flowShareManual', value: 0.6 };
		expect(applyScenario(b, [shares]).problems).toEqual([expect.stringContaining('more than 100%')]);
		expect(apply([shares], b).problems).toEqual([`op 1 (node.set): ${MASKED_RULE}`]);
		// No land left once their own farm's goes, because no hidden farm has any.
		const dry = baseM();
		for (const id of ['B', 'C']) Object.assign(nodeOf(dry, id)!, { areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		const noLand: ScenarioOp[] = (['areaKm2', 'areaHiKm2', 'areaLoKm2'] as const).map((field) => ({ op: 'node.set', nodeId: 'A', field, value: 0 }));
		const plain = applyScenario(dry, noLand).problems;
		expect(plain).toEqual([expect.stringContaining('the catchment has no area left')]);
		expect(apply(noLand, dry).problems).toEqual([plain[0]!.replace(/: the catchment has no area left.*$/, `: ${MASKED_RULE}`)]);
		// With no node hidden, nothing to hide: the rule keeps its words.
		expect(applyScenario(b, [shares], { mask: { crops: ['c2'] } }).problems).toEqual(applyScenario(b, [shares]).problems);
	});

	it('classifies as it applies: an op on a hidden id meets the applicant’s own item, never the hidden one', () => {
		const ops: ScenarioOp[] = [reusing[0]![2]('t2'), { op: 'transfer.set', transferId: 't2', field: 'maxRateM3s', value: 0.03 }];
		const r = apply(ops);
		expect(r.problems).toEqual([]);
		expect(r.input.model.transfers.find((t) => t.id === 't2')!.maxRateM3s).toBe(0.01);
		expect(r.input.model.transfers.find((t) => t.id === 't2-2')!.maxRateM3s).toBe(0.03);
		expect(classifyScenario(baseM(), ops, ['A', 'C'], { mask })).toEqual(['proposal', 'proposal']);
		// Unmasked the add collides, so the set meets the C → B transfer: not wholly theirs.
		expect(classifyScenario(baseM(), ops, ['A', 'C'])).toEqual(['proposal', 'baseline']);
	});
});

describe('cloneData', () => {
	it('copies plain data deeply and drops keys that would reach a prototype (JSON.parse keeps __proto__ as an own key)', () => {
		const src = JSON.parse('{"a":{"b":[1,{"c":2}]},"__proto__":{"polluted":true},"x":{"constructor":{"prototype":{"bad":1}},"prototype":3,"ok":4}}');
		const out = cloneData(src) as Record<string, unknown>;
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
		expect((out as { polluted?: unknown }).polluted).toBeUndefined();
		expect(Object.keys(out)).toEqual(['a', 'x']);
		expect(out.x).toEqual({ ok: 4 });
		expect(Object.hasOwn(out.x as object, 'constructor')).toBe(false);
		expect(out.a).toEqual({ b: [1, { c: 2 }] });
		expect(out.a).not.toBe(src.a);
		expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
	});
});
