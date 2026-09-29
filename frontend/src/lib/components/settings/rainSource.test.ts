import { describe, expect, it } from 'vitest';
import { lastWaterYear, newRainSourcePeriod, rainSourceFormError, withFactorMode, withFallback, withQuantileMap } from './rainSource';

const AT = new Date(Date.UTC(2026, 8, 26)); // 26 September 2026: water year 2025/26 still running

describe('rain-source periods in the Settings form', () => {
	it('starts a period over the last five complete water years, fitted against the reanalysis before them, with the reason to write', () => {
		expect(lastWaterYear(AT)).toBe(2024);
		expect(lastWaterYear(new Date(Date.UTC(2026, 9, 1)))).toBe(2025);
		const p = newRainSourcePeriod(AT);
		expect(p).toEqual({
			start: '2020-10-01',
			end: '2025-09-30',
			series: 'rain_catchment_alt_mm',
			factors: 'fit',
			fitReference: { series: 'rain_reanalysis_mm', fromWaterYear: 2010, toWaterYear: 2019 },
			reason: ''
		});
		// Blocks Save until it has a reason.
		expect(rainSourceFormError([p])).toMatch(/^Rain-source period 1 needs a reason/);
		expect(rainSourceFormError([{ ...p, reason: 'automatic station' }])).toBeNull();
	});

	it('switches between fixed and fitted factors; fixed factors need their provenance before Save', () => {
		const fit = { ...newRainSourcePeriod(AT), reason: 'automatic station' };
		const fixed = withFactorMode(fit, 'fixed');
		expect(fixed.factors).toEqual(new Array(12).fill(1));
		expect(fixed).not.toHaveProperty('fitReference');
		expect(fixed.provenance).toEqual({ source: '', fittedFrom: '2020-10-01', fittedTo: '2025-09-30', method: '' });
		expect(rainSourceFormError([fixed])).toMatch(/provenance needs a source and a method/);
		expect(rainSourceFormError([{ ...fixed, provenance: { ...fixed.provenance!, source: 'hydrologist', method: 'overlap ratio' } }])).toBeNull();
		const back = withFactorMode(fixed, 'fit');
		expect(back).not.toHaveProperty('provenance');
		expect(back.fitReference).toEqual({ series: 'rain_reanalysis_mm', fromWaterYear: 2010, toWaterYear: 2019 });
		expect(withFactorMode(fit, 'fit')).toBe(fit);
	});

	it('names a reanalysis fallback over the reference era, or goes back to CHIRPS; a gauge in CHIRPS needs one', () => {
		const fit = { ...newRainSourcePeriod(AT), reason: 'automatic station', gaugeInChirps: true };
		expect(rainSourceFormError([fit])).toMatch(/need a fallback that isn’t CHIRPS/);
		const named = withFallback(fit, 'rain_reanalysis_mm');
		expect(named.fallback).toEqual({ series: 'rain_reanalysis_mm', fromWaterYear: 2010, toWaterYear: 2019 });
		expect(rainSourceFormError([named])).toBeNull();
		expect(withFallback(named, 'chirps')).not.toHaveProperty('fallback');
		// A fixed-factor period takes the ten years before it.
		expect(withFallback(withFactorMode(fit, 'fixed'), 'rain_reanalysis_mm').fallback).toEqual({ series: 'rain_reanalysis_mm', fromWaterYear: 2010, toWaterYear: 2019 });
	});
});

describe('the quantile map of a rain-source period (engine ≥ 1.21.0)', () => {
	it('turns on over the fit’s reference era at the 1 mm default, off again, and blocks Save on a bad threshold', () => {
		const fit = { ...newRainSourcePeriod(AT), reason: 'automatic station' };
		const on = withQuantileMap(fit, true);
		expect(on.quantileMap).toEqual({ fromWaterYear: 2010, toWaterYear: 2019, wetDayMm: 1 });
		expect(rainSourceFormError([on])).toBeNull();
		expect(withQuantileMap(on, true)).toBe(on);
		expect(withQuantileMap(on, false)).not.toHaveProperty('quantileMap');
		expect(rainSourceFormError([{ ...on, quantileMap: { ...on.quantileMap!, wetDayMm: 0 } }])).toMatch(/wet-day threshold must be 0\.1–10 mm/);
		// A fixed-factor period takes the ten water years before it.
		expect(withQuantileMap(withFactorMode(fit, 'fixed'), true).quantileMap).toEqual({ fromWaterYear: 2010, toWaterYear: 2019, wetDayMm: 1 });
	});
});
