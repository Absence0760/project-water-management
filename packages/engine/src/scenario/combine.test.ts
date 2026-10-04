// Cumulative impact (roadmap WP-3.11): combineScenarios on crafted pairs.
// Conflicts (the same field written twice, a removed element another
// scenario uses) are refused with a readable reason; disjoint scenarios
// combine to the same run in either order; one scenario combined is that
// scenario alone. Synthetic catchment: invented names and values only.
import { describe, expect, it } from 'vitest';
import { blankEwrRuleTable } from '../reserve/rules';
import { runModel } from '../run';
import type { ModelInput, NetworkNode } from '../project';
import { orderFreeDifference, sameOutput } from '../testing/invariants';
import { combineScenarios, scenarioConflicts, type CombineScenario } from './combine';
import { applyScenario } from './overrides';
import type { ScenarioOp } from './ops';

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
		returnFlowFraction: 0,
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
			ewrPragmaticM3PerDay: [800, 800, 800, 800, 800, 800, 800, 800, 800, 800, 800, 800],
			ewrRules: [blankEwrRuleTable('G')]
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
			landCover: []
		},
		series: { rain_catchment_mm: { startDate: '2020-10-01', values: rain } }
	};
}

const sc = (id: string, ops: ScenarioOp[], name = id): CombineScenario => ({ id, name, ops });

function deepFreeze<T>(v: T): T {
	if (v && typeof v === 'object') {
		for (const x of Object.values(v)) deepFreeze(x);
		Object.freeze(v);
	}
	return v;
}

/** A's dam raised; B plants more lucerne: disjoint. */
const raiseA: ScenarioOp[] = [{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 300_000 }];
const plantB: ScenarioOp[] = [{ op: 'cropArea.set', nodeId: 'B', cropId: 'c1', areaM2: 300_000 }];

describe('combineScenarios: disjoint scenarios', () => {
	it('combine to the same run in either order, and equal applying one after the other', () => {
		const b = deepFreeze(base());
		const ab = combineScenarios(b, [sc('a', raiseA), sc('b', plantB)]);
		const ba = combineScenarios(b, [sc('b', plantB), sc('a', raiseA)]);
		expect(ab.conflicts).toEqual([]);
		expect(ab.problems).toEqual([]);
		expect(ba.input).not.toBeNull();
		const outAB = runModel(ab.input!);
		expect(orderFreeDifference(outAB, runModel(ba.input!))).toBeNull();
		expect(sameOutput(outAB, runModel(applyScenario(applyScenario(b, raiseA).input, plantB).input))).toBe(true);
	});

	it('one scenario combined is that scenario alone', () => {
		const b = base();
		const one = combineScenarios(b, [sc('a', raiseA)]);
		expect(sameOutput(runModel(one.input!), runModel(applyScenario(b, raiseA).input))).toBe(true);
		// No scenarios: the base itself.
		expect(combineScenarios(b, []).input).toBe(b);
	});

	it('two fields of one node are not a conflict', () => {
		const r = combineScenarios(base(), [sc('a', raiseA), sc('b', [{ op: 'node.set', nodeId: 'A', field: 'divertCapacityM3Day', value: 9000 }])]);
		expect(r.conflicts).toEqual([]);
		expect(r.input!.model.nodes.find((n) => n.id === 'A')).toMatchObject({ damCapacityM3: 300_000, divertCapacityM3Day: 9000 });
	});

	it('the two together change the outlet more than either alone', () => {
		const b = base();
		const flow = (x: ModelInput) => runModel(x).summary.catchment.meanSimulatedOutflowM3Day;
		const both = flow(combineScenarios(b, [sc('a', raiseA), sc('b', plantB)]).input!);
		expect(both).toBeLessThan(flow(applyScenario(b, plantB).input));
		expect(both).toBeLessThanOrEqual(flow(applyScenario(b, raiseA).input));
	});
});

