import { describe, expect, it } from 'vitest';
import { canonicalUnit, scaleValues, seriesUnit, unitOptions } from './units';

describe('seriesUnit', () => {
	it('stores flow in m³/s and rain in mm, converting the common alternatives', () => {
		expect(seriesUnit('flow_observed_m3s', 'l/s')).toEqual({ ok: true, unit: 'm³/s', factor: 1e-3 });
		expect(seriesUnit('flow_logger_m3s', 'm³/day')).toEqual({ ok: true, unit: 'm³/s', factor: 1 / 86_400 });
		expect(seriesUnit('flow_observed_m3s', 'ML/day')).toEqual({ ok: true, unit: 'm³/s', factor: 1_000 / 86_400 });
		expect(seriesUnit('rain_catchment_mm', 'in')).toEqual({ ok: true, unit: 'mm', factor: 25.4 });
		for (const u of ['m³/s', 'm3/s', 'M3/S', 'm^3/s', 'cumecs', ' m3 / s ', 'm3 per sec']) expect(seriesUnit('flow_observed_m3s', u), u).toMatchObject({ ok: true, factor: 1 });
		for (const u of ['L/s', 'litres/s', 'lps']) expect(seriesUnit('flow_observed_m3s', u), u).toMatchObject({ factor: 1e-3 });
		expect(seriesUnit('rain_forecast_mm', 'mm')).toMatchObject({ ok: true, factor: 1 });
	});

	it('refuses a unit it does not know, or of the wrong dimension, naming the accepted ones', () => {
		const bad = seriesUnit('flow_observed_m3s', 'mm');
		expect(bad.ok).toBe(false);
		expect(!bad.ok && bad.error).toMatch(/unit "mm" isn't one this series can be given in; use one of m³\/s .*l\/s.*\(stored as m³\/s\)/);
		expect(seriesUnit('rain_catchment_mm', 'm³/s').ok).toBe(false);
		// Millilitres a day is not megalitres a day.
		expect(seriesUnit('flow_observed_m3s', 'mL/day').ok).toBe(false);
		expect(seriesUnit('flow_observed_m3s', 'gallons').ok).toBe(false);
	});

	it('knows each kind’s canonical unit', () => {
		expect(canonicalUnit('flow_reference_m3s')).toBe('m³/s');
		expect(canonicalUnit('rain_chirps_mm')).toBe('mm');
	});
});

describe('scaleValues', () => {
	it('scales numbers and keeps gaps', () => {
		expect(scaleValues([1000, null, 250], 1e-3)).toEqual([1, null, 0.25]);
		const same = [1, 2];
		expect(scaleValues(same, 1)).toBe(same);
	});
});

describe('unitOptions', () => {
	it('offers only units seriesUnit accepts, canonical first', () => {
		for (const kind of ['flow_observed_m3s', 'rain_catchment_mm']) {
			const opts = unitOptions(kind);
			expect(opts[0]).toBe(canonicalUnit(kind));
			for (const u of opts) expect(seriesUnit(kind, u).ok, `${kind} ${u}`).toBe(true);
		}
	});
});
