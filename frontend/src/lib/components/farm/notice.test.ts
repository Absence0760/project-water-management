// Which of the WUA's two notices a reader gets (design §7): the farm view
// and the /share page both pick through pickNotice.
import { describe, expect, it } from 'vitest';
import { pickNotice } from './notice';

describe('pickNotice', () => {
	const r = { noticeEn: 'Irrigate at night', noticeAf: '[af] Irrigate at night' };

	it('reads the reader’s language when the WUA wrote it', () => {
		expect(pickNotice(r, 'en')).toEqual({ text: r.noticeEn, lang: 'en' });
		expect(pickNotice(r, 'af')).toEqual({ text: r.noticeAf, lang: 'af' });
	});

	it('falls back to the language that is written; blank counts as not written', () => {
		expect(pickNotice({ ...r, noticeAf: null }, 'af')).toEqual({ text: r.noticeEn, lang: 'en' });
		expect(pickNotice({ ...r, noticeAf: ' \n ' }, 'af')).toEqual({ text: r.noticeEn, lang: 'en' });
		expect(pickNotice({ ...r, noticeEn: '  ' }, 'en')).toEqual({ text: r.noticeAf, lang: 'af' });
		expect(pickNotice({ noticeEn: null, noticeAf: null }, 'en')).toBeNull();
		expect(pickNotice({ noticeEn: null, noticeAf: null }, 'af')).toBeNull();
	});
});
