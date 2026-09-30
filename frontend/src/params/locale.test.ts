// The `locale` route parameter (issue #137): only a language of the table
// other than English, whose landing page is /welcome itself.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES } from '@water-management/engine/languages';
import { match } from './locale';

describe('the locale param matcher', () => {
	it('matches every language but the default', () => {
		for (const l of LOCALES) expect(match(l)).toBe(l !== DEFAULT_LOCALE);
		expect(match('af')).toBe(true);
	});

	it('refuses English, unknown codes and other spellings', () => {
		for (const p of ['en', 'xx', 'AF', 'af-ZA', '', 'welcome']) expect(match(p), p).toBe(false);
	});
});
