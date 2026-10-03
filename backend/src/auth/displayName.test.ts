import { describe, expect, it } from 'vitest';
import { cleanDisplayName, displayName } from './displayName';

describe('display names', () => {
	it('keeps an ordinary name as typed, trimmed', () => {
		expect(displayName.parse('  Ann Smith ')).toBe('Ann Smith');
		expect(displayName.parse('Thandi Nkosi-Dlamini')).toBe('Thandi Nkosi-Dlamini');
		expect(displayName.parse('Pieter van der Merwe 🚜')).toBe('Pieter van der Merwe 🚜');
		// Scripts that need joiners and directional marks keep them.
		expect(displayName.parse('می‌خواهم')).toBe('می‌خواهم');
		expect(displayName.parse('‏שרה')).toBe('‏שרה');
	});

	it('makes every run of whitespace, line breaks included, one space', () => {
		expect(cleanDisplayName('Ann\n\nSmith')).toBe('Ann Smith');
		expect(cleanDisplayName('Ann\t  Smith')).toBe('Ann Smith');
	});

	it('drops control characters and the bidi controls that reorder what is shown', () => {
		expect(displayName.parse('Ann‮nimda')).toBe('Annnimda');
		expect(displayName.parse('⁦Ann⁩')).toBe('Ann');
		expect(displayName.parse('Ann\u0007')).toBe('Ann');
	});

	it('refuses a name that would show as nothing', () => {
		for (const blank of ['', '   ', '​', '​‌‍', '‮', '⁠﻿', '́']) {
			expect(displayName.safeParse(blank).success, JSON.stringify(blank)).toBe(false);
		}
	});

	it('still caps it at 100 characters, counted after cleaning', () => {
		expect(displayName.safeParse('a'.repeat(100)).success).toBe(true);
		expect(displayName.safeParse('a'.repeat(101)).success).toBe(false);
		expect(displayName.safeParse(`${'a'.repeat(100)}‮`).success).toBe(true);
	});
});
