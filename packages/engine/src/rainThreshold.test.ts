import { describe, expect, it } from 'vitest';
import { aboveRainThreshold } from './rainThreshold';

describe('aboveRainThreshold', () => {
	it('keeps rain above the threshold and zeroes rain at or below it', () => {
		expect(aboveRainThreshold(2.5, 2)).toBe(2.5);
		expect(aboveRainThreshold(2, 2)).toBe(0);
		expect(aboveRainThreshold(0.4, 2)).toBe(0);
		expect(aboveRainThreshold(0.4, 0)).toBe(0.4);
		expect(aboveRainThreshold(0, 0)).toBe(0);
	});
});
