import type { InputChange } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { CompareAttribution, HistoryRevision } from '#lib/api/types.js';
import { attributionSummary, byline, historyHref, lineAuthors } from './attribution';

const rev = (id: string, actor: string | null, over: Partial<HistoryRevision> = {}): HistoryRevision => ({
	type: 'revision',
	id,
	createdAt: '2026-09-26T12:30:00.000000Z',
	changeSet: null,
	actor,
	source: 'model_put',
	reason: null,
	changes: [],
	restoredFrom: null,
	restoredFromRun: null,
	...over
});
const change = (text: string): InputChange => ({ area: 'network', kind: 'changed', subject: 'Rooikloof', text });

describe('lineAuthors', () => {
	it('maps each line to its revision, and to null without one', () => {
		const a: CompareAttribution = { revisions: [rev('2', 'Ann'), rev('1', 'Bob')], truncated: false, changedBy: ['1', null, '2'] };
		const out = lineAuthors([change('x'), change('y'), change('z')], a);
		expect(out.map((r) => r?.actor ?? null)).toEqual(['Bob', null, 'Ann']);
	});

	it('is all null when there is no attribution (another project, a scenario run, B before A)', () => {
		expect(lineAuthors([change('x')], null)).toEqual([null]);
		expect(lineAuthors([change('x')], undefined)).toEqual([null]);
	});
});

describe('byline', () => {
	it('names the author and the time, day first on the viewer’s clock, or a former member', () => {
		const tz = process.env.TZ;
		try {
			// 12:30 UTC on 26 Sep is already the 27th at UTC+14, still the 26th at UTC−11.
			process.env.TZ = 'Pacific/Kiritimati';
			expect(byline(rev('1', 'Ann'))).toBe('Changed by Ann on 27 Sep 2026 02:30');
			process.env.TZ = 'Pacific/Pago_Pago';
			expect(byline(rev('1', 'Ann'))).toBe('Changed by Ann on 26 Sep 2026 01:30');
			expect(byline(rev('1', null))).toBe('Changed by a former member on 26 Sep 2026 01:30');
		} finally {
			process.env.TZ = tz;
		}
	});
});

describe('attributionSummary', () => {
	it('counts the changes and names each author once', () => {
		const a: CompareAttribution = { revisions: [rev('3', 'Ann'), rev('2', 'Bob'), rev('1', 'Ann')], truncated: false, changedBy: [] };
		expect(attributionSummary(a)).toBe('3 saved changes to the model or settings between the runs, by Ann and Bob.');
		expect(attributionSummary({ ...a, revisions: [rev('1', null)] })).toBe('1 saved change to the model or settings between the runs, by a former member.');
		expect(attributionSummary({ ...a, truncated: true })).toBe('More than 3 saved changes to the model or settings between the runs, by Ann and Bob.');
	});

	it('says when nothing was saved between the runs', () => {
		expect(attributionSummary({ revisions: [], truncated: false, changedBy: [] })).toBe('No saved model or settings changes between the runs.');
	});
});

describe('historyHref', () => {
	it('opens the project workspace on its History tab', () => {
		expect(historyHref('p-1')).toBe('/projects/p-1?tab=history');
	});
});
