import { ACCUMULATION_MODES, CHIRPS_BIAS_MODES, defaultProjectSettings, ZERO_RAIN_MODES } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { ACCUMULATION_OPTIONS, CHIRPS_BIAS_OPTIONS, CHIRPS_FIT_OPTIONS, chirpsFitChoice, chirpsFitRangesError, describeZeroRain, withChirpsQuantileMap, ZERO_RAIN_OPTIONS } from './rain';

describe('CHIRPS_BIAS_OPTIONS', () => {
	it('offers every engine mode once, default first', () => {
		expect(CHIRPS_BIAS_OPTIONS.map((o) => o.value)).toEqual([...CHIRPS_BIAS_MODES]);
		expect(CHIRPS_BIAS_OPTIONS[0]!.value).toBe(defaultProjectSettings().chirpsBiasCorrection);
		for (const o of CHIRPS_BIAS_OPTIONS) expect(o.help.length).toBeGreaterThan(20);
	});
});

describe('CHIRPS_FIT_OPTIONS', () => {
	it('offers the whole record (the default) and listed ranges, no automatic mode; the ranges help says a proposal needs checking', () => {
		expect(CHIRPS_FIT_OPTIONS.map((o) => o.value)).toEqual(['all', 'ranges']);
		expect(chirpsFitChoice(defaultProjectSettings().chirpsFitPeriod)).toBe('all');
		expect(chirpsFitChoice('segments')).toBe('all');
		expect(chirpsFitChoice([{ fromWaterYear: 1990, toWaterYear: 1999, reason: 'a' }])).toBe('ranges');
		expect(CHIRPS_FIT_OPTIONS[1]!.help).toMatch(/can be a year or two off, and a CHIRPS change moves them too: check each range/);
	});
});

describe('chirpsFitRangesError', () => {
	const r = (fromWaterYear: number, toWaterYear: number, reason = 'x') => ({ fromWaterYear, toWaterYear, reason });
	it('accepts valid ranges and names the first problem otherwise', () => {
		expect(chirpsFitRangesError([r(1990, 1999), r(2005, 2019)])).toBeNull();
		expect(chirpsFitRangesError([])).toMatch(/at least one/);
		expect(chirpsFitRangesError([r(1990, 1999), r(2005, 2001)])).toBe('Fit range 2: ends before it starts');
		expect(chirpsFitRangesError([r(1990, 1999, '  ')])).toBe('Fit range 1: needs a reason');
		expect(chirpsFitRangesError([r(1990, 1999), r(1995, 2005)])).toBe('Fit ranges overlap: 1995/96–2005/06 overlaps 1990/91–1999/00');
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

describe('withChirpsQuantileMap (engine ≥ 1.47.0)', () => {
	it('is off by default, turns on at the default threshold, and back on at the one it was turned off with', () => {
		expect(defaultProjectSettings().chirpsQuantileMap).toBeNull();
		expect(withChirpsQuantileMap(true, null)).toEqual({ wetDayMm: 1 });
		expect(withChirpsQuantileMap(true, { wetDayMm: 2.5 })).toEqual({ wetDayMm: 2.5 });
		expect(withChirpsQuantileMap(false, { wetDayMm: 2.5 })).toBeNull();
	});
});
