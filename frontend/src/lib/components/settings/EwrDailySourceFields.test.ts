// The daily EWR's scaling default (issue #523 D2, #90 B2): a project with no
// source starts from the blank one, scaled by the area ratio, while a stored
// source shows the scaling it was saved with, so a project saved with the MAR
// ratio before the default moved keeps it. Rendered with Svelte's server
// renderer; the browser flow is pinned by e2e/tests/ewr-daily-source.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { blankEwrDailySource, type EwrDailySource } from '@water-management/engine';
import EwrDailySourceFields from './EwrDailySourceFields.svelte';
import { exampleRulFile, exampleTabFile, parseRulFile, parseTabFile, percentileTablesFromRul, rulFileRecord, tabFileRecord, type RulFile, type TabFile } from './drmFiles';

// The fields read the last run through the API only once the MAR ratio is in use in a browser; nothing here runs effects.
vi.mock('#lib/api/index.js', () => ({ api: {} }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));

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

// The rendered markup as text: comments stripped to a fixpoint, then the
// tags, then any `<` or `>` left over, so no tag or comment marker can survive whatever a removal joined up.
const text = (html: string) => {
	let s = html;
	for (let prev = ''; prev !== s; ) {
		prev = s;
		s = s.replace(/<!--[\s\S]*?-->/g, '');
	}
	return s.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ').replace(/\s+/g, ' ');
};

// The kept DRM files (issue #617): the whole .tab under the TAB flows, its total column marked; a changed row says so;
// a source saved before keeps its flows and says to load the file again; the .rul's name, date and REC above its tables.
describe('EwrDailySourceFields: the kept .tab and .rul', () => {
	const tab = parseTabFile(exampleTabFile()) as TabFile;
	const tabFile = tabFileRecord(tab, 'drm.tab');
	const tabSource: EwrDailySource = { ...blankEwrDailySource(), method: 'tab', tableAreaKm2: 40, tabM3s: tab.totalMaintM3s, tableMarMm3: 49.8, tabFile };

	it('shows the whole file: header, annual flows, IFR summary and all seven columns, Total flows, maint. marked as the TAB flows', () => {
		const html = render(EwrDailySourceFields, { props: { value: tabSource, modelAreaKm2: 10 } }).body;
		const t = text(html);
		expect(html).toContain('data-testid="ewr-tab-file-view"');
		for (const s of ['Estimate for SYNTHETIC EXAMPLE', 'Total runoff Synthetic incremental', 'Distribution type Synthetic', 'Ecological category (REC) C', 'S.Dev.', 'BFI Index', 'CV(JJA+JFM) Index', 'Total IFR', 'Drought Lowflow', '47.17']) expect(t).toContain(s);
		expect(html).toMatch(/<th scope="colgroup"[^>]*>Natural flows<\/th>/);
		expect(html).toMatch(/<th scope="colgroup"[^>]*>Modified flows \(IFR\)<\/th>/);
		expect(t).toContain('Month Mean SD CV Low flows, maint. Low flows, drought High flows, maint. Total flows, maint.');
		expect(t).toContain('Total flows, maint. used: the TAB flows');
		expect(t).not.toContain('changed after loading');
		expect(t).not.toContain('Load the .tab again');
	});

	it('a TAB row changed since says so; a source saved before the file was kept says to load it again', () => {
		const edited = render(EwrDailySourceFields, { props: { value: { ...tabSource, tabM3s: tab.totalMaintM3s.map((v, i) => (i === 0 ? 0.5 : v)) }, modelAreaKm2: 10 } }).body;
		expect(text(edited)).toContain('The TAB flows were changed after loading drm.tab; the file is shown as loaded.');
		const { tabFile: _, ...legacy } = tabSource;
		const old = text(render(EwrDailySourceFields, { props: { value: legacy, modelAreaKm2: 10 } }).body);
		expect(old).toContain('These TAB flows were saved without their .tab file. Load the .tab again to see the whole file.');
		expect(text(render(EwrDailySourceFields, { props: { value: legacy, modelAreaKm2: 10, readonly: true } }).body)).not.toContain('Load the .tab again');
		// Kept for its MAR only, then switched to the TAB method: no TAB flow came from it, so it says so and offers them.
		const marOnly = text(render(EwrDailySourceFields, { props: { value: { ...tabSource, tabM3s: null }, modelAreaKm2: 10 } }).body);
		expect(marOnly).toContain('drm.tab gave only the table MAR. Use its TAB flows');
		expect(marOnly).toContain('drm.tab · REC C · gave the table MAR only');
		expect(marOnly).toContain('used: the table MAR');
		expect(marOnly).not.toContain('used: the TAB flows');
		expect(marOnly).not.toContain('changed after loading');
	});

	it('under the percentile tables: the .rul’s file, date, unit and REC above the tables, and a .tab used for its MAR folded', () => {
		const rul = parseRulFile(exampleRulFile('mcm')) as RulFile;
		const value: EwrDailySource = { ...blankEwrDailySource(), method: 'percentile', tableAreaKm2: 40, ...(percentileTablesFromRul(rul) as object), rulFile: rulFileRecord(rul, 'drm.rul'), tabFile };
		const html = render(EwrDailySourceFields, { props: { value, modelAreaKm2: 10 } }).body;
		const t = text(html);
		expect(t).toContain('From drm.rul, generated 01/01/2026, in Mm³ a month (converted to m³/s, February 28 days) · Recommended ecological category (REC) C.');
		expect(html.indexOf('data-testid="ewr-rul-file"')).toBeLessThan(html.indexOf('Natural flow percentile table <span'));
		expect(t).toContain('The .tab this table MAR came from: drm.tab · REC C');
		expect(/<details[^>]*data-testid="ewr-tab-file"[^>]*>/.exec(html)?.[0]).not.toMatch(/\bopen\b/);
		expect(t).toContain('used: the table MAR');
		expect(t).not.toContain('used: the TAB flows');
		// A table typed or pasted over since the .rul loaded: the line says so.
		const edited = text(render(EwrDailySourceFields, { props: { value: { ...value, rulFile: { ...value.rulFile!, edited: true } }, modelAreaKm2: 10 } }).body);
		expect(edited).toContain('(REC) C; the tables were changed since.');
	});
});
