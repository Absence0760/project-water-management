// Which of the WUA's notices a reader gets (design §7): the farm view, /share
// and the alert emails all pick through pickNotice.
import { describe, expect, it } from 'vitest';
import { pickNotice } from './notice';

describe('pickNotice', () => {
	const both = { en: 'Irrigate at night', af: '[af] Irrigate at night' };

	it('reads the reader’s language when the WUA wrote it', () => {
		expect(pickNotice(both, 'en')).toEqual({ text: both.en, lang: 'en' });
		expect(pickNotice(both, 'af')).toEqual({ text: both.af, lang: 'af' });
	});

	it('falls back to English, then to any language that is written; blank counts as not written', () => {
		expect(pickNotice({ en: both.en }, 'af')).toEqual({ text: both.en, lang: 'en' });
		expect(pickNotice({ ...both, af: ' \n ' }, 'af')).toEqual({ text: both.en, lang: 'en' });
		expect(pickNotice({ en: '  ', af: both.af }, 'en')).toEqual({ text: both.af, lang: 'af' });
		expect(pickNotice({}, 'en')).toBeNull();
		expect(pickNotice({ en: '', af: '' }, 'af')).toBeNull();
		expect(pickNotice(null, 'af')).toBeNull();
	});

	it('an unknown reader language reads English; a code the table doesn’t list is never shown', () => {
		expect(pickNotice(both, 'de')).toEqual({ text: both.en, lang: 'en' });
		expect(pickNotice(both, null)).toEqual({ text: both.en, lang: 'en' });
		expect(pickNotice({ de: 'Nachts bewässern' }, 'de')).toBeNull();
		expect(pickNotice(JSON.parse('{"__proto__": "x"}'), '__proto__')).toBeNull();
	});
});
