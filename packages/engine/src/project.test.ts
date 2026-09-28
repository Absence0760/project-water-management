import { describe, expect, it } from 'vitest';
import {
	defaultProjectSettings,
	PAN_COEFFICIENT_PRESETS,
	PAN_COEFFICIENT_TYPICAL_MAX,
	PAN_COEFFICIENT_TYPICAL_MIN,
	panCoefficientOutOfRange
} from './project';

describe('panCoefficientOutOfRange', () => {
	it('names no months when every value sits inside 0.6–0.85 (boundaries included)', () => {
		expect(panCoefficientOutOfRange(defaultProjectSettings().panCoefficient)).toEqual([]);
		expect(panCoefficientOutOfRange([PAN_COEFFICIENT_TYPICAL_MIN, PAN_COEFFICIENT_TYPICAL_MAX])).toEqual([]);
	});

	it('names each out-of-range month by water-year index', () => {
		const values = [0.5, 0.7, 0.9, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.59];
		expect(panCoefficientOutOfRange(values)).toEqual([0, 2, 11]);
	});
});

describe('PAN_COEFFICIENT_PRESETS', () => {
	it('has 12 water-year-order values per preset, every one inside the FAO-56 typical range', () => {
		for (const preset of PAN_COEFFICIENT_PRESETS) {
			expect(preset.values, preset.id).toHaveLength(12);
			expect(panCoefficientOutOfRange(preset.values), preset.id).toEqual([]);
		}
		expect(PAN_COEFFICIENT_PRESETS.map((p) => p.id)).toEqual(['generic', 'winter-rainfall', 'summer-rainfall']);
	});

	it('the generic preset matches the flat default', () => {
		const generic = PAN_COEFFICIENT_PRESETS.find((p) => p.id === 'generic')!;
		expect(generic.values).toEqual(defaultProjectSettings().panCoefficient);
	});

	it('winter and summer presets differ from generic and from each other', () => {
		const [generic, winter, summer] = PAN_COEFFICIENT_PRESETS;
		expect(winter!.values).not.toEqual(generic!.values);
		expect(summer!.values).not.toEqual(generic!.values);
		expect(winter!.values).not.toEqual(summer!.values);
	});
});
