import { describe, expect, it } from 'vitest';
import type { Role } from '$lib/api/types';
import {
	ALL_TABS,
	hasModelInputsToggle,
	stripTabs,
	TAB_GROUP,
	VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT,
	visibleTabs,
	type TabId
} from './tabs';

const EVERY_ROLE: (Role | null | undefined)[] = ['owner', 'editor', 'viewer', 'farmer', null, undefined];
// What the page rendered before the Scenarios tab existed.
const PAGE: TabId[] = ['overview', 'network', 'crops', 'transfers', 'series', 'settings', 'runs', 'history'];

describe('visibleTabs', () => {
	it('shows owners and editors every tab, in order', () => {
		for (const role of ['owner', 'editor'] as const) {
			expect(visibleTabs(role)).toEqual(ALL_TABS);
			expect(visibleTabs(role, {}, PAGE)).toEqual(PAGE);
			// The viewer toggle doesn't take anything away from them.
			expect(visibleTabs(role, { showModelInputs: false }, PAGE)).toEqual(PAGE);
		}
	});

	it('shows a viewer Overview, Data and Runs & results (and Scenarios) by default', () => {
		expect(VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT).toBe(false);
		expect(visibleTabs('viewer')).toEqual(['overview', 'series', 'runs', 'scenarios']);
		expect(visibleTabs('viewer', {}, PAGE)).toEqual(['overview', 'series', 'runs']);
		expect(visibleTabs('viewer', { showModelInputs: false }, PAGE)).toEqual(['overview', 'series', 'runs']);
	});

	it('gives a viewer every tab once "Show model inputs" is on', () => {
		expect(visibleTabs('viewer', { showModelInputs: true })).toEqual(ALL_TABS);
		expect(visibleTabs('viewer', { showModelInputs: true }, PAGE)).toEqual(PAGE);
	});

	it('shows a farmer or an unknown role Overview only', () => {
		for (const role of ['farmer', null, undefined] as const) {
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
		const withScenarios: TabId[] = [...PAGE.slice(0, 7), 'scenarios', 'history'];
		for (const role of ['owner', 'editor', 'viewer'] as const) expect(visibleTabs(role, {}, withScenarios)).toContain('scenarios');
		expect(visibleTabs('farmer', {}, withScenarios)).not.toContain('scenarios');
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
		expect(stripTabs(short, 'scenarios', PAGE)).toEqual(short);
	});
});
