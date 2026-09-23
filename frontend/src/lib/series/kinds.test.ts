import { describe, expect, it } from 'vitest';
import { defaultUnit, kindLabel, KIND_OPTIONS } from './kinds';

describe('series kinds', () => {
	it('labels every engine kind and infers units', () => {
		expect(KIND_OPTIONS.every((o) => o.label !== o.value)).toBe(true);
		expect(kindLabel('unknown_kind')).toBe('unknown_kind');
		expect(defaultUnit('rain_catchment_mm')).toBe('mm');
		expect(defaultUnit('flow_observed_m3s')).toBe('m³/s');
		expect(defaultUnit('other')).toBe('');
	});
});
