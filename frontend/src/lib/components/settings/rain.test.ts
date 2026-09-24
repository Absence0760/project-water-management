import { CHIRPS_BIAS_MODES, defaultProjectSettings, ZERO_RAIN_MODES } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { CHIRPS_BIAS_OPTIONS, describeZeroRain, ZERO_RAIN_OPTIONS } from './rain';

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

describe('describeZeroRain', () => {
	it('names the mode and counts the periods that apply', () => {
		expect(describeZeroRain({ mode: 'missing', keepDry: [], missing: [] })).toBe('flagged runs treated as missing');
		const one = { waterYear: 2003, reason: 'x' };
		expect(describeZeroRain({ mode: 'missing', keepDry: [one], missing: [one, { waterYear: 2004, reason: 'y' }] })).toBe(
			'flagged runs treated as missing; 1 keep-dry period; 2 extra missing periods'
		);
		// Keep-dry periods don't apply when every flagged run is run as recorded.
		expect(describeZeroRain({ mode: 'asRecorded', keepDry: [one], missing: [] })).toBe('flagged runs run as recorded (dry)');
	});
});
