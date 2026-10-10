// The Area fill slider's state (areaFill.svelte.ts): a whole percentage on the
// slider's step, kept in this browser, 100 % (and nothing stored) by default
// or when storage can't be read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AREA_FILL_KEY, AreaFill, areaFillPercent } from './areaFill.svelte';

// A stand-in store, as flowUnit.test.ts does: the test runner's own localStorage varies by Node version.
let kept: Map<string, string>;
beforeEach(() => {
	kept = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => kept.get(k) ?? null,
		setItem: (k: string, v: string) => void kept.set(k, v),
		removeItem: (k: string) => void kept.delete(k)
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('areaFillPercent', () => {
	it('keeps a percentage on the 5 % step within 0–100, and makes anything else 100', () => {
		expect(areaFillPercent('40')).toBe(40);
		expect(areaFillPercent(42)).toBe(40);
		expect(areaFillPercent(43)).toBe(45);
		expect(areaFillPercent(-10)).toBe(0);
		expect(areaFillPercent(250)).toBe(100);
		for (const v of [null, undefined, '', 'abc', NaN, {}]) expect(areaFillPercent(v)).toBe(100);
	});
});

describe('AreaFill', () => {
	it('starts at 100 % with nothing stored, and remembers a change in this browser', () => {
		const a = new AreaFill();
		expect(a.percent).toBe(100);
		expect(a.scale).toBe(1);
		a.set('35');
		expect(a.percent).toBe(35);
		expect(a.scale).toBe(0.35);
		expect(localStorage.getItem(AREA_FILL_KEY)).toBe('35');
		expect(new AreaFill().percent).toBe(35);
		// Back to full forgets it.
		a.set(100);
		expect(localStorage.getItem(AREA_FILL_KEY)).toBeNull();
	});

	it('starts at 100 % when storage throws, and still moves for this visit', () => {
		const blocked = () => {
			throw new Error('blocked');
		};
		vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
		const a = new AreaFill();
		expect(a.percent).toBe(100);
		a.set(20);
		expect(a.percent).toBe(20);
	});
});
