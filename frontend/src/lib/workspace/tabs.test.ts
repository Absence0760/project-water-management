import { describe, expect, it } from 'vitest';
import type { Role } from '$lib/api/types';
import {
	ALL_TABS,
	canOpenTab,
	NAV_SECTIONS,
	navSections,
	LINKED_ONLY,
	hasModelInputsToggle,
	DEFAULT_HIDDEN_TABS,
	hiddenChoice,
	hiddenTabs,
	stripTabs,
	TAB_GROUP,
	VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT,
	visibleTabs,
	withTabHidden,
	type TabId
} from './tabs';

const EVERY_ROLE: (Role | null | undefined)[] = ['owner', 'editor', 'viewer', 'contributor', 'farmer', null, undefined];
// What the page renders (Applications is added where it's tested).
const PAGE: TabId[] = ['overview', 'network', 'crops', 'transfers', 'series', 'settings', 'runs', 'scenarios', 'allocations', 'history'];

describe('visibleTabs', () => {
	it('shows owners and editors every tab but the linked-only ones, in order', () => {
		for (const role of ['owner', 'editor'] as const) {
			expect(visibleTabs(role)).toEqual(ALL_TABS.filter((id) => !LINKED_ONLY.includes(id)));
			expect(visibleTabs(role, {}, PAGE)).toEqual(PAGE);
			// The viewer toggle doesn't take anything away from them.
			expect(visibleTabs(role, { showModelInputs: false }, PAGE)).toEqual(PAGE);
		}
	});

	it('shows a viewer Overview, Data and Runs & results (and Dams, Compare runs, Scenarios, Allocations) by default', () => {
		expect(VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT).toBe(false);
		const core = ['overview', 'series', 'runs', 'scenarios', 'allocations'];
		expect(visibleTabs('viewer')).toEqual(['overview', 'map', 'series', 'runs', 'river', 'supply', 'dams', 'compare', 'scenarios', 'allocations', 'project']);
		expect(visibleTabs('viewer', {}, PAGE)).toEqual(core);
		expect(visibleTabs('viewer', { showModelInputs: false }, PAGE)).toEqual(core);
	});

	it('gives a viewer every tab once "Show model inputs" is on', () => {
		expect(visibleTabs('viewer', { showModelInputs: true })).toEqual(ALL_TABS.filter((id) => id !== 'applications' && !LINKED_ONLY.includes(id)));
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

// Members choose their own sections (followups.md): each person hides what
// they don't use, within what their role sees; the Summary stays.
describe('visibleTabs with the person’s own hidden sections', () => {
	const hidden = ['crops', 'history', 'dams', 'applications'];

	it('drops the hidden sections for every role that sees them, and nothing else', () => {
		expect(visibleTabs('owner', { hidden }, PAGE)).toEqual(PAGE.filter((id) => !hidden.includes(id)));
		expect(visibleTabs('editor', { hidden }, [...PAGE, 'applications'])).toEqual(PAGE.filter((id) => !hidden.includes(id)));
		// A viewer: the core set, less what they hid; the inputs they hid stay hidden once shown.
		expect(visibleTabs('viewer', { hidden: ['allocations'] }, PAGE)).toEqual(['overview', 'series', 'runs', 'scenarios']);
		expect(visibleTabs('viewer', { hidden, showModelInputs: true }, PAGE)).toEqual(PAGE.filter((id) => !hidden.includes(id)));
	});

	it('never shows a section the role doesn’t see, hidden or not (hiding only takes away)', () => {
		expect(visibleTabs('viewer', { hidden: [] }, [...PAGE, 'applications'])).not.toContain('applications');
		expect(visibleTabs('viewer', { hidden: ['series'] }, PAGE)).not.toContain('network');
		for (const role of ['farmer', 'contributor', null] as const) expect(visibleTabs(role, { hidden }, PAGE)).toEqual(['overview']);
	});

	it('never hides the Summary, even when an owner (or anyone) asks to hide every section', () => {
		for (const role of EVERY_ROLE)
			for (const showModelInputs of [undefined, true, false]) {
				const shown = visibleTabs(role, { showModelInputs, hidden: [...ALL_TABS] }, PAGE);
				expect(shown).toEqual(['overview']);
			}
	});

	it('ignores ids no section has', () => {
		expect(visibleTabs('owner', { hidden: ['nope', 'brand-new-ish'] }, PAGE)).toEqual(PAGE);
	});
});

describe('hiddenTabs (the "Hidden (n)" count)', () => {
	it('counts only the hidden sections the role would show here, in the sidebar’s order, never the Summary', () => {
		const ownerTabs = visibleTabs('owner', {}, PAGE);
		expect(hiddenTabs(ownerTabs, ['history', 'overview', 'crops', 'nope'])).toEqual(['crops', 'history']);
		// A viewer doesn't see Crops & demand without the inputs, so it isn't counted here, but stays stored.
		const viewerTabs = visibleTabs('viewer', {}, PAGE);
		expect(hiddenTabs(viewerTabs, ['history', 'crops', 'runs'])).toEqual(['runs']);
		expect(hiddenTabs(viewerTabs, undefined)).toEqual([]);
	});
});

describe('hiddenChoice (the default hidden sections)', () => {
	it('hides History, Allocations and Applications until the person chooses; their own choice, even [], wins', () => {
		expect([...DEFAULT_HIDDEN_TABS].sort()).toEqual(['allocations', 'applications', 'history']);
		for (const never of [null, undefined]) {
			const shown = visibleTabs('owner', { hidden: hiddenChoice(never) }, PAGE);
			expect(shown).not.toContain('history');
			expect(shown).not.toContain('allocations');
			expect(shown).not.toContain('applications');
			expect(shown).toContain('overview');
		}
		expect(visibleTabs('owner', { hidden: hiddenChoice([]) }, PAGE)).toEqual(PAGE);
		expect(visibleTabs('owner', { hidden: hiddenChoice(['crops']) }, PAGE)).toContain('history');
		// Every default id is a real section, so the default never silently hides nothing.
		for (const id of DEFAULT_HIDDEN_TABS) expect(ALL_TABS).toContain(id);
	});
});

describe('withTabHidden', () => {
	it('hides a section once, shows it again, and never stores the Summary', () => {
		expect(withTabHidden(undefined, 'crops', true)).toEqual(['crops']);
		expect(withTabHidden(['crops'], 'crops', true)).toEqual(['crops']);
		expect(withTabHidden(['crops', 'dams'], 'crops', false)).toEqual(['dams']);
		expect(withTabHidden([], 'overview', true)).toEqual([]);
		expect(withTabHidden(['overview', 'dams'], 'history', true)).toEqual(['dams', 'history']);
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

	it('keeps a hidden tab with problems to fix, in its place, beside the open one', () => {
		expect(stripTabs(short, 'runs', PAGE, ['transfers'])).toEqual(['overview', 'transfers', 'series', 'runs']);
		expect(stripTabs(short, 'network', PAGE, ['transfers', 'network'])).toEqual(['overview', 'network', 'transfers', 'series', 'runs']);
		// A kept tab already shown, or one the page doesn't render, adds nothing.
		expect(stripTabs(short, 'runs', PAGE, ['series'])).toEqual(short);
		expect(stripTabs(short, 'runs', PAGE.filter((id) => id !== 'crops'), ['crops'])).toEqual(short);
	});
});

describe('navSections', () => {
	it('lists every tab in exactly one section', () => {
		const listed = NAV_SECTIONS.flatMap((s) => [...s.tabs]);
		expect([...listed].sort()).toEqual([...ALL_TABS].sort());
		expect(new Set(listed).size).toBe(listed.length);
	});

	it('puts the outcomes first (the Summary a project opens on at the top), then the model, then review', () => {
		expect(navSections(ALL_TABS)).toEqual([
			{ id: 'outcomes', label: 'Outcomes', tabs: ['overview', 'river', 'supply', 'runs', 'dams', 'compare', 'scenarios', 'allocations'] },
			{ id: 'model', label: 'Build the model', tabs: ['network', 'map', 'crops', 'transfers', 'series', 'settings'] },
			{ id: 'review', label: 'Review', tabs: ['project', 'applications', 'history'] }
		]);
	});

	it('puts the Project page first under Review, for owners, editors and viewers (no model inputs needed)', () => {
		const rendered: TabId[] = ['overview', 'project', 'applications', 'history'];
		for (const role of ['owner', 'editor'] as const) {
			expect(navSections(visibleTabs(role, {}, rendered))).toContainEqual({ id: 'review', label: 'Review', tabs: ['project', 'applications', 'history'] });
		}
		expect(navSections(visibleTabs('viewer', {}, rendered))).toContainEqual({ id: 'review', label: 'Review', tabs: ['project'] });
		for (const role of ['contributor', 'farmer', null] as const) expect(visibleTabs(role, {}, rendered)).toEqual(['overview']);
	});

	it('puts River & reserve under Outcomes, after the Summary, for owners, editors and viewers only', () => {
		const rendered: TabId[] = ['overview', 'runs', 'river'];
		for (const role of ['owner', 'editor', 'viewer'] as const) {
			expect(navSections(visibleTabs(role, {}, rendered))).toEqual([{ id: 'outcomes', label: 'Outcomes', tabs: ['overview', 'river', 'runs'] }]);
		}
		// An applicant (contributor) and a farmer get their own views; the workspace shows them the Summary only.
		for (const role of ['contributor', 'farmer', null] as const) expect(visibleTabs(role, {}, rendered)).toEqual(['overview']);
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

describe('canOpenTab', () => {
	it('lets owners and editors open the assessors’ Applications tab', () => {
		expect(canOpenTab('owner', 'applications')).toBe(true);
		expect(canOpenTab('editor', 'applications')).toBe(true);
	});
	it('refuses it to everyone else, so an old link lands on the Summary', () => {
		for (const role of ['viewer', 'farmer', 'contributor', null, undefined] as (Role | null | undefined)[]) {
			expect(canOpenTab(role, 'applications')).toBe(false);
		}
	});
	it('still opens a viewer’s hidden model-input tabs from a link (hiding is presentation)', () => {
		expect(visibleTabs('viewer')).not.toContain('network');
		expect(canOpenTab('viewer', 'network')).toBe(true);
		expect(canOpenTab('viewer', 'overview')).toBe(true);
	});
});

describe('the Map (issue #288; a sidebar row since #326 D3)', () => {
	it('is listed for every member, after the Network, and nothing is linked-only now', () => {
		expect(LINKED_ONLY).toEqual([]);
		for (const role of ['owner', 'editor', 'viewer'] as const) {
			const shown = visibleTabs(role, { hidden: [] });
			expect(shown).toContain('map');
			expect(canOpenTab(role, 'map')).toBe(true);
		}
		const model = navSections(visibleTabs('owner', { hidden: [] })).find((s) => s.id === 'model')!;
		expect(model.tabs.indexOf('map')).toBe(model.tabs.indexOf('network') + 1);
		// A viewer sees it without "Show model inputs" (it shows results too), but not the Network.
		const viewer = navSections(visibleTabs('viewer', { hidden: [] }));
		expect(viewer.find((s) => s.id === 'model')?.tabs).toEqual(['map', 'series']);
		expect(TAB_GROUP.map).toBe('core');
	});
});

