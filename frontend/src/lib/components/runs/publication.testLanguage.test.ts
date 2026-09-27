// Issue #58's proof on the publish form and the notice card: a language is
// one entry in the language table. With a stand-in third language added to
// the table (tests only, never shipped), the form offers it a field, the
// draft carries it to the API, and a reader who chose it reads it (else
// English, with the line naming the language the WUA wrote in), with no
// other change.
import { describe, expect, it, vi } from 'vitest';
import { vaalbankFixture } from '$lib/components/farm/fixture';
import { noticeCard } from '$lib/components/farm/cards';
import { languageName, pickNotice } from '$lib/components/farm/notice';
import { i18n } from '$lib/i18n/locale.svelte';
import { draftFrom, emptyDraft, noticeTextFields, noticeLanguages, parseDraft } from './publication';

/** The types know only the shipped languages; the stand-in exists at run time. */
const loose = (o: Record<string, string>) => o as never;

vi.mock('@water-management/engine/languages', async (importOriginal) => {
	const real = await importOriginal<typeof import('@water-management/engine/languages')>();
	return { ...real, ...real.languageTable([...real.LANGUAGES, { code: 'xx', name: 'Xx-test', intl: 'en-US', decimalMark: ',' }]) };
});

describe('the notice with a stand-in language in the table', () => {
	it('gets its own field in the publish form, after English and Afrikaans', () => {
		expect(noticeTextFields()).toEqual([
			{ code: 'en', label: 'Notice in English' },
			{ code: 'af', label: 'Notice in Afrikaans' },
			{ code: 'xx', label: 'Notice in Xx-test' }
		]);
		expect(emptyDraft().notice).toEqual({ en: '', af: '', xx: '' });
	});

	it('is carried from the form to the API and back, trimmed', () => {
		const d = emptyDraft();
		d.level = 'advisory';
		(d.notice as Record<string, string>).xx = '  [xx] Irrigate at night ';
		const parsed = parseDraft(d);
		expect(parsed).toEqual({ ok: true, restriction: { level: 'advisory', pct: null, notice: { xx: '[xx] Irrigate at night' } }, nextExpectedOn: null });
		expect(draftFrom({ restriction: { level: 'advisory', pct: null, notice: loose({ xx: '[xx] Irrigate at night' }) }, nextExpectedOn: null }).notice).toEqual({
			en: '',
			af: '',
			xx: '[xx] Irrigate at night'
		});
		expect(noticeLanguages(loose({ xx: 'x', en: 'e' })).map((n) => n.name)).toEqual(['English', 'Xx-test']);
	});

	it('is read by its reader, and named by the table when the browser has no name for it', () => {
		const notice = { en: 'Irrigate at night', xx: '[xx] Irrigate at night' };
		expect(pickNotice(notice, 'xx')).toEqual({ text: notice.xx, lang: 'xx' });
		expect(languageName('xx' as never)).toBe('Xx-test');
		// An English reader of a notice written only in the stand-in: the card says which language it is in.
		const v = vaalbankFixture();
		v.publication.restriction = { level: 'advisory', pct: null, notice: loose({ xx: notice.xx }) };
		expect(i18n.locale).toBe('en');
		expect(noticeCard(v)).toMatchObject({ heading: notice.xx, lang: 'xx', langNote: 'The WUA wrote this notice in Xx-test only.' });
	});
});
