import { describe, expect, it } from 'vitest';
import { cleanName, displayName, projectName, teamName } from './visibleName';

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
		expect(cleanName('Ann\n\nSmith')).toBe('Ann Smith');
		expect(cleanName('Ann\t  Smith')).toBe('Ann Smith');
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

describe('team and project names', () => {
	it('clean and refuse as display names do', () => {
		for (const schema of [teamName, projectName]) {
			expect(schema.parse('  Upper\nBerg ')).toBe('Upper Berg');
			expect(schema.parse('Berg‮tset')).toBe('Bergtset');
			expect(schema.parse('Bergrivier 🌊')).toBe('Bergrivier 🌊');
			for (const blank of ['', '   ', '​', '‮⁦⁩', '⁠﻿']) {
				expect(schema.safeParse(blank).success, JSON.stringify(blank)).toBe(false);
			}
		}
	});

	it('allow 200 characters after cleaning (the column check), not 201', () => {
		for (const schema of [teamName, projectName]) {
			expect(schema.safeParse('a'.repeat(200)).success).toBe(true);
			expect(schema.safeParse(`${'a'.repeat(200)}‮`).success).toBe(true);
			expect(schema.safeParse('a'.repeat(201)).success).toBe(false);
		}
	});

	it('names what was refused', () => {
		const r = teamName.safeParse('​');
		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.message).toBe('a team name needs at least one visible character');
		expect(projectName.safeParse('​').error?.issues[0]?.message).toBe('a project name needs at least one visible character');
	});
});
