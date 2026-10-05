// River off-takes (engine 1.14.0, docs/model.md §2.6a): which rules run, and
// the calculation order that puts each destination after its source.
import { describe, expect, it } from 'vitest';
import type { NetworkNode, Transfer } from '../project';
import { offtakeOrder, planOfftakes, splitLicenceWarnings } from './offtake';
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
		expect(warnings).toEqual(['river off-take x references a hydrological unit that does not exist; skipped', 'river off-take a → g: an off-take runs from one unit to another; skipped']);
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

describe('splitLicenceWarnings (engine ≥ 1.70.0, issue #90 Q25)', () => {
	const nodes = [n('g', null, 'gauge'), n('a', 'g'), n('c', 'g'), n('e', 'g')];
	const warn = (rules: Transfer[]) => {
		const warnings: string[] = [];
		planOfftakes(rules, nodes, warnings, () => undefined);
		return warnings;
	};
	it('warns once per group of rules with one source, one destination and one priority that share a month, in id order', () => {
		const w = warn([t('2', 'a', 'c'), t('1', 'a', 'c'), t('3', 'a', 'c', { priority: 4 }), t('4', 'a', 'c', { priority: 4 })]);
		expect(w).toHaveLength(2);
		expect(w[0]).toMatch(/^river off-take a → c: 2 rules of priority 0 \(1, 2\) take from the same river for the same unit\. If they are one licence entered more than once at its full size, it takes that many times its licence: enter each licence once/);
		expect(w[1]).toMatch(/2 rules of priority 4 \(3, 4\)/);
	});
	it('no warning across sources, destinations or priorities, for one rule, or for rules that never run in one month', () => {
		expect(warn([t('1', 'a', 'c'), t('2', 'a', 'e')])).toEqual([]);
		expect(warn([t('1', 'a', 'c'), t('2', 'e', 'c')])).toEqual([]);
		expect(warn([t('1', 'a', 'c'), t('2', 'a', 'c', { priority: 1 })])).toEqual([]);
		expect(warn([t('1', 'a', 'c')])).toEqual([]);
		expect(warn([t('1', 'a', 'c', { months: [1] }), t('2', 'a', 'c', { months: [2] })])).toEqual([]);
		// A rule with no capacity in any month never meets another.
		expect(warn([t('1', 'a', 'c'), t('2', 'a', 'c', { maxRateM3s: 0 })])).toEqual([]);
	});
	it('counts only the planned rules: a skipped or disabled twin doesn’t make a group', () => {
		expect(warn([t('1', 'a', 'c'), t('2', 'a', 'c', { enabled: false })])).toEqual([]);
		// A twin into the gauge is skipped (an off-take runs between units), with its own warning only.
		expect(warn([t('1', 'a', 'g'), t('2', 'a', 'g')]).filter((x) => /licence/.test(x))).toEqual([]);
	});
	it('reads the plan directly: an empty or single plan warns nothing', () => {
		const w: string[] = [];
		splitLicenceWarnings([], nodes, w);
		expect(w).toEqual([]);
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
