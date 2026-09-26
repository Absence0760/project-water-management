// The active language without the catalogue (WP-2.5; docs/ui.md § Language).
// Number and date formatting read the choice from here, so a module that only
// formats (the /share page's) never pulls in messages/en.ts. The catalogue
// and the message functions live in ./locale.svelte.ts, which re-exports all
// of this.

export const LOCALES = ['en', 'af'] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language's name in that language (fixed names, never translated). */
export const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', af: 'Afrikaans' };

/** `locale`: the choice. `complete`: its catalogue has every key (always true for English). */
export const i18n = $state<{ locale: Locale; complete: boolean }>({ locale: 'en', complete: true });

export const isLocale = (v: unknown): v is Locale => (LOCALES as readonly unknown[]).includes(v);

/** The language the words on the page are in: the chosen one once its catalogue is complete, else English. */
export function wordsLang(): Locale {
	return i18n.locale !== 'en' && i18n.complete ? i18n.locale : 'en';
}

// ---- Which language to start in -------------------------------------------

const STORAGE_KEY = 'wm.locale';

/** The language chosen on this device before signing in (null when none or storage is blocked). */
export function readStoredLocale(s: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): Locale | null {
	try {
		const v = s?.getItem(STORAGE_KEY);
		return isLocale(v) ? v : null;
	} catch {
		return null;
	}
}

export function storeLocale(locale: Locale, s: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): void {
	try {
		s?.setItem(STORAGE_KEY, locale);
	} catch {
		// Not kept: the choice still applies for this visit (and to the account, when signed in).
	}
}

/**
 * The account's language (app_user.locale) when signed in and chosen, else
 * this device's choice, else Afrikaans when it is the browser's first
 * language, else English.
 */
export function resolveLocale(
	accountLocale: string | null | undefined,
	stored: Locale | null,
	languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]
): Locale {
	if (isLocale(accountLocale)) return accountLocale;
	if (stored) return stored;
	return /^af\b/i.test(languages[0] ?? '') ? 'af' : 'en';
}
