import { describe, expect, it } from 'vitest';
import { amount, flowText } from './format';

describe('amount', () => {
	it('keeps fixed decimals while they show at least two significant figures', () => {
		expect(amount(12.3456, 2)).toBe('12.35');
		expect(amount(0.0123, 3)).toBe('0.012');
		expect(amount(-3.5, 2)).toBe('-3.50');
	});
	it('gives a small non-zero value two significant figures instead of rounding it to zero (issue #45)', () => {
		expect(amount(0.00042, 3)).toBe('0.00042');
		expect(amount(0.004, 3)).toBe('0.004');
		expect(amount(-0.0042, 2)).toBe('-0.0042');
		expect(amount(2.3e-9, 3)).toBe('2.3e-9');
	});
	it('writes zero as 0', () => {
		expect(amount(0, 3)).toBe('0');
		expect(amount(-0, 2)).toBe('0');
	});
});

describe('flowText', () => {
	it('uses two decimals from 1 m³/s and three below', () => {
		expect(flowText(25.254)).toBe('25.25');
		expect(flowText(0.1234)).toBe('0.123');
		expect(flowText(0.00031)).toBe('0.00031');
	});
});
