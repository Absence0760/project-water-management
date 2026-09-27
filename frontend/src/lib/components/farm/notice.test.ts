// Which of the WUA's notices a reader gets (design §7; the rule itself is the
// engine's pickNotice, tested there), and how the "wrote this notice in …
// only" line names the language.
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '$lib/i18n/locale.svelte';
import { MESSAGE_IDS } from '$lib/i18n/messages/ids.generated';
import { languageName, pickNotice } from './notice';

describe('pickNotice', () => {
	it('is the engine’s: the reader’s language, else English, else another', () => {
		const both = { en: 'Irrigate at night', af: '[af] Irrigate at night' };
		expect(pickNotice(both, 'af')).toEqual({ text: both.af, lang: 'af' });
		expect(pickNotice({ en: both.en }, 'af')).toEqual({ text: both.en, lang: 'en' });
		expect(pickNotice({ af: both.af }, 'en')).toEqual({ text: both.af, lang: 'af' });
		expect(pickNotice({}, 'en')).toBeNull();
	});
});

describe('languageName', () => {
	afterEach(() => setLocale('en'));

	it('names the language in the language the page’s words are in', async () => {
		expect(languageName('en')).toBe('English');
		expect(languageName('af')).toBe('Afrikaans');
		// Afrikaans chosen, but its words not all translated: the page (and this line) is still English.
		await setLocale('af', {});
		expect(languageName('en')).toBe('English');
		// A complete catalogue: the words are Afrikaans, and so is the name.
		await setLocale('af', Object.fromEntries(MESSAGE_IDS.map((id) => [id, '…'])));
		expect(languageName('en')).toBe('Engels');
	});
});
