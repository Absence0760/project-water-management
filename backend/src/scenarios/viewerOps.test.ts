// A scenario's check as a viewer kept from each farm's volume reads it (issue #523 G1): the ops left out, the rest renumbered.
import { describe, expect, it } from 'vitest';
import { checkWithout, viewerScenario } from './viewerOps.js';
import type { ScenarioRow } from './execute.js';

const set = (nodeId: string) => ({ op: 'allocation.set', allocation: { id: `a-${nodeId}`, nodeId, waterSource: 'surface', volumeM3PerYear: 9 } });
const node = (nodeId: string) => ({ op: 'node.set', nodeId, field: 'damCapacityM3', value: 1 });

describe('viewerScenario', () => {
	it('leaves out every volume set on a unit that isn’t an application’s own (all of a team scenario’s), saying how many', () => {
		const ops = [node('n1'), set('n1'), set('n2')];
		const team = viewerScenario({ ops, origin: 'team', ownedNodeIds: ['n1'] } as unknown as ScenarioRow);
		expect(team.scenario.ops).toEqual([node('n1')]);
		expect(team.scenario.withheldOps).toBe(2);
		const app = viewerScenario({ ops, origin: 'applicant', ownedNodeIds: ['n1'] } as unknown as ScenarioRow);
		expect(app.scenario.ops).toEqual([node('n1'), set('n1')]);
		expect([...app.drop]).toEqual([2]);
		// Nothing to leave out: the row as it was.
		const plain = { ops: [node('n1')], origin: 'team', ownedNodeIds: [] } as unknown as ScenarioRow;
		expect(viewerScenario(plain).scenario).toBe(plain);
	});
});

describe('checkWithout', () => {
	it('drops the left-out ops from the check and renumbers the rest, problem lines and masked rules included', () => {
		const check = {
			applied: [{ index: 0 }, { index: 2 }, { index: 3 }],
			classified: ['proposal', 'baseline', 'baseline', 'proposal'],
			problems: ['op 2 (allocation.set): no such unit', 'ops 3–4 (node.set, "Upper"): breaks a rule', 'ops 1, 2 (node.set, "X"): both', 'a line with no op'],
			maskedRules: [
				{ problem: 0, ops: [1], rules: ['r'] },
				{ problem: 1, ops: [2, 3], rules: ['r'] }
			]
		};
		const out = checkWithout(check, new Set([1]));
		expect(out.applied).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
		expect(out.classified).toEqual(['proposal', 'baseline', 'proposal']);
		expect(out.problems).toEqual(['ops 2–3 (node.set, "Upper"): breaks a rule', 'op 1 (node.set, "X"): both', 'a line with no op']);
		expect(out.maskedRules).toEqual([{ problem: 0, ops: [1, 2], rules: ['r'] }]);
		// Nothing left out: the check as it was.
		expect(checkWithout(check, new Set())).toBe(check);
	});
});
