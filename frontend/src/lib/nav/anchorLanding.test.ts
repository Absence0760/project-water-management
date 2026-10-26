import { describe, expect, it, vi } from 'vitest';
import { followAnchors, queryHashLink, type LandingEnv, type LinkClick } from './anchorLanding';

// The browser listener reads SvelteKit's page; these tests pass their own URLs.
vi.mock('$app/state', () => ({ page: { url: new URL('https://example.org/') } }));

/** A fake browser: `go` changes the URL and fires the hash change, as typing a #fragment does. */
function fakeEnv(path: string) {
	let url = new URL(path, 'https://example.org');
	let onHash: ((traversal: boolean) => void) | null = null;
	const env: LandingEnv = {
		url: () => url,
		listen(fn) {
			onHash = fn;
			return () => (onHash = null);
		}
	};
	return {
		env,
		go(hash: string, traversal = false) {
			url = new URL(hash, url);
			onHash?.(traversal);
		},
		listening: () => onHash !== null
	};
}

function spies() {
	const stops: ReturnType<typeof vi.fn>[] = [];
	const land = vi.fn((id: string) => {
		const stop = vi.fn();
		stops.push(stop);
		void id;
		return stop;
	});
	return { land, stops, forward: vi.fn() };
}

describe('followAnchors', () => {
	it('lands on load, then again on each hash change, ending the landing before (finding R2-D)', () => {
		const b = fakeEnv('/projects/p1?tab=settings#set-ewr');
		const s = spies();
		const stop = followAnchors({ page: 'settings', land: s.land, forward: s.forward, env: b.env });
		expect(s.land.mock.calls).toEqual([['set-ewr']]);
		b.go('#set-period');
		expect(s.land.mock.calls).toEqual([['set-ewr'], ['set-period']]);
		expect(s.stops[0]).toHaveBeenCalled();
		stop();
		expect(s.stops[1]).toHaveBeenCalled();
		expect(b.listening()).toBe(false);
		expect(s.forward).not.toHaveBeenCalled();
	});

	it('forwards a moved anchor typed while the page is open, keeping the query', () => {
		const b = fakeEnv('/projects/p1?tab=settings&rain=boundary');
		const s = spies();
		followAnchors({ page: 'settings', land: s.land, forward: s.forward, env: b.env });
		// The bare ?rain=boundary forwards on load already.
		expect(s.forward).toHaveBeenLastCalledWith('/projects/p1?tab=series&rain=boundary#data-feeds');
		expect(b.listening()).toBe(false);

		const c = fakeEnv('/projects/p1?tab=settings&run=r1');
		const t = spies();
		followAnchors({ page: 'settings', land: t.land, forward: t.forward, env: c.env });
		expect(t.land).not.toHaveBeenCalled();
		c.go('#set-api-keys');
		expect(t.forward).toHaveBeenCalledWith('/projects/p1?tab=project&run=r1#project-api-keys');
		expect(t.land).not.toHaveBeenCalled();
	});

	it('forwards a moved anchor on load instead of landing, and listens no more', () => {
		const b = fakeEnv('/projects/p1?tab=runs&run=r1&window=last7#res-curtailment');
		const s = spies();
		followAnchors({ page: 'runs', land: s.land, forward: s.forward, env: b.env });
		expect(s.forward).toHaveBeenCalledWith('/projects/p1?tab=supply&run=r1&window=last7#res-curtailment');
		expect(s.land).not.toHaveBeenCalled();
		expect(b.listening()).toBe(false);
	});

	it('with onLoad false, forwards on load but leaves the load’s landing to the page; lands on a change', () => {
		const b = fakeEnv('/projects/p1?tab=runs&run=r1#res-notes');
		const s = spies();
		followAnchors({ page: 'runs', land: s.land, forward: s.forward, onLoad: false, env: b.env });
		expect(s.land).not.toHaveBeenCalled();
		b.go('#res-validation');
		expect(s.land.mock.calls).toEqual([['res-validation']]);
		b.go('#res-reserve');
		expect(s.forward).toHaveBeenCalledWith('/projects/p1?tab=river&run=r1#res-reserve');
		expect(s.stops[0]).toHaveBeenCalled();
	});

	it('keeps Back and Forward’s place: a traversal ends the landing and lands nowhere', () => {
		const b = fakeEnv('/projects/p1?tab=project#members-h');
		const s = spies();
		followAnchors({ page: 'project', land: s.land, forward: s.forward, env: b.env });
		b.go('#share-h', true);
		expect(s.land.mock.calls).toEqual([['members-h']]);
		expect(s.stops[0]).toHaveBeenCalled();
	});

	it('lands nowhere for no hash or a malformed one, and decodes the rest', () => {
		const b = fakeEnv('/projects/p1?tab=series');
		const s = spies();
		followAnchors({ page: 'series', land: s.land, forward: s.forward, env: b.env });
		b.go('#%E0');
		expect(s.land).not.toHaveBeenCalled();
		b.go('#data%2Dfeeds');
		expect(s.land.mock.calls).toEqual([['data-feeds']]);
	});
});

const here = { origin: 'https://example.org', pathname: '/projects/p1', search: '?tab=runs&run=r1' };

/** A click on a span inside a link to `href`. */
function clickOn(href: string, init: Partial<LinkClick> = {}, attrs: Record<string, string> = {}): LinkClick {
	const a = { href, target: attrs.target ?? '', hasAttribute: (n: string) => n in attrs };
	const span = { closest: (sel: string) => (sel === 'a[href]' ? a : null) };
	return { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: span as unknown as EventTarget, ...init };
}

describe('queryHashLink', () => {
	it('notes a same-page link with another query and a #fragment', () => {
		expect(queryHashLink(clickOn('https://example.org/projects/p1?tab=runs&run=r2#res-notes'), here)).toBe(
			'https://example.org/projects/p1?tab=runs&run=r2#res-notes'
		);
	});

	it('ignores a link hashchange already covers, one with no fragment, another page and a click off any link', () => {
		expect(queryHashLink(clickOn('https://example.org/projects/p1?tab=runs&run=r1#res-notes'), here)).toBeNull();
		expect(queryHashLink(clickOn('https://example.org/projects/p1?tab=runs&run=r2'), here)).toBeNull();
		expect(queryHashLink(clickOn('https://example.org/projects/p1?tab=runs&run=r2#'), here)).toBeNull();
		expect(queryHashLink(clickOn('https://example.org/projects/p2?tab=runs#res-notes'), here)).toBeNull();
		expect(queryHashLink(clickOn('https://other.example/projects/p1?run=r2#res-notes'), here)).toBeNull();
		expect(queryHashLink({ ...clickOn('x'), target: { closest: () => null } as unknown as EventTarget }, here)).toBeNull();
	});

	it('ignores a modified click, another button, a new window and a download', () => {
		const href = 'https://example.org/projects/p1?tab=runs&run=r2#res-notes';
		expect(queryHashLink(clickOn(href, { ctrlKey: true }), here)).toBeNull();
		expect(queryHashLink(clickOn(href, { metaKey: true }), here)).toBeNull();
		expect(queryHashLink(clickOn(href, { button: 1 }), here)).toBeNull();
		expect(queryHashLink(clickOn(href, {}, { target: '_blank' }), here)).toBeNull();
		expect(queryHashLink(clickOn(href, {}, { download: '' }), here)).toBeNull();
	});
});
