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
