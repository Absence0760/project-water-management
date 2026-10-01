import { beforeEach, describe, expect, it } from 'vitest';
import { cachedMappedNodes, clearMappedNodes, loadMappedNodes, mappedNodeIds, mapNodeHref } from './mapLinks';
import { MappedNodes } from './mappedNodes.svelte';

const list = (nodeIds: (string | null)[]) => async () => ({ features: nodeIds.map((nodeId) => ({ nodeId })) });

describe('Show on map links (issue #326 A2)', () => {
	beforeEach(() => clearMappedNodes());

	it('opens the Map tab with the node selected, as the Map tab reads it', () => {
		expect(mapNodeHref('n1')).toBe('?tab=map&node=n1');
		expect(mapNodeHref('a b&c')).toBe('?tab=map&node=a+b%26c');
		expect(new URLSearchParams(mapNodeHref('a b&c').slice(1)).get('node')).toBe('a b&c');
	});

	it('takes only the nodes a feature is linked to, once each', () => {
		expect([...mappedNodeIds([{ nodeId: 'n1' }, { nodeId: null }, { nodeId: 'n2' }, { nodeId: 'n1' }])].sort()).toEqual(['n1', 'n2']);
		expect(mappedNodeIds([]).size).toBe(0);
	});

	it('remembers the last set per project for the next page’s first frame', async () => {
		expect(cachedMappedNodes('p1')).toBeUndefined();
		await loadMappedNodes('p1', list(['n1']));
		expect([...cachedMappedNodes('p1')!]).toEqual(['n1']);
		expect(cachedMappedNodes('p2')).toBeUndefined();
		// A later visit refreshes it: a feature unlinked on the Map tab loses its node's link.
		await loadMappedNodes('p1', list([null]));
		expect(cachedMappedNodes('p1')!.size).toBe(0);
	});

	it('leaves the cache alone when the list can’t be read', async () => {
		await loadMappedNodes('p1', list(['n1']));
		await expect(loadMappedNodes('p1', () => Promise.reject(new Error('offline')))).rejects.toThrow('offline');
		expect([...cachedMappedNodes('p1')!]).toEqual(['n1']);
	});

	it('a page starts from the cached set and shows no link before any', async () => {
		expect(new MappedNodes(() => 'p1', list(['n1'])).has('n1')).toBe(false);
		await loadMappedNodes('p1', list(['n1']));
		const m = new MappedNodes(() => 'p1', list(['n2']));
		expect(m.has('n1')).toBe(true);
		expect(m.has('n2')).toBe(false);
		// Loading replaces it with the server's set.
		await m.load();
		expect(m.has('n1')).toBe(false);
		expect(m.has('n2')).toBe(true);
	});

	it('a page shows no link when the list fails, rather than a stale one', async () => {
		await loadMappedNodes('p1', list(['n1']));
		const m = new MappedNodes(() => 'p1', () => Promise.reject(new Error('offline')));
		expect(m.has('n1')).toBe(true);
		await m.load();
		expect(m.has('n1')).toBe(false);
	});

	it('follows a project switch, and drops a late answer for the earlier project', async () => {
		type List = { features: { nodeId: string | null }[] };
		let project = 'p1';
		const pending: ((v: List) => void)[] = [];
		const slow = () => new Promise<List>((r) => pending.push(r));
		const m = new MappedNodes(() => project, slow);
		const first = m.load();
		// The workspace switches project before p1's list arrives.
		project = 'p2';
		const second = m.load();
		pending[1]!({ features: [{ nodeId: 'p2-node' }] });
		await second;
		expect(m.has('p2-node')).toBe(true);
		// p1's answer lands late: it doesn't replace p2's set.
		pending[0]!({ features: [{ nodeId: 'p1-node' }] });
		await first;
		expect(m.has('p2-node')).toBe(true);
		expect(m.has('p1-node')).toBe(false);
	});

	it('never answers for another project than the current one', async () => {
		await loadMappedNodes('p1', list(['n1']));
		let project = 'p1';
		const m = new MappedNodes(() => project, list(['n1']));
		expect(m.has('n1')).toBe(true);
		project = 'p2';
		expect(m.has('n1')).toBe(false);
	});

	it('a page without a project never asks', async () => {
		let asked = false;
		const m = new MappedNodes(() => '', async () => ((asked = true), { features: [] }));
		await m.load();
		expect(asked).toBe(false);
		expect(m.has('n1')).toBe(false);
	});
});
