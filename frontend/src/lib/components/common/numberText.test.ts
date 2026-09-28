import { describe, expect, it } from 'vitest';
import { parseNum } from '$lib/format/number';
import { groupedText, plainText } from './numberText';

describe('groupedText', () => {
	it('groups thousands and keeps the decimals that are there', () => {
		expect(groupedText(300000)).toBe('300\u202f000');
		expect(groupedText(1234.5)).toBe('1\u202f234.5');
		expect(groupedText(0.15)).toBe('0.15');
		expect(groupedText(0)).toBe('0');
	});
	it('applies the display scale without float noise', () => {
		expect(groupedText(0.07, 100)).toBe('7');
		expect(groupedText(12.5, 1000)).toBe('12\u202f500');
	});
	it('shows nothing for a missing value', () => {
		expect(groupedText(null)).toBe('');
		expect(groupedText(NaN)).toBe('');
	});
});

describe('reading grouped text back (parseNum)', () => {
	it('round-trips grouped, spaced and plain input', () => {
		expect(parseNum('300,000')).toBe(300000);
		expect(parseNum('300 000')).toBe(300000);
		expect(parseNum('1,234.5')).toBe(1234.5);
		expect(parseNum(groupedText(987654.321))).toBe(987654.321);
	});
	it('rejects text that is not a number', () => {
		expect(parseNum('')).toBeNull();
		expect(parseNum('12a')).toBeNull();
	});
});

describe('plainText', () => {
	it('trims float noise and applies the display scale', () => {
		expect(plainText(0.07, 100)).toBe('7');
		expect(plainText(0.1 + 0.2)).toBe('0.3');
		expect(plainText(null)).toBe('');
	});
	it('rounds to the decimals asked for, so two thirds as a percentage reads 66.7', () => {
		expect(plainText(2 / 3, 100)).toBe('66.666666667');
		expect(plainText(2 / 3, 100, 1)).toBe('66.7');
		expect(plainText(1.5, 100, 1)).toBe('150');
		expect(plainText(0.676, 100, 0)).toBe('68');
	});
});
