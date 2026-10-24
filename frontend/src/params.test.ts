// The `locale` route parameter (issue #137): only a language of the table
// other than English, whose landing page is /welcome itself.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES } from '@water-management/engine/languages';
import { matchLocale, params } from './params';

/** What the router gets from the matcher: the value, or no match. */
async function routed(param: string): Promise<string | undefined> {
	const r = await params.locale['~standard'].validate(param);
	return 'issues' in r && r.issues ? undefined : (r as { value: string }).value;
}

describe('the locale param matcher', () => {
	it('matches every language but the default', async () => {
		for (const l of LOCALES) {
			expect(matchLocale(l)).toBe(l !== DEFAULT_LOCALE);
			expect(await routed(l), l).toBe(l === DEFAULT_LOCALE ? undefined : l);
		}
		expect(await routed('af')).toBe('af');
	});

	it('refuses English, unknown codes and other spellings', async () => {
		for (const p of ['en', 'xx', 'AF', 'af-ZA', '', 'welcome']) {
			expect(matchLocale(p), p).toBe(false);
			expect(await routed(p), p).toBeUndefined();
		}
	});
});
