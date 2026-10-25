// Settings → Judge results by, rendered with Svelte's server renderer (issue #444): with no Reserve rule table
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
});
