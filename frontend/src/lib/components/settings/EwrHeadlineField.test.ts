// Model settings → EWR the results are judged by ("Judge results by" until issue #586 E14), rendered with Svelte's server renderer (issue #444): with no Reserve rule table
// there is nothing to choose, so one line says so, at the summary line's size like the other panels', and its
// link is named as the heading it goes to (issue #586, C16).
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { NetworkNode } from '@water-management/engine';
import EwrHeadlineField from './EwrHeadlineField.svelte';

const nodes = [{ id: 'g', name: 'Outlet', kind: 'gauge', damCapacityM3: 0, downstreamNodeId: null, sortOrder: 0 }] as unknown as NetworkNode[];

describe('EwrHeadlineField', () => {
	it('with nothing to choose: one summary line, linking to the Reserve rule tables by their heading', () => {
		const html = render(EwrHeadlineField, { props: { value: { source: 'auto' }, ewrRules: [], ewrPragmatic: new Array(12).fill(0), nodes } }).body;
		expect(html).toMatch(/<p class="summary[^"]*" data-testid="judge-nothing">/);
		expect(html).toContain('<a href="#set-reserve">Reserve rule tables</a>');
		expect(html).not.toMatch(/>Reserve rules</);
	});

	it('names the panel in plain words, its heading in a panel head as every other panel’s, so its line keeps its gap (issue #586 R4-B)', () => {
		const html = render(EwrHeadlineField, { props: { value: { source: 'auto' }, ewrRules: [], ewrPragmatic: new Array(12).fill(0), nodes } }).body;
		expect(html).toMatch(/<div class="panel-head[^"]*"><h2 id="judge-h"[^>]*>EWR the results are judged by<\/h2><\/div>/);
		expect(html).not.toContain('Judge results by');
	});

	it('with a rule table to choose: the select is labelled by the heading', () => {
		const html = render(EwrHeadlineField, {
			props: { value: { source: 'auto' }, ewrRules: [{ siteNodeId: 'g' }], ewrPragmatic: new Array(12).fill(1), nodes }
		}).body;
		expect(html).toMatch(/<label for="judge-pick"[^>]*>EWR the results are judged by<\/label>/);
	});
});
