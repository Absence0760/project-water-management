// Settings → Flow share → Split the EWR between units by (EwrSplitFields.svelte, settings.ewrSplit,
// issue #553), rendered with Svelte's server renderer: the two options, the stored value selected
// (the flow share when unset), and the state line saying the choice only matters with Rain for each
// unit on. The browser flow (picking, saving) is pinned by e2e/tests/ewr-split.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import EwrSplitFields from './EwrSplitFields.svelte';
import { ewrSplitHint, ewrSplitSummary, EWR_SPLIT_OPTIONS } from './ewrSplit';

vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/') } }));

const text = (body: string) => {
	let s = body;
	for (let prev = ''; prev !== s; ) {
		prev = s;
		s = s.replace(/<!--[\s\S]*?-->/g, '');
	}
	return s;
};

describe('EwrSplitFields', () => {
	it('selects the flow share when the setting is unset, and names both options', () => {
		const body = text(render(EwrSplitFields, { props: { value: undefined } }).body);
		expect(body).toContain('Split the EWR between units by');
		expect(body).toMatch(/<option value="flowShare"[^>]*selected[^>]*>The flow share<\/option>/);
		expect(body).toContain('<option value="naturalMar">Each unit’s natural MAR</option>');
		expect(body).toContain('data-unit-rain="off"');
		expect(body).toContain('both give the flow share. The choice matters only with Rain for each unit on.');
	});

	it('selects the natural MAR when stored, and says it splits by each unit’s own runoff with Rain for each unit on', () => {
		const body = text(render(EwrSplitFields, { props: { value: 'naturalMar', perUnit: true } }).body);
		expect(body).toMatch(/<option value="naturalMar"[^>]*selected/);
		expect(body).toContain('data-unit-rain="on"');
		expect(body).toContain('each unit’s EWR share is its own GR4J runoff’s share, not its flow share.');
		// Both lines describe the select.
		expect(body).toMatch(/aria-describedby="([^"]+)-split-h \1-split-state"/);
	});

	it('is disabled when read-only', () => {
		expect(render(EwrSplitFields, { props: { value: 'flowShare', readonly: true } }).body).toMatch(/<select[^>]*disabled/);
	});
});

describe('ewrSplit helpers', () => {
	it('offers the engine’s two methods', () => {
		expect(EWR_SPLIT_OPTIONS.map((o) => o.value)).toEqual(['flowShare', 'naturalMar']);
	});

	it('the hint follows the method and Rain for each unit', () => {
		expect(ewrSplitHint('naturalMar', true).explain).toMatch(/complete water years .* provisional/);
		expect(ewrSplitHint('flowShare', true).state).toMatch(/the flow share splits the EWR/);
		expect(ewrSplitHint('naturalMar', false).state).toBe(ewrSplitHint('flowShare', false).state);
	});

	it('the summary names only a split other than the flow share', () => {
		expect(ewrSplitSummary(undefined, true)).toBeNull();
		expect(ewrSplitSummary('flowShare', true)).toBeNull();
		expect(ewrSplitSummary('naturalMar', true)).toBe('the EWR split by each unit’s natural MAR');
	});
});
