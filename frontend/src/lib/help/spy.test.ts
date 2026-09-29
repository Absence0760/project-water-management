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

	it('at the end keeps a just-linked section marked while its heading is on screen', () => {
		// A link to the third-from-last term of a short page lands at the end of it.
		expect(currentSection([-900, 100, 400, 600], 80, true, 1, 800)).toBe(1);
		// Scrolled past it (heading above the window, or below it): the last section again.
		expect(currentSection([-900, -100, 400, 600], 80, true, 1, 800)).toBe(3);
		expect(currentSection([-900, 100, 850, 900], 80, true, 2, 800)).toBe(3);
		expect(currentSection([-900, 100, 400, 600], 80, true, 5, 800)).toBe(3);
		// Not at the end, the link doesn't matter: the line decides.
		expect(currentSection([-900, 20, 400, 600], 80, false, 3, 800)).toBe(1);
	});
});
