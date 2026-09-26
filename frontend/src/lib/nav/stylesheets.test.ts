import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STYLESHEET_WAIT_CAP_MS, stylesheetsReady } from './stylesheets';

type Listener = () => void;
function link(opts: { loaded?: boolean; disabled?: boolean; href?: string } = {}) {
	const on: Record<string, Listener[]> = {};
	return {
		sheet: opts.loaded ? {} : null,
		disabled: opts.disabled ?? false,
		href: opts.href ?? 'http://localhost/_app/immutable/assets/page.css',
		addEventListener: (type: string, fn: Listener) => (on[type] ??= []).push(fn),
		fire: (type: 'load' | 'error') => (on[type] ?? []).forEach((fn) => fn())
	};
}
const docOf = (links: ReturnType<typeof link>[]) => ({ querySelectorAll: () => links }) as unknown as Document;

/** Whether the promise has settled, after letting pending callbacks run. */
async function settled(p: Promise<unknown>) {
	let done = false;
	void p.then(() => (done = true));
	await vi.advanceTimersByTimeAsync(0);
	return done;
}

describe('stylesheetsReady', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('resolves at once when every stylesheet has loaded, or is disabled, or there are none', async () => {
		expect(await settled(stylesheetsReady(docOf([])))).toBe(true);
		expect(await settled(stylesheetsReady(docOf([link({ loaded: true }), link({ disabled: true })])))).toBe(true);
	});

	it('waits for every stylesheet still downloading; a failed one counts as done', async () => {
		const a = link();
		const b = link();
		const log = vi.fn();
		const p = stylesheetsReady(docOf([link({ loaded: true }), a, b]), STYLESHEET_WAIT_CAP_MS, log);
		expect(await settled(p)).toBe(false);
		a.fire('load');
		expect(await settled(p)).toBe(false);
		b.fire('error');
		expect(await settled(p)).toBe(true);
		// Resolved on the events, so the cap never fires and nothing is logged.
		await vi.advanceTimersByTimeAsync(STYLESHEET_WAIT_CAP_MS * 2);
		expect(log).not.toHaveBeenCalled();
	});

	it('gives up on a stylesheet that never reports back after the cap, and logs which one', async () => {
		const stuck = link({ href: 'http://localhost/_app/immutable/assets/stuck.css' });
		const log = vi.fn();
		const p = stylesheetsReady(docOf([stuck, link({ loaded: true })]), 5_000, log);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(await settled(p)).toBe(false);
		expect(log).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(await settled(p)).toBe(true);
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls[0]![0]).toContain('stuck.css');
		expect(log.mock.calls[0]![0]).toContain('5000 ms');
	});
});
