import { describe, expect, it } from 'vitest';
import { headlineKey, headlineOfKey, headlineOptions, headlineProblem, headlineTest, judgedByText, resolveEwrHeadline, ruleTableSites } from './headline';

// Synthetic network: an outlet gauge, two gauges above it, a farm.
const nodes = [
	{ id: 'o', name: 'Outlet weir', kind: 'gauge' as const, downstreamNodeId: null, sortOrder: 0 },
	{ id: 'g2', name: 'Gauge B', kind: 'gauge' as const, downstreamNodeId: 'o', sortOrder: 2 },
	{ id: 'g1', name: 'Gauge A', kind: 'gauge' as const, downstreamNodeId: 'o', sortOrder: 1 },
	{ id: 'f', name: 'Unit 1', kind: 'farm' as const, downstreamNodeId: 'o', sortOrder: 3 }
];
const EWR = Array.from({ length: 12 }, () => 100);
const ZERO = Array.from({ length: 12 }, () => 0);

describe('resolveEwrHeadline', () => {
	it('is automatic when absent or not a choice', () => {
		expect(resolveEwrHeadline({})).toEqual({ source: 'auto' });
		expect(resolveEwrHeadline(null)).toEqual({ source: 'auto' });
		expect(resolveEwrHeadline({ ewrHeadline: { source: 'nonsense' } })).toEqual({ source: 'auto' });
		expect(resolveEwrHeadline({ ewrHeadline: { source: 'ruleTable', siteNodeId: 3 } })).toEqual({ source: 'auto' });
	});
	it('keeps a valid choice', () => {
		expect(resolveEwrHeadline({ ewrHeadline: { source: 'pragmatic' } })).toEqual({ source: 'pragmatic' });
		expect(resolveEwrHeadline({ ewrHeadline: { source: 'ruleTable', siteNodeId: null } })).toEqual({ source: 'ruleTable', siteNodeId: null });
		expect(resolveEwrHeadline({ ewrHeadline: { source: 'ruleTable', siteNodeId: 'g1' } })).toEqual({ source: 'ruleTable', siteNodeId: 'g1' });
	});
});

describe('headlineKey / headlineOfKey', () => {
	it('round-trips every choice', () => {
		for (const h of [{ source: 'auto' }, { source: 'pragmatic' }, { source: 'ruleTable', siteNodeId: null }, { source: 'ruleTable', siteNodeId: 'g1' }] as const) {
			expect(headlineOfKey(headlineKey(h))).toEqual(h);
		}
		expect(headlineKey({ source: 'ruleTable', siteNodeId: null })).toBe('table:outlet');
	});
});

describe('ruleTableSites', () => {
	it('lists the outlet first (keyed null or by its id), then gauges in network order, never a gone gauge', () => {
		expect(ruleTableSites(nodes, [{ siteNodeId: 'g2' }, { siteNodeId: 'o' }, { siteNodeId: 'g1' }, { siteNodeId: 'gone' }])).toEqual([
			{ siteNodeId: null, label: 'the outlet, Outlet weir' },
			{ siteNodeId: 'g1', label: 'Gauge A' },
			{ siteNodeId: 'g2', label: 'Gauge B' }
		]);
		expect(ruleTableSites(nodes, [{ siteNodeId: null }])).toEqual([{ siteNodeId: null, label: 'the outlet, Outlet weir' }]);
	});
});

describe('headlineOptions', () => {
	it('offers automatic (naming what it picks now), the pragmatic EWR when set, and each table', () => {
		expect(headlineOptions(nodes, [{ siteNodeId: 'g1' }, { siteNodeId: null }], EWR, { source: 'auto' })).toEqual([
			{ key: 'auto', label: 'Automatic: now the Reserve rule table at the outlet, Outlet weir' },
			{ key: 'pragmatic', label: 'The pragmatic EWR at the outflow gauge' },
			{ key: 'table:outlet', label: 'The Reserve rule table at the outlet, Outlet weir' },
			{ key: 'table:g1', label: 'The Reserve rule table at Gauge A' }
		]);
	});
	it('without tables, automatic is the pragmatic EWR; an unset pragmatic EWR is not offered', () => {
		expect(headlineOptions(nodes, [], EWR, { source: 'auto' })[0]!.label).toBe('Automatic: now the pragmatic EWR at the outflow gauge');
		expect(headlineOptions(nodes, [{ siteNodeId: 'g1' }], ZERO, { source: 'auto' }).map((o) => o.key)).toEqual(['auto', 'table:g1']);
	});
	it('keeps a stored choice that is no longer on offer, so the select shows it', () => {
		expect(headlineOptions(nodes, [], ZERO, { source: 'pragmatic' }).map((o) => o.key)).toEqual(['auto', 'pragmatic']);
		expect(headlineOptions(nodes, [], EWR, { source: 'ruleTable', siteNodeId: 'g1' }).at(-1)).toEqual({ key: 'table:g1', label: 'A Reserve rule table no longer in the settings' });
	});
});

describe('headlineProblem', () => {
	it('is null for a choice that can be followed', () => {
		expect(headlineProblem({ source: 'auto' }, nodes, [], ZERO)).toBeNull();
		expect(headlineProblem({ source: 'pragmatic' }, nodes, [], EWR)).toBeNull();
		expect(headlineProblem({ source: 'ruleTable', siteNodeId: null }, nodes, [{ siteNodeId: 'o' }], EWR)).toBeNull();
	});
	it('says when the table has gone, or the pragmatic EWR is 0 everywhere', () => {
		expect(headlineProblem({ source: 'ruleTable', siteNodeId: 'g1' }, nodes, [{ siteNodeId: null }], EWR)).toMatch(/no Reserve rule table any more, so results are judged automatically/);
		expect(headlineProblem({ source: 'pragmatic' }, nodes, [], ZERO)).toMatch(/0 in every month/);
	});
});

describe('judgedByText', () => {
	it('names the run’s test, marked automatic when the project hasn’t chosen', () => {
		expect(judgedByText(null, { source: 'pragmatic' })).toBe('the pragmatic EWR at the outflow gauge');
		expect(judgedByText(null, undefined)).toBe('the pragmatic EWR at the outflow gauge (automatic)');
		expect(judgedByText({ isOutlet: true, name: 'Outlet weir' }, { source: 'auto' })).toBe('the Reserve rule table at the outlet, Outlet weir (automatic)');
		expect(judgedByText({ isOutlet: false, name: 'Gauge A' }, { source: 'ruleTable', siteNodeId: 'g1' })).toBe('the Reserve rule table at Gauge A');
	});
});

describe('headlineTest', () => {
	it('is the test a choice judges by as the settings stand: automatic is a rule table whenever there is one', () => {
		expect(headlineTest({ source: 'auto' }, nodes, [{ siteNodeId: null }])).toBe('ruleTable');
		expect(headlineTest({ source: 'auto' }, nodes, [])).toBe('pragmatic');
		expect(headlineTest({ source: 'pragmatic' }, nodes, [{ siteNodeId: null }])).toBe('pragmatic');
		expect(headlineTest({ source: 'ruleTable', siteNodeId: 'g1' }, nodes, [{ siteNodeId: 'g1' }])).toBe('ruleTable');
		// A gone table falls back to automatic: the pragmatic EWR without any table.
		expect(headlineTest({ source: 'ruleTable', siteNodeId: 'g1' }, nodes, [])).toBe('pragmatic');
	});
});
