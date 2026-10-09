import { describe, expect, it } from 'vitest';
import { parseGaugeSeriesKey, parseUnitRainSeriesKey, UNIT_RAIN_KINDS, unitRainSeriesKey } from './project';

describe('unit rain series keys (issue #482)', () => {
	it('round-trips every unit rain kind', () => {
		for (const kind of UNIT_RAIN_KINDS) expect(parseUnitRainSeriesKey(unitRainSeriesKey(kind, 'u1'))).toEqual({ kind, nodeId: 'u1' });
	});

	it('refuses plain kinds, flow records, other kinds and an empty node', () => {
		expect(parseUnitRainSeriesKey('rain_chirps_mm')).toBeNull();
		expect(parseUnitRainSeriesKey('flow_observed_m3s@g1')).toBeNull();
		expect(parseUnitRainSeriesKey('rain_forecast_mm@u1')).toBeNull();
		expect(parseUnitRainSeriesKey('rain_chirps_mm@')).toBeNull();
	});

	it('is never read as a gauge flow record', () => {
		expect(parseGaugeSeriesKey(unitRainSeriesKey('rain_chirps_mm', 'u1'))).toBeNull();
	});
});
