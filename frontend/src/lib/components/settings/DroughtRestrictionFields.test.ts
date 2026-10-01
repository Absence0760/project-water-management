// The drought restriction editor's choices of storage, units and EWR trigger
// (engine 1.54.0), rendered with Svelte's server renderer. The browser flow is
// pinned by e2e/tests/settings-drought-restriction.spec.ts and
// drought-restrictions-run.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { DroughtRestrictionRule } from '@water-management/engine';
import DroughtRestrictionFields from './DroughtRestrictionFields.svelte';

// The editor reads the published notice through the app's API only on a click; nothing here clicks.
vi.mock('$lib/api', () => ({ api: {} }));

// Comments stripped until none are left, so one split by another can't survive
// as a fresh '<!--' (CodeQL js/incomplete-multi-character-sanitization).
const text = (html: string) => {
	let s = html;
	for (let prev = ''; prev !== s; ) {
		prev = s;
		s = s.replace(/<!--[\s\S]*?-->/g, '');
	}
	return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
};
const nodes = [
	{ id: 'g', name: 'Outlet', kind: 'gauge' as const, damCapacityM3: 0, downstreamNodeId: null },
	{ id: 'm', name: 'Mid gauge', kind: 'gauge' as const, damCapacityM3: 0, downstreamNodeId: 'g' },
	{ id: 'a', name: 'Upper farm', kind: 'farm' as const, damCapacityM3: 1000, downstreamNodeId: 'm' },
	{ id: 'b', name: 'River farm', kind: 'farm' as const, damCapacityM3: 0, downstreamNodeId: 'g' }
];
const rule: DroughtRestrictionRule = {
	reviewDates: ['01-01'],
	levels: [{ label: 'Level 1', belowPct: 0.5, cuts: { crops: 0.3 } }],
	basis: 'dams',
	damNodeIds: ['a'],
	nodeIds: ['b'],
	ewrTrigger: { siteNodeId: 'm', level: 1 }
};

describe('the drought restriction editor’s storage, units and EWR trigger (engine 1.54.0)', () => {
	it('offers the dams, units and EWR sites of the model, and says the rule in words by name', () => {
		const html = render(DroughtRestrictionFields, { props: { value: rule, nodes } }).body;
		const body = text(html);
		expect(body).toContain('Storage the level reads');
		// Only a farm with a dam is a dam to read; every farm is a unit to cut.
		expect(body).toMatch(/Some dams \(their total\)[\s\S]*Upper farm/);
		expect(body).toContain('Units it cuts');
		expect(body).toContain('River farm');
		// The outlet and the gauges above it are the EWR sites.
		expect(body).toMatch(/The outlet\s+Mid gauge/);
		expect(body).toContain("the storage of Upper farm; cutting River farm only; at least level 1 when the EWR at Mid gauge wasn't met the day before a review");
	});
	it('hides those choices without the model, and the notice button without a project', () => {
		const body = text(render(DroughtRestrictionFields, { props: { value: { reviewDates: ['01-01'], levels: rule.levels } } }).body);
		expect(body).not.toContain('Storage the level reads');
		expect(body).not.toContain('Start from the published notice');
		expect(text(render(DroughtRestrictionFields, { props: { value: null, projectId: 'p' } }).body)).toContain('Start from the published notice');
	});
});
