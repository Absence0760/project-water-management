// The Restriction log's wording (log.ts) and its decisions as RestrictionLogList.svelte renders them, with Svelte's
// server renderer. The page's loading and paging are pinned by e2e/tests/restriction-log.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { RestrictionDecision } from '#lib/api/types.js';
import RestrictionLogList from './RestrictionLogList.svelte';
import { decisionBy, decisionFacts, decisionNotices, decisionTitle, inForceId, levelText, logContext, printedNote, runHref } from './log';

const RUN = '0b1f6c1e-8d1c-4c43-9a55-3f0a7e7c2a11';
const decision = (o: Partial<RestrictionDecision> = {}): RestrictionDecision => ({
	id: '1',
	kind: 'published',
	at: '2026-03-04T08:30:00.000000Z',
	by: 'Ann Editor',
	auto: false,
	publicationId: 'p1',
	runId: RUN,
	restriction: { level: 'restricted', pct: 25, notice: { en: 'Cut by a quarter.', af: 'Sny met ’n kwart.' } },
	nextExpectedOn: '2026-04-01',
	note: 'Dam levels low',
	farms: 6,
	season: { from: '2025-10-01', to: '2026-03-03', dataUntil: '2026-03-01' },
	current: false,
	runKept: true,
	...o
});

describe('log wording', () => {
	it('says the level with its cut, and an unknown level as not recorded', () => {
		expect(levelText({ level: 'restricted', pct: 25, notice: null })).toBe('Restricted · 25 %');
		expect(levelText({ level: 'advisory', pct: null, notice: null })).toBe('Advisory');
		expect(levelText({ level: 'none', pct: null, notice: {} })).toBe('No restriction');
		expect(levelText({ level: null, pct: null, notice: null })).toBe('Level not recorded');
	});

	it('titles a publication and a notice change by what changed', () => {
		expect(decisionTitle(decision())).toBe('Published a run');
		expect(decisionTitle(decision({ auto: true }))).toBe('Published an automatic run');
		expect(decisionTitle(decision({ kind: 'notice_changed', fields: ['restriction'] }))).toBe('Changed the restriction');
		expect(decisionTitle(decision({ kind: 'notice_changed', fields: ['restriction', 'nextExpectedOn', 'note'] }))).toBe(
			'Changed the restriction, next publication date and note'
		);
		expect(decisionTitle(decision({ kind: 'notice_changed', fields: [] }))).toBe('Changed the notice');
	});

	it('names who made it: their name, the automatic run, or a former member', () => {
		expect(decisionBy(decision())).toBe('Ann Editor');
		expect(decisionBy(decision({ by: null, auto: true }))).toBe('the automatic run');
		expect(decisionBy(decision({ by: null }))).toBe('a former member');
	});

	it('marks the newest decision of the current publication as in force', () => {
		const items = [decision({ id: '3', current: true, kind: 'notice_changed' }), decision({ id: '2', current: true }), decision({ id: '1' })];
		expect(inForceId(items)).toBe('3');
		expect(inForceId([decision()])).toBeNull();
	});

	it('says in the header what is in force and since when, or that nothing is published', () => {
		expect(logContext(null)).toMatch(/^Every restriction/);
		expect(logContext([])).toBe('Nothing published yet');
		expect(logContext([decision({ current: true })])).toBe('In force: Restricted · 25 %, since 4 Mar 2026 by Ann Editor');
		// Its publication trimmed and not current (can't happen today, but the line still says something true).
		expect(logContext([decision()])).toBe('Latest decision 4 Mar 2026: Restricted · 25 %');
	});

	it('lists the season, units and next date; an old event keeps only what it recorded', () => {
		expect(decisionFacts(decision())).toEqual(['Season 1 Oct 2025 to 3 Mar 2026, data to 1 Mar 2026', 'Sent to 6 hydrological units', 'Next publication expected 1 Apr 2026']);
		expect(decisionFacts(decision({ season: null, farms: 1, nextExpectedOn: null }))).toEqual(['Sent to 1 hydrological unit', 'No next publication date']);
		expect(decisionFacts(decision({ season: null, farms: null, nextExpectedOn: undefined }))).toEqual([]);
	});

	it('lists the notice in table order, English first, or null when the event kept no text', () => {
		expect(decisionNotices(decision())!.map((n) => n.name)).toEqual(['English', 'Afrikaans']);
		expect(decisionNotices(decision({ restriction: { level: 'advisory', pct: null, notice: null } }))).toBeNull();
	});

	it('links to the run’s Publication panel only while the run is kept', () => {
		expect(runHref(decision())).toBe(`?tab=runs&run=${RUN}#res-publication`);
		expect(runHref(decision({ runKept: false }))).toBeNull();
		expect(runHref(decision({ runId: null }))).toBeNull();
	});
});

