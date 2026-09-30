// Server hooks run only at build time here: the app is static (adapter-static),
// so the one server render is the prerender of the static pages and the
// fallback index.html (docs/architecture.md § The landing page).
//
// `<html lang>` (issue #137): app.html says `en`, right for every page but the
// landing page in another language (/welcome/af), whose prerendered words are
// that language's. There it is the language the words came out in (wordsLang:
// the page set it while rendering, before this transform sees the HTML; it
// stays `en` if that language's catalogue is incomplete). Only that route:
// the i18n state is module-wide, and another page (the fallback above all)
// must not pick up the last landing page's language.
import type { Handle } from '@sveltejs/kit';
import { LANDING_ROUTE } from '$lib/auth/session.svelte';
import { wordsLang } from '$lib/i18n/locale.svelte';

export const handle: Handle = ({ event, resolve }) => {
	if (event.route.id !== LANDING_ROUTE) return resolve(event);
	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace('<html lang="en">', `<html lang="${wordsLang()}">`)
	});
};