describe('combineScenarios: conflicts are refused, never merged', () => {
	const conflictOf = (a: ScenarioOp[], b: ScenarioOp[]) => {
		const r = combineScenarios(base(), [sc('a', a, 'App A'), sc('b', b, 'App B')]);
		expect(r.input).toBeNull();
		return r.conflicts;
	};

	it('the same field of one node', () => {
		const [c, ...rest] = conflictOf(raiseA, [{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 250_000 }]);
		expect(rest).toEqual([]);
		expect(c).toMatchObject({ reason: 'same_target', target: 'node "Farm A": damCapacityM3', a: { scenarioId: 'a', opIndex: 0 }, b: { scenarioId: 'b', opIndex: 0 } });
		expect(c!.message).toBe('"App A" op 1 (node.set) and "App B" op 1 (node.set) both change node "Farm A": damCapacityM3');
	});

	it('a node removed that another scenario adds a farm below', () => {
		const add: ScenarioOp = { op: 'node.add', node: node('N', { name: 'New farm', downstreamNodeId: 'B' }) };
		const [c] = conflictOf([{ op: 'node.remove', nodeId: 'B' }], [add]);
		expect(c).toMatchObject({ reason: 'removed_in_use', target: 'node "Farm B"' });
		expect(c!.message).toBe('"App A" op 1 (node.remove) removes node "Farm B", which "App B" op 1 (node.add) changes or uses');
	});

	it('a node removed whose upstream node another scenario moves (the removal re-links it)', () => {
		const [c] = conflictOf([{ op: 'node.remove', nodeId: 'A' }], [{ op: 'node.move', nodeId: 'C', downstreamNodeId: 'B' }]);
		expect(c).toMatchObject({ reason: 'same_target', target: 'node "Farm C": downstreamNodeId' });
	});

	it('a crop removed that another scenario plants', () => {
		const [c] = conflictOf([{ op: 'crop.remove', cropId: 'c1' }], plantB);
		expect(c).toMatchObject({ reason: 'removed_in_use', target: 'crop "Lucerne"' });
	});

	it('a unit’s efficiency and a planting another scenario sets on that unit, or a crop’s system and a planting of it (engine ≥ 1.72.0, fuzz seed 35)', () => {
		// The efficiency puts every planting on the unit on its system: one planted after it wouldn't be, in one order.
		const [c] = conflictOf([{ op: 'node.set', nodeId: 'B', field: 'irrigationEfficiency', value: 0.7 }], plantB);
		expect(c).toMatchObject({ reason: 'same_target', target: 'crop area of "Lucerne" on "Farm B"' });
		const [d] = conflictOf([{ op: 'crop.set', cropId: 'c1', field: 'irrigationSystemId', value: null }], plantB);
		expect(d).toMatchObject({ reason: 'same_target', target: 'crop area of "Lucerne" on "Farm B"' });
		// Positive controls: a planting on another unit, and another field of the unit, meet nothing.
		expect(scenarioConflicts(base(), [sc('a', [{ op: 'node.set', nodeId: 'A', field: 'irrigationEfficiency', value: 0.7 }]), sc('b', plantB)])).toEqual([]);
		expect(scenarioConflicts(base(), [sc('a', [{ op: 'node.set', nodeId: 'B', field: 'damCapacityM3', value: 1 }]), sc('b', plantB)])).toEqual([]);
	});

	it("a transfer changed whose end another scenario removes", () => {
		const cs = conflictOf([{ op: 'transfer.set', transferId: 't1', field: 'maxRateM3s', value: 0.1 }], [{ op: 'node.remove', nodeId: 'C' }]);
		expect(cs.map((c) => [c.reason, c.target, c.a.scenarioId])).toContainEqual(['removed_in_use', 'node "Farm C"', 'b']);
	});

	it('the same settings path, the same Reserve table, a global and a named demand cut', () => {
		expect(conflictOf([{ op: 'settings.set', path: 'gr4j.x1', value: 300 }], [{ op: 'settings.set', path: 'gr4j.x1', value: 310 }])[0]!.target).toBe('settings: gr4j.x1');
		expect(conflictOf([{ op: 'ewrRule.set', table: blankEwrRuleTable(null) }], [{ op: 'ewrRule.remove', siteNodeId: null }])[0]).toMatchObject({
			reason: 'removed_in_use',
			target: 'Reserve rule table at the outlet'
		});
		expect(conflictOf([{ op: 'demand.scale', factor: 0.9 }], [{ op: 'demand.scale', factor: 0.8, nodeIds: ['B'] }])[0]!.target).toBe('demand of "Farm B"');
	});

	it('two removals of one thing', () => {
		const [c] = conflictOf([{ op: 'crop.remove', cropId: 'c1' }], [{ op: 'crop.remove', cropId: 'c1' }]);
		expect(c!.message).toBe('"App A" op 1 (crop.remove) and "App B" op 1 (crop.remove) both remove crop "Lucerne"');
	});

	it('lists every pair of scenarios that meet, once per target', () => {
		const set = (v: number): ScenarioOp => ({ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: v });
		const cs = scenarioConflicts(base(), [sc('a', [set(1), set(2)]), sc('b', [set(3)]), sc('c', [set(4)])]);
		// a–b, a–c, b–c: one each, though a writes the field twice.
		expect(cs.map((c) => `${c.a.scenarioId}-${c.b.scenarioId}`)).toEqual(['a-b', 'a-c', 'b-c']);
	});

	it('never mutates the base', () => {
		const b = deepFreeze(base());
		expect(() => combineScenarios(b, [sc('a', raiseA), sc('b', raiseA)])).not.toThrow();
		expect(() => combineScenarios(b, [sc('a', [{ op: 'node.remove', nodeId: 'C' }]), sc('b', plantB)])).not.toThrow();
	});
});

describe('combineScenarios: ops that apply alone but not together', () => {
	it('two new farms given one name are refused, naming the scenario whose op failed', () => {
		const r = combineScenarios(base(), [
			sc('a', [{ op: 'node.add', node: node('N1', { name: 'New dam', downstreamNodeId: 'B' }) }], 'App A'),
			sc('b', [{ op: 'node.add', node: node('N2', { name: 'New dam', downstreamNodeId: 'G' }) }], 'App B')
		]);
		expect(r.conflicts).toEqual([]);
		expect(r.input).toBeNull();
		expect(r.problems).toHaveLength(1);
		expect(r.problems[0]).toMatch(/^"App B": op 1 \(node\.add\): /);
	});
});