describe('RestrictionLogList', () => {
	const html = render(RestrictionLogList, {
		props: {
			items: [
				decision({ id: '3', kind: 'notice_changed', fields: ['restriction'], current: true, note: '' }),
				decision({ id: '2', current: true, restriction: { level: 'advisory', pct: 10, notice: { en: 'Please save water.' } } }),
				decision({ id: '1', runKept: false, by: null, restriction: { level: 'restricted', pct: 40, notice: null }, season: null, nextExpectedOn: undefined, note: undefined })
			]
		}
	}).body;
	const entries = html.split('data-testid="restriction-decision"').slice(1);

	it('renders one entry per decision, newest first, with a heading, the level and the time', () => {
		expect(entries).toHaveLength(3);
		expect(entries[0]).toContain('Changed the restriction');
		expect(entries[0]).toContain('Restricted · 25 %');
		expect(entries[1]).toContain('Published a run');
		expect(entries[1]).toContain('Advisory · 10 %');
		expect(html).toContain('datetime="2026-03-04T08:30:00.000000Z"');
		expect(html).toContain('aria-label="Restriction decisions, newest first"');
	});

	it('marks only the newest decision of the current publication as in force', () => {
		expect(html.match(/data-testid="restriction-in-force"/g)).toHaveLength(1);
		expect(entries[0]).toContain('restriction-in-force');
	});

	it('shows the notice in each language with its lang, the staff note, and who made it', () => {
		expect(entries[0]).toContain('Notice (English)');
		expect(entries[0]).toMatch(/<dd lang="af"[^>]*>Sny met ’n kwart\.<\/dd>/);
		expect(entries[1]).toContain('Staff note (farmers don’t see it):');
		expect(entries[1]).toContain('Dam levels low');
		expect(entries[0]).not.toContain('Staff note');
		expect(entries[0]).toContain('By Ann Editor');
	});

	it('links to a kept run, and says when the run is gone or the event kept no notice', () => {
		expect(entries[0]).toContain(`href="?tab=runs&amp;run=${RUN}#res-publication"`);
		expect(entries[2]).not.toContain('href=');
		expect(entries[2]).toContain(`run ${RUN.slice(0, 8)} no longer kept`);
		expect(entries[2]).toContain('By a former member');
		expect(entries[2]).toContain('Recorded before notices were kept in the log');
	});
});

describe('the printed page', () => {
	const at = new Date('2026-03-04T08:30:00Z');
	it('says what the paper holds, and that the CSV holds the whole log while older decisions aren’t loaded', () => {
		expect(printedNote(1, false, at)).toMatch(/^Printed .*2026.*: 1 decision, newest first\.$/);
		expect(printedNote(50, true, at)).toMatch(/: 50 decisions, newest first\. Older decisions weren’t loaded: Download CSV holds the whole log\.$/);
	});

	it('names the run by its short id on paper, where the link can’t be followed', () => {
		const html = render(RestrictionLogList, { props: { items: [decision({ runKept: true })] } }).body;
		expect(html).toContain('class="screen-only');
		expect(html).toMatch(/<span class="print-only[^"]*">run 0b1f6c1e<\/span>/);
	});
});
