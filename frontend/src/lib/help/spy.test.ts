import { describe, expect, it } from 'vitest';
import { currentSection } from './spy';

describe('currentSection', () => {
	it('is -1 with no sections, or while the intro is still above the first heading', () => {
		expect(currentSection([], 80, false)).toBe(-1);
		expect(currentSection([300, 900, 1500], 80, false)).toBe(-1);
	});

	it('is the last heading that has passed the line', () => {
		expect(currentSection([80, 900, 1500], 80, false)).toBe(0);
		expect(currentSection([-600, 20, 700], 80, false)).toBe(1);
		expect(currentSection([-2000, -900, -10], 80, false)).toBe(2);
	});

	it('stops at the first heading below the line, even if a later one reads higher', () => {
		// Tops come in page order, so a later one can't be higher; the scan doesn't trust it.
		expect(currentSection([10, 500, 40], 80, false)).toBe(0);
	});

	it('is the last section at the end of the page, where a short last section never reaches the line', () => {
		expect(currentSection([-900, -100, 400], 80, true)).toBe(2);
		expect(currentSection([500], 80, true)).toBe(0);
	});

	it('at the end of the page, keeps the section the reader jumped to while its heading is in the window', () => {
		// A term link near the end of a topic scrolls the page to its end: the term asked for is the one being read.
		expect(currentSection([-900, 30, 400, 700], 80, true, 1)).toBe(1);
		// Scrolled on past it (its heading has left the window): the last section again.
		expect(currentSection([-900, -30, 400, 700], 80, true, 1)).toBe(3);
		// No target, or one that isn't a section: the last section.
		expect(currentSection([-900, 30, 400], 80, true)).toBe(2);
		expect(currentSection([-900, 30, 400], 80, true, 7)).toBe(2);
		// Not at the end: the target changes nothing.
		expect(currentSection([-900, 30, 400], 80, false, 2)).toBe(1);
	});
});
