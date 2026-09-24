import { describe, expect, it } from 'vitest';
import { monthsText, paramLabel } from './provenance';

describe('paramLabel', () => {
	it('names each model’s parameters, and falls back to the key', () => {
		expect(paramLabel('gr4j', 'x1')).toMatch(/X1$/);
		expect(paramLabel('legacy', 'a')).toBe('Peak-flow coefficient a');
		expect(paramLabel('gr4j', 'a')).toBe('a');
		expect(paramLabel('nope' as never, 'x1')).toBe('x1');
	});
});

describe('monthsText', () => {
	it('shows a uniform monthly value once, and every month by name otherwise', () => {
		expect(monthsText(Array(12).fill(0.7))).toBe('0.70 every month');
		const varied = [0.65, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7];
		expect(monthsText(varied)).toBe('Oct 0.65, Nov 0.70, Dec 0.70, Jan 0.70, Feb 0.70, Mar 0.70, Apr 0.70, May 0.70, Jun 0.70, Jul 0.70, Aug 0.70, Sep 0.70');
		expect(monthsText([150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100], 0)).toMatch(/^Oct 150, Nov 180, .*Sep 100$/);
	});
});
