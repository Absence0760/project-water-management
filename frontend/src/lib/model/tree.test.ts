import { describe, expect, it } from 'vitest';
import type { NetworkNode } from '@water-management/engine';
import { drainageTree } from './tree';

const n = (id: string, down: string | null, sortOrder = 0) =>
	({ id, name: id.toUpperCase(), downstreamNodeId: down, sortOrder }) as NetworkNode;

describe('drainageTree', () => {
	it('orders depth-first from the outlet with upstream counts', () => {
		const { rows, orphans } = drainageTree([n('b', 'g', 2), n('g', null), n('a', 'g', 1), n('c', 'a')]);
		expect(rows.map((r) => [r.node.id, r.depth, r.upstreamCount])).toEqual([
			['g', 0, 3],
			['a', 1, 1],
			['c', 2, 0],
			['b', 1, 0]
		]);
		expect(orphans).toEqual([]);
	});

	it('returns nodes in a cycle as orphans', () => {
		const { rows, orphans } = drainageTree([n('g', null), n('x', 'y'), n('y', 'x')]);
		expect(rows.map((r) => r.node.id)).toEqual(['g']);
		expect(orphans.map((o) => o.id)).toEqual(['x', 'y']);
	});
});
