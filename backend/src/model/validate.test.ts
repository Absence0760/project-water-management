import type { ProjectModel } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { node } from '../__tests__/helpers.js';
import { ModelBody, modelProblems } from './validate.js';

const model = (nodes: ReturnType<typeof node>[]): ProjectModel =>
	({ nodes, crops: [], cropAreas: [], transfers: [] }) as unknown as ProjectModel;

describe('modelProblems', () => {
	it('accepts an empty model and a simple tree', () => {
		expect(modelProblems(model([]))).toEqual([]);
		const out = node('Gauge', null);
		expect(modelProblems(model([out, node('A', out.id), node('B', out.id)]))).toEqual([]);
	});

	it('requires exactly one outflow node', () => {
		expect(modelProblems(model([node('G1', null), node('G2', null)])).join()).toMatch(/exactly one outflow/);
	});

	it('detects loops and unknown downstream nodes', () => {
		const a = node('A', null);
		const b = node('B', a.id);
		a.downstreamNodeId = b.id;
		const c = node('C', null);
		expect(modelProblems(model([a, b, c])).join()).toMatch(/loop/);
		expect(modelProblems(model([c, node('D', crypto.randomUUID())])).join()).toMatch(/unknown node/);
	});

	it('rejects duplicate names case-insensitively', () => {
		const g = node('Gauge', null);
		expect(modelProblems(model([g, node('Farm', g.id), node('farm', g.id)])).join()).toMatch(/duplicate node name/);
	});
});

describe('ModelBody (PUT /model, project documents)', () => {
	const body = (nodes: Record<string, unknown>[]) => ({ nodes, crops: [], cropAreas: [], transfers: [] });

	it('needs 0 < irrigation efficiency ≤ 1 and a loss return fraction in 0–1 (N1)', () => {
		const out = node('Gauge', null);
		const farm = node('A', out.id);
		expect(ModelBody.safeParse(body([out, farm])).success).toBe(true);
		expect(ModelBody.safeParse(body([out, { ...farm, irrigationEfficiency: 0 }])).success).toBe(false);
		expect(ModelBody.safeParse(body([out, { ...farm, irrigationEfficiency: 1.01 }])).success).toBe(false);
		expect(ModelBody.safeParse(body([out, { ...farm, lossReturnFraction: -0.1 }])).success).toBe(false);
	});

	it('reads a model from before engine 0.15.0 as migration 006 stored it: return flow % → efficiency', () => {
		const out = node('Gauge', null);
		const { irrigationEfficiency: _e, lossReturnFraction: _b, ...legacy } = node('A', out.id);
		const parsed = ModelBody.parse(body([out, { ...legacy, returnFlowPct: 0.25 }, { ...legacy, id: crypto.randomUUID(), name: 'B', returnFlowPct: 0 }]));
		expect(parsed.nodes[1]).toMatchObject({ irrigationEfficiency: 0.75, lossReturnFraction: 1 });
		expect(parsed.nodes[2]).toMatchObject({ irrigationEfficiency: 1, lossReturnFraction: 0 });
		expect(parsed.nodes[1]).not.toHaveProperty('returnFlowPct');
	});
});
