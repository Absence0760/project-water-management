// The landing page's own address (issue #57), prerendered once per language
// (issue #137): `/welcome` in English and `/welcome/<code>` in each other
// language of the table (`entries`, the `locale` matcher). Its HTML is written
// at build time (welcome.html, welcome/af.html), in that language and with
// that `<html lang>` (hooks.server.ts), so crawlers, link previews and a
// visitor before any script runs all read the page in the address's language.
// Every other route stays a client-rendered SPA page (routes/+layout.ts).
// CloudFront serves each from its .html (infra/s3_cloudfront.tf, spa_rewrite).
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@water-management/engine/languages';
import { loadCatalogue } from '$lib/i18n/locale.svelte';
import type { EntryGenerator, PageLoad } from './$types';

export const ssr = true;
export const prerender = true;

/** Every language but the default (English is `/welcome` itself, which the crawl's `*` entry finds). */
export const entries: EntryGenerator = () => LOCALES.filter((l) => l !== DEFAULT_LOCALE).map((lang) => ({ lang }));

// No side effect here (a hover preloads this load): the page switches to the
// language as it renders, from what this returns.
export const load: PageLoad = async ({ params }) => {
	const locale: Locale = params.lang ?? DEFAULT_LOCALE;
	return { locale, catalogue: await loadCatalogue(locale) };
};
