import { describe, expect, it } from 'vitest';
import { activeSectionId } from './sectionNav';

describe('activeSectionId', () => {
	const tops = (...t: number[]) => t.map((top, i) => ({ id: `s${i}`, top }));

	it('marks the last section whose top has reached the line under the header', () => {
		expect(activeSectionId(tops(-900, -200, 60, 700), 68)).toBe('s2');
		expect(activeSectionId(tops(-900, -200, 69, 700), 68)).toBe('s1');
	});

	it('marks the first section before any has reached the line', () => {
		expect(activeSectionId(tops(300, 900), 68)).toBe('s0');
	});

	it('marks the last section at the bottom of the page, even if it never reached the line', () => {
		expect(activeSectionId(tops(-900, -200, 400), 68, true)).toBe('s2');
	});

	it('has nothing to mark before any section is on the page', () => {
		expect(activeSectionId([], 68)).toBeNull();
	});
});
