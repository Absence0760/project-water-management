// closeNav.ts: an open made while a closing sheet's URL drop is under way waits for it, and a
// link clicked in that gap is held and clicked again once the drop has landed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSettled, closing, followedLink, holdLinksWhileClosing, trackClose, type LinkClick } from './closeNav';

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

/** A stand-in anchor: what followedLink and the hold read of one. */
function anchor(href: string, attrs: { target?: string; download?: boolean; connected?: boolean } = {}) {
	const a = {
		origin: new URL(href, ORIGIN).origin,
		target: attrs.target ?? '',
		isConnected: attrs.connected ?? true,
		hasAttribute: (n: string) => n === 'download' && !!attrs.download,
		click: vi.fn(),
		closest: (sel: string) => (sel === 'a[href]' ? a : null)
	};
	return a;
}

function click(target: unknown, extra: Partial<LinkClick> = {}): LinkClick & { preventDefault: ReturnType<typeof vi.fn> } {
	return { target: target as EventTarget, defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn(), ...extra } as LinkClick & { preventDefault: ReturnType<typeof vi.fn> };
}

/** A document that records its capture-phase click listener. */
function fakeDoc() {
	let listener: ((e: Event) => void) | null = null;
	return {
		addEventListener: (type: string, fn: (e: Event) => void, capture?: boolean) => {
			if (type === 'click' && capture) listener = fn;
		},
		removeEventListener: () => {
			listener = null;
		},
		fire: (e: LinkClick) => listener?.(e as unknown as Event),
		get installed() {
			return listener !== null;
		}
	};
}

afterEach(async () => {
	await closeSettled();
});

describe('trackClose and closeSettled', () => {
	it('settles at once with no close under way', async () => {
		expect(closing()).toBe(false);
		await expect(closeSettled()).resolves.toBeUndefined();
	});

	it('waits for the close under way to land', async () => {
		const d = deferred();
		void trackClose(d.promise);
		expect(closing()).toBe(true);
		let settled = false;
		const waiting = closeSettled().then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);
		d.resolve();
		await waiting;
		expect(settled).toBe(true);
		expect(closing()).toBe(false);
	});

	it('waits for a failed close too, and leaves the failure to whoever holds it', async () => {
		const d = deferred();
		const nav = trackClose(d.promise);
		const held = nav.catch((e: unknown) => e);
		d.reject(new Error('navigation aborted'));
		await expect(closeSettled()).resolves.toBeUndefined();
		expect(await held).toEqual(new Error('navigation aborted'));
		expect(closing()).toBe(false);
	});

	it('waits for a close that starts while it waits', async () => {
		const first = deferred();
		const second = deferred();
		void trackClose(first.promise);
		let settled = false;
		const waiting = closeSettled().then(() => (settled = true));
		void trackClose(second.promise);
		first.resolve();
		await first.promise;
		await Promise.resolve();
		expect(settled).toBe(false);
		second.resolve();
		await waiting;
		expect(settled).toBe(true);
	});
});

describe('followedLink', () => {
	it('is the link of a plain click inside the app', () => {
		const a = anchor('/projects/p1?tab=crops&grid=crop-factors');
		expect(followedLink(click(a), ORIGIN)).toBe(a);
	});

	it('is null for a modified or non-primary click, a new tab, a download, another site, or no link', () => {
		const a = anchor('/projects/p1');
		expect(followedLink(click(a, { ctrlKey: true }), ORIGIN)).toBeNull();
		expect(followedLink(click(a, { metaKey: true }), ORIGIN)).toBeNull();
		expect(followedLink(click(a, { shiftKey: true }), ORIGIN)).toBeNull();
		expect(followedLink(click(a, { altKey: true }), ORIGIN)).toBeNull();
		expect(followedLink(click(a, { button: 1 }), ORIGIN)).toBeNull();
		expect(followedLink(click(a, { defaultPrevented: true }), ORIGIN)).toBeNull();
		expect(followedLink(click(anchor('/x', { target: '_blank' })), ORIGIN)).toBeNull();
		expect(followedLink(click(anchor('/x', { download: true })), ORIGIN)).toBeNull();
		expect(followedLink(click(anchor('https://elsewhere.test/x')), ORIGIN)).toBeNull();
		expect(followedLink(click({ closest: () => null }), ORIGIN)).toBeNull();
		expect(followedLink(click(null), ORIGIN)).toBeNull();
	});
});

describe('holdLinksWhileClosing', () => {
	it('lets a link through when no close is under way', () => {
		const doc = fakeDoc();
		const stop = holdLinksWhileClosing(doc, ORIGIN);
		const e = click(anchor('/projects/p1?grid=nodes'));
		doc.fire(e);
		expect(e.preventDefault).not.toHaveBeenCalled();
		stop();
		expect(doc.installed).toBe(false);
	});

	it('holds a link clicked while a close is under way, and clicks it again once it has landed', async () => {
		const doc = fakeDoc();
		const stop = holdLinksWhileClosing(doc, ORIGIN);
		const d = deferred();
		void trackClose(d.promise);
		const a = anchor('/projects/p1?grid=nodes');
		const e = click(a);
		doc.fire(e);
		expect(e.preventDefault).toHaveBeenCalled();
		expect(a.click).not.toHaveBeenCalled();
		d.resolve();
		await closeSettled();
		await Promise.resolve();
		expect(a.click).toHaveBeenCalledOnce();
		stop();
	});

	it('drops a held click whose link went with the re-render', async () => {
		const doc = fakeDoc();
		const stop = holdLinksWhileClosing(doc, ORIGIN);
		const d = deferred();
		void trackClose(d.promise);
		const a = anchor('/projects/p1?crop=c1', { connected: false });
		doc.fire(click(a));
		d.resolve();
		await closeSettled();
		await Promise.resolve();
		expect(a.click).not.toHaveBeenCalled();
		stop();
	});

	it('leaves a modified click alone even while a close is under way', () => {
		const doc = fakeDoc();
		const stop = holdLinksWhileClosing(doc, ORIGIN);
		const d = deferred();
		void trackClose(d.promise);
		const e = click(anchor('/projects/p1?grid=nodes'), { ctrlKey: true });
		doc.fire(e);
		expect(e.preventDefault).not.toHaveBeenCalled();
		d.resolve();
		stop();
	});
});
