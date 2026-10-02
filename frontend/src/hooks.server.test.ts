// <html lang> in the prerendered HTML (issue #137): the landing route's is
// the language its words came out in; every other page (the fallback
// index.html above all) keeps app.html's `en`, whatever the i18n state holds.
import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent, ResolveOptions } from '@sveltejs/kit';

const words = vi.hoisted(() => ({ lang: 'af' }));
vi.mock('$lib/i18n/locale.svelte', () => ({ wordsLang: () => words.lang }));
const { handle } = await import('./hooks.server');

const HTML = '<!doctype html>\n<html lang="en">\n\t<head></head><body></body></html>';

async function htmlFor(routeId: string | null): Promise<string> {
	let out = HTML;
	await handle({
		event: { route: { id: routeId } } as RequestEvent,
		resolve: async (_event: RequestEvent, opts?: ResolveOptions) => {
			out = (await opts?.transformPageChunk?.({ html: HTML, done: true })) ?? HTML;
			return new Response(out);
		}
	});
	return out;
}

describe('html lang', () => {
	it("is the landing page's words' language", async () => {
		words.lang = 'af';
		expect(await htmlFor('/welcome/[[lang=locale]]')).toContain('<html lang="af">');
		words.lang = 'en';
		expect(await htmlFor('/welcome/[[lang=locale]]')).toContain('<html lang="en">');
	});

	it('stays en everywhere else, the fallback page included', async () => {
		words.lang = 'af';
		for (const id of [null, '/privacy', '/terms', '/methods', '/data-sources', '/login']) expect(await htmlFor(id), String(id)).toContain('<html lang="en">');
	});
});
