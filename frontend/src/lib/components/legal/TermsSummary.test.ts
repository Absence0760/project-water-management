// The terms summary (termsSummary.ts): the four main points of the Terms, shown
// in English at the top of /terms and in the reader's language above the
// sign-up button and on the re-acceptance notice.
import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, t } from '$lib/i18n/locale.svelte';
import { af } from '$lib/i18n/messages/af';
import TermsSummary from './TermsSummary.svelte';
import { SUMMARY_LANGUAGE_NOTE, SUMMARY_POINTS, SUMMARY_TITLE } from './termsSummary';

// Comments stripped until none are left, so one split by another can't survive
// as a fresh '<!--' (CodeQL js/incomplete-multi-character-sanitization).
const text = (html: string) => {
	let s = html;
	for (let prev = ''; prev !== s; ) {
		prev = s;
		s = s.replace(/<!--[\s\S]*?-->/g, '');
	}
	return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
};

describe('the terms summary', () => {
	afterEach(() => setLocale('en'));

	it('is four points, each naming the section of the Terms it summarises (bar the first)', () => {
		expect(SUMMARY_POINTS).toHaveLength(4);
		expect(SUMMARY_POINTS.slice(1).map((p) => /\(Terms §(\d+)\)\.$/.exec(p)?.[1])).toEqual(['13', '14', '15']);
		// The law point says who gets South African law, and keeps local rights for everyone.
		expect(SUMMARY_POINTS[3]).toMatch(/^If you live or are based in South Africa, South African law and South African courts apply/);
	});

	it('shows in English without the language note', () => {
		const body = text(render(TermsSummary).body);
		expect(body).toContain(SUMMARY_TITLE);
		for (const p of SUMMARY_POINTS) expect(body).toContain(p);
		expect(body).not.toContain(SUMMARY_LANGUAGE_NOTE);
	});

	it('shows in the reader’s language, saying the Terms themselves are English', async () => {
		await setLocale('af', af);
		const body = text(render(TermsSummary).body);
		expect(body).toContain(t(SUMMARY_TITLE));
		expect(t(SUMMARY_TITLE)).not.toBe(SUMMARY_TITLE);
		for (const p of SUMMARY_POINTS) expect(body).toContain(t(p));
		expect(body).toContain(t(SUMMARY_LANGUAGE_NOTE));
	});

	it('contained (the sign-up form): the points in their own scroll box, with the full terms linked beside the heading', () => {
		const html = render(TermsSummary, { props: { contained: true } }).body;
		const body = text(html);
		expect(body).toContain(SUMMARY_TITLE);
		for (const p of SUMMARY_POINTS) expect(body).toContain(p);
		expect(html).toMatch(/<a class="full[^"]*" href="[^"]*\/terms">Read the full terms<\/a>/);
		// The app's scroll-region watcher makes it a focusable, named group while it overflows.
		expect(html).toMatch(/<div class="scroll[^"]*" data-scroll-region/);
		expect(html.indexOf('Read the full terms')).toBeLessThan(html.indexOf('data-scroll-region'));
		// Not contained (the re-acceptance notice): the plain box, no link.
		expect(render(TermsSummary).body).not.toContain('data-scroll-region');
	});

	it('is the short version at the top of /terms, in English', () => {
		const terms = readFileSync(new URL('../../../routes/terms/+page.svelte', import.meta.url), 'utf8');
		expect(terms).toContain("import { SUMMARY_POINTS } from '$lib/components/legal/termsSummary';");
		expect(terms.indexOf('id="short"')).toBeLessThan(terms.indexOf('id="agreement"'));
		expect(terms).toMatch(/\{#each SUMMARY_POINTS as point \(point\)\}<li>\{point\}<\/li>\{\/each\}/);
	});
});
