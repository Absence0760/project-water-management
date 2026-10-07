import { describe, expect, it } from 'vitest';
import { allocationsHref } from './links';

describe('allocationsHref', () => {
	it('opens Allocations, with the run compared and the unit picked when given', () => {
		expect(allocationsHref()).toBe('?tab=allocations');
		expect(allocationsHref(null)).toBe('?tab=allocations');
		expect(allocationsHref('r1')).toBe('?tab=allocations&run=r1');
		expect(allocationsHref('r1', { unit: 'n 2' })).toBe('?tab=allocations&run=r1&unit=n+2');
		expect(allocationsHref(null, { unit: 'n2' })).toBe('?tab=allocations&unit=n2');
	});
});
