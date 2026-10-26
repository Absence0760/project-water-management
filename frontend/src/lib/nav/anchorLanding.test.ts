import { describe, expect, it, vi } from 'vitest';
import { followAnchors, type LandingEnv } from './anchorLanding';

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
