import { describe, expect, it } from 'vitest';
import { fitList } from './record.js';

describe('fitList', () => {
	it('lists every item when they fit', () => {
		expect(fitList(['a', 'b', 'c'], 7)).toBe('a, b, c');
		expect(fitList([], 0)).toBe('');
	});
	it('counts the items that do not fit, never cutting one', () => {
		expect(fitList(['alpha', 'beta', 'gamma'], 17)).toBe('alpha and 2 more');
		expect(fitList(['alpha', 'beta', 'gamma', 'delta'], 25, ' and ')).toBe('alpha and beta and 2 more');
	});
	it('falls back to the count alone when not even the first fits', () => {
		expect(fitList(['alpha', 'beta'], 3)).toBe('2 of them');
		expect(fitList(['alpha', 'beta'], 3, ', ', (n) => `${n} areas`)).toBe('2 areas');
	});
});
