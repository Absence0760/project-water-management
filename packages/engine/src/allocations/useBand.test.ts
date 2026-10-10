import { describe, expect, it } from 'vitest';
import { useBand } from './useBand';

describe('useBand (issue #510)', () => {
	it('the band edges: 0.99, 1.00, 1.10, 1.1001, 1.50, 1.5001', () => {
		const at = (r: number) => useBand(r * 250_000, 250_000);
		expect([0.99, 1, 1.1, 1.1001, 1.5, 1.5001].map(at)).toEqual(['under', 'near', 'near', 'over', 'over', 'far']);
	});

	it('nothing registered: use is unregistered, neither is none', () => {
		expect(useBand(10, 0)).toBe('unregistered');
		expect(useBand(0, 0)).toBe('none');
	});

	it('r = 1 survives float dust; a real difference does not', () => {
		expect(useBand(1 - 1e-12, 1)).toBe('near');
		expect(useBand(99_990, 100_000)).toBe('under');
	});
});
