import { describe, expect, it } from 'vitest';
import { formOffScreen, inViewDelta } from './scroll';

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

describe('inViewDelta', () => {
	const box = { left: 0, top: 0, right: 100, bottom: 100 };
	it('scrolls nothing for an item already in view', () => {
		expect(inViewDelta(box, { left: 20, top: 20, right: 40, bottom: 40 })).toEqual({ dx: 0, dy: 0 });
	});
	it('brings an item past the far edge, or before the near one, in with a margin', () => {
		expect(inViewDelta(box, { left: 150, top: 10, right: 170, bottom: 30 })).toEqual({ dx: 78, dy: 0 });
		expect(inViewDelta(box, { left: 10, top: -50, right: 30, bottom: -30 })).toEqual({ dx: 0, dy: -58 });
	});
	it('lines an item bigger than the box up with its start', () => {
		expect(inViewDelta(box, { left: 50, top: 0, right: 300, bottom: 20 }).dx).toBe(42);
	});
});
