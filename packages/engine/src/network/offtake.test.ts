// River off-takes (engine 1.14.0, docs/model.md §2.6a): which rules run, and
// the calculation order that puts each destination after its source.
import { describe, expect, it } from 'vitest';
import type { NetworkNode, Transfer } from '../project';
import { offtakeOrder, planOfftakes } from './offtake';
import { buildTopology } from './topology';

const n = (id: string, downstreamNodeId: string | null, kind: NetworkNode['kind'] = 'farm', sortOrder = 0) => ({ id, name: id, kind, downstreamNodeId, sortOrder }) as NetworkNode;
const t = (id: string, fromNodeId: string, toNodeId: string, over: Partial<Transfer> = {}): Transfer => ({
	id,
	fromNodeId,
	toNodeId,
	months: [1],
	maxRateM3s: 1,
	dailyCapM3: null,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	source: 'river',
	...over
});

describe('planOfftakes', () => {
	// Two branches into g: a (upstream a2) and c (upstream c2).
	const nodes = [n('g', null, 'gauge'), n('a', 'g'), n('a2', 'a'), n('c', 'g'), n('c2', 'c')];

	it('runs enabled river rules between two units, in id order, and skips the rest saying why', () => {
		const warnings: string[] = [];
		const plan = planOfftakes(
			[t('z', 'a', 'c'), t('b', 'a2', 'c2', { enabled: false }), t('dam', 'a', 'c', { source: 'dam' }), t('y', 'a', 'g'), t('x', 'a', 'nowhere')],
			nodes,
			warnings,
			(tr) => `k@${tr.id}`
		);
		expect(plan.map((o) => [o.id, o.from, o.to, o.seriesKey])).toEqual([['z', 1, 3, 'k@z']]);
		expect(warnings).toEqual(['river off-take x references a node that does not exist; skipped', 'river off-take a → g: an off-take runs from one unit to another; skipped']);
	});

	it('skips a rule whose destination drains into its source, along the river or through off-takes accepted before it', () => {
		const warnings: string[] = [];
		// a2 drains into a, so a → a2 would take water before it arrives. c → a is fine; a → c after it closes a loop.
		const plan = planOfftakes([t('1', 'a', 'a2'), t('2', 'c', 'a'), t('3', 'a', 'c')], nodes, warnings, () => undefined);
		expect(plan.map((o) => o.id)).toEqual(['2']);
		expect(warnings).toHaveLength(2);
		expect(warnings.every((w) => /drains into its source/.test(w))).toBe(true);
	});

	it('clamps a loss outside [0, 1) to 0 and a bad hands-off flow to none, with a warning', () => {
		const warnings: string[] = [];
		const [o] = planOfftakes([t('1', 'a', 'c', { lossPct: 1.5, handsOffM3Day: -3 })], nodes, warnings, () => undefined);
		expect([o!.loss, o!.handsOffM3Day]).toEqual([0, 0]);
		expect(warnings).toHaveLength(2);
	});
});

describe('offtakeOrder', () => {
	it('puts every destination after its source and every node after its upstream nodes, keeping the order otherwise', () => {
		const nodes = [n('g', null, 'gauge', 9), n('c', 'g', 'farm', 1), n('c2', 'c', 'farm', 2), n('a', 'g', 'farm', 3), n('a2', 'a', 'farm', 4)];
		const topo = buildTopology(nodes);
		const names = (o: Int32Array) => [...o].map((i) => nodes[i]!.id);
		// The c branch comes first on its own; an off-take a2 → c2 moves the c branch after a2.
		expect(names(topo.order)).toEqual(['c2', 'c', 'a2', 'a', 'g']);
		const plan = planOfftakes([t('o', 'a2', 'c2')], nodes, [], () => undefined);
		const order = names(offtakeOrder(topo.order, topo.upstream, plan));
		expect(order.indexOf('a2')).toBeLessThan(order.indexOf('c2'));
		for (const x of nodes) if (x.downstreamNodeId) expect(order.indexOf(x.id)).toBeLessThan(order.indexOf(x.downstreamNodeId));
		// Without off-takes it is the same array.
		expect(offtakeOrder(topo.order, topo.upstream, [])).toBe(topo.order);
	});
});
