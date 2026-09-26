// The model's save rules (modelRules.ts) are the one home the backend's
// modelProblems and applyScenario share. The rules themselves are tested
// through the backend (backend/src/model/validate.test.ts) and the scenario
// ops (scenario/overrides.test.ts); here, what sharing them promises: a
// scenario applied to a valid model never produces a model a save would
// refuse.
import { describe, expect, it } from 'vitest';
import { modelRuleIssues, modelRuleProblems } from './modelRules';
import { randomInput } from './testing/fuzz';
import { randomOps } from './testing/scenarioFuzz';
import { applyScenario } from './scenario/overrides';
import type { ProjectModel } from './project';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.SCENARIO_FUZZ_CASES ?? 300);

describe('modelRuleIssues', () => {
	it('keys each broken rule by ids, and lists each sentence once', () => {
		const n = (id: string, name: string, downstreamNodeId: string | null) => ({ id, name, kind: 'farm', downstreamNodeId }) as ProjectModel['nodes'][number];
		const m = { nodes: [n('g', 'Gauge', null), n('a', 'Farm', 'g'), n('b', ' farm ', 'g'), n('c', 'Other', null)], crops: [], cropAreas: [], transfers: [] } as unknown as ProjectModel;
		const issues = modelRuleIssues(m);
		expect([...issues.keys()].sort()).toEqual(['dup:node name:farm', 'outlets']);
		expect(modelRuleProblems(m)).toEqual(['duplicate node name "farm"', 'the network needs exactly one outflow node (drains into nothing); found 2']);
	});

	it('individual boreholes (WP-3.9): on a farm or user, and emergency mode or pumping into a dam only on a farm with a dam', () => {
		const n = (id: string, kind: string, damCapacityM3: number, downstreamNodeId: string | null) => ({ id, name: id, kind, damCapacityM3, downstreamNodeId }) as ProjectModel['nodes'][number];
		const b = (id: string, nodeId: string, over: object = {}) => ({ id, nodeId, name: id, capacityM3Day: 1, annualCapM3: null, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0, ...over });
		const m = {
			nodes: [n('g', 'gauge', 0, null), n('dam', 'farm', 100, 'g'), n('dry', 'farm', 0, 'g')],
			crops: [],
			cropAreas: [],
			transfers: [],
			boreholes: [b('ok', 'dam', { mode: 'emergency', target: 'dam' }), b('ok2', 'dry'), b('off', 'dry', { mode: 'none', target: 'dam' }), b('x', 'g'), b('y', 'zz'), b('e', 'dry', { mode: 'emergency' }), b('d', 'dry', { target: 'dam' }), b('ok', 'dam')]
		} as unknown as ProjectModel;
		expect([...modelRuleIssues(m).keys()].sort()).toEqual(['bhDam:d', 'bhEmergency:e', 'bhGauge:x', 'bhNode:y', 'dup:borehole id:ok']);
	});

	it('supply rules (WP-3.8): a farm’s; trigger needs a dam; run of river has none; stop ≥ trigger', () => {
		const n = (id: string, kind: string, damCapacityM3: number, over: object = {}) => ({ id, name: id, kind, damCapacityM3, downstreamNodeId: id === 'g' ? null : 'g', ...over }) as ProjectModel['nodes'][number];
		const m = {
			nodes: [
				n('g', 'gauge', 0),
				n('ok1', 'farm', 100, { supplyRule: 'trigger', supplyTriggerPct: 0.3, supplyStopPct: 0.3 }),
				n('ok2', 'farm', 0, { supplyRule: 'runOfRiver', pumpCapacityM3Day: 10 }),
				n('ok3', 'farm', 100, { supplyRule: 'riverFirst', pumpCapacityM3Day: null }),
				n('ok4', 'user', 0, { supplyRule: 'damFirst', pumpCapacityM3Day: null }),
				n('u', 'user', 0, { pumpCapacityM3Day: 5 }),
				n('t', 'farm', 0, { supplyRule: 'trigger' }),
				n('r', 'farm', 100, { supplyRule: 'runOfRiver' }),
				n('s', 'farm', 100, { supplyRule: 'trigger', supplyTriggerPct: 0.5, supplyStopPct: 0.4 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		} as unknown as ProjectModel;
		expect([...modelRuleIssues(m).keys()].sort()).toEqual(['supplyKind:u', 'supplyRor:r', 'supplyStop:s', 'supplyTrigger:t']);
	});

	it('a scenario applied to a valid model leaves a model the backend would save', () => {
		let checked = 0;
		for (let seed = 1; checked < CASES && seed < CASES * 4; seed++) {
			const base = randomInput(seed, { maxNodes: 12, maxDays: 60 });
			// Only bases a save would accept (the fuzz also makes deliberately odd ones).
			if (modelRuleIssues(base.model).size) continue;
			const { input } = applyScenario(base, randomOps(base, seed));
			expect(modelRuleProblems(input.model), `seed ${seed}`).toEqual([]);
			checked++;
		}
		expect(checked).toBeGreaterThan(CASES / 2);
	});
});
