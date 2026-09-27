// The app's Afrikaans, read from its catalogues (WP-2.5), so a spec checks the
// page against the wording that ships rather than a copy of it: a later
// correction to a translation doesn't break the specs.
//
//   const af = await afWords();
//   af('Sign in')                    → the site's Afrikaans for that message
//   af('Create account', 'page title')
//   const mail = await afMail();
//   mail('mail.alert.subject')       → an email string, by its key
//
// Both throw on a message with no Afrikaans, so a spec never passes by
// looking for English.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// By URL, so the e2e typecheck doesn't pull the frontend's and backend's modules into its program.
const url = (rel: string) => pathToFileURL(path.join(ROOT, rel)).href;

type Catalogue = Record<string, string | Record<string, string>>;

export async function afWords(): Promise<(english: string, context?: string) => string> {
	const [{ af }, { messageId }] = (await Promise.all([import(url('frontend/src/lib/i18n/messages/af.ts')), import(url('frontend/src/lib/i18n/msg.ts'))])) as [
		{ af: Catalogue },
		{ messageId: (english: string, context?: string) => string }
	];
	return (english, context) => {
		const words = af[messageId(english, context)];
		if (typeof words !== 'string') throw new Error(`no Afrikaans for "${english}"${context ? ` (${context})` : ''}`);
		return words;
	};
}

export async function afMail(): Promise<(key: string) => string> {
	const { af } = (await import(url('backend/src/mail/i18n/af.ts'))) as { af: Record<string, string> };
	return (key) => {
		const words = af[key];
		if (typeof words !== 'string') throw new Error(`no Afrikaans for ${key}`);
		return words;
	};
}
