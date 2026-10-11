// The Reserve's DRM uploads say what they take in the shared "Expected format"
// note (common/FormatHelp.svelte, docs/ui.md § Expected format), and the
// file load sits at the top of each rule table and above the daily EWR's
// tables (issue #455 follow-ups), rendered with Svelte's server renderer.
// The browser flow is pinned by e2e/tests/ewr-daily-source.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { blankEwrDailySource, blankEwrRuleTable } from '@water-management/engine';
import DrmFormatHelp from './DrmFormatHelp.svelte';
import EwrRuleTablesEditor from './EwrRuleTablesEditor.svelte';
import EwrDailySourceFields from './EwrDailySourceFields.svelte';
import { drmExampleFiles, exampleRulFile, exampleTabFile, parseDrmFile } from './drmFiles';
import { parseGrid } from './ewrRules';

// The daily EWR's fields read the last run through the API only once the MAR ratio is in use in a browser; nothing here runs effects.
vi.mock('$lib/api', () => ({ api: {} }));
vi.mock('$app/paths', () => ({ base: '' }));

const decoded = (href: string) => decodeURIComponent(href.slice(href.indexOf(',') + 1));
/** Each example link's download name and data URL, in page order. */
const links = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*download="([^"]+)"/g)].map((m) => ({ href: m[1]!.replace(/&amp;/g, '&'), name: m[2]! }));

describe('DrmFormatHelp builds on the shared Expected format', () => {
	it('is the shared note, its summary told apart for a screen reader, with the DRM example files and the form’s CSVs', () => {
		const html = render(DrmFormatHelp, { props: { target: 'ruleTable', context: 'of a file for the rule table at Outlet' } }).body;
		expect(html).toContain('data-testid="format-help"');
		expect(html).toMatch(/<summary[^>]*>Expected format(<!--[^>]*-->)?<span class="visually-hidden"> of a file for the rule table at Outlet<\/span>(<!--[^>]*-->)?<\/summary>/);
		expect(html).toContain('data-testid="format-accepts"');
		expect(links(html).map((l) => l.name)).toEqual(['drm-example.rul', 'drm-example-mcm.rul', 'drm-example.tab', 'ewr-total-example.csv', 'ewr-low-flow-example.csv']);
		// The link to every format, on the File formats help page (issue #477).
		expect(html).toContain('href="/help/formats#reserve-rule-table"');
	});

	it('offers files its boxes read: each DRM example parses as its kind, each in plain text with no byte-order mark', () => {
		const html = render(DrmFormatHelp, { props: { target: 'dailyEwr', context: 'x' } }).body;
		const got = links(html).filter((l) => !l.name.endsWith('.csv'));
		expect(got.map((l) => l.name)).toEqual(['drm-example.rul', 'drm-example-mcm.rul', 'drm-example.tab']);
		for (const l of got) {
			expect(l.href.startsWith('data:text/plain;charset=utf-8,')).toBe(true);
			const text = decoded(l.href);
			expect(text.startsWith('﻿')).toBe(false);
			const parsed = parseDrmFile(text);
			expect(parsed && !('error' in parsed) && parsed.kind).toBe(l.name.endsWith('.tab') ? 'tab' : 'rul');
		}
		expect(decoded(got[0]!.href)).toBe(exampleRulFile('m3s'));
		expect(decoded(got[1]!.href)).toBe(exampleRulFile('mcm'));
		expect(decoded(got[2]!.href)).toBe(exampleTabFile());
		expect(drmExampleFiles().map((f) => f.label)).toEqual(['Example .rul (m³/s)', 'Example .rul (Mm³ a month)', 'Example .tab']);
	});

	it('says what each file fills for its form: the daily EWR keeps its method', () => {
		const daily = render(DrmFormatHelp, { props: { target: 'dailyEwr', context: 'x' } }).body;
		expect(daily).toContain('The method you picked stays as it is.');
		expect(daily).toContain('A CSV isn’t loaded here');
		const rule = render(DrmFormatHelp, { props: { target: 'ruleTable', context: 'x' } }).body;
		expect(rule).toContain('It fills the determination’s natural MAR and the REC.');
		expect(rule).toContain('which goes into the paste box below the table');
	});
});

describe('the file load comes first', () => {
	const options = [{ id: null, label: 'Outlet (Gauge)' }];

	it('a rule table opens with its file load and Expected format, before the fields and grids; its CSV examples read back through the paste', () => {
		const html = render(EwrRuleTablesEditor, { props: { value: [blankEwrRuleTable()], options } }).body;
		const load = html.indexOf('Load a DRM file (.rul / .tab) or a CSV');
		expect(load).toBeGreaterThan(html.indexOf('<legend>Rule table at Outlet (Gauge)</legend>'));
		expect(load).toBeLessThan(html.indexOf('>EWR site</label>'));
		expect(html.indexOf('data-testid="format-help"')).toBeLessThan(html.indexOf('>EWR site</label>'));
		expect(html.indexOf('aria-label="File result"')).toBeLessThan(html.indexOf('>EWR site</label>'));
		// The paste box stays under the grid.
		expect(html.indexOf('Paste from a spreadsheet')).toBeGreaterThan(html.indexOf('EWR at each % point'));
		const csv = links(html).filter((l) => l.name.startsWith('ewr-'));
		expect(csv.map((l) => l.name)).toEqual(['ewr-total-example.csv', 'ewr-low-flow-example.csv']);
		for (const l of csv) {
			const g = parseGrid(decoded(l.href));
			expect('error' in g ? g.error : g.rows.length).toBe(12);
		}
	});

	it('a read-only rule table has no file load', () => {
		const html = render(EwrRuleTablesEditor, { props: { value: [blankEwrRuleTable()], options, readonly: true } }).body;
		expect(html).not.toContain('type="file"');
		expect(html).not.toContain('data-testid="format-help"');
	});

	it.each(['tab', 'percentile'] as const)('the daily EWR under %s: the file load and its Expected format sit above the tables, the paste box below', (method) => {
		const html = render(EwrDailySourceFields, { props: { value: { ...blankEwrDailySource(), method }, modelAreaKm2: 10 } }).body;
		const load = html.indexOf('Load a DRM file (.rul / .tab)');
		const firstTable = html.indexOf('<caption');
		expect(load).toBeGreaterThan(0);
		expect(load).toBeLessThan(firstTable);
		expect(html.indexOf('data-testid="format-help"')).toBeLessThan(firstTable);
		expect(html.indexOf('aria-label="File result"')).toBeLessThan(firstTable);
		expect(html.indexOf('aria-label="Paste result"')).toBeGreaterThan(html.lastIndexOf('</table>'));
		const csv = links(html).find((l) => l.name === 'ewr-example.csv')!;
		const g = parseGrid(decoded(csv.href));
		expect('error' in g ? g.error : [g.rows.length, g.rows[0]!.length]).toEqual([12, 10]);
	});

	it('the pragmatic EWR has no file load', () => {
		const html = render(EwrDailySourceFields, { props: { value: blankEwrDailySource(), modelAreaKm2: 10 } }).body;
		expect(html).not.toContain('type="file"');
	});
});
