import { describe, expect, it } from 'vitest';
import { CHECKOUT_TAG_LENGTH, checkoutTag, thisCheckout } from './checkout.js';

describe('checkoutTag', () => {
	it('is 16 lowercase hex digits, stable for a path', () => {
		expect(checkoutTag('/home/x/wm-a')).toMatch(/^[0-9a-f]{16}$/);
		expect(CHECKOUT_TAG_LENGTH).toBe(16);
		expect(checkoutTag('/home/x/wm-a')).toBe(checkoutTag('/home/x/wm-a'));
	});

	it('differs between paths, even ones that differ by a character', () => {
		const tags = Array.from({ length: 5000 }, (_, i) => checkoutTag(`/home/x/wm-${i}`));
		expect(new Set(tags).size).toBe(tags.length);
		expect(checkoutTag('/home/x/wm-a')).not.toBe(checkoutTag('/home/x/wm-a/'));
	});
});

describe('thisCheckout', () => {
	it('finds the repo root (it has a pnpm workspace file)', async () => {
		const { existsSync } = await import('node:fs');
		const here = thisCheckout();
		expect(existsSync(`${here.path}/pnpm-workspace.yaml`)).toBe(true);
		expect(typeof here.isWorktree).toBe('boolean');
	});
});
