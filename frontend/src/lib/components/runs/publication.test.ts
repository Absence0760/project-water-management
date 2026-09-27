import { describe, expect, it } from 'vitest';
import { damsWithoutStopLevel, draftFrom, emptyDraft, parseDraft, publishBlocker, publishedRunIds, restrictionSummary } from './publication';

describe('damsWithoutStopLevel', () => {
	it('counts farm dams whose stop level is 0, not farms without a dam or gauges', () => {
		expect(
			damsWithoutStopLevel([
				{ kind: 'farm', damCapacityM3: 1000, damMinPct: 0 },
				{ kind: 'farm', damCapacityM3: 1000, damMinPct: 0.15 },
				{ kind: 'farm', damCapacityM3: 0, damMinPct: 0 },
				{ kind: 'gauge', damCapacityM3: 0, damMinPct: 0 },
				{ kind: 'farm', damCapacityM3: 500 }
			])
		).toBe(2);
		expect(damsWithoutStopLevel(undefined)).toBe(0);
	});
});

describe('publishBlocker and publishedRunIds', () => {
	it('blocks only a legacy run', () => {
		expect(publishBlocker({ legacy: true })).toMatch(/legacy runoff model/);
		// The model is gone (engine 1.0.0): the way out is a new run, which uses GR4J.
		expect(publishBlocker({ legacy: true })).toMatch(/run the project again \(a new run uses GR4J\)/);
		expect(publishBlocker({ legacy: false })).toBeNull();
	});
	it('collects every run the history holds', () => {
		expect(publishedRunIds([{ runId: 'a' }, { runId: 'b' }, { runId: 'a' }])).toEqual(new Set(['a', 'b']));
		expect(publishedRunIds(undefined).size).toBe(0);
	});
});

describe('restrictionSummary', () => {
	it('names the level, with the percentage when there is one', () => {
		expect(restrictionSummary({ level: 'advisory', pct: 10 })).toBe('Advisory · 10 %');
		expect(restrictionSummary({ level: 'restricted', pct: null })).toBe('Restricted');
		expect(restrictionSummary({ level: 'none', pct: null })).toBe('No restriction');
	});
});

describe('the notice draft', () => {
	it('round-trips a publication', () => {
		const p = { restriction: { level: 'restricted' as const, pct: 25.5, noticeEn: 'Cut', noticeAf: null }, nextExpectedOn: '2024-02-01' };
		expect(draftFrom(p)).toEqual({ level: 'restricted', pct: '25.5', noticeEn: 'Cut', noticeAf: '', nextExpectedOn: '2024-02-01' });
		expect(parseDraft(draftFrom(p))).toEqual({ ok: true, restriction: p.restriction, nextExpectedOn: '2024-02-01' });
		expect(draftFrom(null)).toEqual(emptyDraft());
	});
	it('takes a decimal comma, trims the notices and treats empty as none', () => {
		expect(parseDraft({ level: 'advisory', pct: ' 12,5 ', noticeEn: '  Save water ', noticeAf: '   ', nextExpectedOn: '' })).toEqual({
			ok: true,
			restriction: { level: 'advisory', pct: 12.5, noticeEn: 'Save water', noticeAf: null },
			nextExpectedOn: null
		});
	});
	it('refuses a percentage without a restriction, out of range, or not a number, and an over-long notice', () => {
		expect(parseDraft({ ...emptyDraft(), pct: '5' })).toMatchObject({ ok: false });
		expect(parseDraft({ ...emptyDraft(), level: 'advisory', pct: '120' })).toMatchObject({ ok: false });
		expect(parseDraft({ ...emptyDraft(), level: 'advisory', pct: 'ten' })).toMatchObject({ ok: false });
		expect(parseDraft({ ...emptyDraft(), noticeAf: 'x'.repeat(2001) })).toEqual({ ok: false, error: 'The Afrikaans notice is 2001 characters; the most is 2000.' });
	});
});
