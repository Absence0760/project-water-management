import { describe, expect, it } from 'vitest';
import type { Role } from '$lib/api/types';
import {
	ALL_TABS,
	NAV_SECTIONS,
	navSections,
	hasModelInputsToggle,
	stripTabs,
	TAB_GROUP,
	VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT,
	visibleTabs,
	type TabId
} from './tabs';

const EVERY_ROLE: (Role | null | undefined)[] = ['owner', 'editor', 'viewer', 'contributor', 'farmer', null, undefined];
// What the page renders (Applications is added where it's tested).
const PAGE: TabId[] = ['overview', 'network', 'crops', 'transfers', 'series', 'settings', 'runs', 'scenarios', 'allocations', 'history'];

describe('visibleTabs', () => {
	it('shows owners and editors every tab, in order', () => {
		for (const role of ['owner', 'editor'] as const) {
			expect(visibleTabs(role)).toEqual(ALL_TABS);
			expect(visibleTabs(role, {}, PAGE)).toEqual(PAGE);
			// The viewer toggle doesn't take anything away from them.
			expect(visibleTabs(role, { showModelInputs: false }, PAGE)).toEqual(PAGE);
		}
	});

	it('shows a viewer Overview, Data and Runs & results (and Compare runs, Scenarios, Allocations) by default', () => {
		expect(VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT).toBe(false);
		const core = ['overview', 'series', 'runs', 'scenarios', 'allocations'];
		expect(visibleTabs('viewer')).toEqual(['overview', 'series', 'runs', 'compare', 'scenarios', 'allocations']);
		expect(visibleTabs('viewer', {}, PAGE)).toEqual(core);
		expect(visibleTabs('viewer', { showModelInputs: false }, PAGE)).toEqual(core);
	});

	it('gives a viewer every tab once "Show model inputs" is on', () => {
		expect(visibleTabs('viewer', { showModelInputs: true })).toEqual(ALL_TABS.filter((id) => id !== 'applications'));
		expect(visibleTabs('viewer', { showModelInputs: true }, PAGE)).toEqual(PAGE);
	});

	it('shows a farmer, an applicant or an unknown role Overview only (the workspace shows them their own views)', () => {
		for (const role of ['farmer', 'contributor', null, undefined] as const) {
			expect(visibleTabs(role)).toEqual(['overview']);
			expect(visibleTabs(role, { showModelInputs: true }, PAGE)).toEqual(['overview']);
		}
	});

	it('never hides Overview, whatever the role and prefs', () => {
		for (const role of EVERY_ROLE)
			for (const showModelInputs of [undefined, true, false])
				expect(visibleTabs(role, { showModelInputs }, PAGE)[0]).toBe('overview');
	});

	it('only returns tabs the page renders, in the page’s order', () => {
		const reordered: TabId[] = ['runs', 'overview', 'series'];
		expect(visibleTabs('owner', {}, reordered)).toEqual(reordered);
		expect(visibleTabs('viewer', {}, ['overview', 'network'])).toEqual(['overview']);
	});

	it('lists Scenarios for owners, editors and viewers once the page renders it', () => {
		const withScenarios = PAGE;
		for (const role of ['owner', 'editor', 'viewer'] as const) expect(visibleTabs(role, {}, withScenarios)).toContain('scenarios');
		expect(visibleTabs('farmer', {}, withScenarios)).not.toContain('scenarios');
	});

	// Viewers read registered volumes (not names: that is RLS, not the tab strip).
	it('lists Allocations for owners, editors and viewers, never farmers', () => {
		for (const role of ['owner', 'editor', 'viewer'] as const) expect(visibleTabs(role, {}, PAGE)).toContain('allocations');
		for (const role of ['contributor', 'farmer'] as const) expect(visibleTabs(role, { showModelInputs: true }, PAGE)).not.toContain('allocations');
	});

	it('lists Applications for owners and editors only (WP-3.3)', () => {
		const withApplications: TabId[] = [...PAGE, 'applications'];
		for (const role of ['owner', 'editor'] as const) expect(visibleTabs(role, {}, withApplications)).toContain('applications');
		for (const role of ['viewer', 'contributor', 'farmer'] as const) {
			expect(visibleTabs(role, { showModelInputs: true }, withApplications)).not.toContain('applications');
		}
	});

	it('treats a tab it doesn’t know as a model input', () => {
		const rendered = ['overview', 'runs', 'brand-new'];
		expect(visibleTabs('editor', {}, rendered)).toEqual(rendered);
		expect(visibleTabs('viewer', {}, rendered)).toEqual(['overview', 'runs']);
		expect(visibleTabs('viewer', { showModelInputs: true }, rendered)).toEqual(rendered);
	});

	it('groups every tab', () => {
		expect(ALL_TABS).toEqual(Object.keys(TAB_GROUP));
		for (const id of PAGE) expect(Object.hasOwn(TAB_GROUP, id)).toBe(true);
	});
});

describe('hasModelInputsToggle', () => {
	it('is offered to viewers only', () => {
		expect(EVERY_ROLE.filter(hasModelInputsToggle)).toEqual(['viewer']);
	});
});

describe('stripTabs', () => {
	const short: TabId[] = ['overview', 'series', 'runs'];

	it('is the visible tabs when the open tab is one of them', () => {
		expect(stripTabs(short, 'runs', PAGE)).toEqual(short);
	});

	it('adds a hidden tab a deep link opened, in its place', () => {
		expect(stripTabs(short, 'settings', PAGE)).toEqual(['overview', 'series', 'settings', 'runs']);
		expect(stripTabs(short, 'network', PAGE)).toEqual(['overview', 'network', 'series', 'runs']);
	});

	it('ignores an open tab the page doesn’t render', () => {
		expect(stripTabs(short, 'scenarios', PAGE.filter((id) => id !== 'scenarios'))).toEqual(short);
	});
});

describe('navSections', () => {
	it('lists every tab in exactly one section', () => {
		const listed = NAV_SECTIONS.flatMap((s) => [...s.tabs]);
		expect([...listed].sort()).toEqual([...ALL_TABS].sort());
		expect(new Set(listed).size).toBe(listed.length);
	});

	it('puts outcomes first, then the model, then review', () => {
		expect(navSections(ALL_TABS)).toEqual([
			{ id: 'outcomes', label: 'Outcomes', tabs: ['overview', 'runs', 'compare', 'scenarios', 'allocations'] },
			{ id: 'model', label: 'Build the model', tabs: ['network', 'crops', 'transfers', 'series', 'settings'] },
			{ id: 'review', label: 'Review', tabs: ['applications', 'history'] }
		]);
	});

	it('orders by section whatever order the tabs arrive in, and drops empty sections', () => {
		// A viewer before "Show model inputs".
		expect(navSections(visibleTabs('viewer', {}, PAGE))).toEqual([
			{ id: 'outcomes', label: 'Outcomes', tabs: ['overview', 'runs', 'scenarios', 'allocations'] },
			{ id: 'model', label: 'Build the model', tabs: ['series'] }
		]);
		expect(navSections<TabId>(['history', 'overview'])).toEqual([
			{ id: 'outcomes', label: 'Outcomes', tabs: ['overview'] },
			{ id: 'review', label: 'Review', tabs: ['history'] }
		]);
		expect(navSections<TabId>([])).toEqual([]);
	});

	it('puts a tab no section lists at the end of "Build the model"', () => {
		expect(navSections(['overview', 'newthing', 'network'])).toEqual([
			{ id: 'outcomes', label: 'Outcomes', tabs: ['overview'] },
			{ id: 'model', label: 'Build the model', tabs: ['network', 'newthing'] }
		]);
	});
});
