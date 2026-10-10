// Settings → Reserve rule tables, rendered with Svelte's server renderer: the
// two method choices under the tables, and the "Filter settings unconfirmed"
// note beside the low-flow measure (issue #507 item 6, docs/model.md §2.9d).
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { blankEwrRuleTable, type NetworkNode } from '@water-management/engine';
import EwrRulesSection from './EwrRulesSection.svelte';

vi.mock('$lib/api', () => ({ api: {} }));
vi.mock('$app/paths', () => ({ base: '' }));

const text = (html: string) => {
	let s = html;
	for (let prev = ''; prev !== s; ) {
		prev = s;
		s = s.replace(/<!--[\s\S]*?-->/g, '');
	}
	return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
};
const nodes = [{ id: 'g', name: 'Outlet', kind: 'gauge', damCapacityM3: 0, downstreamNodeId: null, sortOrder: 0 }] as unknown as NetworkNode[];

describe('EwrRulesSection', () => {
	it('notes beside Low flows judged on that the base-flow filter settings are unconfirmed', () => {
		const html = render(EwrRulesSection, { props: { value: [blankEwrRuleTable(null)], nodes } }).body;
		expect(html).toContain('data-testid="baseflow-filter-unconfirmed"');
		const t = text(html);
		expect(t).toContain('Low flows judged on');
		expect(t).toContain('Filter settings unconfirmed');
		expect(t).toContain('isn’t yet checked against the Desktop Reserve Model’s own method');
		// The note is part of the choice's description, so a screen reader hears it with the select.
		const describedBy = /<select id="([^"]+)-low"[^>]*aria-describedby="([^"]+)"/.exec(html);
		expect(describedBy?.[2]).toBe(`${describedBy?.[1]}-low-h`);
		expect(html).toMatch(new RegExp(`id="${describedBy?.[1]}-low-h"[\\s\\S]*?baseflow-filter-unconfirmed`));
	});

	it('shows no method choices, and so no note, without a rule table', () => {
		const html = render(EwrRulesSection, { props: { value: [], nodes } }).body;
		expect(html).not.toContain('baseflow-filter-unconfirmed');
		expect(text(html)).not.toContain('Low flows judged on');
	});
});
