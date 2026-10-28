// Settings → Reserve rule tables, rendered with Svelte's server renderer: the
// two method choices under the tables, and the base-flow filter's method beside
// the low-flow measure (issue #523 D3, docs/model.md §2.9d).
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { blankEwrDailySource, blankEwrRuleTable, type EwrDailySource, type NetworkNode } from '@water-management/engine';
import EwrRulesSection from './EwrRulesSection.svelte';
import EwrRuleTablesEditor from './EwrRuleTablesEditor.svelte';
import { exampleRulFile, parseRulFile, percentileTablesFromRul, ruleTableFromRul, type RulFile } from './drmFiles';

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

// The editor itself (EwrRulesSection loads it lazily, so it is rendered on its own here): the outlet's table filled
// from the same .rul as the daily EWR folds its grids under one line (issue #617), every other field still shown.
describe('EwrRuleTablesEditor: grids that repeat the daily EWR’s .rul tables', () => {
	const rul = parseRulFile(exampleRulFile('mcm')) as RulFile;
	const daily: EwrDailySource = { ...blankEwrDailySource(), method: 'percentile', tableAreaKm2: 10, ...(percentileTablesFromRul(rul) as object) };
	const options = [{ id: null, label: 'Outlet (Outlet)' }, { id: 'g2', label: 'Gauge 2' }];
	const card = (site: string | null = null) => ruleTableFromRul(blankEwrRuleTable(site), rul, 'drm.rul');
	const foldOf = (html: string) => /<details[^>]*data-testid="rule-grids-repeat"[^>]*>/.exec(html)?.[0];

	it('the outlet’s same grids fold, closed, under a line naming them; the REC and the other fields stay', () => {
		const html = render(EwrRuleTablesEditor, { props: { value: [card()], options, daily } }).body;
		expect(foldOf(html)).toBeDefined();
		expect(foldOf(html)).not.toMatch(/\bopen\b/);
		const t = text(html);
		expect(t).toContain('Grids: the daily EWR’s .rul tables · EWR, low flows');
		expect(html).toContain('href="#set-ewr"');
		expect(t).toContain('Recommended ecological category (REC)');
		expect(html).toMatch(/id="[^"]+-rec"[^>]*value="C"|value="C"[^>]*id="[^"]+-rec"/);
		expect(t).toContain('Kind of source');
		expect(t).toContain('Table settings:');
		// The grids are still in the page, inside the fold, to open and edit.
		expect(html).toMatch(/data-testid="rule-grids-repeat"[\s\S]*EWR \(total flow\) at each % point/);
		expect(html).not.toContain('rule-grids-differ');
	});

	it('different grids show open, with a note; a gauge’s table and a TAB daily EWR are unchanged', () => {
		const t = card();
		t.ewr[0]![0] = t.ewr[0]![0]! + 1;
		const differs = render(EwrRuleTablesEditor, { props: { value: [t], options, daily } }).body;
		// The same fold, open, so an edit that flips the state never re-creates the field being typed in.
		expect(foldOf(differs)).toMatch(/\bopen\b/);
		expect(text(differs)).toContain('Grids: not the daily EWR’s tables · EWR, low flows');
		expect(text(differs).replace(/ :/g, ':')).toContain('These grids differ from the tables of The daily EWR at the outlet above: monthly compliance reads these, the daily EWR those.');
		for (const [value, d] of [
			[[card('g2')], daily],
			[[card()], { ...daily, method: 'tab' as const }],
			[[card()], null]
		] as const) {
			const html = render(EwrRuleTablesEditor, { props: { value: [...value], options, daily: d } }).body;
			expect(foldOf(html)).toBeUndefined();
			expect(html).not.toContain('rule-grids-differ');
		}
	});
});
