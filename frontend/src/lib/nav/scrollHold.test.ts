// The one scroll hold (scrollHold.ts): when it aligns, when it ends, and an anchor yielding to Back.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anchorYields, expectBack, holdScroll, READER_INPUT, SETTLE_MS, type HoldEnv } from './scrollHold';

function env(fonts = false) {
	const target = new EventTarget();
	let onLayout: (() => void) | undefined;
	let loadFonts!: () => void;
	const timers: { ms: number; fn: () => void; live: boolean }[] = [];
	const e: HoldEnv = {
		target,
		fontsReady: fonts ? new Promise<void>((r) => (loadFonts = r)) : undefined,
		watchLayout(cb) {
			onLayout = cb;
			return () => (onLayout = undefined);
		},
		after(ms, fn) {
			const t = { ms, fn, live: true };
			timers.push(t);
			return () => (t.live = false);
		}
	};
	return { e, target, layout: () => onLayout?.(), settle: () => timers.filter((t) => t.live).forEach((t) => t.fn()), loadFonts: () => loadFonts(), timers };
}

afterEach(() => expectBack(false));

describe('holdScroll', () => {
	it('aligns at once and on each layout change until released, then never again', () => {
		const { e, layout } = env();
		const align = vi.fn();
		const release = holdScroll(align, { env: e })!;
		layout();
		expect(align).toHaveBeenCalledTimes(2);
		release();
		release();
		layout();
		expect(align).toHaveBeenCalledTimes(2);
	});

	it('ends at the reader’s input, at a history step or #hash, and when the page settles', () => {
		for (const type of [...READER_INPUT, 'popstate', 'hashchange']) {
			const { e, target, layout } = env();
			const align = vi.fn();
			holdScroll(align, { env: e });
			target.dispatchEvent(new Event(type));
			layout();
			expect(align, type).toHaveBeenCalledTimes(1);
		}
		const { e, layout, settle, timers } = env();
		const align = vi.fn();
		holdScroll(align, { env: e });
		expect(timers.at(-1)!.ms).toBe(SETTLE_MS);
		layout(); // a change restarts the settle
		settle();
		layout();
		expect(align).toHaveBeenCalledTimes(2);
	});

	it('doesn’t settle before the fonts are in, whose swap re-flows the page late', async () => {
		const { e, layout, settle, loadFonts } = env(true);
		const align = vi.fn();
		holdScroll(align, { env: e });
		settle();
		layout();
		expect(align).toHaveBeenCalledTimes(2);
		loadFonts();
		await Promise.resolve();
		expect(align).toHaveBeenCalledTimes(3);
		settle();
		layout();
		expect(align).toHaveBeenCalledTimes(3);
	});

	it('one hold at a time: a newer hold releases the older', () => {
		const a = env();
		const b = env();
		const first = vi.fn();
		holdScroll(first, { env: a.e });
		holdScroll(vi.fn(), { env: b.e });
		a.layout();
		expect(first).toHaveBeenCalledTimes(1);
	});

	it('an anchor yields to Back, on its way or holding; once Back is done it holds again (positive control)', () => {
		expectBack(true);
		expect(anchorYields()).toBe(true);
		expect(holdScroll(vi.fn(), { env: env().e })).toBeNull();
		const back = holdScroll(vi.fn(), { env: env().e, back: true })!;
		expect(anchorYields()).toBe(true);
		expect(holdScroll(vi.fn(), { env: env().e })).toBeNull();
		back();
		expect(anchorYields()).toBe(false);
		expect(holdScroll(vi.fn(), { env: env().e })).not.toBeNull();
	});
});
