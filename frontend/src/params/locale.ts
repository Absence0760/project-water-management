// The `locale` route parameter (issue #137): a language of the table
// (packages/engine/src/languages.ts) other than the default, English, whose
// address carries no code (`/welcome`, not `/welcome/en`). Anything else is
// no match, so `/welcome/xx` is the app's not-found page, never a landing
// page in English under a wrong address.
import { DEFAULT_LOCALE, isLocale, type Locale } from '@water-management/engine/languages';

export function match(param: string): param is Locale {
	return param !== DEFAULT_LOCALE && isLocale(param);
}
