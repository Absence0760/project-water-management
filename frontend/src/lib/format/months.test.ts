import { describe, expect, it } from 'vitest';
import { describeMonths } from './months';

describe('describeMonths', () => {
	it('summarises runs in water-year order', () => {
		expect(describeMonths([])).toBe('None');
		expect(describeMonths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBe('All year');
		expect(describeMonths([10, 11, 12, 1])).toBe('Oct–Jan');
		expect(describeMonths([1, 3, 4, 5])).toBe('Jan, Mar–May');
		expect(describeMonths([6, 7])).toBe('Jun, Jul');
	});
});
