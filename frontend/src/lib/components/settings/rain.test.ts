import { CHIRPS_BIAS_MODES, defaultProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { CHIRPS_BIAS_OPTIONS } from './rain';

describe('CHIRPS_BIAS_OPTIONS', () => {
	it('offers every engine mode once, default first', () => {
		expect(CHIRPS_BIAS_OPTIONS.map((o) => o.value)).toEqual([...CHIRPS_BIAS_MODES]);
		expect(CHIRPS_BIAS_OPTIONS[0]!.value).toBe(defaultProjectSettings().chirpsBiasCorrection);
		for (const o of CHIRPS_BIAS_OPTIONS) expect(o.help.length).toBeGreaterThan(20);
	});
});
