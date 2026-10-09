// The shared in-page menu's markup, rendered with Svelte's server renderer: the bar it draws before any
// width is measured (the rail needs the content's width, so it is pinned in the browser by
// e2e/tests/section-nav.spec.ts and settings-index.spec.ts).
import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import SectionNav from './SectionNav.svelte';
import { withoutComments } from '../__fixtures__/withoutComments';

const bare = withoutComments;
const groups = [
	{ label: 'Inputs', sections: [{ id: 'a', label: 'Demand' }, { id: 'b', label: 'Flow', problem: true }] },
	{ label: 'Elsewhere', sections: [{ id: 'c', label: 'Data tab', href: '?tab=series' }] }
];

describe('SectionNav', () => {
	it('draws the bar: a link per section, a link to another page by its href, and a problem in words', () => {
		const html = bare(render(SectionNav, { props: { groups, label: 'Test sections' } }).body);
		expect(html).toContain('aria-label="Test sections"');
		expect(html).toMatch(/href="#a"[^>]*>Demand/);
		expect(html).toMatch(/href="\?tab=series"[^>]*>Data tab/);
		expect(html).toContain('(has a problem)');
		// No find box unless asked for.
		expect(html).not.toContain('find-btn');
	});

	it('with `find`, starts the bar with a Find button that opens the box; with content, wraps it after the menu', () => {
		const children = createRawSnippet(() => ({ render: () => '<p id="body">The panels</p>' }));
		const html = bare(render(SectionNav, { props: { groups, label: 'Test sections', find: 'Find a setting', railFrom: 80, children } }).body);
		expect(html).toMatch(/<button[^>]*class="pill find-btn[^"]*"[^>]*aria-expanded="false"/);
		expect(html).toContain('a setting');
		expect(html.indexOf('find-btn')).toBeLessThan(html.indexOf('href="#a"'));
		expect(html).toContain('<div class="nav-body');
		expect(html.indexOf('id="body"')).toBeGreaterThan(html.indexOf('aria-label="Test sections"'));
	});
});
