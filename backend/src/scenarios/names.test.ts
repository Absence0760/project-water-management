// opNames (047_scenario_op_names): the names a scenario's ops need, from the
// base run's snapshot, keeping names an earlier base gave.
import type { ScenarioOp } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { applicantOpNames, opNames, ownNames } from './names.js';

const [a, b, c, crop, t] = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-0000000000cc', '00000000-0000-4000-8000-0000000000ff'];
const model = {
	nodes: [
		{ id: b, name: 'Kalkoenkrans' },
		{ id: a, name: 'Rooikloof' },
		{ id: c, name: 'Gauge' }
	],
	crops: [{ id: crop, name: 'Citrus' }]
} as never;

describe('opNames', () => {
	it('names every node and crop an op names, in id order, and nothing else', () => {
		const ops: ScenarioOp[] = [
			{ op: 'cropArea.set', nodeId: b, cropId: crop, areaM2: 1 },
			{ op: 'node.set', nodeId: a, field: 'damCapacityM3', value: 1 }
		];
		expect(opNames(ops, model, [])).toEqual([
			{ id: a, name: 'Rooikloof' },
			{ id: b, name: 'Kalkoenkrans' },
			{ id: crop, name: 'Citrus' }
		]);
	});

	it('names the nodes a demand.scale op names (issue #53 R1)', () => {
		const ops: ScenarioOp[] = [
			{ op: 'demand.scale', factor: 0.85, nodeIds: [c, a] },
			{ op: 'demand.scale', factor: 0.9 }
		];
		expect(opNames(ops, model, []).map((x) => x.id)).toEqual([a, c]);
	});

	it('names a transfer end set by value, and a new node’s downstream node', () => {
		const ops: ScenarioOp[] = [
			{ op: 'transfer.set', transferId: t, field: 'toNodeId', value: c },
			{ op: 'node.remove', nodeId: b }
		];
		expect(opNames(ops, model, []).map((x) => x.name)).toEqual(['Kalkoenkrans', 'Gauge']);
	});

	it('keeps a name the base no longer has while an op names it; the base’s name wins; unused names go', () => {
		const ops: ScenarioOp[] = [{ op: 'node.set', nodeId: b, field: 'damCapacityM3', value: 1 }, { op: 'node.set', nodeId: a, field: 'name', value: 'x' }];
		const newer = { nodes: [{ id: a, name: 'Rooikloof (renamed)' }], crops: [] } as never;
		const kept = [
			{ id: a, name: 'Rooikloof' },
			{ id: b, name: 'Kalkoenkrans' },
			{ id: c, name: 'Gauge' }
		];
		expect(opNames(ops, newer, kept)).toEqual([
			{ id: a, name: 'Rooikloof (renamed)' },
			{ id: b, name: 'Kalkoenkrans' }
		]);
		expect(opNames(ops, null, kept)).toEqual(kept.slice(0, 2));
	});
});

describe('what an applicant is shown (applicantOpNames)', () => {
	const s = {
		ownedNodeIds: [a],
		opNames: [
			{ id: a, name: 'Rooikloof' },
			{ id: b, name: 'Kalkoenkrans' },
			{ id: crop, name: 'Citrus' }
		]
	};
	it('shows a contributor only the scenario’s own nodes, and the team every name', () => {
		expect(applicantOpNames(s, 'contributor').opNames).toEqual([{ id: a, name: 'Rooikloof' }]);
		expect(ownNames(s).opNames).toEqual([{ id: a, name: 'Rooikloof' }]);
		for (const role of ['viewer', 'editor', 'owner'] as const) expect(applicantOpNames(s, role)).toBe(s);
	});
});
