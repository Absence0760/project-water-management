import { describe, expect, it } from 'vitest';
import { LABEL_CHAR_PX, labelX, yearLabelIndices } from './yearAxis';

describe('yearLabelIndices', () => {
	it('labels every year when there are few', () => {
		expect(yearLabelIndices(3)).toEqual([0, 1, 2]);
		expect(yearLabelIndices(6)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(yearLabelIndices(1)).toEqual([0]);
		expect(yearLabelIndices(0)).toEqual([]);
	});

	it('labels about six of many, always the last', () => {
		// 15 water years: every third, and the last (12 would crowd it, so it goes).
		expect(yearLabelIndices(15)).toEqual([0, 3, 6, 9, 14]);
		expect(yearLabelIndices(16)).toEqual([0, 3, 6, 9, 12, 15]);
	});

	it('drops a regular label too close before the last, so the two never overlap', () => {
		// Every other year of 8: 0, 2, 4, 6 and the last (7) would sit next to 6, so 6 goes.
		expect(yearLabelIndices(8)).toEqual([0, 2, 4, 7]);
		// When the step lands on the last, nothing is dropped.
		expect(yearLabelIndices(7)).toEqual([0, 2, 4, 6]);
	});
});

describe('labelX', () => {
	const w = '2024/25'.length * LABEL_CHAR_PX;

	it('centres a label on its group when it fits', () => {
		expect(labelX(150, '2024/25', 0, 300)).toBe(150);
	});

	it('moves the last label in from the right edge instead of clipping it (issue #162: "2024/2…")', () => {
		const x = labelX(292, '2024/25', 0, 300);
		expect(x + w / 2).toBeLessThanOrEqual(300);
		expect(x).toBeCloseTo(300 - w / 2);
	});

	it('keeps a label off the left edge too', () => {
		expect(labelX(5, '2024/25', 0, 300) - w / 2).toBeGreaterThanOrEqual(0);
	});
});
