import { ACCUMULATION_MODES, CHIRPS_BIAS_MODES, defaultProjectSettings, ZERO_RAIN_MODES } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { ACCUMULATION_OPTIONS, CHIRPS_BIAS_OPTIONS, describeZeroRain, ZERO_RAIN_OPTIONS } from './rain';

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

describe('ACCUMULATION_OPTIONS', () => {
	it('offers every engine mode once, default first', () => {
		expect(ACCUMULATION_OPTIONS.map((o) => o.value)).toEqual([...ACCUMULATION_MODES]);
		expect(ACCUMULATION_OPTIONS[0]!.value).toBe(defaultProjectSettings().zeroRainRuns.accumulationMode);
		for (const o of ACCUMULATION_OPTIONS) expect(o.help.length).toBeGreaterThan(20);
	});
});

describe('describeZeroRain', () => {
	const d = defaultProjectSettings().zeroRainRuns;
	it('names the modes and counts the periods that apply', () => {
		expect(describeZeroRain(d)).toBe('flagged runs treated as missing; accumulations spread');
		const one = { waterYear: 2003, reason: 'x' };
		expect(describeZeroRain({ ...d, keepDry: [one], missing: [one, { waterYear: 2004, reason: 'y' }] })).toBe(
			'flagged runs treated as missing; 1 keep-dry period; 2 extra missing periods; accumulations spread'
		);
		// Keep-dry periods don't apply when every flagged run is run as recorded, nor kept readings when no accumulation is spread.
		expect(describeZeroRain({ ...d, mode: 'asRecorded', keepDry: [one], accumulationMode: 'asRecorded', keepReadings: [one] })).toBe(
			'flagged runs run as recorded (dry); accumulations as recorded'
		);
		expect(describeZeroRain({ ...d, keepReadings: [one], addAccumulations: [one, one] })).toBe(
			'flagged runs treated as missing; accumulations spread; 1 reading kept as recorded; 2 listed accumulations'
		);
	});

	it('describes a fit recorded before engine 0.20.0 as having run accumulations as recorded', () => {
		expect(describeZeroRain({ mode: 'missing', keepDry: [], missing: [] })).toBe('flagged runs treated as missing; accumulations as recorded');
	});
});
