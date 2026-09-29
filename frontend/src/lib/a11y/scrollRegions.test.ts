import { describe, expect, it } from 'vitest';
import { overflows } from './scrollRegions';

const box = (scrollWidth: number, clientWidth: number, scrollHeight = 100, clientHeight = 100) => ({ scrollWidth, clientWidth, scrollHeight, clientHeight });

describe('overflows', () => {
	it('counts a box as scrolling from its first pixel of overflow, either way', () => {
		expect(overflows(box(308, 308))).toBe(false);
		// The Compare summary's calibration table on a phone (issue #162): 1 px still scrolls.
		expect(overflows(box(309, 308))).toBe(true);
		expect(overflows(box(300, 308, 101, 100))).toBe(true);
	});
});
