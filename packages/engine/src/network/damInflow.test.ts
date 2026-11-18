import { describe, expect, it } from 'vitest';
import type { ModelInput, NetworkNode, Transfer } from '../project';
import { damInflowRoutes } from './damInflow';

const unit = (id: string, over: Partial<NetworkNode> = {}) =>
	({ id, name: id, kind: 'farm', downstreamNodeId: 'g', pctRunoffToDam: 0, pctUpstreamToDam: 0, divertCapacityM3Day: 0, damCapacityM3: 0, ...over }) as NetworkNode;
const model = (nodes: NetworkNode[], transfers: Partial<Transfer>[] = []) => ({ model: { nodes, crops: [], cropAreas: [], transfers: transfers as Transfer[] } }) as Pick<ModelInput, 'model'>;

describe('damInflowRoutes', () => {
	it('a unit with no dam in the base routes nothing into one: it receives nothing', () => {
		expect(damInflowRoutes(model([unit('h', { damCapacityM3: 50_000 })]), 'h')).toEqual({
			runoffToDam: 0,
			upstreamToDam: 0,
			upstreamUnits: 0,
			riverToDam: false,
			transfersIn: 0,
			receives: false
		});
	});

	it('receives through its runoff share, an upstream share with a unit above, River to dam, or a transfer in', () => {
		expect(damInflowRoutes(model([unit('h', { pctRunoffToDam: 0.4 })]), 'h').receives).toBe(true);
		// An upstream share with nothing upstream brings nothing; with a unit draining in, it does.
		expect(damInflowRoutes(model([unit('h', { pctUpstreamToDam: 1 })]), 'h').receives).toBe(false);
		expect(damInflowRoutes(model([unit('h', { pctUpstreamToDam: 1 }), unit('u', { downstreamNodeId: 'h' })]), 'h')).toMatchObject({ upstreamUnits: 1, receives: true });
		expect(damInflowRoutes(model([unit('h', { divertCapacityM3Day: 500 })]), 'h').receives).toBe(true);
		// Monthly River to dam replaces the one value: all zero is none, even with a stale one value.
		expect(damInflowRoutes(model([unit('h', { divertCapacityM3Day: 500, divertMonthlyM3Day: new Array(12).fill(0) })]), 'h').riverToDam).toBe(false);
		expect(damInflowRoutes(model([unit('h', { divertMonthlyM3Day: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10] })]), 'h').riverToDam).toBe(true);
		expect(damInflowRoutes(model([unit('h'), unit('a')], [{ id: 't', fromNodeId: 'a', toNodeId: 'h' }]), 'h')).toMatchObject({ transfersIn: 1, receives: true });
		// A split rule's second destination counts too.
		const split = { id: 's', fromNodeId: 'a', toNodeId: 'b', destinations: [{ nodeId: 'b', pct: 0.5 }, { nodeId: 'h', pct: 0.5 }] };
		expect(damInflowRoutes(model([unit('h'), unit('a'), unit('b')], [split]), 'h').transfersIn).toBe(1);
	});

	it('refuses an unknown unit', () => {
		expect(() => damInflowRoutes(model([]), 'nope')).toThrow(/not found/);
	});
});
