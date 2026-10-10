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

	it('says a section’s shorter bar name on the bar, and the page another page’s link goes to (issue #462)', () => {
		const html = bare(
			render(SectionNav, {
				props: {
					groups: [
						{ label: 'Model', sections: [{ id: 'cal', label: 'Calibration against observed flow', bar: 'Calibration' }] },
						{ label: 'On River & reserve', sections: [{ id: 'river-w', label: 'Water account', href: '?tab=river#res-water-account', page: 'River & reserve' }] }
					],
					label: 'Test sections'
				}
			}).body
		);
		expect(html).toMatch(/<a class="pill[^"]*" href="#cal"[^>]*>Calibration</);
		// The bar's hidden measuring copy says the bar's name too, never the heading.
		expect(html).not.toContain('Calibration against observed flow');
		// The page it goes to is in the link's name, not a hidden span Chromium would space off ("Water account , on …").
		expect(html).toMatch(/href="\?tab=river#res-water-account"[^>]*aria-label="Water account, on River &amp; reserve"[^>]*>Water account</);
		expect(html).not.toContain(', on River &amp; reserve</span>');
	});

	it('with no sections draws no menu, only the content', () => {
		const children = createRawSnippet(() => ({ render: () => '<p id="body">Loading</p>' }));
		const html = bare(render(SectionNav, { props: { groups: [{ label: 'A', sections: [] }], label: 'Test sections', railFrom: 60, railSide: 'right', children } }).body);
		expect(html).not.toContain('<nav');
		expect(html).toContain('id="body"');
	});

	it('in a box of its own (`onjump`, the node sheet): a bar that does not stick, with no heading when given none (issue #462)', () => {
		const html = bare(render(SectionNav, { props: { groups, label: 'Sections of the form', heading: null, onjump: () => {} } }).body);
		expect(html).toMatch(/<nav class="sections[^"]*embedded[^"]*" aria-label="Sections of the form"/);
		expect(html).not.toContain('On this page');
		// Still links to the sections, so it reads as a menu of links.
		expect(html).toMatch(/href="#a"[^>]*>Demand/);
		const page = bare(render(SectionNav, { props: { groups, label: 'Test sections' } }).body);
		expect(page).toContain('On this page');
		expect(page).not.toContain('embedded');
	});
});

