// The app's route parameter matchers (SvelteKit 3: one src/params.ts, defineParams).
import { defineParams } from '@sveltejs/kit/params';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@water-management/engine/languages';

// The `locale` route parameter (issue #137): a language of the table
// (packages/engine/src/languages.ts) other than the default, English, whose
// address carries no code (`/welcome`, not `/welcome/en`). Anything else is
// no match, so `/welcome/xx` is the app's not-found page, never a landing
// page in English under a wrong address.
export function matchLocale(param: string): param is Locale {
	return param !== DEFAULT_LOCALE && isLocale(param);
}

export const params = defineParams({
	locale: (param) => (matchLocale(param) ? param : undefined)
});
