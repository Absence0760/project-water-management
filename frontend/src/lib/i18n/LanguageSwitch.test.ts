// The language switch's markup with the shipped table (two languages: a
// button pair), rendered with Svelte's server renderer. The three-or-more
// shape (a <select>) is pinned in testLanguage.test.ts with a stand-in
// language; the browser behaviour by e2e/tests/language.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { LANGUAGES } from '@water-management/engine/languages';
import LanguageSwitch from './LanguageSwitch.svelte';

vi.mock('$lib/api', () => ({ api: {} }));
vi.mock('$lib/auth/session.svelte', () => ({ session: { user: null } }));

describe('LanguageSwitch with two languages', () => {
	it('is a button per language, named in its own language and marked with its lang', () => {
		const { body } = render(LanguageSwitch);
		expect(body).not.toContain('<select');
		const buttons = [...body.matchAll(/<button[^>]*lang="(\w+)"[^>]*>\s*([^<]*?)\s*<\/button>/g)].map((m) => [m[1], m[2]]);
		expect(buttons).toEqual(LANGUAGES.map((l) => [l.code, l.name]));
		expect(body).toMatch(/<button[^>]*lang="en"[^>]*aria-pressed="true"/);
	});

	it('shows codes when compact, keeping the names as the accessible names', () => {
		const { body } = render(LanguageSwitch, { props: { compact: true } });
		for (const l of LANGUAGES) expect(body).toMatch(new RegExp(`<button[^>]*lang="${l.code}"[^>]*aria-label="${l.name}"[^>]*>\\s*${l.code.toUpperCase()}\\s*</button>`));
	});

	it('with addressOf, is a link per language to its own address, the current one marked, not preloaded (issue #137)', () => {
		const { body } = render(LanguageSwitch, { props: { compact: true, addressOf: (l: string) => `/welcome/${l}` } });
		expect(body).not.toContain('<button');
		expect(body).toMatch(/role="group"[^>]*data-sveltekit-preload-data="off"/);
		const links = [...body.matchAll(/<a href="([^"]+)" hreflang="(\w+)" lang="(\w+)"[^>]*aria-label="([^"]+)"[^>]*>\s*([^<]*?)\s*<\/a>/g)].map((m) => m.slice(1));
		expect(links).toEqual(LANGUAGES.map((l) => [`/welcome/${l.code}`, l.code, l.code, l.name, l.code.toUpperCase()]));
		expect(body).toMatch(/<a href="\/welcome\/en"[^>]*aria-current="true"/);
		expect(body).not.toMatch(/<a href="\/welcome\/af"[^>]*aria-current/);
	});
});
