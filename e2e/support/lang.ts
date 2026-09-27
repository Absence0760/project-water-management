// A language's words, read from its catalogues (WP-2.5, issue #58), so a
// spec checks the page against the wording that ships rather than a copy of
// it: a later correction to a translation doesn't break the specs.
//
//   const af = await words('af');
//   af('Sign in')                    → the site's words in that language for that message
//   af('Create account', 'page title')
//   const mailAf = await mail('af');
//   mailAf('mail.alert.subject')     → an email string, by its key
//
// Both throw on a message with no words in that language, so a spec never
// passes by looking for English.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// By URL, so the e2e typecheck doesn't pull the frontend's and backend's modules into its program.
const url = (rel: string) => pathToFileURL(path.join(ROOT, rel)).href;

type Catalogue = Record<string, string | Record<string, string>>;

/** `lang`'s site words, by English (frontend/src/lib/i18n/messages/<lang>.ts, export `const <lang>`). */
export async function words(lang: string): Promise<(english: string, context?: string) => string> {
	const [catalogueModule, { messageId }] = (await Promise.all([import(url(`frontend/src/lib/i18n/messages/${lang}.ts`)), import(url('frontend/src/lib/i18n/msg.ts'))])) as [
		Record<string, Catalogue>,
		{ messageId: (english: string, context?: string) => string }
	];
	const catalogue = catalogueModule[lang] ?? {};
	return (english, context) => {
		const w = catalogue[messageId(english, context)];
		if (typeof w !== 'string') throw new Error(`no ${lang} words for "${english}"${context ? ` (${context})` : ''}`);
		return w;
	};
}

/** `lang`'s email words, by key (backend/src/mail/i18n/<lang>.ts, export `const <lang>`). */
export async function mail(lang: string): Promise<(key: string) => string> {
	const catalogueModule = (await import(url(`backend/src/mail/i18n/${lang}.ts`))) as Record<string, Record<string, string>>;
	const catalogue = catalogueModule[lang] ?? {};
	return (key) => {
		const w = catalogue[key];
		if (typeof w !== 'string') throw new Error(`no ${lang} words for ${key}`);
		return w;
	};
}

/** Every language the app supports (packages/engine/src/languages.ts LANGUAGES), English first. */
export async function languages(): Promise<readonly { code: string; name: string }[]> {
	const { LANGUAGES } = (await import(url('packages/engine/src/languages.ts'))) as { LANGUAGES: readonly { code: string; name: string }[] };
	return LANGUAGES;
}
