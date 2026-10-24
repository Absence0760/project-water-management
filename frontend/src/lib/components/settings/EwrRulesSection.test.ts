// Settings → Reserve rule tables, rendered with Svelte's server renderer: the
// two method choices under the tables, and the base-flow filter's method beside
// the low-flow measure (issue #523 D3, docs/model.md §2.9d).
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { blankEwrRuleTable, type NetworkNode } from '@water-management/engine';
import EwrRulesSection from './EwrRulesSection.svelte';

vi.mock('#lib/api/index.js', () => ({ api: {} }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));

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
	it('names the base-flow filter beside Low flows judged on, checked against the DRM’s method (no "unconfirmed" badge)', () => {
		const html = render(EwrRulesSection, { props: { value: [blankEwrRuleTable(null)], nodes } }).body;
		expect(html).not.toContain('baseflow-filter-unconfirmed');
		expect(html).toContain('data-testid="baseflow-filter-method"');
		const t = text(html);
		expect(t).toContain('Low flows judged on');
		expect(t).not.toContain('unconfirmed');
		expect(t).toContain('the Lyne–Hollick filter, one pass, α 0.995 (Hughes, Hannart &amp; Watkins 2003)');
		// The note is part of the choice's description, so a screen reader hears it with the select.
		const describedBy = /<select id="([^"]+)-low"[^>]*aria-describedby="([^"]+)"/.exec(html);
		expect(describedBy?.[2]).toBe(`${describedBy?.[1]}-low-h`);
		expect(html).toMatch(new RegExp(`id="${describedBy?.[1]}-low-h"[\\s\\S]*?baseflow-filter-method`));
	});

	it('shows no method choices, and so no note, without a rule table', () => {
		const html = render(EwrRulesSection, { props: { value: [], nodes } }).body;
		expect(html).not.toContain('baseflow-filter-method');
		expect(text(html)).not.toContain('Low flows judged on');
	});
});
