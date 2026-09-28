// Issue #58's proof: a language is one entry in the language table. With a
// stand-in third language added to the table (tests only, never shipped),
// pickNotice reads it with no other change.
import { describe, expect, it, vi } from 'vitest';
import { pickNotice } from './notice';

vi.mock('../languages', async (importOriginal) => {
	const real = await importOriginal<typeof import('../languages')>();
	return { ...real, ...real.languageTable([...real.LANGUAGES, { code: 'xx', name: 'Xx-test', intl: 'en-US', decimalMark: ',' }]) };
});

describe('pickNotice with a stand-in language in the table', () => {
	it('reads the new language for its reader, and falls back to it after English', () => {
		const notice = { en: 'Irrigate at night', af: '[af] Irrigate at night', xx: '[xx] Irrigate at night' };
		expect(pickNotice(notice, 'xx')).toEqual({ text: notice.xx, lang: 'xx' });
		expect(pickNotice({ ...notice, xx: ' ' }, 'xx')).toEqual({ text: notice.en, lang: 'en' });
		// Neither the reader's nor English: the first written one in table order.
		expect(pickNotice({ xx: notice.xx }, 'af')).toEqual({ text: notice.xx, lang: 'xx' });
		expect(pickNotice({ xx: notice.xx, af: notice.af }, 'en')).toEqual({ text: notice.af, lang: 'af' });
	});
});
