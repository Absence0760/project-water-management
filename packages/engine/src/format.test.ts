import { describe, expect, it } from 'vitest';
import { THOUSANDS_SEP, groupDigits, regroup } from './format';

describe('the thousands separator (D10, issue #76)', () => {
	it('is a narrow no-break space', () => {
		expect(THOUSANDS_SEP).toBe('\u202f');
		// No-break, so a figure never wraps, and still a space to anything that strips whitespace (parseNum).
		expect(/\s/.test(THOUSANDS_SEP)).toBe(true);
	});
	it('regroups an en-US figure and leaves the decimal point', () => {
		expect(regroup('1,234,567.891')).toBe('1\u202f234\u202f567.891');
		expect(regroup('-12,345')).toBe('-12\u202f345');
		expect(regroup('999')).toBe('999');
	});
	it('groups an integer’s digits in threes', () => {
		expect(['1', '12', '123', '1234', '1234567'].map(groupDigits)).toEqual(['1', '12', '123', '1\u202f234', '1\u202f234\u202f567']);
	});
});
