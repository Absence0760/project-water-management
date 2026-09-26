import { describe, expect, it } from 'vitest';
import { MODEL_BAND, modelBand } from './farmView';

describe('modelBand', () => {
	it('bands the headline at 90 % and 70 %', () => {
		expect(modelBand(0.95, 0, 1)).toBe('ok');
		expect(modelBand(MODEL_BAND.okFrom, 0, 1)).toBe('ok');
		expect(modelBand(0.83, 0, 1)).toBe('watch');
		expect(modelBand(MODEL_BAND.watchFrom, 0, 1)).toBe('watch');
		expect(modelBand(0.52, 0, 1)).toBe('short');
	});

	it('makes a storage part at or above the floor a watch, and ignores crumbs', () => {
		expect(modelBand(0.95, 1, 1)).toBe('watch');
		expect(modelBand(0.95, 0.4, 1)).toBe('ok');
		expect(modelBand(0.5, 5, 1)).toBe('short');
	});

	it('has no band without a headline', () => {
		expect(modelBand(null, 5, 1)).toBeNull();
		expect(modelBand(Number.NaN, 0, 1)).toBeNull();
	});
});
