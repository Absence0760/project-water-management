// A stand-in Afrikaans catalogue for layout tests (WP-2.5, issue #49): every
// message on the translation sheet, in its English with each word stretched
// by about a third, since Afrikaans runs 20–30 % longer than English and
// builds long compound words. It is served in place of the site's empty af
// catalogue chunk, so a test sees every translated page as it would look
// with a complete, long catalogue (and <html lang="af">), without any
// Afrikaans being written: the real wording waits for the client's
// translator (docs/i18n/af-translation-sheet.md).
//
// Only an empty catalogue is replaced. Once reviewed wording lands in
// frontend/src/lib/i18n/messages/af.ts the chunk isn't empty any more and
// is served as built: until it is complete the page stays lang="en", the
// layout spec's first assertion fails, and the spec should switch to the
// real words (the 360 px check the issue asks for on the reviewed batch).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';

type Forms = Partial<Record<string, string>>;
interface Extracted {
	id: string;
	kind: 'text' | 'plural';
	english?: string;
	forms?: Forms;
}
interface Extractor {
	extract: () => { messages: Map<string, Extracted>; problems: string[] };
}

const EXTRACTOR = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/guards/i18n_extract.mjs')).href;

/** How much longer each word gets. */
export const STRETCH = 0.35;

/**
 * Each word of three letters or more grows by STRETCH, its own letters
 * repeated ("water" → "waterwa"). `{placeholders}` and the `**` bold marks
 * are left as they are, so the app still fills and bolds them.
 */
export function stretch(text: string): string {
	return text
		.split(/(\{\w+\})/)
		.map((part, i) => (i % 2 ? part : part.replace(/\p{L}{3,}/gu, (w) => w + w.slice(0, Math.ceil(w.length * STRETCH)).toLowerCase())))
		.join('');
}

let built: Record<string, string | Forms> | undefined;
export async function stretchedCatalogue(): Promise<Record<string, string | Forms>> {
	if (built) return built;
	const { extract } = (await import(EXTRACTOR)) as Extractor;
	const { messages, problems } = extract();
	if (problems.length) throw new Error(`i18n extractor: ${problems.join('; ')}`);
	built = Object.fromEntries(
		[...messages.values()].map((m) => [m.id, m.kind === 'plural' ? Object.fromEntries(Object.entries(m.forms!).map(([c, f]) => [c, stretch(f!)])) : stretch(m.english!)])
	);
	return built;
}

/** The built af catalogue chunk while af.ts is still empty: `const o={};export{o as af};`. */
const EMPTY_AF = /^\s*const (\w+)=\{\};\s*export\s*\{\s*\1 as af\s*\};?\s*$/;

/** Serve the stretched catalogue in place of the site's af chunk, for this page. */
export async function withStretchedAfrikaans(page: Page): Promise<void> {
	const catalogue = await stretchedCatalogue();
	const body = `const c=${JSON.stringify(catalogue)};export{c as af};`;
	await page.route('**/_app/immutable/chunks/*.js', async (route) => {
		const response = await route.fetch();
		const source = await response.text();
		// Any other chunk, or a catalogue with real wording in it: served as built.
		if (!EMPTY_AF.test(source)) return route.fulfill({ response, body: source });
		return route.fulfill({ response, body });
	});
}
