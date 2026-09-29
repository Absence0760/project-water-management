import { describe, expect, it } from 'vitest';
import { modelDams } from '$lib/components/dams/dams';
import { modelFacts, otherNodesLine } from './modelFacts';

type Node = Parameters<typeof modelFacts>[0]['nodes'][number];
const node = (id: string, kind: 'farm' | 'gauge' | 'user', over: Partial<Node> = {}) =>
	({ id, name: id, kind, downstreamNodeId: 'out', areaKm2: 1, damCapacityM3: 0, damMinPct: 0, ...over }) as Node;
const model = (nodes: Node[], over: Partial<Parameters<typeof modelFacts>[0]> = {}) =>
	({ nodes, crops: [], cropAreas: [], transfers: [], ...over }) as Parameters<typeof modelFacts>[0];

describe('modelFacts (issue #177: the tiles count as Network and Dams do)', () => {
	const nodes = [
		node('out', 'gauge', { name: 'Outflow gauge', downstreamNodeId: null, areaKm2: 2 }),
		node('weir', 'gauge', { damCapacityM3: 5_000 }),
		node('a', 'farm', { damCapacityM3: 150_000 }),
		node('b', 'farm', { damCapacityM3: 0.5 }),
		node('c', 'farm'),
		node('town', 'user', { areaKm2: 0 })
	];

	it('counts gauges only, not other water users, as the Network header line does', () => {
		const f = modelFacts(model(nodes));
		expect(f).toMatchObject({ farms: 3, gauges: 2, users: 1 });
		// Network: farms, gauges and users are each their own kind; nothing falls between them.
		expect(f.farms + f.gauges + f.users).toBe(nodes.length);
	});

	it('counts and sums the Dams page’s dams: a farm with at least 1 m³, never a capacity on a gauge', () => {
		const f = modelFacts(model(nodes));
		expect(f.dams).toBe(1);
		expect(f.damM3).toBe(150_000);
		const dams = modelDams(nodes);
		expect(f.dams).toBe(dams.length);
		expect(f.damM3).toBe(dams.reduce((s, d) => s + d.capacityM3, 0));
	});

	it('sums every node’s area, irrigated area in ha and enabled transfers, and names the outlet', () => {
		const f = modelFacts(
			model(nodes, {
				crops: [{ id: 'k' }, { id: 'l' }] as never,
				cropAreas: [{ nodeId: 'a', cropId: 'k', areaM2: 25_000 }, { nodeId: 'c', cropId: 'l', areaM2: 5_000 }] as never,
				transfers: [{ enabled: true }, { enabled: false }] as never
			})
		);
		expect(f).toMatchObject({ areaKm2: 6, crops: 2, irrigatedHa: 3, transfers: 1, outlet: 'Outflow gauge' });
	});

	it('is all zeros for an empty model, and has no outlet for an unnamed one', () => {
		expect(modelFacts(model([]))).toEqual({ farms: 0, gauges: 0, users: 0, areaKm2: 0, dams: 0, damM3: 0, crops: 0, irrigatedHa: 0, transfers: 0, outlet: null });
		expect(modelFacts(model([node('out', 'gauge', { name: '', downstreamNodeId: null })])).outlet).toBeNull();
	});
});

describe('otherNodesLine', () => {
	it('names the gauges, and the other water users only when there are any', () => {
		expect(otherNodesLine({ gauges: 0, users: 0 })).toBe('+ 0 gauges');
		expect(otherNodesLine({ gauges: 1, users: 0 })).toBe('+ 1 gauge');
		expect(otherNodesLine({ gauges: 2, users: 1 })).toBe('+ 2 gauges, 1 other user');
		expect(otherNodesLine({ gauges: 1, users: 3 })).toBe('+ 1 gauge, 3 other users');
	});
});
