// printedPage.svelte.ts: while the page is open its @page rule is in <head>, gaining the footer
// with "Page X of Y" once the footer is known; a print forces the light theme and puts the
// previous one back; inactive, it adds nothing; closed, it takes all of it away.
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { printedPage } from './printedPage.svelte';
import { reportPageRule } from './printPage';

afterEach(() => vi.unstubAllGlobals());

function fakeDom() {
	const head: { textContent: string; removed: boolean }[] = [];
	const listeners = new Map<string, Set<() => void>>();
	const attrs = new Map<string, string>();
	vi.stubGlobal('document', {
		createElement: () => {
			const el = {
				textContent: '',
				removed: false,
				remove() {
					el.removed = true;
					head.splice(head.indexOf(el), 1);
				}
			};
			return el;
		},
		head: { append: (el: (typeof head)[number]) => head.push(el) },
		documentElement: {
			getAttribute: (k: string) => attrs.get(k) ?? null,
			setAttribute: (k: string, v: string) => void attrs.set(k, v),
			removeAttribute: (k: string) => void attrs.delete(k)
		}
	});
	vi.stubGlobal('addEventListener', (t: string, fn: () => void) => {
		if (!listeners.has(t)) listeners.set(t, new Set());
		listeners.get(t)!.add(fn);
	});
	vi.stubGlobal('removeEventListener', (t: string, fn: () => void) => void listeners.get(t)?.delete(fn));
	const fire = (t: string) => listeners.get(t)?.forEach((fn) => fn());
	return { head, listeners, attrs, fire };
}

describe('printedPage', () => {
	it('adds the A4 rule, then the footer with page numbers once it is known, and removes it all when closed', () => {
		const dom = fakeDom();
		let footer = $state<string | undefined>(undefined);
		const stop = $effect.root(() => printedPage(() => footer));
		flushSync();
		expect(dom.head.map((s) => s.textContent)).toEqual([reportPageRule(undefined)]);
		const known = 'Draft · not issued · Dam · Run 1 · Model estimates.';
		footer = known;
		flushSync();
		expect(dom.head).toHaveLength(1);
		expect(dom.head[0]!.textContent).toBe(reportPageRule(known));
		expect(dom.head[0]!.textContent).toContain('counter(page) " of " counter(pages)');

		// A print is light, and the theme comes back after it.
		dom.attrs.set('data-theme', 'dark');
		dom.fire('beforeprint');
		expect(dom.attrs.get('data-theme')).toBe('light');
		dom.fire('afterprint');
		expect(dom.attrs.get('data-theme')).toBe('dark');

		stop();
		expect(dom.head).toHaveLength(0);
		expect(dom.listeners.get('beforeprint')?.size ?? 0).toBe(0);
		expect(dom.listeners.get('afterprint')?.size ?? 0).toBe(0);
	});

	it('adds nothing while inactive (another component owns the print), and its rule once active', () => {
		const dom = fakeDom();
		let active = $state(false);
		const stop = $effect.root(() =>
			printedPage(
				() => 'Dam · Run 1.',
				() => active
			)
		);
		flushSync();
		expect(dom.head).toHaveLength(0);
		expect(dom.listeners.get('beforeprint')?.size ?? 0).toBe(0);
		active = true;
		flushSync();
		expect(dom.head.map((s) => s.textContent)).toEqual([reportPageRule('Dam · Run 1.')]);
		active = false;
		flushSync();
		expect(dom.head).toHaveLength(0);
		stop();
	});
});
