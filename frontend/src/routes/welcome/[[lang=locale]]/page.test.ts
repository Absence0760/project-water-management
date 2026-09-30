// The landing page once per language (issue #137): the route's entries and
// load, and the page rendered as the prerender renders it (Svelte's server
// renderer), in English at /welcome and in Afrikaans at /welcome/af: the
// words, the canonical and hreflang links, the Open Graph locale and the
// language switch as links between the two addresses. The built HTML and its
// <html lang> are e2e/tests/landing-language.spec.ts's.
import { render } from 'svelte/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCALE, LOCALES } from '@water-management/engine/languages';
import { messageId } from '$lib/i18n/msg';
import { af } from '$lib/i18n/messages/af';
import { i18n, setLocale } from '$lib/i18n/locale.svelte';
import { entries, load, prerender, ssr } from './+page';
import Page from './+page.svelte';

const url = vi.hoisted(() => ({ href: 'https://example.org/welcome' }));
vi.mock('$app/paths', () => ({ base: '' }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/state', () => ({
	page: {
		get url() {
			return new URL(url.href);
		}
	}
}));
vi.mock('$lib/api', () => ({ api: {} }));

const HEADLINE = 'Every drop in the catchment, accounted for.';
type LoadEvent = Parameters<typeof load>[0];
const loadFor = async (lang?: string) => (await load({ params: { lang } } as unknown as LoadEvent)) as { locale: 'en' | 'af'; catalogue: Record<string, unknown> };

afterEach(() => setLocale('en'));

describe('the landing route', () => {
	it('is prerendered, and for every language but English (whose page is /welcome)', () => {
		expect(ssr).toBe(true);
		expect(prerender).toBe(true);
		expect(entries()).toEqual(LOCALES.filter((l) => l !== DEFAULT_LOCALE).map((lang) => ({ lang })));
		expect(entries()).toContainEqual({ lang: 'af' });
	});

	it("loads the address's language and its catalogue, without switching to it (a hover preloads it)", async () => {
		const en = await loadFor(undefined);
		expect(en).toEqual({ locale: 'en', catalogue: {} });
		const afData = await loadFor('af');
		expect(afData.locale).toBe('af');
		expect(afData.catalogue).toBe(af);
		expect(i18n.locale).toBe('en');
	});
});

describe('the landing page as prerendered', () => {
	it('/welcome is English, points at both addresses and marks English current', async () => {
		url.href = 'https://example.org/welcome';
		const { head, body } = render(Page, { props: { data: await loadFor(undefined) } as never });
		expect(body).toContain(HEADLINE);
		expect(head).toContain('<link rel="canonical" href="https://example.org/welcome"');
		expect(head).toContain('<link rel="alternate" hreflang="en" href="https://example.org/welcome"');
		expect(head).toContain('<link rel="alternate" hreflang="af" href="https://example.org/welcome/af"');
		expect(head).toContain('<link rel="alternate" hreflang="x-default" href="https://example.org/welcome"');
		expect(head).toContain('<meta property="og:locale" content="en_ZA"');
		expect(head).toContain('<meta property="og:locale:alternate" content="af_ZA"');
		expect(body).toMatch(/<a href="\/welcome" hreflang="en" lang="en" aria-current="true"/);
		expect(body).toMatch(/<a href="\/welcome\/af" hreflang="af" lang="af"(?! aria-current)/);
		expect(body).not.toMatch(/<button[^>]*lang="af"/);
	});

	it('/welcome/af is Afrikaans from the catalogue, canonical to itself, with Afrikaans current', async () => {
		url.href = 'https://example.org/welcome/af';
		const { head, body } = render(Page, { props: { data: await loadFor('af') } as never });
		expect(body).toContain(af[messageId(HEADLINE)]);
		expect(body).not.toContain(HEADLINE);
		expect(head).toContain(`<title>${af[messageId('Water Management: daily water balance for a catchment')]}</title>`);
		expect(head).toContain('<link rel="canonical" href="https://example.org/welcome/af"');
		expect(head).toContain('<link rel="alternate" hreflang="x-default" href="https://example.org/welcome"');
		expect(head).toContain('<meta property="og:url" content="https://example.org/welcome/af"');
		expect(head).toContain('<meta property="og:locale" content="af_ZA"');
		expect(body).toMatch(/<a href="\/welcome\/af" hreflang="af" lang="af" aria-current="true"/);
		expect(body).toMatch(/<a href="\/welcome" hreflang="en" lang="en"(?! aria-current)/);
	});
});
