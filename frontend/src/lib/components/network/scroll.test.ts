import { describe, expect, it } from 'vitest';
import { formOffScreen } from './scroll';

describe('formOffScreen', () => {
	const vh = 900;

	it('is false when the picker is in the upper part of the viewport (the form is visible)', () => {
		expect(formOffScreen({ top: 56, bottom: 110 }, vh)).toBe(false);
		expect(formOffScreen({ top: 500, bottom: 550 }, vh)).toBe(false);
	});

	it('is true when the picker sits low in the viewport or below it (phone: form under the schematic)', () => {
		expect(formOffScreen({ top: 540, bottom: 590 }, vh)).toBe(false);
		expect(formOffScreen({ top: 541, bottom: 590 }, vh)).toBe(true);
		expect(formOffScreen({ top: 897, bottom: 950 }, vh)).toBe(true);
		expect(formOffScreen({ top: 1400, bottom: 1450 }, vh)).toBe(true);
	});

	it('is true when the picker has scrolled up out of view', () => {
		expect(formOffScreen({ top: -80, bottom: -20 }, vh)).toBe(true);
	});
});
