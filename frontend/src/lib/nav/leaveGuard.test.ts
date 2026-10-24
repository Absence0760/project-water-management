// The leave guard's beforeNavigate (leaveGuard.ts) on SvelteKit 3: shallow
// routing is a goto({ shallow: true }) now, which reaches beforeNavigate as
// pushState/replaceState never did, and it must not ask about unsaved work it
// doesn't drop (the token pages rewrite their address on load).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeforeNavigate } from '$app/navigation';

const h = vi.hoisted(() => ({ handler: null as null | ((nav: BeforeNavigate) => void), confirm: vi.fn(), url: new URL('https://app.test/projects/p1?tab=network') }));

vi.mock('svelte', async (importOriginal) => ({ ...(await importOriginal<typeof import('svelte')>()), onMount: () => {} }));
vi.mock('$app/navigation', () => ({
	beforeNavigate: (fn: (nav: BeforeNavigate) => void) => {
		h.handler = fn;
	},
	goto: vi.fn()
}));
vi.mock('$app/state', () => ({ page: { get url() { return h.url; } } }));
vi.mock('#lib/nav/base.js', () => ({ basePath: () => '' }));
vi.mock('#lib/components/common/confirm.svelte.js', () => ({ confirmDialog: h.confirm }));

import { installLeaveGuard } from './leaveGuard';
import { registerUnsaved } from './unsaved';

function nav(to: string, extra: Partial<BeforeNavigate> = {}): BeforeNavigate & { cancel: ReturnType<typeof vi.fn> } {
	return { from: null, to: { url: new URL(to) }, type: 'goto', willUnload: false, shallow: false, cancel: vi.fn(), complete: Promise.resolve(), ...extra } as unknown as BeforeNavigate & { cancel: ReturnType<typeof vi.fn> };
}

describe('the leave guard', () => {
	let unregister: () => void;
	beforeEach(() => {
		h.confirm.mockReset().mockResolvedValue(false);
		installLeaveGuard();
		unregister = registerUnsaved({ dirty: () => true, what: 'model edits' });
	});
	afterEach(() => unregister());

	it('lets a shallow goto through: it rewrites the address, the page and its work stay', () => {
		const n = nav('https://app.test/teams', { shallow: true });
		h.handler!(n);
		expect(n.cancel).not.toHaveBeenCalled();
		expect(h.confirm).not.toHaveBeenCalled();
	});

	it('positive control: the same navigation, not shallow, is stopped and asks', () => {
		const n = nav('https://app.test/teams');
		h.handler!(n);
		expect(n.cancel).toHaveBeenCalledOnce();
		expect(h.confirm).toHaveBeenCalledOnce();
		expect(h.confirm.mock.calls[0]![0]).toMatchObject({ confirmLabel: 'Leave without saving' });
	});
});
