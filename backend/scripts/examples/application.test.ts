// The demo applicant's seeded application (examples/application.ts) passes the
// evidence report's two river checks (evidence-10, docs/evidence-pack.md §
// What stops issue on the river), so the demo can issue an application pack.
// The failing cases are the engine's (evidence/report.test.ts) and the packs
// DB test's; here, the positive control is the seed's own data, and the
// negative one is the same application without its hands-off condition.
import { applyScenario, classifyScenario, proposedRiverWorks, unboundedRiverWorks, type ScenarioOp } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { APPLICATION_FARM, applicationOf } from './application.js';
import { buildExamples, inputOf } from './catchments.js';

const sandspruit = buildExamples({ fit: false }).find((p) => p.name.includes('Sandspruit'))!;
const base = inputOf(sandspruit);
const farm = base.model.nodes.find((n) => n.name === APPLICATION_FARM)!;
const window = { startDate: '2010-01-01', endDate: '2024-12-31' };

function judge(ops: ScenarioOp[]) {
	const after = applyScenario(base, ops).input.model;
	const classified = classifyScenario(base, ops, [farm.id]);
	return { classified, works: proposedRiverWorks(ops, classified, base.model, after, window), unbounded: [...unboundedRiverWorks(base.model, window), ...unboundedRiverWorks(after, window)] };
}

describe('the demo applicant’s application', () => {
	const app = applicationOf(farm.id, farm.damCapacityM3);

	it('is all proposals, and its own river take (River to dam) keeps the EWR; no river take in either run is uncapped', () => {
		const { classified, works, unbounded } = judge(app.ops);
		expect(classified).toEqual(app.ops.map(() => 'proposal'));
		expect(works.map((w) => `${w.kind}:${w.protectsEwr}`)).toEqual(['divert:true']);
		expect(unbounded).toEqual([]);
	});

	it('without the hands-off condition, would fail the EWR check (negative control)', () => {
		const { works } = judge(app.ops.filter((o) => !(o.op === 'node.set' && o.field === 'handsOffEwr')));
		expect(works.map((w) => `${w.kind}:${w.protectsEwr}`)).toEqual(['divert:false']);
	});
});
