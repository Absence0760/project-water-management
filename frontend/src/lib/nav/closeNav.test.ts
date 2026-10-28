// closeNav.ts: an open made while a closing sheet's URL drop is under way waits for it; the
// wait ends on the drop settling, on any completed navigation, or at the fail-safe; an opener
// link's own handler runs once and its plain click waits, then goes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	afterNavigate: null as null | (() => void),
	goto: vi.fn(async () => {}),
	onTick: null as null | (() => void),
	attr: false
}));
vi.mock('$app/navigation', () => ({
	afterNavigate: (fn: () => void) => {
		h.afterNavigate = fn;
	},
	goto: h.goto
}));
vi.mock('svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('svelte')>()),
	tick: async () => {
		const fn = h.onTick;
		h.onTick = null;
		fn?.();
	}
}));

import { closeSettled, closing, FAILSAFE_MS, followsInApp, installCloseNav, navigated, openAfterClose, trackClose } from './closeNav';

const ORIGIN = 'https://app.test';

function deferred() {
	let resolve!: () => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A click on a stand-in link, as openAfterClose's handler receives it. */
function linkClick(href: string, extra: Partial<MouseEvent> = {}, link: { target?: string; download?: boolean; noscroll?: boolean } = {}) {
	const a = {
		href: new URL(href, ORIGIN).href,
		target: link.target ?? '',
		hasAttribute: (n: string) => n === 'download' && !!link.download,
		closest: (sel: string) => (sel === '[data-sveltekit-noscroll]' && link.noscroll ? a : null)
	};
	const e = { currentTarget: a, defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn(), ...extra };
	return e as unknown as MouseEvent & { currentTarget: HTMLAnchorElement; preventDefault: ReturnType<typeof vi.fn> };
}

/** Lets every queued promise callback run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
	h.attr = false;
	h.goto.mockClear();
	h.onTick = null;
	vi.stubGlobal('document', { documentElement: { toggleAttribute: (_: string, on: boolean) => (h.attr = on) } });
	vi.stubGlobal('location', { origin: ORIGIN });
});
afterEach(async () => {
	navigated();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('trackClose and closeSettled', () => {
	it('settles at once with no close under way', async () => {
		expect(closing()).toBe(false);
		await expect(closeSettled()).resolves.toBeUndefined();
	});

	it('marks <html data-closing> and waits until the close lands', async () => {
		const d = deferred();
		void trackClose(d.promise);
		expect(closing()).toBe(true);
		expect(h.attr).toBe(true);
		let settled = false;
		const waiting = closeSettled().then(() => (settled = true));
		await flush();
		expect(settled).toBe(false);
		d.resolve();
		await waiting;
		expect(settled).toBe(true);
		expect(closing()).toBe(false);
		expect(h.attr).toBe(false);
	});

	it('ends on a failed close too, and leaves the failure to whoever holds it', async () => {
		const d = deferred();
		const held = trackClose(d.promise).catch((e: unknown) => e);
		d.reject(new Error('navigation aborted'));
		await expect(closeSettled()).resolves.toBeUndefined();
		expect(await held).toEqual(new Error('navigation aborted'));
		expect(h.attr).toBe(false);
	});

	it('ends when a navigation completes (afterNavigate), even if the close never settles', async () => {
		installCloseNav();
		void trackClose(new Promise<void>(() => {}));
		const waiting = closeSettled();
		h.afterNavigate!();
		await waiting;
		expect(closing()).toBe(false);
		expect(h.attr).toBe(false);
	});

	it('ends at the fail-safe when the close never settles and no navigation completes', async () => {
		vi.useFakeTimers();
		void trackClose(new Promise<void>(() => {}));
		let settled = false;
		const waiting = closeSettled().then(() => (settled = true));
		await vi.advanceTimersByTimeAsync(FAILSAFE_MS - 1);
		expect(settled).toBe(false);
		expect(h.attr).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		await waiting;
		expect(settled).toBe(true);
		expect(h.attr).toBe(false);
	});

	it('waits for a close that starts while it waits', async () => {
		const first = deferred();
		const second = deferred();
		void trackClose(first.promise);
		let settled = false;
		const waiting = closeSettled().then(() => (settled = true));
		void trackClose(second.promise);
		first.resolve();
		await flush();
		expect(settled).toBe(false);
		second.resolve();
		await waiting;
		expect(settled).toBe(true);
	});

	it('waits for a close that starts during the re-render it waits for', async () => {
		const first = deferred();
		const second = deferred();
		void trackClose(first.promise);
		h.onTick = () => void trackClose(second.promise);
		let settled = false;
		const waiting = closeSettled().then(() => (settled = true));
		first.resolve();
		await flush();
		expect(closing()).toBe(true);
		expect(settled).toBe(false);
		second.resolve();
		await waiting;
		expect(settled).toBe(true);
	});
});

describe('followsInApp', () => {
	const a = (href: string, target = '', download = false) => ({ href: new URL(href, ORIGIN).href, target, hasAttribute: (n: string) => n === 'download' && download });
	const click = (extra: Partial<MouseEvent> = {}) => ({ defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });
	it('is a plain primary click on a link inside the app', () => {
		expect(followsInApp(click(), a('/projects/p1?grid=nodes'), ORIGIN)).toBe(true);
		expect(followsInApp(click(), a('/x', '_self'), ORIGIN)).toBe(true);
	});
	it('is not a modified, non-primary or prevented click, a new tab, a download or another site', () => {
		for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) expect(followsInApp(click(extra), a('/x'), ORIGIN)).toBe(false);
		expect(followsInApp(click(), a('/x', '_blank'), ORIGIN)).toBe(false);
		expect(followsInApp(click(), a('/x', '', true), ORIGIN)).toBe(false);
		expect(followsInApp(click(), a('https://elsewhere.test/x'), ORIGIN)).toBe(false);
	});
});

describe('openAfterClose', () => {
	it('leaves the click to SvelteKit when nothing is closing, and runs the link’s own handler once', () => {
		const own = vi.fn();
		const e = linkClick('/projects/p1?grid=nodes');
		openAfterClose(own)(e);
		expect(own).toHaveBeenCalledOnce();
		expect(e.preventDefault).not.toHaveBeenCalled();
		expect(h.goto).not.toHaveBeenCalled();
	});

	it('holds a plain click while a close is under way, then goes once, running the link’s own handler once', async () => {
		const own = vi.fn();
		const d = deferred();
		void trackClose(d.promise);
		const e = linkClick('/projects/p1?grid=nodes', {}, { noscroll: true });
		openAfterClose(own)(e);
		expect(own).toHaveBeenCalledOnce();
		expect(e.preventDefault).toHaveBeenCalledOnce();
		expect(h.goto).not.toHaveBeenCalled();
		d.resolve();
		await flush();
		expect(h.goto).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}/projects/p1?grid=nodes`, { reset: false });
		expect(own).toHaveBeenCalledOnce();
	});

	it('goes once after a close that starts during the re-render', async () => {
		const first = deferred();
		const second = deferred();
		void trackClose(first.promise);
		h.onTick = () => void trackClose(second.promise);
		openAfterClose()(linkClick('/projects/p1?settings=1'));
		first.resolve();
		await flush();
		expect(h.goto).not.toHaveBeenCalled();
		second.resolve();
		await flush();
		expect(h.goto).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}/projects/p1?settings=1`, { reset: true });
	});

	it('goes once after the fail-safe when the close never settles', async () => {
		vi.useFakeTimers();
		void trackClose(new Promise<void>(() => {}));
		openAfterClose()(linkClick('/projects/p1?grid=nodes'));
		await vi.advanceTimersByTimeAsync(FAILSAFE_MS);
		expect(h.goto).toHaveBeenCalledOnce();
		expect(h.attr).toBe(false);
	});

	it('leaves a modified click alone even while a close is under way', () => {
		void trackClose(deferred().promise);
		const e = linkClick('/projects/p1?grid=nodes', { ctrlKey: true });
		openAfterClose()(e);
		expect(e.preventDefault).not.toHaveBeenCalled();
		expect(h.goto).not.toHaveBeenCalled();
	});
});
