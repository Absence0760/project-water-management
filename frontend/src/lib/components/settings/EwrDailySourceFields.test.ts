// The daily EWR's scaling default (issue #523 D2, #90 B2): a project with no
// source starts from the blank one, scaled by the area ratio, while a stored
// source shows the scaling it was saved with, so a project saved with the MAR
// ratio before the default moved keeps it. Rendered with Svelte's server
// renderer; the browser flow is pinned by e2e/tests/ewr-daily-source.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { blankEwrDailySource, type EwrDailySource } from '@water-management/engine';
import EwrDailySourceFields from './EwrDailySourceFields.svelte';

// The fields read the last run through the API only once the MAR ratio is in use in a browser; nothing here runs effects.
vi.mock('$lib/api', () => ({ api: {} }));
vi.mock('$app/paths', () => ({ base: '' }));

/** The value of the option the scaling select renders as selected. */
const selectedScaling = (html: string) => {
	const select = html.match(/<select id="[^"]*-scaling"[\s\S]*?<\/select>/)?.[0] ?? '';
	return [...select.matchAll(/<option value="(\w+)"([^>]*)>/g)].filter((m) => /\bselected\b/.test(m[2]!)).map((m) => m[1]);
};
const factorLine = (html: string) => html.match(/data-testid="ewr-scale-factor"[^>]*>([^<]*)</)?.[1] ?? '';

describe('EwrDailySourceFields: the scaling default', () => {
	it('a project with no source shows no scaling (the pragmatic EWR), and the blank it starts from scales by area', () => {
		const html = render(EwrDailySourceFields, { props: { value: null, modelAreaKm2: 10 } }).body;
		expect(selectedScaling(html)).toEqual([]);
		expect(blankEwrDailySource().scaling).toBe('area');
	});

	it('a new table source (the blank switched to the TAB file) is scaled by the area ratio', () => {
		const value: EwrDailySource = { ...blankEwrDailySource(), method: 'tab', tableAreaKm2: 40 };
		const html = render(EwrDailySourceFields, { props: { value, modelAreaKm2: 10 } }).body;
		expect(selectedScaling(html)).toEqual(['area']);
		expect(factorLine(html)).toContain('10 km² ÷ 40 km² = 0.25');
	});

	it('a stored MAR-ratio source keeps the MAR ratio: the default never rewrites a saved choice', () => {
		const value: EwrDailySource = { ...blankEwrDailySource(), method: 'tab', scaling: 'mar', tableMarMm3: 100, tabM3s: new Array(12).fill(0.5) };
		const html = render(EwrDailySourceFields, { props: { value, modelAreaKm2: 10 } }).body;
		expect(selectedScaling(html)).toEqual(['mar']);
		expect(factorLine(html)).toContain('natural MAR at the outlet ÷ 100');
	});
});
