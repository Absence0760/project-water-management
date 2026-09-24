import { CHIRPS_BIAS_MODES, defaultProjectSettings, ZERO_RAIN_MODES } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { CHIRPS_BIAS_OPTIONS, ZERO_RAIN_OPTIONS } from './rain';

describe('CHIRPS_BIAS_OPTIONS', () => {
	it('offers every engine mode once, default first', () => {
		expect(CHIRPS_BIAS_OPTIONS.map((o) => o.value)).toEqual([...CHIRPS_BIAS_MODES]);
		expect(CHIRPS_BIAS_OPTIONS[0]!.value).toBe(defaultProjectSettings().chirpsBiasCorrection);
		for (const o of CHIRPS_BIAS_OPTIONS) expect(o.help.length).toBeGreaterThan(20);
	});
});

describe('ZERO_RAIN_OPTIONS', () => {
	it('offers every engine mode once, default first', () => {
		expect(ZERO_RAIN_OPTIONS.map((o) => o.value)).toEqual([...ZERO_RAIN_MODES]);
		expect(ZERO_RAIN_OPTIONS[0]!.value).toBe(defaultProjectSettings().zeroRainRuns.mode);
		for (const o of ZERO_RAIN_OPTIONS) expect(o.help.length).toBeGreaterThan(20);
	});
});
